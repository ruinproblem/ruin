import { split } from "../../../program/client/index.js";
import type { Trade } from "./yolo.js";
export type Sample = {
  id?: number;
  market?: string;
  publish_ts: number;
  price: string;
  slot: number;
  recv_ms: number;
};
export type Outcome =
  "rows" | "pending" | "unmatched" | "noRecord" | "unresolved" | "expired";
export type Calculation = {
  status: Outcome;
  row?: any;
  window?: any;
  oid?: string;
};
export function pairTrades(input: { trade: Trade; cursor: number }[]) {
  const key = (t: Trade, time: number) =>
    [t.owner, t.market, t.side, time, t.margin].join("|");
  const opens = new Map<string, { trade: Trade; cursor: number }[]>(),
    pairs = new Map<string, Trade>();
  for (const item of [...input].sort((a, b) => a.cursor - b.cursor)) {
    const t = item.trade;
    if (t.kind === "open") {
      const k = key(t, Number(t.executedAt)),
        list = opens.get(k) ?? [];
      list.push(item);
      opens.set(k, list);
    }
  }
  const used = new Set<string>();
  for (const { trade: t } of [...input].sort((a, b) => a.cursor - b.cursor)) {
    if (t.kind === "open") continue;
    const list = (
      opens.get(key(t, Number(t.executedAt) - Number(t.heldFor))) ?? []
    ).filter((x) => !used.has(x.trade.id));
    if (!list.length) continue;
    if (
      list.some(
        (x) =>
          x.trade.price !== list[0].trade.price ||
          x.trade.leverage !== list[0].trade.leverage,
      )
    )
      continue;
    const o = list[0].trade;
    pairs.set(t.id, o);
    used.add(o.id);
  }
  return pairs;
}
export const rounded = (num: bigint, den: bigint, places: number) =>
  Number((num * 10n ** BigInt(places) + den / 2n) / den) / 10 ** places;
