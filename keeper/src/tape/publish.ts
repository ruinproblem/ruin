import { resolve } from "node:path";
import { Store } from "../common/sqlite.js";
import { RpcFault, RpcPool } from "../common/rpc.js";
import { json } from "../common/env.js";
import { MARKETS } from "../common/oracle.js";
import { calculate, pairTrades, ruinPath, type Sample } from "./calculate.js";
import { log, safeError } from "../common/log.js";
import { atomicFile } from "./http.js";
import { YoloReader, type Trade } from "./yolo.js";
import { RUIN_PROGRAM_ADDRESS } from "../../../program/client/index.js";
export class Publisher {
  private lastBody = "";
  private lastCursor = "";
  private lastTapeMs = 0;
  private lastWindowMs = 0;
  private windowJob?: Promise<void>;
  /** Slots of the current window signatures; an answered signature is not asked again. */
  private slots = new Map<string, number>();
  /** Bounds a status lookup that never settles; the pool's own deadlines end well before. */
  windowTimeoutMs = 30000;
  private ruinPaths = new Map<string, ReturnType<typeof ruinPath> | null>();
  constructor(
    readonly store: Store,
    readonly dir: string,
    readonly yolo: YoloReader,
    readonly sourceRpc: RpcPool,
    readonly ruinRpc: RpcPool,
    readonly state?: () => unknown,
    readonly http?: () => unknown,
  ) {}
  /** Settled rows do not change, so each path is computed once per signature and event index. */
  ruinRow(sig: string, index: number, row: any) {
    const key = `${sig}:${index}`;
    if (!this.ruinPaths.has(key)) {
      let path: ReturnType<typeof ruinPath> | null = null;
      try {
        const samples = this.store.db
          .prepare(
            "SELECT publish_ts,price FROM doves WHERE market=? AND publish_ts>? AND publish_ts<? ORDER BY publish_ts,slot,id",
          )
          .all(
            MARKETS[Number(row.market)] ?? "",
            Number(row.fillPublishTs),
            Number(row.endPublishTs),
          ) as { publish_ts: number; price: string }[];
        path = ruinPath(row, samples);
      } catch (e) {
        log({ event: "state-error", error: safeError(e) });
      }
      this.ruinPaths.set(key, path);
    }
    const path = this.ruinPaths.get(key);
    return path ? { ...row, ...path } : row;
  }
  covered(market: string, baseline: Sample, end: number) {
    const first = this.store.db
      .prepare("SELECT MIN(start_ms) a,MAX(end_ms) b FROM coverage")
      .get() as any;
    if (first.a === null || baseline.publish_ts < Math.floor(first.a / 1000))
      return false;
    const gaps = this.store.db
      .prepare(
        "SELECT a,b FROM gaps WHERE market=? AND a<? AND (b IS NULL OR b>?)",
      )
      .all(market, end, baseline.publish_ts) as any[];
    if (gaps.length) return false;
    if (end * 1000 > first.b) return "pending" as const;
    const publication = this.store.db
      .prepare("SELECT MAX(publish_ts) t FROM doves WHERE market=?")
      .get(market) as any;
    if (publication.t === null || Number(publication.t) < end)
      return "pending" as const;
    return true;
  }
  calculate() {
    const cursor = this.store.get("yolo-cursor");
    if (!cursor) return;
    const pending = this.store.db
      .prepare("SELECT 1 FROM results WHERE status='pending' LIMIT 1")
      .get();
    if (cursor === this.lastCursor && !pending) return;
    const firstPass = this.lastCursor === "";
    this.lastCursor = cursor;
    const trades = (
      this.store.db
        .prepare("SELECT cursor,raw FROM trades ORDER BY cursor")
        .all() as any[]
    ).map((r) => ({ cursor: r.cursor, trade: JSON.parse(r.raw) as Trade }));
    const pairs = pairTrades(trades),
      samples = new Map<string, Sample[]>();
    for (const market of MARKETS)
      samples.set(
        market,
        this.store.db
          .prepare(
            "SELECT * FROM doves WHERE market=? ORDER BY publish_ts,slot,id",
          )
          .all(market) as Sample[],
      );
    const existing = new Map(
      (
        this.store.db.prepare("SELECT id,status FROM results").all() as any[]
      ).map((x) => [x.id, x.status]),
    );
    const put = this.store.db.prepare(
      "INSERT INTO results VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,oid=excluded.oid,row=excluded.row,window=excluded.window",
    );
    this.store.db.exec("BEGIN");
    try {
      for (const { trade: t } of trades) {
        if (t.kind === "open") continue;
        if (
          existing.has(t.id) &&
          existing.get(t.id) !== "pending" &&
          !(firstPass && existing.get(t.id) === "rows")
        )
          continue;
        const result = calculate(
          t,
          pairs.get(t.id),
          samples.get(t.market) ?? [],
          (a, end) => this.covered(t.market, a, end),
        );
        put.run(
          t.id,
          Number(t.executedAt),
          result.status,
          result.oid ?? null,
          result.row ? json(result.row) : null,
          result.window ? json(result.window) : null,
        );
      }
      this.store.db.exec("COMMIT");
    } catch (e) {
      this.store.db.exec("ROLLBACK");
      throw e;
    }
  }
  publish(now = Math.floor(Date.now() / 1000)) {
    const rows = (
      this.store.db
        .prepare(
          "SELECT row FROM results WHERE status='rows' AND te>=? ORDER BY te,id",
        )
        .all(now - 3600) as any[]
    ).map((x) => JSON.parse(x.row));
    const ruinRows = this.store.db
        .prepare(
          "SELECT sig,event_index,row FROM ruin ORDER BY end_slot DESC LIMIT 100",
        )
        .all() as any[],
      ruin = ruinRows.map((x) =>
        this.ruinRow(x.sig, Number(x.event_index), JSON.parse(x.row)),
      ),
      keep = new Set(ruinRows.map((x) => `${x.sig}:${x.event_index}`));
    for (const key of this.ruinPaths.keys())
      if (!keep.has(key)) this.ruinPaths.delete(key);
    const refunds = (this.store.db.prepare("SELECT row FROM refunds ORDER BY slot DESC LIMIT 100").all() as any[]).map((x) => JSON.parse(x.row));
    const body = json({ rows, ruin, refunds });
    if (
      (body !== this.lastBody || !this.lastTapeMs) &&
      Date.now() - this.lastTapeMs >= 2000
    ) {
      atomicFile(this.dir, "tape.json", {
        v: 1,
        generated: now,
        k: 10,
        e_bps: 700,
        span: 3600,
        w0: now - 3600,
        rows,
        ruin,
        refunds,
      });
      this.lastBody = body;
      this.lastTapeMs = Date.now();
    }
    if (!this.windowJob && Date.now() - this.lastWindowMs >= 60000) {
      this.lastWindowMs = Date.now();
      this.windowJob = this.publishWindow(now)
        .catch((e) => log({ event: "publish-error", error: safeError(e) }))
        .finally(() => (this.windowJob = undefined));
    }
    return this.windowJob;
  }
  /** Each bet carries its YOLO open's signature, price and slot; a bet missing any of them is left out of that round. */
  async publishWindow(now = Math.floor(Date.now() / 1000)) {
    const bets = (
      this.store.db
        .prepare(
          "SELECT window,raw FROM (SELECT r.window,r.te,r.id,t.raw FROM results r LEFT JOIN trades t ON t.id=r.oid WHERE r.window IS NOT NULL ORDER BY r.te DESC,r.id DESC LIMIT 200) ORDER BY te,id",
        )
        .all() as any[]
    ).flatMap((x) => {
      const open = x.raw ? (JSON.parse(x.raw) as Trade) : null;
      if (
        !open ||
        typeof open.signature !== "string" ||
        !open.signature ||
        !/^\d+$/.test(open.price)
      )
        return [];
      return [
        {
          ...JSON.parse(x.window),
          sig: open.signature,
          p: Number(BigInt(open.price) / 10000n),
        },
      ];
    });
    const current = new Set(bets.map((b) => b.sig as string));
    for (const sig of this.slots.keys())
      if (!current.has(sig)) this.slots.delete(sig);
    const asked = [...current].filter((sig) => !this.slots.has(sig));
    try {
      for (let i = 0; i < asked.length; i += 256)
        await this.askSlots(asked.slice(i, i + 256));
    } catch (e) {
      log({ event: "window-error", error: safeError(e) });
    }
    atomicFile(this.dir, "window.json", {
      v: 1,
      generated: now,
      src: "doves",
      bets: bets.flatMap((b) =>
        this.slots.has(b.sig) ? [{ ...b, slot: this.slots.get(b.sig) }] : [],
      ),
    });
  }
  private async askSlots(sigs: string[]) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        this.sourceRpc.call<{ value: any[] }>("getSignatureStatuses", [
          sigs,
          { searchTransactionHistory: true },
        ]),
        new Promise<never>((_, no) => {
          timer = setTimeout(
            () => no(new RpcFault("getSignatureStatuses")),
            this.windowTimeoutMs,
          );
        }),
      ]);
      sigs.forEach((sig, i) => {
        const status = Array.isArray(result?.value) ? result.value[i] : null;
        if (
          status &&
          status.err == null &&
          Number.isSafeInteger(status.slot) &&
          status.slot >= 0
        )
          this.slots.set(sig, status.slot);
      });
    } finally {
      clearTimeout(timer);
    }
  }
  status(now = Math.floor(Date.now() / 1000)) {
    const doves: Record<string, unknown> = {};
    for (const market of MARKETS) {
      const row = this.store.db
        .prepare("SELECT * FROM doves WHERE market=? ORDER BY id DESC LIMIT 1")
        .get(market) as any;
      if (row)
        doves[market] = {
          slot: row.slot,
          publishTs: row.publish_ts,
          price: row.price,
          recvAgeMs: Date.now() - row.recv_ms,
          coveredSince:
            (
              this.store.db
                .prepare("SELECT MAX(start_ms) a FROM coverage")
                .get() as any
            ).a ?? null,
        };
    }
    const counts1h: Record<string, number> = {
      exits: 0,
      rows: 0,
      pending: 0,
      unmatched: 0,
      noRecord: 0,
      unresolved: 0,
      expired: 0,
    };
    for (const row of this.store.db
      .prepare(
        "SELECT COALESCE(r.status,'pending') status,COUNT(*) n FROM trades t LEFT JOIN results r ON t.id=r.id WHERE t.kind<>'open' AND t.executed_at>=? GROUP BY COALESCE(r.status,'pending')",
      )
      .all(now - 3600) as any[]) {
      counts1h[row.status] = row.n;
      counts1h.exits += row.n;
    }
    const methods: Record<string, number> = {
      ...this.sourceRpc.metrics.snapshot().methods,
    };
    for (const [k, v] of Object.entries(
      this.ruinRpc.metrics.snapshot().methods,
    ))
      methods[k] = (methods[k] ?? 0) + v;
    const lastExecutedAt = Number(
      (
        this.store.db
          .prepare("SELECT MAX(executed_at) t FROM trades")
          .get() as any
      ).t ?? 0,
    );
    const value = {
      v: 1,
      generated: now,
      cluster: this.ruinRpc.cluster,
      program: RUIN_PROGRAM_ADDRESS,
      doves,
      yolo: {
        cursor: Number(this.store.get("yolo-cursor") ?? 0),
        lastExecutedAt,
        lastPollAgeMs: this.yolo.lastPollMs
          ? Date.now() - this.yolo.lastPollMs
          : null,
        lagSecs: lastExecutedAt ? now - lastExecutedAt : null,
      },
      ruin: {
        lastSig: this.store.get("ruin-last-sig") ?? null,
        lastSlot: Number(this.store.get("ruin-last-slot") ?? 0),
      },
      state: this.stateStatus(),
      http: this.http?.() ?? null,
      counts1h,
      rpc1h: methods,
    };
    atomicFile(this.dir, "status.json", value);
    return value;
  }
  private stateStatus() {
    if (!this.state) return null;
    try {
      return this.state();
    } catch (e) {
      log({ event: "state-error", error: safeError(e) });
      return null;
    }
  }
  prune() {
    const cutoff = Math.floor(Date.now() / 1000) - 80 * 3600;
    this.store.db.prepare("DELETE FROM doves WHERE publish_ts<?").run(cutoff);
    this.store.db.prepare("DELETE FROM trades WHERE executed_at<?").run(cutoff);
    this.store.db.prepare("DELETE FROM results WHERE te<?").run(cutoff);
  }
}
