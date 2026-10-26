import { getBase58Decoder } from "@solana/kit";
import { TABLE_DISCRIMINATOR } from "../../../program/client/index.js";
import { RpcPool } from "../common/rpc.js";
import { Subscriptions } from "../common/ws.js";
import { log, type Logger } from "../common/log.js";

export type OverlayCallbacks = {
  onSlot(slot: bigint): unknown;
  onPrice(market: number, feed: string, raw: any, slot: number): unknown;
  onTable(key: string, raw: any, slot: number): unknown;
  windows(): { target: bigint; end: bigint }[];
  openCount(): number;
  signatures(): string[];
  onStatuses(signatures: string[], statuses: any[]): unknown;
};
const filters = [
  { dataSize: 177 },
  { memcmp: { offset: 0, bytes: getBase58Decoder().decode(TABLE_DISCRIMINATOR) } },
];

/** Independent read schedules also cover silent notification loss. */
export class Overlay {
  readonly counts: Record<string, number> = {};
  wsLoss = 0;
  slot = 0n;
  private timers: ReturnType<typeof setInterval>[] = [];
  private stops: (() => void)[] = [];
  private feedStops: (() => void)[] = [];
  private busy = new Set<string>();
  private observations = new Map<string, { value: string; ws: boolean; at: number; counted: boolean }>();
  private feedAt = 0;
  private stopped = false;
  constructor(
    readonly rpc: RpcPool,
    readonly ws: Subscriptions,
    readonly program: string,
    private feeds: readonly string[],
    readonly callbacks: OverlayCallbacks,
    private logger: Logger = log,
  ) {}
  private observe(key: string, raw: any, source: "ws" | "poll") {
    const value = JSON.stringify(raw?.data ?? null), old = this.observations.get(key);
    if (old?.value === value) {
      if (source === "ws") old.ws = true;
      return;
    }
    // A value may be replaced before the two-second loss deadline.
    if (old && !old.ws && !old.counted) this.pending.push({ key, observation: old });
    this.observations.set(key, { value, ws: source === "ws", at: Date.now(), counted: false });
  }
  private pending: { key: string; observation: { value: string; ws: boolean; at: number; counted: boolean } }[] = [];
  private noteWs(key: string, raw: any) {
    const value = JSON.stringify(raw?.data ?? null);
    for (const p of this.pending) if (p.key === key && p.observation.value === value) p.observation.ws = true;
    this.observe(key, raw, "ws");
  }
  private losses() {
    const now = Date.now();
    for (const [key, observation] of this.observations)
      this.countLoss(key, observation, now);
    this.pending = this.pending.filter(({ key, observation }) => {
      this.countLoss(key, observation, now);
      return now - observation.at < 2000;
    });
  }
  private countLoss(key: string, o: { ws: boolean; at: number; counted: boolean }, now: number) {
    if (!o.ws && !o.counted && now - o.at >= 2000) {
      o.counted = true;
      this.wsLoss++;
      this.logger({ event: "ws-loss", key, count: this.wsLoss });
    }
  }
  private onSlot(slot: number | bigint) {
    if (BigInt(slot) > this.slot) this.slot = BigInt(slot);
    this.callbacks.onSlot(BigInt(slot));
  }
  setFeeds(feeds: readonly string[]) {
    this.feeds = [...feeds];
    this.feedStops.forEach((stop) => stop());
    this.feedStops = feeds.map((feed, market) => this.ws.subscribe("accountSubscribe", [feed, { encoding: "base64", commitment: "processed" }], (v) => {
      this.noteWs(`feed:${feed}`, v.value);
      this.onSlot(v.context.slot);
      void this.callbacks.onPrice(market, feed, v.value, v.context.slot);
    }));
  }
  private async job(name: string, work: () => Promise<void>) {
    if (this.stopped || this.busy.has(name)) return;
    this.busy.add(name);
    try { await work(); }
    catch { this.logger({ event: "overlay-read-error", method: name }); }
    finally { this.busy.delete(name); }
  }
  private call(method: string, params: unknown[], lane?: string) {
    this.counts[method] = (this.counts[method] ?? 0) + 1;
    return this.rpc.call(method, params, "normal", lane);
  }
  pollTables() {
    return this.job("tables", async () => {
      const v = await this.call("getProgramAccounts", [this.program, { encoding: "base64", commitment: "processed", filters, withContext: true }]);
      // Deliver table data before the context slot can cause an action.
      for (const row of v.value) {
        this.observe(`table:${row.pubkey}`, row.account, "poll");
        this.callbacks.onTable(row.pubkey, row.account, v.context.slot);
      }
      this.onSlot(v.context.slot);
    });
  }
  pollFeeds() {
    return this.job("feeds", async () => {
      const feeds = [...this.feeds];
      const v = await this.call("getMultipleAccounts", [feeds, { encoding: "base64", commitment: "processed" }], "overlay-feeds");
      await Promise.all(v.value.map((raw: any, market: number) => {
        this.observe(`feed:${feeds[market]}`, raw, "poll");
        return this.callbacks.onPrice(market, feeds[market]!, raw, v.context.slot);
      }));
      this.onSlot(v.context.slot);
    });
  }
  nearWindow() {
    return this.callbacks.windows().some(({ target, end }) => this.slot >= target - 5n && this.slot <= end);
  }
  pollSlot() {
    if (!this.nearWindow()) return Promise.resolve();
    return this.job("slot", async () => this.onSlot(await this.call("getSlot", [{ commitment: "processed" }], "overlay-slot")));
  }
  pollSignatures() {
    return this.job("signatures", async () => {
      const signatures = this.callbacks.signatures();
      if (!signatures.length) return;
      const v = await this.call("getSignatureStatuses", [signatures]);
      this.callbacks.onStatuses(signatures, v.value);
    });
  }
  start() {
    this.stops.push(this.ws.subscribe("programSubscribe", [this.program, { encoding: "base64", commitment: "processed", filters }], (v) => {
      this.noteWs(`table:${v.value.pubkey}`, v.value.account);
      this.callbacks.onTable(v.value.pubkey, v.value.account, v.context.slot);
      this.onSlot(v.context.slot);
    }));
    this.stops.push(this.ws.subscribe("slotSubscribe", [], (v) => this.onSlot(v.slot)));
    this.setFeeds(this.feeds);
    const repeat = (ms: number, fn: () => unknown) => this.timers.push(setInterval(fn, ms));
    repeat(2000, () => void this.pollTables());
    repeat(100, () => {
      const cadence = this.callbacks.openCount() > 0 ? 400 : 1000;
      if (Date.now() - this.feedAt < cadence || this.busy.has("feeds")) return;
      this.feedAt = Date.now();
      void this.pollFeeds();
    });
    repeat(400, () => void this.pollSlot());
    repeat(1000, () => void this.pollSignatures());
    repeat(100, () => this.losses());
    void this.pollTables();
    this.feedAt = Date.now();
    void this.pollFeeds();
  }
  close() {
    this.stopped = true;
    this.timers.forEach(clearInterval);
    [...this.stops, ...this.feedStops].forEach((stop) => stop());
  }
}