export function delta(values: number[]) {
  return values.map((v, i) => (i ? v - values[i - 1] : v)).join(",");
}
export function calculate(
  exit: Trade,
  open: Trade | undefined,
  samples: Sample[],
  covered: (a: Sample, end: number) => boolean | "pending",
  now = Math.floor(Date.now() / 1000),
): Calculation {
  if (!open) return { status: "unmatched" };
  const t0 = Number(open.executedAt),
    te = Number(exit.executedAt),
    held = Number(exit.heldFor),
    tx = t0 + 86400;
  const P0 = BigInt(open.price),
    PE = BigInt(exit.price),
    m = BigInt(open.margin),
    L = open.leverage,
    side = open.side === "long" ? 0 : 1,
    s = side === 0 ? 1 : -1;
  let lo = 0,
    hi = samples.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].publish_ts <= t0) lo = mid + 1;
    else hi = mid;
  }
  const baseline = samples[lo - 1];
  if (!baseline) return { status: "noRecord", oid: open.id };
  const D0 = BigInt(baseline.price),
    limit = exit.kind === "close" ? Math.min(te, tx) : Math.min(tx, te + 3600);
  let hit: Sample | undefined, decision: ReturnType<typeof split> | undefined;
  const path: { t: number; n: bigint; den: bigint }[] = [
    { t: 0, n: P0, den: 1n },
  ];
  for (let i = lo; i < samples.length; i++) {
    const v = samples[i];
    if (
      v.publish_ts > limit ||
      (exit.kind === "close" && v.publish_ts === limit)
    )
      break;
    const result = split({
      side,
      lev: L,
      m,
      k: 10,
      eBps: 700,
      p0: D0,
      p: BigInt(v.price),
    });
    path.push({ t: v.publish_ts - t0, n: P0 * BigInt(v.price), den: D0 });
    if (result.line) {
      hit = v;
      decision = result;
      break;
    }
  }
  let end: number;
  if (hit) {
    end = hit.publish_ts;
  } else if (exit.kind === "close" && te <= tx) {
    end = te;
    decision = split({ side, lev: L, m, k: 10, eBps: 700, p0: P0, p: PE });
    path.push({ t: held, n: PE, den: 1n });
  } else {
    const through = Math.min(now, tx, te + 3600);
    const coverage = covered(baseline, through);
    if (coverage === "pending") return { status: "pending", oid: open.id };
    if (!coverage) return { status: "noRecord", oid: open.id };
    return {
      status:
        now < Math.min(tx, te + 3600)
          ? "pending"
          : tx <= te + 3600
            ? "expired"
            : "unresolved",
      oid: open.id,
    };
  }
  const coverage = covered(baseline, end);
  if (coverage === "pending") return { status: "pending", oid: open.id };
  if (!coverage) return { status: "noRecord", oid: open.id };
  const result = decision!,
    c = result.line === "TraderLine" ? -1 : result.line === "HouseLine" ? 1 : 0,
    d = end - t0,
    dp = exit.market === "SOL" ? 4 : exit.market === "BTC" ? 2 : 3;
  let selected = path;
  if (path.length > 300) {
    const indices = new Set<number>([0, path.length - 1]);
    for (let i = 0; i < 300; i++)
      indices.add(Math.floor((i * (path.length - 1)) / 299));
    selected = [...indices].sort((a, b) => a - b).map((i) => path[i]);
  }
  const q = selected.map((p) =>
    Number(
      (p.n * 10n ** BigInt(dp) + p.den * 500000000000n) /
        (p.den * 1000000000000n),
    ),
  );
  const row = {
    te,
    mk: exit.market,
    s,
    m: rounded(m, 1000000n, 2),
    L,
    held,
    yk: exit.kind === "close" ? 1 : 2,
    yr: rounded(
      BigInt(exit.amount ?? "0") + BigInt(exit.queued ?? "0"),
      1000000n,
      2,
    ),
    yp0: Number(P0) / 1e12,
    ype: Number(PE) / 1e12,
    p0: Number(P0) / 1e12,
    c,
    d,
    f: rounded(result.fE9, 1000000000n, 5),
    A: rounded(result.a, 1000000n, 2),
    B: rounded(result.b, 1000000n, 2),
    dp,
    ts: delta(selected.map((x) => x.t)),
    q: delta(q),
    id: exit.id,
    oid: open.id,
    src: "doves",
  };
  let window: any;
  if (exit.market === "SOL" && L === 1000 && c !== 0 && d >= 2) {
    const cents: number[] = [];
    let j = 0,
      peak = 0;
    for (let sec = 0; sec <= d; sec++) {
      while (j + 1 < path.length && path[j + 1].t <= sec) j++;
      const point = path[j];
      cents.push(
        Number(
          (point.n * 100n + point.den * 500000000000n) /
            (point.den * 1000000000000n),
        ),
      );
      peak = Math.max(
        peak,
        s * L * (Number(point.n) / Number(point.den) / Number(P0) - 1),
      );
    }
    window = {
      t0,
      s,
      m: row.m,
      d,
      h: c === 1 ? 1 : 0,
      c: delta(cents),
      pk: c === 1 ? 10 : Math.round(Math.min(10, peak) * 100) / 100,
    };
  }
  return { status: "rows", row, window, oid: open.id };
}
const RUIN_MARKETS = ["SOL", "BTC", "ETH"] as const;
const RUIN_DP: Record<string, number> = { SOL: 4, BTC: 2, ETH: 3 };
/**
 * Path of a settled ruin table: the fill value, the recorded publications strictly
 * between fill and end, and the settling value. Times are seconds after the fill
 * publication; prices are raw 10^-8 values rounded to `dp` places. Paths longer
 * than 300 points keep both ends and evenly spaced points, as for YOLO rows.
 */
export function ruinPath(
  row: {
    market: string;
    p0: string;
    pEnd: string;
    fillPublishTs: string;
    endPublishTs: string;
  },
  samples: { publish_ts: number; price: string }[],
) {
  const market = RUIN_MARKETS[Number(row.market)];
  if (!market) throw new Error("Settlement market is unknown");
  const dp = RUIN_DP[market],
    t0 = BigInt(row.fillPublishTs),
    t1 = BigInt(row.endPublishTs);
  let points = [{ t: 0n, p: BigInt(row.p0) }];
  for (const s of samples) {
    const t = BigInt(s.publish_ts);
    if (t > t0 && t < t1) points.push({ t: t - t0, p: BigInt(s.price) });
  }
  points.push({ t: t1 - t0, p: BigInt(row.pEnd) });
  if (points.length > 300) {
    const indices = new Set<number>([0, points.length - 1]);
    for (let i = 0; i < 300; i++)
      indices.add(Math.floor((i * (points.length - 1)) / 299));
    points = [...indices].sort((a, b) => a - b).map((i) => points[i]);
  }
  const unit = 10n ** BigInt(dp);
  return {
    dp,
    ts: delta(points.map((x) => Number(x.t))),
    q: delta(points.map((x) => Number((x.p * unit + 50000000n) / 100000000n))),
  };
}
