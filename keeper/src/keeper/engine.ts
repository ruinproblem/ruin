import {
  address,
  getBase58Decoder,
  type Address,
  type TransactionSigner,
  type Instruction,
} from "@solana/kit";
import { findAssociatedTokenPda } from "@solana-program/token";
import * as r from "../../../program/client/index.js";
import { TOKEN } from "../../../program/client/constants.js";
import { RpcPool } from "../common/rpc.js";
import { Subscriptions } from "../common/ws.js";
import { parseFeed, type Price } from "../common/oracle.js";
import { log, type Logger } from "../common/log.js";
import { sleep } from "../common/env.js";
import {
  buildRefund,
  encodedAccount,
  tokenAccount,
  eventAccounts,
} from "./chain.js";
import {
  Sender,
  prepareTransaction,
  type Kind,
  type Prepared,
} from "./sender.js";
import { Overlay } from "./overlay.js";
import { writableAccounts, selectPriorityFee } from "./priority.js";
export const tableFilters = [
  { dataSize: 177 },
  {
    memcmp: {
      offset: 0,
      bytes: getBase58Decoder().decode(r.TABLE_DISCRIMINATOR),
    },
  },
];
export type Entry = {
  address: Address;
  table: r.Table;
  fingerprint: string;
  slot: number;
  target?: bigint;
  closeTarget?: bigint;
  ready: boolean;
  preparing?: boolean;
  building?: boolean;
  jobs: Map<Kind, Prepared>;
  lastAttemptSlot?: bigint;
  nextExpiryMs?: number;
  nonce: bigint;
  failedBlockhash?: string;
  failedSignatures: Set<string>;
};
export function chooseAction(
  t: r.Table,
  price: Price | undefined,
  slot: bigint,
  now: bigint,
  target?: bigint,
  closeTarget?: bigint,
): { kind: Kind; target?: bigint; end?: bigint } | undefined {
  if (t.state === r.TableState.Requested) {
    if (slot > t.requestSlot + BigInt(t.delayMax + t.fillWindow))
      return { kind: "refund" };
    if (
      target !== undefined &&
      slot >= target &&
      slot <= target + BigInt(t.fillWindow)
    )
      return { kind: "fill", target, end: target + BigInt(t.fillWindow) };
    return;
  }
  if (
    price &&
    price.publishTs >= t.fillPublishTs &&
    r.split({
      side: t.side,
      lev: t.lev,
      m: t.m,
      k: t.k,
      eBps: t.eBps,
      p0: t.p0,
      p: price.price,
    }).line
  )
    return { kind: "settle-line" };
  if (
    t.state === r.TableState.CloseRequested &&
    closeTarget !== undefined &&
    slot >= closeTarget &&
    slot <= closeTarget + BigInt(t.closeWindow) &&
    price &&
    price.publishTs > t.closePublishTs
  )
    return {
      kind: "settle-stop",
      target: closeTarget,
      end: closeTarget + BigInt(t.closeWindow),
    };
  if (now >= t.fillTs + BigInt(t.expirySecs)) return { kind: "settle-expiry" };
}
export class Keeper {
  readonly tables = new Map<string, Entry>();
  readonly prices = new Map<number, Price>();
  readonly sender: Sender;
  config!: r.Config;
  configAddress!: Address;
  rent = 0n;
  slot = 0n;
  height = 0n;
  slotSeconds = 0.24;
  latest?: { blockhash: any; lastValidBlockHeight: bigint };
  private clockBase = { slot: 0n, timestamp: 0n };
  private recipients = new Map<
    string,
    { owner: Address; mint: Address } | null
  >();
  private recipientPending = new Map<string, Promise<void>>();
  private hashCache?: { at: number; data: Buffer };
  private hashPending?: Promise<Buffer>;
  private fees = new Map<
    string,
    {
      price: bigint;
      at: number;
      pending?: boolean;
      ixs: readonly Instruction[];
      table: string;
    }
  >();
  overlay?: Overlay;
  private timers: ReturnType<typeof setInterval>[] = [];
  private stopped = false;
  private rpcScan = false;
  readonly minimum = BigInt(process.env.KEEPER_PRIORITY_FEE_MIN || 10000);
  readonly maximum = BigInt(process.env.KEEPER_PRIORITY_FEE_MAX || 1000000);
  constructor(
    readonly rpc: RpcPool,
    readonly ws: Subscriptions,
    readonly payer: TransactionSigner,
    readonly logger: Logger = log,
  ) {
    if (this.minimum < 0n || this.maximum < this.minimum)
      throw new Error("Invalid priority fee range");
    this.sender = new Sender(
      rpc,
      ws,
      () => this.slot,
      () => this.height,
      (key, p) => {
        const e = this.tables.get(key);
        if (!e) return;
        e.failedBlockhash = p.blockhash;
        e.failedSignatures.add(p.signature);
        e.nonce++;
        e.jobs.clear();
        if (p.kind !== "fill")
          void this.recipient(e.table, true)
            .then(() => this.build(e))
            .catch(() => {});
        else void this.build(e);
      },
      logger,
    );
  }
  chainTime() {
    return (
      this.clockBase.timestamp +
      BigInt(
        Math.floor(Number(this.slot - this.clockBase.slot) * this.slotSeconds),
      )
    );
  }
  async initialize() {
    this.configAddress = (await r.findConfigPda())[0];
    const program = await encodedAccount(this.rpc, r.RUIN_PROGRAM_ADDRESS);
    if (!program?.executable) throw new Error("Program is not executable");
    this.rent = BigInt(
      await this.rpc.call("getMinimumBalanceForRentExemption", [165]),
    );
    await this.blockhash();
    await this.clock();
    const samples = await this.rpc.call("getRecentPerformanceSamples", [30]);
    const seconds = samples.reduce(
        (n: number, x: any) => n + x.samplePeriodSecs,
        0,
      ),
      slots = samples.reduce((n: number, x: any) => n + x.numSlots, 0);
    if (slots) this.slotSeconds = seconds / slots;
    await this.rescan();
  }
  async clock() {
    const raw = await encodedAccount(
        this.rpc,
        "SysvarC1ock11111111111111111111111111111111",
      ),
      d = Buffer.from(raw.data[0], "base64");
    this.clockBase = {
      slot: d.readBigUInt64LE(0),
      timestamp: d.readBigInt64LE(32),
    };
    if (this.slot < this.clockBase.slot) this.slot = this.clockBase.slot;
  }
  async blockhash() {
    const [b, h] = await Promise.all([
      this.rpc.call("getLatestBlockhash", [{ commitment: "confirmed" }]),
      this.rpc.call("getBlockHeight", [{ commitment: "processed" }]),
    ]);
    this.latest = {
      blockhash: b.value.blockhash,
      lastValidBlockHeight: BigInt(b.value.lastValidBlockHeight),
    };
    this.height = BigInt(h);
    for (const e of this.tables.values()) if (e.ready) void this.build(e);
  }
  private subscribeFeeds() {
    this.overlay?.setFeeds(this.config.markets.map((m) => m.feed));
  }
  async rescan() {
    if (this.rpcScan) return;
    this.rpcScan = true;
    try {
      const raw = await encodedAccount(this.rpc, this.configAddress),
        config = r
          .getConfigDecoder()
          .decode(Buffer.from(raw.data[0], "base64"));
      const changed =
        !this.config ||
        config.markets.some((m, i) => this.config.markets[i].feed !== m.feed);
      this.config = config;
      if (changed) {
        this.prices.clear();
        this.subscribeFeeds();
        for (const e of this.tables.values()) {
          e.jobs.clear();
          void this.build(e);
        }
      }
      const [all, prices] = await Promise.all([
        this.rpc.call("getProgramAccounts", [
          r.RUIN_PROGRAM_ADDRESS,
          {
            encoding: "base64",
            commitment: "processed",
            filters: tableFilters,
            withContext: true,
          },
        ]),
        this.rpc.call("getMultipleAccounts", [
          this.config.markets.map((m) => m.feed),
          { encoding: "base64", commitment: "processed" },
        ]),
      ]);
      const present = new Set<string>();
      for (const row of all.value) {
        present.add(row.pubkey);
        this.onTable(row.pubkey, row.account, all.context.slot);
      }
      for (const [key, entry] of this.tables)
        if (!present.has(key) && all.context.slot >= entry.slot) {
          this.sender.cancel(key, "reconcile-closed", all.context.slot);
          this.tables.delete(key);
        }
      await Promise.all(
        prices.value.map((v: any, i: number) =>
          this.onPrice(i, this.config.markets[i].feed, v, prices.context.slot),
        ),
      );
    } finally {
      this.rpcScan = false;
    }
  }
  onTable(key: string, raw: any, slot: number) {
    const d = Buffer.from(raw?.data?.[0] ?? "", "base64"),
      old = this.tables.get(key);
    if (old && slot < old.slot) return;
    if (
      !raw ||
      raw.lamports === 0 ||
      raw.owner !== r.RUIN_PROGRAM_ADDRESS ||
      d.length !== 177 ||
      !d.subarray(0, 8).equals(Buffer.from(r.TABLE_DISCRIMINATOR))
    ) {
      this.sender.cancel(key, "table-closed", slot);
      this.tables.delete(key);
      return;
    }
    const fingerprint = d.toString("hex");
    if (old?.fingerprint === fingerprint) {
      old.slot = slot;
      return;
    }
    if (old) this.sender.cancel(key, "table-changed", slot);
    const table = r.getTableDecoder().decode(d),
      entry: Entry = {
        address: address(key),
        table,
        fingerprint,
        slot,
        ready: false,
        jobs: new Map(),
        nonce: old?.nonce ?? 0n,
        failedBlockhash: old?.failedBlockhash,
        failedSignatures: old?.failedSignatures ?? new Set(),
      };
    this.tables.set(key, entry);
    this.logger({
      event: "table",
      table: key,
      house: table.house,
      seq: table.seq,
      state: r.TableState[table.state],
      slot,
      requestSlot: table.requestSlot,
      closeRequestSlot: table.closeRequestSlot,
    });
    void this.prepare(entry).catch(() =>
      this.logger({ event: "preparation-retry", table: key }),
    );
  }
  async onPrice(market: number, key: string, raw: any, slot: number) {
    try {
      const price = await parseFeed(key, raw, market, this.rpc.cluster);
      const old = this.prices.get(market);
      if (old && slot < old.slot) return;
      this.prices.set(market, { ...price, slot });
      for (const e of this.tables.values())
        if (e.table.market === market && e.ready) {
          if (
            !old ||
            old.price !== price.price ||
            old.publishTs !== price.publishTs
          )
            e.lastAttemptSlot = undefined;
          await this.build(e);
          this.tickEntry(e);
        }
    } catch {
      this.logger({ event: "feed-invalid", market });
    }
  }
  onSlot(slot: bigint) {
    if (slot < this.slot) return;
    this.slot = slot;
    for (const e of this.tables.values()) {
      if (!e.ready && !e.preparing) void this.prepare(e).catch(() => {});
      this.tickEntry(e);
    }
  }
  private async recipient(t: r.Table, force = false) {
    const [ata] = await findAssociatedTokenPda({
      owner: t.trader,
      mint: this.config.quoteMint,
      tokenProgram: TOKEN,
    });
    if (this.recipients.has(ata) && !force) return;
    let pending = this.recipientPending.get(ata);
    if (!pending) {
      pending = encodedAccount(this.rpc, ata, "prepare")
        .then((raw) => {
          this.recipients.set(ata, tokenAccount(raw));
        })
        .finally(() => this.recipientPending.delete(ata));
      this.recipientPending.set(ata, pending);
    }
    await pending;
  }
  private async hashes() {
    if (this.hashCache && Date.now() - this.hashCache.at < 180)
      return this.hashCache.data;
    if (!this.hashPending)
      this.hashPending = encodedAccount(
        this.rpc,
        "SysvarS1otHashes111111111111111111111111111",
        "prepare",
      )
        .then((raw) => {
          const data = Buffer.from(raw.data[0], "base64");
          this.hashCache = { at: Date.now(), data };
          return data;
        })
        .finally(() => {
          this.hashPending = undefined;
        });
    return this.hashPending;
  }
  async target(request: bigint, min: number, max: number) {
    const until = Date.now() + 5000;
    do {
      const d = await this.hashes(),
        n = Number(d.readBigUInt64LE(0));
      for (let i = 0; i < n; i++) {
        const at = 8 + 40 * i;
        if (d.readBigUInt64LE(at) === request)
          return request + r.delay(d.subarray(at + 8, at + 40), min, max);
      }
      await sleep(200);
    } while (Date.now() < until);
    throw new Error("SlotHash unavailable");
  }
  private async prepare(e: Entry) {
    if (e.preparing || this.stopped) return;
    e.preparing = true;
    const start = Date.now();
    try {
      const t = e.table,
        requested = t.state === r.TableState.Requested,
        req = requested ? t.requestSlot : t.closeRequestSlot;
      const hash = requested
        ? this.slot <= req + BigInt(t.delayMax + t.fillWindow)
        : t.state === r.TableState.CloseRequested &&
          this.slot <= req + BigInt(t.delayMax + t.closeWindow);
      const [, target] = await Promise.all([
        this.recipient(t, true),
        hash
          ? this.target(req, t.delayMin, t.delayMax)
          : Promise.resolve(undefined),
      ]);
      if (this.tables.get(e.address) !== e) return;
      if (requested) e.target = target;
      else e.closeTarget = target;
      e.ready = true;
      await this.build(e);
      this.logger({
        event: "prepared",
        table: e.address,
        targetSlot: e.target ?? e.closeTarget,
        elapsedMs: Date.now() - start,
        slot: this.slot,
      });
      this.tickEntry(e);
    } finally {
      e.preparing = false;
    }
  }
  async build(e: Entry) {
    if (
      e.building ||
      !e.ready ||
      !this.latest ||
      this.tables.get(e.address) !== e
    )
      return;
    e.building = true;
    const nonce = e.nonce;
    try {
      const t = e.table,
        getAccount = async (a: Address) => {
          if (!this.recipients.has(a))
            throw new Error("Recipient not prepared");
          return this.recipients.get(a)!;
        };
      const kinds: Kind[] =
        t.state === r.TableState.Requested
          ? ["fill", "refund"]
          : ["settle-line", "settle-stop", "settle-expiry"];
      for (const kind of kinds) {
        let ixs: Instruction[];
        if (kind === "fill")
          ixs = [
            r.getFillOpenInstruction({
              config: this.configAddress,
              house: t.house,
              table: e.address,
              feed: this.config.markets[t.market].feed,
              ...(await eventAccounts()),
            }),
          ];
        else if (kind === "refund")
          ixs = await buildRefund({
            table: t,
            tableAddress: e.address,
            payer: this.payer,
            quoteMint: this.config.quoteMint,
            getAccount,
            rent: this.rent,
          });
        else
          ixs = await r.buildSettleInstructions({
            payer: this.payer,
            tableAddress: e.address,
            table: t,
            quoteMint: this.config.quoteMint,
            feed: this.config.markets[t.market].feed,
            price: this.prices.get(t.market)?.price ?? t.p0,
            getAccount,
            rent: this.rent,
          });
        const makes = ixs.length > 1,
          limit =
            kind === "fill"
              ? 40000
              : kind === "refund"
                ? makes
                  ? 100000
                  : 60000
                : makes
                  ? 120000
                  : 80000;
        const feeKey =
            kind.split("-")[0] +
            ":" +
            writableAccounts(ixs, this.payer.address).sort().join(","),
          cached = this.fees.get(feeKey);
        if (!cached) {
          this.fees.set(feeKey, {
            price: this.minimum,
            at: 0,
            ixs,
            table: e.address,
          });
        }
        let price = this.fees.get(feeKey)!.price;
        if (e.failedBlockhash === this.latest.blockhash) price += e.nonce;
        const target =
            kind === "fill"
              ? e.target
              : kind === "settle-stop"
                ? e.closeTarget
                : undefined,
          end =
            target === undefined
              ? undefined
              : target + BigInt(kind === "fill" ? t.fillWindow : t.closeWindow);
        let p: Prepared;
        do {
          p = await prepareTransaction(
            ixs,
            this.payer,
            this.latest,
            kind,
            limit,
            price,
            target,
            end,
          );
          price++;
        } while (e.failedSignatures.has(p.signature));
        p.feeKey = feeKey;
        if (this.tables.get(e.address) === e && e.nonce === nonce)
          e.jobs.set(kind, p);
      }
    } catch {
      this.logger({ event: "build-retry", table: e.address });
    } finally {
      e.building = false;
      if (e.nonce !== nonce) void this.build(e);
    }
  }
  private async refreshFee(key: string) {
    const f = this.fees.get(key)!;
    if (f.pending) return;
    f.pending = true;
    try {
      const samples = await this.rpc.call("getRecentPrioritizationFees", [
        writableAccounts(f.ixs, this.payer.address),
      ]);
      f.price = selectPriorityFee(samples, this.minimum, this.maximum);
      f.at = Date.now();
    } catch {
    } finally {
      f.pending = false;
    }
  }
  private tickEntry(e: Entry) {
    if (!e.ready || this.sender.flights.has(e.address)) return;
    let action;
    try {
      action = chooseAction(
        e.table,
        this.prices.get(e.table.market),
        this.slot,
        this.chainTime(),
        e.target,
        e.closeTarget,
      );
    } catch {
      return;
    }
    if (!action || e.lastAttemptSlot === this.slot) return;
    if (action.kind === "settle-expiry" && Date.now() < (e.nextExpiryMs ?? 0))
      return;
    const p = e.jobs.get(action.kind);
    if (!p) {
      void this.build(e);
      return;
    }
    if (p.end !== action.end || p.target !== action.target) return;
    e.lastAttemptSlot = this.slot;
    if (action.kind === "settle-expiry") e.nextExpiryMs = Date.now() + 2000;
    void this.sender.send(e.address, e.table.house, e.table.seq, p);
  }
  start() {
    this.overlay = new Overlay(this.rpc, this.ws, r.RUIN_PROGRAM_ADDRESS,
      this.config.markets.map((m) => m.feed), {
        onSlot: (slot) => this.onSlot(slot),
        onPrice: (i, feed, raw, slot) => this.onPrice(i, feed, raw, slot),
        onTable: (key, raw, slot) => this.onTable(key, raw, slot),
        openCount: () => [...this.tables.values()].filter((e) => e.table.state !== r.TableState.Requested).length,
        windows: () => [...this.tables.values()].flatMap((e) => {
          const target = e.table.state === r.TableState.Requested ? e.target :
            e.table.state === r.TableState.CloseRequested ? e.closeTarget : undefined;
          return target === undefined ? [] : [{ target, end: target + BigInt(e.table.state === r.TableState.Requested ? e.table.fillWindow : e.table.closeWindow) }];
        }),
        signatures: () => this.sender.pendingSignatures(),
        onStatuses: (signatures, statuses) => this.sender.onStatuses(signatures, statuses),
      }, this.logger);
    this.overlay.slot = this.slot;
    this.overlay.start();
    this.ws.on("ready", () => {
      void this.rescan().catch(() => {});
    });
    this.ws.start();
    const repeat = (ms: number, fn: () => Promise<unknown> | unknown) =>
      this.timers.push(
        setInterval(() => {
          void Promise.resolve(fn()).catch(() => {});
        }, ms),
      );
    repeat(2000, () => this.blockhash());
    repeat(10000, () => this.clock());
    repeat(15000, () => this.rescan());
    repeat(10000, () => {
      const active = new Set<string>();
      for (const entry of this.tables.values())
        for (const job of entry.jobs.values())
          if (job.feeKey) active.add(job.feeKey);
      for (const flight of this.sender.flights.values())
        if (flight.prepared.feeKey) active.add(flight.prepared.feeKey);
      for (const [key, fee] of this.fees)
        if (!this.tables.has(fee.table) || !active.has(key))
          this.fees.delete(key);
      return Promise.all([...this.fees.keys()].map((k) => this.refreshFee(k)));
    });
    repeat(60000, async () => {
      const balance = (await this.rpc.call("getBalance", [this.payer.address]))
          .value,
        states: Record<string, number> = {};
      for (const e of this.tables.values()) {
        const s = r.TableState[e.table.state];
        states[s] = (states[s] ?? 0) + 1;
      }
      const cpu = process.resourceUsage();
      this.logger({
        event: "keeper-minute",
        subscribed: this.ws.ready,
        overlay: { wsLoss: this.overlay?.wsLoss, calls: this.overlay?.counts },
        tables: this.tables.size,
        states,
        balance,
        warning: balance < 50000000 ? "low-balance" : undefined,
        rpc: this.rpc.metrics.snapshot(),
        rss: process.memoryUsage().rss,
        userCpuMicros: cpu.userCPUTime,
        systemCpuMicros: cpu.systemCPUTime,
      });
    });
    this.logger({
      event: "keeper-started",
      payer: this.payer.address,
      cluster: this.rpc.cluster,
      pid: process.pid,
      slot: this.slot,
    });
  }
  close() {
    this.stopped = true;
    this.timers.forEach(clearInterval);
    this.overlay?.close();
    this.sender.close();
    this.ws.close();
    this.rpc.close();
    this.logger({
      event: "keeper-stopped",
      rpc: this.rpc.metrics.snapshot(),
      rss: process.memoryUsage().rss,
      cpu: process.resourceUsage(),
    });
  }
}
