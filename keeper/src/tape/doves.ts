import { randomUUID } from "node:crypto";
import { FEEDS } from "../../../program/client/constants.js";
import { MARKETS } from "../common/oracle.js";
import { RpcPool } from "../common/rpc.js";
import { Store } from "../common/sqlite.js";
import { json, sleep } from "../common/env.js";
import { log } from "../common/log.js";
import { decodeDovesTransaction, type DovesUpdate } from "./doves-tx.js";

type Cursor = { sig: string; slot: number; at: number; end: number };
type DecodeGap = { pending: Record<string, number>; afterSlot: number };
export class DovesRecorder {
  private readonly connection = randomUUID();
  private readonly started = Date.now();
  private readonly cursors = new Map<string, Cursor>();
  private readonly latest = new Map<string, any>();
  private readonly decoded = new Map<string, DovesUpdate[]>();
  private readonly decodeFailures = new Map<string, { round: number; count: number }>();
  private readonly skipped = new Set<string>();
  private readonly decodeGaps = new Map<string, DecodeGap>();
  private readonly listFailures = new Map<string, number>();
  private round = 0;
  private coverageId?: number;
  private stopped = false;
  private polling = false;
  constructor(readonly store: Store, readonly rpc: RpcPool) {
    const coverage = store.db.prepare("SELECT id,end_ms FROM coverage ORDER BY id DESC LIMIT 1").get() as any;
    this.coverageId = coverage?.id;
    for (const market of MARKETS) {
      const row = store.db.prepare("SELECT * FROM doves WHERE market=? ORDER BY publish_ts DESC,slot DESC,id DESC LIMIT 1").get(market) as any;
      if (row) this.latest.set(market, row);
      const decode = store.get(`doves-decode:${market}`);
      if (decode) this.decodeGaps.set(market, JSON.parse(decode));
      const raw = store.get(`doves-cursor:${market}`);
      if (raw) {
        const cursor: Cursor = JSON.parse(raw);
        if (this.started - cursor.at <= 21600000) this.cursors.set(market, cursor);
        else this.gap(market, "process-start");
      } else if (row) this.gap(market, "process-start");
      if (!this.cursors.has(market)) this.abandonDecodeHistory(market);
    }
  }
  private gap(market: string, reason: string) {
    if (this.store.db.prepare("SELECT 1 FROM gaps WHERE market=? AND reason=? AND b IS NULL").get(market, reason)) return;
    const cursor = this.cursors.get(market), value = this.latest.get(market);
    this.store.db.prepare("INSERT INTO gaps(market,a,reason,start_ms) VALUES(?,?,?,?)")
      .run(market, value?.publish_ts ?? 0, reason, cursor?.end ?? Date.now());
  }
  private saveDecodeGap(market: string, value: DecodeGap) {
    this.decodeGaps.set(market, value);
    this.store.set(`doves-decode:${market}`, json(value));
  }
  private resetCursor(market: string) {
    this.gap(market, "process-start");
    this.abandonDecodeHistory(market);
    this.cursors.delete(market);
    this.store.db.prepare("DELETE FROM kv WHERE key=?").run(`doves-cursor:${market}`);
    this.listFailures.delete(market);
    log({ event: "doves-cursor-reset", market, reason: "listing-failures", consecutive: 10 });
  }
  private abandonDecodeHistory(market: string) {
    const decode = this.decodeGaps.get(market);
    if (decode) this.saveDecodeGap(market, {
      pending: {}, afterSlot: Math.max(decode.afterSlot, ...Object.values(decode.pending)),
    });
  }
  private closeGaps(market: string, end: number) {
    const value = this.latest.get(market);
    if (!value) return;
    this.store.db.prepare("UPDATE gaps SET b=?,end_ms=? WHERE market=? AND b IS NULL AND reason='listing'")
      .run(value.publish_ts, end, market);
    this.store.db.prepare("UPDATE gaps SET b=?,end_ms=? WHERE market=? AND b IS NULL AND reason='process-start' AND a<?")
      .run(value.publish_ts, end, market, value.publish_ts);
    const decode = this.decodeGaps.get(market);
    if (decode && !Object.keys(decode.pending).length && value.slot > decode.afterSlot) {
      this.store.db.prepare("UPDATE gaps SET b=?,end_ms=? WHERE market=? AND b IS NULL AND reason='decode'")
        .run(value.publish_ts, end, market);
      this.decodeGaps.delete(market);
      this.store.db.prepare("DELETE FROM kv WHERE key=?").run(`doves-decode:${market}`);
    }
  }
  sample(update: DovesUpdate) {
    const old = this.latest.get(update.market);
    const result = this.store.db.prepare("INSERT OR IGNORE INTO doves(market,publish_ts,price,slot,recv_ms,connection) VALUES(?,?,?,?,?,?)")
      .run(update.market, update.publish_ts, update.price, update.slot, update.recv_ms, this.connection);
    if (Number(result.changes)) this.store.db.prepare("INSERT OR REPLACE INTO doves_arrivals VALUES(?,?)").run(result.lastInsertRowid, Date.now());
    // Independent address listings may discover an older transaction in a later poll.
    // Keep its history without moving the current-value cursor backwards.
    if (old && update.publish_ts < old.publish_ts) return;
    if (old && update.publish_ts - old.publish_ts > 10)
      this.store.db.prepare("INSERT INTO gaps(market,a,b,reason,start_ms,end_ms) VALUES(?,?,?,?,?,?)")
        .run(update.market, old.publish_ts, update.publish_ts, "publication-gap", old.recv_ms, update.recv_ms);
    this.latest.set(update.market, update);
  }
  private async list(feed: string, market: string, requested: number) {
    const cursor = this.cursors.get(market), rows: any[] = [];
    let before: string | undefined;
    for (;;) {
      const batch: any[] = await this.rpc.call("getSignaturesForAddress", [feed, {
        commitment: "confirmed", limit: 1000, ...(cursor ? { until: cursor.sig } : {}), ...(before ? { before } : {}),
      }]);
      if (cursor && batch.some((row) => row.slot < cursor.slot)) throw new Error("Oracle cursor not reached");
      rows.push(...batch.filter((row) => row.signature !== cursor?.sig));
      if (batch.length < 1000 || !cursor) break;
      const next = batch.at(-1)?.signature;
      if (!next || next === before) throw new Error("Oracle listing did not advance");
      before = next;
    }
    // The first read establishes a current baseline rather than replaying old history.
    const relevant = cursor ? rows : rows.filter((row) => Number(row.blockTime) * 1000 >= requested - 15000);
    return { market, requested, head: rows[0], rows: relevant };
  }
  async poll() {
    if (this.polling || this.stopped) return;
    this.polling = true;
    const round = ++this.round;
    try {
      const listings: Awaited<ReturnType<DovesRecorder["list"]>>[] = [];
      for (let i = 0; i < FEEDS.length; i++) {
        const market = MARKETS[i]!, requested = Date.now();
        try {
          listings.push(await this.list(FEEDS[i]!, market, requested));
          this.listFailures.delete(market);
        }
        catch {
          this.gap(market, "listing");
          if (this.cursors.has(market)) {
            const count = (this.listFailures.get(market) ?? 0) + 1;
            this.listFailures.set(market, count);
            if (count >= 10) this.resetCursor(market);
          }
          log({ event: "doves-list-error", market });
        }
      }
      const union = new Map<string, any>();
      for (const list of listings) for (const row of list.rows) if (row.err === null) union.set(row.signature, row);
      const failures = new Map<string, "listing" | "decode">();
      for (const row of [...union.values()].sort((a, b) => a.slot - b.slot)) {
        if (this.stopped) return;
        if (this.skipped.has(row.signature)) continue;
        let decoded = this.decoded.get(row.signature);
        if (!decoded) {
          let tx: any;
          try {
            tx = await this.rpc.call("getTransaction", [row.signature, { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "confirmed" }]);
            if (!tx) throw new Error("Oracle transaction unavailable");
          } catch { failures.set(row.signature, "listing"); continue; }
          try { decoded = decodeDovesTransaction(tx); }
          catch {
            const previous = this.decodeFailures.get(row.signature);
            const count = previous?.round === round - 1 ? previous.count + 1 : 1;
            this.decodeFailures.set(row.signature, { round, count });
            if (count >= 2) {
              this.skipped.add(row.signature);
              log({ event: "doves-decode-skipped", signature: row.signature, slot: row.slot, consecutive: count });
            } else failures.set(row.signature, "decode");
            continue;
          }
          this.decoded.set(row.signature, decoded);
          this.decodeFailures.delete(row.signature);
        }
      }
      for (const list of listings) {
        for (const row of list.rows) {
          if (row.err !== null) continue;
          const failure = failures.get(row.signature), skipped = this.skipped.has(row.signature);
          let decode = this.decodeGaps.get(list.market);
          if (failure === "decode" || skipped) {
            this.gap(list.market, "decode");
            decode ??= { pending: {}, afterSlot: -1 };
            if (skipped) {
              delete decode.pending[row.signature];
              decode.afterSlot = Math.max(decode.afterSlot, row.slot);
            } else decode.pending[row.signature] = row.slot;
          } else if (this.decoded.has(row.signature) && decode) delete decode.pending[row.signature];
          if (decode) this.saveDecodeGap(list.market, decode);
          if (failure === "listing") this.gap(list.market, "listing");
        }
        // A market's history follows only its own confirmed address listing.
        const updates = list.rows.flatMap(row => this.decoded.get(row.signature) ?? [])
          .filter(row => row.market === list.market);
        updates.sort((a, b) => a.slot - b.slot || a.publish_ts - b.publish_ts).forEach(row => this.sample(row));
        const failure = list.rows.map((row) => failures.get(row.signature)).find(Boolean);
        if (failure) { this.gap(list.market, failure); continue; }
        const previous = this.cursors.get(list.market), head = list.head;
        if (!head && !previous) continue;
        const cursor: Cursor = { sig: head?.signature ?? previous!.sig, slot: head?.slot ?? previous!.slot,
          at: head?.blockTime ? head.blockTime * 1000 : previous?.at ?? list.requested, end: list.requested - 5000 };
        this.cursors.set(list.market, cursor);
        this.store.set(`doves-cursor:${list.market}`, json(cursor));
        this.closeGaps(list.market, cursor.end);
      }
      if (this.cursors.size === 3) {
        const end = Math.min(...[...this.cursors.values()].map((x) => x.end));
        if (this.coverageId === undefined) {
          const result = this.store.db.prepare("INSERT INTO coverage(connection,start_ms,end_ms) VALUES(?,?,?)").run(this.connection, Math.min(this.started, end), end);
          this.coverageId = Number(result.lastInsertRowid);
        } else this.store.db.prepare("UPDATE coverage SET end_ms=MAX(end_ms,?) WHERE id=?").run(end, this.coverageId);
      }
      if (this.decoded.size > 10000) {
        const needed = new Set(listings.flatMap((list) => list.rows.map((row) => row.signature)));
        for (const key of this.decoded.keys()) if (!needed.has(key)) this.decoded.delete(key);
      }
    } finally { this.polling = false; }
  }
  start() {
    void (async () => {
      while (!this.stopped) {
        const at = Date.now();
        try { await this.poll(); } catch { log({ event: "doves-read-error" }); }
        await sleep(Math.max(0, 3000 - (Date.now() - at)));
      }
    })();
  }
  close() { this.stopped = true; }
}
