import {
  address,
  getAddressDecoder,
  getBase58Decoder,
  unwrapOption,
  type ReadonlyUint8Array,
} from "@solana/kit";
import * as r from "../../../program/client/index.js";
import {
  LOADER,
  TOKEN,
  TOKEN_2022,
} from "../../../program/client/constants.js";
import { GENESIS, json, type Cluster } from "../common/env.js";
import { log, safeError, type Logger } from "../common/log.js";
import { MARKETS, parseFeed } from "../common/oracle.js";
import type { RpcPool } from "../common/rpc.js";
import { Subscriptions } from "../common/ws.js";
import { delta } from "./calculate.js";
import { atomicFile } from "./http.js";

const PROGRAM: string = r.RUIN_PROGRAM_ADDRESS;
const COMMITMENT = "processed";
// The price accounts are the largest accounts read together (394 bytes).
// ProgramData is returned truncated; only its 45-byte header is used.
const SLICE = { offset: 0, length: 394 };
export const TIMING = {
  fullMs: 15000,
  programsMs: 5000,
  accountsMs: 2000,
  slotMs: 2000,
  tickMs: 50,
  spacingMs: 250,
  heartbeatMs: 1000,
  historyMs: 180000,
  slotWindowMs: 60000,
  defaultSlotMs: 400,
  closedMs: 60000,
};
const filter = (d: ReadonlyUint8Array) => [
  { memcmp: { offset: 0, bytes: getBase58Decoder().decode(d) } },
];
export const houseFilters = filter(r.HOUSE_DISCRIMINATOR);
export const tableFilters = filter(r.TABLE_DISCRIMINATOR);

export function deltaBig(values: bigint[]) {
  return values.map((v, i) => String(i ? v - values[i - 1] : v)).join(",");
}
export type Written = { at: number; content: string; body: string };
/** Content changes are written at least `spacing` apart; unchanged content once per `heartbeat`. */
export function shouldWrite(
  last: Written | undefined,
  now: number,
  content: string,
  body: string,
  spacing = TIMING.spacingMs,
  heartbeat = TIMING.heartbeatMs,
) {
  if (!last) return true;
  if (body === last.body) return false;
  const since = now - last.at;
  if (since < spacing) return false;
  return content !== last.content || since >= heartbeat;
}

type Raw = { data?: [string, string]; lamports?: number; owner?: string } | null;
type Live<T> = { value: T; slot: number; data: string };
type Change = { recvMs: number; slot: number; price: bigint; publishTs: bigint };
type Feed = { address: string; lastSlot: number; current?: Change; hist: Change[] };
export type Kind = "house" | "table";
export type Socket = {
  ready: boolean;
  endpoint?: string;
  subscribe(method: string, params: unknown[], cb: (v: any) => void): () => void;
  start(): void;
  close(): void;
  on(event: "ready" | "disconnect", listener: () => void): unknown;
};
export type Rpc = {
  readonly cluster: Cluster;
  call<T = any>(method: string, params?: unknown[]): Promise<T>;
};
export type StateOptions = {
  ws?: Socket;
  now?: () => number;
  logger?: Logger;
  write?: (value: unknown) => void;
};

const bytes = (raw: Raw) => Buffer.from(raw?.data?.[0] ?? "", "base64");
const same = (d: Buffer, expected: ReadonlyUint8Array) =>
  d.length >= 8 && d.subarray(0, 8).equals(Buffer.from(expected));
const order = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);

