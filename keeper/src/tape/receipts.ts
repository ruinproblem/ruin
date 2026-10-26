import { address, getBase58Encoder } from "@solana/kit";
import {
  decodeEvents,
  RUIN_PROGRAM_ADDRESS,
  getSettleDiscriminatorBytes,
} from "../../../program/client/index.js";
import { RpcPool } from "../common/rpc.js";
import { Store } from "../common/sqlite.js";
import { json, sleep } from "../common/env.js";
import { log, safeError } from "../common/log.js";
export function transactionEvents(tx: any) {
  if (!tx?.meta || tx.meta.err !== null) return [];
  const keys = [
    ...tx.transaction.message.accountKeys,
    ...(tx.meta.loadedAddresses?.writable ?? []),
    ...(tx.meta.loadedAddresses?.readonly ?? []),
  ].map((k) => (typeof k === "string" ? k : k.pubkey));
  const events: any[] = [];
  for (const g of tx.meta.innerInstructions ?? [])
    for (const ix of g.instructions) {
      if (keys[ix.programIdIndex] !== RUIN_PROGRAM_ADDRESS) continue;
      try {
        events.push(
          ...decodeEvents([
            { programAddress: address(keys[ix.programIdIndex]), data: ix.data },
          ]),
        );
      } catch {
        /* Other development events are outside the public event schema. */
      }
    }
  return events;
}
export function settleFeed(tx: any, table: string) {
  const keys = [
    ...tx.transaction.message.accountKeys,
    ...(tx.meta.loadedAddresses?.writable ?? []),
    ...(tx.meta.loadedAddresses?.readonly ?? []),
  ].map((k) => (typeof k === "string" ? k : k.pubkey));
  const instructions = [
    ...tx.transaction.message.instructions,
    ...(tx.meta.innerInstructions ?? []).flatMap((g: any) => g.instructions),
  ];
  for (const ix of instructions) {
    if (keys[ix.programIdIndex] !== RUIN_PROGRAM_ADDRESS) continue;
    const d = Buffer.from(getBase58Encoder().encode(ix.data));
    if (
      d.subarray(0, 8).equals(Buffer.from(getSettleDiscriminatorBytes())) &&
      keys[ix.accounts[2]] === table
    )
      return keys[ix.accounts[8]];
  }
  throw new Error("Settlement feed account missing");
}
export type Recent = { sig: string; slot: number; err: unknown; fail?: { from: string; code?: number; name?: string } };
export function transactionFailure(tx: any, program = RUIN_PROGRAM_ADDRESS as string): Recent["fail"] {
  const logs: string[] = tx?.meta?.logMessages ?? [];
  const from = logs.map((line) => /^Program (\S+) failed/.exec(line)?.[1]).find(Boolean);
  if (!from) return undefined;
  if (from !== program) return { from };
  const match = /Error Code: (\w+)\. Error Number: (\d+)/.exec(logs.join("\n"));
  return match ? { from, name: match[1], code: Number(match[2]) } : { from };
}
export class ReceiptReader {
  stopped = false;
  listedAt = 0;
  readonly recent = new Map<string, Recent>();
  private queue: any[] = [];
  private queued = new Set<string>();
  private listing = false;
  private draining = false;
  constructor(
    readonly store: Store,
    readonly rpc: RpcPool,
  ) {
    const max = Number((store.db.prepare("SELECT MAX(slot) n FROM transactions").get() as any)?.n ?? 0);
    for (const row of store.db.prepare("SELECT sig,slot,raw FROM transactions WHERE slot>=? ORDER BY slot").all(max - 600) as any[]) {
      const tx = JSON.parse(row.raw);
      this.recent.set(row.sig, { sig: row.sig, slot: row.slot, err: tx.meta?.err ?? null, ...(tx.meta?.err ? { fail: transactionFailure(tx) } : {}) });
    }
    if (!store.db.prepare("SELECT 1 FROM refunds LIMIT 1").get()) {
      for (const row of store.db.prepare("SELECT sig,raw FROM transactions ORDER BY slot").all() as any[])
        this.refunds(row.sig, JSON.parse(row.raw));
    }
  }
  private refunds(sig: string, tx: any) {
    transactionEvents(tx).forEach((event, index) => {
      if (event.name !== "OpenRefunded") return;
      const d = event.data, house = this.store.db.prepare("SELECT id FROM houses WHERE address=?").get(d.house) as any;
      if (!house) throw new Error("Refund house has no creation event");
      this.store.db.prepare("INSERT OR IGNORE INTO refunds VALUES(?,?,?,?)").run(sig, index, tx.slot, json({
        table: d.table, house: d.house, seq: String(d.seq), trader: d.trader, m: String(d.m), slot: String(tx.slot), sig, houseId: house.id,
      }));
    });
  }
  recentRows(slot: number) {
    const newest = Math.max(slot, ...[...this.recent.values()].map((x) => x.slot));
    for (const [sig, row] of this.recent) if (row.slot < newest - 600) this.recent.delete(sig);
    return [...this.recent.values()].sort((a, b) => b.slot - a.slot);
  }
  ingest(sig: string, tx: any) {
    const events = transactionEvents(tx);
    this.store.db.exec("BEGIN");
    try {
      events.forEach((event, index) => {
        const d = event.data;
        if (event.name === "HousePosted")
          this.store.db
            .prepare("INSERT OR REPLACE INTO houses VALUES(?,?)")
            .run(d.house, String(d.id));
        if (event.name === "Settled") {
          const house = this.store.db
            .prepare("SELECT id FROM houses WHERE address=?")
            .get(d.house) as any;
          if (!house) throw new Error("Settlement house has no creation event");
          const fields = Object.fromEntries(
            Object.entries(d)
              .filter(([k]) => k !== "discriminator")
              .map(([k, v]) => [
                k,
                typeof v === "number" || typeof v === "bigint" ? String(v) : v,
              ]),
          );
          this.store.db
            .prepare("INSERT OR IGNORE INTO ruin VALUES(?,?,?,?)")
            .run(
              sig,
              index,
              Number(d.endSlot),
              json({
                ...fields,
                sig,
                houseId: house.id,
                feed: settleFeed(tx, d.table),
              }),
            );
        }
      });
      this.refunds(sig, tx);
      this.store.db
        .prepare("INSERT OR IGNORE INTO transactions VALUES(?,?,?)")
        .run(sig, tx.slot, json(tx));
      this.store.set("ruin-last-sig", sig);
      this.store.set("ruin-last-slot", String(tx.slot));
      this.store.db.exec("COMMIT");
      this.recent.set(sig, { sig, slot: tx.slot, err: tx.meta?.err ?? null, ...(tx.meta?.err ? { fail: transactionFailure(tx) } : {}) });
    } catch (e) {
      this.store.db.exec("ROLLBACK");
      throw e;
    }
  }
  async poll() {
    if (this.listing || this.stopped) return;
    this.listing = true;
    try {
      const last = this.store.get("ruin-last-sig"), signatures: any[] = [];
      let before: string | undefined;
      for (;;) {
        const batch = await this.rpc.call("getSignaturesForAddress", [RUIN_PROGRAM_ADDRESS, {
          limit: 1000, commitment: "confirmed", ...(last ? { until: last } : {}), ...(before ? { before } : {}),
        }]);
        signatures.push(...batch);
        if (batch.length < 1000) break;
        before = batch.at(-1).signature;
      }
      for (const item of signatures) {
        const old = this.recent.get(item.signature);
        this.recent.set(item.signature, { sig: item.signature, slot: item.slot, err: item.err, ...(old?.fail ? { fail: old.fail } : {}) });
      }
      this.listedAt = Date.now();
      for (const item of signatures.reverse()) {
        if (this.queued.has(item.signature) || this.store.db.prepare("SELECT 1 FROM transactions WHERE sig=?").get(item.signature)) continue;
        this.queued.add(item.signature);
        this.queue.push(item);
      }
    } finally { this.listing = false; }
  }
  async drainOne() {
    if (this.draining || this.stopped || !this.queue.length) return;
    this.draining = true;
    const item = this.queue[0];
    try {
      const tx = await this.rpc.call("getTransaction", [item.signature, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 1 }]);
      if (!tx) throw new Error("Transaction is not yet available");
      this.ingest(item.signature, tx);
      this.queue.shift();
      this.queued.delete(item.signature);
    } finally { this.draining = false; }
  }
  async run() {
    const bodies = async () => {
      while (!this.stopped) {
        try { await this.drainOne(); }
        catch (e) { log({ event: "ruin-body-error", error: safeError(e) }); }
        await sleep(400);
      }
    };
    void bodies();
    while (!this.stopped) {
      const start = Date.now();
      try { await this.poll(); }
      catch (e) { log({ event: "ruin-read-error", error: safeError(e) }); }
      await sleep(Math.max(0, 3000 - (Date.now() - start)));
    }
  }
}
