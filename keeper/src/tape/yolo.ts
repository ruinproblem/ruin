import { Store } from "../common/sqlite.js";
import { sleep, json } from "../common/env.js";
import { log } from "../common/log.js";
export type Trade = {
  id: string;
  signature: string;
  kind: "open" | "close" | "liquidate";
  market: string;
  owner: string;
  side: "long" | "short";
  margin: string;
  notional: string;
  leverage: number;
  price: string;
  executedAt: string;
  amount: string;
  queued: string;
  heldFor: string | number | null;
};
function validApiTrade(t: any): t is Trade {
  return (
    !!t &&
    typeof t.id === "string" &&
    typeof t.owner === "string" &&
    t.owner.length > 0 &&
    ["open", "close", "liquidate"].includes(t.kind) &&
    typeof t.market === "string" && t.market.length > 0 &&
    ["long", "short"].includes(t.side) &&
    [t.margin, t.price, t.executedAt, t.amount, t.queued].every(
      (v) => typeof v === "string" && /^\d+$/.test(v),
    ) &&
    BigInt(t.price) > 0n &&
    (t.kind === "open"
      ? t.heldFor === null
      : (typeof t.heldFor === "number" ||
          (typeof t.heldFor === "string" && /^\d+$/.test(t.heldFor))) &&
        Number.isSafeInteger(Number(t.heldFor)) &&
        Number(t.heldFor) >= 0) &&
    Number.isInteger(t.leverage) &&
    t.leverage >= 500 &&
    t.leverage <= 1000
  );
}
export function validTrade(t: any): t is Trade {
  return validApiTrade(t) && ["SOL", "BTC", "ETH"].includes(t.market);
}
export class YoloReader {
  stopped = false;
  lastPollMs = 0;
  lastExecutedAt = 0;
  calls = 0;
  constructor(
    readonly store: Store,
    private api = process.env.YOLO_API || "https://yolo-api.jup.ag",
  ) {}
  async page(after?: number) {
    this.calls++;
    const response = await fetch(
      `${this.api}/trades?limit=1000${after === undefined ? "" : `&after=${after}`}`,
      { signal: AbortSignal.timeout(15000) },
    );
    if (!response.ok) throw new Error(`YOLO HTTP ${response.status}`);
    const body = (await response.json()) as any;
    body.cursor = Number(body.cursor);
    if (
      !Number.isSafeInteger(body.cursor) ||
      !Array.isArray(body.trades) ||
      body.trades.some((t: any) => !validApiTrade(t))
    )
      throw new Error("YOLO response schema changed");
    this.lastPollMs = Date.now();
    return body as { cursor: number; trades: Trade[] };
  }
  private save(page: { cursor: number; trades: Trade[] }) {
    const put = this.store.db.prepare(
      "INSERT OR IGNORE INTO trades VALUES(?,?,?,?,?)",
    );
    this.store.db.exec("BEGIN");
    try {
      page.trades.forEach((t, i) => {
        // Preserve the full API page length and cursor offsets for other markets.
        if (!validTrade(t)) return;
        put.run(
          t.id,
          page.cursor - page.trades.length + i,
          Number(t.executedAt),
          t.kind,
          json(t),
        );
        this.lastExecutedAt = Math.max(
          this.lastExecutedAt,
          Number(t.executedAt),
        );
      });
      this.store.db.exec("COMMIT");
    } catch (e) {
      this.store.db.exec("ROLLBACK");
      throw e;
    }
  }
  async run() {
    let wait = 1000;
    while (!this.stopped) {
      try {
        if (!this.store.get("yolo-cursor")) {
          const latest = await this.page();
          this.save(latest);
          let before = latest.cursor - latest.trades.length;
          this.store.set("yolo-bootstrap-end", String(latest.cursor));
          while (!this.stopped && before > 0 && latest.trades.length) {
            await sleep(500);
            const after = Math.max(0, before - 1000),
              p = await this.page(after);
            this.save(p);
            before = after;
            if (
              p.trades.length &&
              Number(p.trades[0].executedAt) < Date.now() / 1000 - 80 * 3600
            )
              break;
          }
          this.store.set("yolo-cursor", String(latest.cursor));
          log({
            event: "yolo-bootstrap",
            trades: (
              this.store.db
                .prepare("SELECT COUNT(*) n FROM trades")
                .get() as any
            ).n,
          });
        }
        let page;
        do {
          page = await this.page(Number(this.store.get("yolo-cursor")));
          this.save(page);
          this.store.set("yolo-cursor", String(page.cursor));
          if (page.trades.length === 1000) await sleep(500);
        } while (!this.stopped && page.trades.length === 1000);
        wait = 1000;
        await sleep(3000);
      } catch (e) {
        log({
          event: "yolo-error",
          error:
            e instanceof Error &&
            /^YOLO (HTTP \d{3}|response schema changed)$/.test(e.message)
              ? e.message
              : "YOLO transport unavailable",
          retryMs: wait,
        });
        await sleep(wait);
        wait = Math.min(60000, wait * 2);
      }
    }
  }
}