/** Reads program state from the program cluster and writes `state.json`. */
export class StateReader {
  readonly ws: Socket;
  readonly houses = new Map<string, Live<r.House>>();
  readonly tables = new Map<string, Live<r.Table>>();
  readonly feeds: (Feed | undefined)[] = [undefined, undefined, undefined];
  config?: Live<r.Config>;
  configAddress?: string;
  programData?: string | null;
  upgradeAuthority?: string | null;
  slot = 0;
  private lockPending = new Map<string, Promise<void>>();
  private lockBumps = new Map<string, number>();
  private decimals = new Map<string, number>();
  private closed = new Map<string, { slot: number; at: number }>();
  private slots: { at: number; slot: number }[] = [];
  private reads: { house?: number; table?: number; accounts?: number } = {};
  private feedStops: (() => void)[] = [];
  private running = new Map<string, Promise<void>>();
  private refreshing?: Promise<void>;
  private again = false;
  private timers: ReturnType<typeof setInterval>[] = [];
  private stopped = false;
  private dirty = true;
  private last?: Written;
  private failedAt?: number;
  private readonly now: () => number;
  private readonly logger: Logger;
  private readonly write: (value: unknown) => void;
  constructor(
    readonly rpc: Rpc,
    readonly dir: string,
    options: StateOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.logger = options.logger ?? log;
    this.ws =
      options.ws ??
      new Subscriptions(rpc as RpcPool, undefined, (e) =>
        this.logger({ ...e, scope: "state" }),
      );
    this.write =
      options.write ?? ((value) => atomicFile(dir, "state.json", value));
  }
  private fail(e: unknown) {
    this.logger({ event: "state-error", error: safeError(e) });
  }
  private guard(fn: () => unknown) {
    try {
      const result = fn();
      if (result instanceof Promise) result.catch((e) => this.fail(e));
    } catch (e) {
      this.fail(e);
    }
  }
  private async address() {
    return (this.configAddress ??= (await r.findConfigPda())[0]);
  }
  async start() {
    try {
      const config = await this.address();
      if (this.stopped) return;
      this.ws.subscribe(
        "programSubscribe",
        [PROGRAM, { encoding: "base64", commitment: COMMITMENT, filters: houseFilters }],
        (v) =>
          this.guard(() =>
            this.onAccount("house", v.value.pubkey, v.value.account, v.context.slot),
          ),
      );
      this.ws.subscribe(
        "programSubscribe",
        [PROGRAM, { encoding: "base64", commitment: COMMITMENT, filters: tableFilters }],
        (v) =>
          this.guard(() =>
            this.onAccount("table", v.value.pubkey, v.value.account, v.context.slot),
          ),
      );
      this.ws.subscribe(
        "accountSubscribe",
        [config, { encoding: "base64", commitment: COMMITMENT }],
        (v) => this.guard(() => this.onConfig(v.value, v.context.slot)),
      );
      this.ws.subscribe("slotSubscribe", [], (v) =>
        this.guard(() => this.onSlot(Number(v.slot), this.now())),
      );
      this.ws.on("ready", () => void this.refresh());
      this.ws.start();
      const every = (ms: number, fn: () => unknown) =>
        this.timers.push(setInterval(() => this.guard(fn), ms));
      const polling = () => !this.refreshing && !this.stopped;
      every(TIMING.fullMs, () => this.refresh());
      every(TIMING.programsMs, () => {
        if (!polling()) return;
        void this.once("house", () => this.readProgram("house"));
        void this.once("table", () => this.readProgram("table"));
      });
      every(TIMING.accountsMs, () => {
        if (polling()) void this.once("accounts", () => this.readAccounts(false));
      });
      every(TIMING.slotMs, () => {
        if (!this.ws.ready && polling()) void this.once("slot", () => this.readSlot());
      });
      every(TIMING.tickMs, () => this.tick());
      await this.refresh();
    } catch (e) {
      this.fail(e);
    }
  }
  close() {
    this.stopped = true;
    this.timers.forEach(clearInterval);
    this.timers = [];
    this.feedStops.forEach((stop) => stop());
    this.feedStops = [];
    try {
      this.ws.close();
    } catch (e) {
      this.fail(e);
    }
  }
  private once(key: string, fn: () => Promise<void>) {
    const existing = this.running.get(key);
    if (existing) return existing;
    const work = fn()
      .catch((e) => this.fail(e))
      .finally(() => this.running.delete(key));
    this.running.set(key, work);
    return work;
  }
  /** Two program scans and one multiple-account read. Requests made during a read run once more after it. */
  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.refreshing) {
      this.again = true;
      return this.refreshing;
    }
    const work = (async () => {
      do {
        this.again = false;
        await Promise.all([
          this.readProgram("house").catch((e) => this.fail(e)),
          this.readProgram("table").catch((e) => this.fail(e)),
          this.readAccounts(true).catch((e) => this.fail(e)),
        ]);
      } while (this.again && !this.stopped);
    })().finally(() => {
      this.refreshing = undefined;
    });
    this.refreshing = work;
    return work;
  }
  async readProgram(kind: Kind) {
    const result = await this.rpc.call("getProgramAccounts", [
      PROGRAM,
      {
        encoding: "base64",
        commitment: COMMITMENT,
        filters: kind === "house" ? houseFilters : tableFilters,
        withContext: true,
      },
    ]);
    if (this.stopped) return;
    this.snapshot(kind, result.value, Number(result.context.slot));
    if (kind === "house") await Promise.all(this.lockPending.values());
    this.reads[kind] = this.now();
  }
  private keys(full: boolean) {
    const c = this.config?.value,
      list: { kind: "config" | "feed" | "mint" | "programData"; address: string; index?: number }[] = [
        { kind: "config", address: this.configAddress! },
      ];
    if (c) c.markets.forEach((m, index) => list.push({ kind: "feed", address: m.feed, index }));
    if (full && c) {
      list.push({ kind: "mint", address: c.quoteMint });
      const ruin = unwrapOption(c.ruinMint);
      if (ruin) list.push({ kind: "mint", address: ruin });
    }
    if (full && this.programData) list.push({ kind: "programData", address: this.programData });
    return list;
  }
  async readAccounts(full: boolean) {
    await this.address();
    if (full && this.programData === undefined) await this.readProgramAccount();
    for (let pass = 0; pass < 2 && !this.stopped; pass++) {
      const keys = this.keys(full),
        result = await this.rpc.call("getMultipleAccounts", [
          keys.map((k) => k.address),
          { encoding: "base64", commitment: COMMITMENT, dataSlice: SLICE },
        ]);
      if (this.stopped) return;
      const slot = Number(result.context.slot),
        at = this.now(),
        errors: string[] = [],
        pending: Promise<void>[] = [];
      let configured = false;
      keys.forEach((k, i) => {
        const raw: Raw = result.value[i];
        try {
          if (k.kind === "config") {
            this.onConfig(raw, slot);
            configured = true;
          } else if (k.kind === "feed")
            pending.push(this.onFeed(k.index!, k.address, raw, slot, at));
          else if (k.kind === "mint") this.onMint(k.address, raw);
          else this.onProgramData(raw);
        } catch (e) {
          errors.push(safeError(e));
        }
      });
      await Promise.all(pending);
      this.onSlot(slot, this.now());
      if (errors.length) this.fail(new Error(errors.join("; ")));
      if (configured) this.reads.accounts = this.now();
      const next = this.keys(full).map((k) => k.address).join();
      if (next === keys.map((k) => k.address).join()) break;
    }
  }
  async readSlot() {
    const slot = await this.rpc.call<number>("getSlot", [{ commitment: COMMITMENT }]);
    if (!this.stopped) this.onSlot(Number(slot), this.now());
  }
  private async readProgramAccount() {
    const result = await this.rpc.call("getAccountInfo", [
      PROGRAM,
      { encoding: "base64", commitment: COMMITMENT },
    ]);
    const raw: Raw = result?.value ?? null;
    if (!raw) throw new Error("Program account unavailable");
    if (raw.owner !== LOADER) {
      this.programData = null;
      this.upgradeAuthority = null;
      return;
    }
    const d = bytes(raw);
    if (d.length < 36 || d.readUInt32LE(0) !== 2) throw new Error("Program account invalid");
    this.programData = getAddressDecoder().decode(d.subarray(4, 36));
  }
  private onProgramData(raw: Raw) {
    const d = bytes(raw);
    if (!raw || raw.owner !== LOADER || d.length < 45 || d.readUInt32LE(0) !== 3 || d[12] > 1)
      throw new Error("ProgramData account invalid");
    const authority = d[12] === 1 ? getAddressDecoder().decode(d.subarray(13, 45)) : null;
    if (authority !== this.upgradeAuthority) this.dirty = true;
    this.upgradeAuthority = authority;
  }
  private onMint(address: string, raw: Raw) {
    const d = bytes(raw);
    if (!raw || (raw.owner !== TOKEN && raw.owner !== TOKEN_2022) || d.length < 82 || d[45] !== 1)
      throw new Error("Mint account invalid");
    if (this.decimals.get(address) !== d[44]) this.dirty = true;
    this.decimals.set(address, d[44]);
  }
  onConfig(raw: Raw, slot: number) {
    if (this.config && slot < this.config.slot) return;
    const d = bytes(raw);
    if (!raw || raw.owner !== PROGRAM || !raw.lamports || !same(d, r.CONFIG_DISCRIMINATOR))
      throw new Error("Config account invalid");
    const data = raw.data![0],
      old = this.config;
    this.bump(slot);
    if (old?.data === data) {
      old.slot = slot;
      return;
    }
    const value = r.getConfigDecoder().decode(d);
    this.config = { value, slot, data };
    this.dirty = true;
    if (!old || value.markets.some((m, i) => old.value.markets[i].feed !== m.feed))
      this.subscribeFeeds();
  }
  private subscribeFeeds() {
    this.feedStops.forEach((stop) => stop());
    const markets = this.config!.value.markets;
    markets.forEach((m, i) => {
      if (this.feeds[i]?.address !== m.feed)
        this.feeds[i] = { address: m.feed, lastSlot: 0, hist: [] };
    });
    this.feedStops = markets.map((m, i) =>
      this.ws.subscribe(
        "accountSubscribe",
        [m.feed, { encoding: "base64", commitment: COMMITMENT }],
        (v) => this.guard(() => this.onFeed(i, m.feed, v.value, v.context.slot, this.now())),
      ),
    );
  }
  async onFeed(index: number, key: string, raw: Raw, slot: number, at: number) {
    const current = () => this.feeds[index]?.address === key && this.config?.value.markets[index]?.feed === key;
    if (!current()) return;
    if (!raw) {
      this.fail(new Error(`${MARKETS[index]} price account unavailable`));
      return;
    }
    let value: Awaited<ReturnType<typeof parseFeed>>;
    try {
      value = await parseFeed(key, raw, index, this.rpc.cluster);
    } catch {
      this.fail(new Error(`${MARKETS[index]} price account invalid`));
      return;
    }
    const f = this.feeds[index];
    if (!f || !current() || slot < f.lastSlot) return;
    f.lastSlot = slot;
    this.bump(slot);
    if (f.current && f.current.price === value.price && f.current.publishTs === value.publishTs)
      return;
    const change = { recvMs: at, slot, price: value.price, publishTs: value.publishTs };
    f.current = change;
    f.hist.push(change);
    this.trim(f, at);
    this.dirty = true;
  }
  private trim(f: Feed, now: number) {
    while (f.hist.length && f.hist[0].recvMs < now - TIMING.historyMs) f.hist.shift();
  }
  onSlot(slot: number, at: number) {
    this.slots.push({ at, slot });
    while (this.slots.length && this.slots[0].at < at - TIMING.slotWindowMs) this.slots.shift();
    this.bump(slot);
  }
  slotMs(now: number) {
    const recent = this.slots.filter((x) => x.at >= now - TIMING.slotWindowMs);
    if (recent.length < 2) return TIMING.defaultSlotMs;
    const a = recent[0],
      b = recent[recent.length - 1];
    if (b.slot <= a.slot || b.at <= a.at) return TIMING.defaultSlotMs;
    return Math.round(((b.at - a.at) / (b.slot - a.slot)) * 10) / 10;
  }
  private bump(slot: number) {
    if (slot > this.slot) {
      this.slot = slot;
      this.dirty = true;
    }
  }
  private kind(kind: Kind) {
    return kind === "house"
      ? {
          map: this.houses as Map<string, Live<unknown>>,
          size: r.getHouseSize(),
          disc: r.HOUSE_DISCRIMINATOR,
          decode: (d: Buffer): unknown => r.getHouseDecoder().decode(d),
        }
      : {
          map: this.tables as Map<string, Live<unknown>>,
          size: r.getTableSize(),
          disc: r.TABLE_DISCRIMINATOR,
          decode: (d: Buffer): unknown => r.getTableDecoder().decode(d),
        };
  }
  private remove(map: Map<string, unknown>, key: string, slot: number) {
    if (map.delete(key)) this.dirty = true;
    const tomb = this.closed.get(key);
    if (!tomb || tomb.slot < slot) this.closed.set(key, { slot, at: this.now() });
  }
  /** Applies one House or Table account. Returns false when the data is not that account type. */
  onAccount(kind: Kind, key: string, raw: Raw, slot: number) {
    const { map, size, disc, decode } = this.kind(kind),
      old = map.get(key),
      tomb = this.closed.get(key);
    if ((old && slot < old.slot) || (tomb && slot <= tomb.slot)) return true;
    this.bump(slot);
    const d = bytes(raw);
    if (!raw || !raw.lamports || d.length === 0 || raw.owner !== PROGRAM) {
      this.remove(map, key, slot);
      return true;
    }
    if (d.length !== size || !same(d, disc)) {
      this.remove(map, key, slot);
      return false;
    }
    const data = raw.data![0];
    if (old?.data === data) {
      old.slot = slot;
      return true;
    }
    map.set(key, { value: decode(d), slot, data });
    if (kind === "house" && !this.lockBumps.has(key) && !this.lockPending.has(key)) {
      const pending = r.findLockVaultPda(address(key)).then(([, bump]) => {
        if (!this.stopped && this.houses.has(key)) {
          this.lockBumps.set(key, bump);
          this.dirty = true;
        }
      }).catch((e) => this.fail(e)).finally(() => this.lockPending.delete(key));
      this.lockPending.set(key, pending);
    }
    this.dirty = true;
    return true;
  }
  snapshot(kind: Kind, rows: { pubkey: string; account: Raw }[], slot: number) {
    const { map } = this.kind(kind),
      seen = new Set<string>();
    let invalid = 0;
    for (const row of rows) {
      seen.add(row.pubkey);
      if (!this.onAccount(kind, row.pubkey, row.account, slot)) invalid++;
    }
    for (const [key, entry] of map)
      if (!seen.has(key) && slot >= entry.slot) this.remove(map, key, slot);
    const now = this.now();
    for (const [key, tomb] of this.closed)
      if (tomb.at < now - TIMING.closedMs) this.closed.delete(key);
    this.bump(slot);
    if (invalid) this.fail(new Error(`${invalid} ${kind} accounts invalid`));
  }
  ready() {
    const c = this.config?.value;
    if (
      !c ||
      this.upgradeAuthority === undefined ||
      this.reads.house === undefined ||
      this.reads.table === undefined
    )
      return false;
    if ([...this.houses.keys()].some((key) => !this.lockBumps.has(key))) return false;
    if (!this.decimals.has(c.quoteMint)) return false;
    const ruin = unwrapOption(c.ruinMint);
    return !ruin || this.decimals.has(ruin);
  }
  content(now: number) {
    const c = this.config!.value,
      ruinMint = unwrapOption(c.ruinMint);
    const feeds = [];
    for (let i = 0; i < this.feeds.length; i++) {
      const f = this.feeds[i];
      if (!f?.current) continue;
      this.trim(f, now);
      const h = f.hist;
      feeds.push({
        market: MARKETS[i],
        address: f.address,
        price: String(f.current.price),
        publishTs: String(f.current.publishTs),
        slot: String(f.current.slot),
        recvMs: f.current.recvMs,
        hist: {
          t: delta(h.map((x) => x.recvMs)),
          s: deltaBig(h.map((x) => BigInt(x.slot))),
          p: deltaBig(h.map((x) => x.price)),
        },
      });
    }
    return {
      cluster: this.rpc.cluster,
      genesis: GENESIS[this.rpc.cluster],
      program: PROGRAM,
      upgradeAuthority: this.upgradeAuthority ?? null,
      slot: String(this.slot),
      slotMs: this.slotMs(now),
      config: {
        address: this.configAddress!,
        admin: c.admin,
        quoteMint: c.quoteMint,
        quoteDecimals: this.decimals.get(c.quoteMint)!,
        ruinMint: ruinMint ?? null,
        ruinTokenProgram: ruinMint ? (unwrapOption(c.ruinTokenProgram) ?? null) : null,
        ruinDecimals: ruinMint ? this.decimals.get(ruinMint)! : null,
        markets: c.markets.map((m) => ({ feed: m.feed, asset: m.asset })),
        levMin: c.levMin,
        levMax: c.levMax,
        kMin: c.kMin,
        kMax: c.kMax,
        eMinBps: c.eMinBps,
        eMaxBps: c.eMaxBps,
        expirySecs: c.expirySecs,
        mMin: String(c.mMin),
        freeStake: String(c.freeStake),
        ruinPerUsd: String(c.ruinPerUsd),
        delayMin: c.delayMin,
        delayMax: c.delayMax,
        fillWindow: c.fillWindow,
        closeWindow: c.closeWindow,
        staleSecs: c.staleSecs,
        nextHouseId: String(c.nextHouseId),
      },
      feeds,
      houses: [...this.houses]
        .sort(([, a], [, b]) => order(a.value.id, b.value.id))
        .map(([address, { value: h }]) => ({
          address,
          id: String(h.id),
          owner: h.owner,
          market: h.market,
          sides: h.sides,
          k: h.k,
          eBps: h.eBps,
          stake: String(h.stake),
          freeStake: String(h.freeStake),
          ruinPerUsd: String(h.ruinPerUsd),
          ruinLocked: String(h.ruinLocked),
          lockVault: h.ruinLocked > 0n || h.lockVaultBump === this.lockBumps.get(address),
          accepting: h.accepting,
          state: r.HouseState[h.state],
          nextSeq: String(h.nextSeq),
          currentSeq: String(h.currentSeq),
        })),
      tables: [...this.tables]
        .sort(([ka, a], [kb, b]) => order(a.value.requestSlot, b.value.requestSlot) || (ka < kb ? -1 : ka > kb ? 1 : 0))
        .map(([address, { value: t }]) => ({
          address,
          house: t.house,
          seq: String(t.seq),
          trader: t.trader,
          market: t.market,
          side: r.Side[t.side],
          lev: t.lev,
          m: String(t.m),
          k: t.k,
          eBps: t.eBps,
          delayMin: t.delayMin,
          delayMax: t.delayMax,
          fillWindow: t.fillWindow,
          closeWindow: t.closeWindow,
          staleSecs: t.staleSecs,
          expirySecs: t.expirySecs,
          state: r.TableState[t.state],
          requestSlot: String(t.requestSlot),
          requestPublishTs: String(t.requestPublishTs),
          p0: String(t.p0),
          fillSlot: String(t.fillSlot),
          fillPublishTs: String(t.fillPublishTs),
          fillTs: String(t.fillTs),
          closeRequestSlot: String(t.closeRequestSlot),
          closePublishTs: String(t.closePublishTs),
        })),
    };
  }
  /** Writes `state.json` when the cadence allows. Returns true when a file was written. */
  tick() {
    if (this.stopped) return false;
    const now = this.now();
    try {
      if (!this.ready()) return false;
      if ([this.reads.house, this.reads.table, this.reads.accounts].some((at) => at === undefined || now - at > 12000)) return false;
      if (this.failedAt !== undefined && now - this.failedAt < TIMING.heartbeatMs) return false;
      if (this.last) {
        const since = now - this.last.at;
        if (since < TIMING.spacingMs) return false;
        if (!this.dirty && since < TIMING.heartbeatMs) return false;
      }
      const content = this.content(now),
        text = json(content),
        value = { v: 1, generated: now, ...content },
        body = json(value);
      this.dirty = false;
      if (!shouldWrite(this.last, now, text, body)) return false;
      this.write(value);
      this.last = { at: now, content: text, body };
      this.failedAt = undefined;
      return true;
    } catch (e) {
      this.failedAt = now;
      this.dirty = true;
      this.fail(e);
      return false;
    }
  }
  status() {
    const now = this.now(),
      reads = [this.reads.house, this.reads.table, this.reads.accounts];
    return {
      ready: this.ws.ready,
      endpoint: this.ws.ready ? (this.ws.endpoint ?? null) : null,
      houses: this.houses.size,
      tables: this.tables.size,
      ageMs: reads.every((x) => x !== undefined)
        ? now - Math.min(...(reads as number[]))
        : null,
    };
  }
}
