import { it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  address,
  getAddressDecoder,
  getAddressEncoder,
  getBase58Decoder,
  getBase58Encoder,
  getProgramDerivedAddress,
  type Address,
} from "@solana/kit";
import * as r from "../../program/client/index.js";
import {
  ASSETS,
  LOADER,
  TOKEN,
  TOKEN_2022,
} from "../../program/client/constants.js";
import { GENESIS, json, sleep } from "../src/common/env.js";
import { RpcPool } from "../src/common/rpc.js";
import { Store } from "../src/common/sqlite.js";
import { StateReader, shouldWrite } from "../src/tape/state.js";
import { ruinPath } from "../src/tape/calculate.js";
import { atomicFile, httpServer } from "../src/tape/http.js";
import { Publisher } from "../src/tape/publish.js";
const { WebSocketServer } = createRequire(import.meta.url)("ws");

const program = r.RUIN_PROGRAM_ADDRESS as string;
const SYSTEM = "11111111111111111111111111111111";
const key = () => getAddressDecoder().decode(randomBytes(32)) as string;
const encodeAddress = (a: string) => Buffer.from(getAddressEncoder().encode(a as Address));
const configAddress = (await r.findConfigPda())[0] as string;
const devFeeds = await Promise.all(
  [0, 1, 2].map(
    async (i) =>
      (
        await getProgramDerivedAddress({
          programAddress: r.RUIN_PROGRAM_ADDRESS,
          seeds: ["dev_feed", new Uint8Array([i])],
        })
      )[0] as string,
  ),
);
const houseBytes = getBase58Decoder().decode(r.HOUSE_DISCRIMINATOR);
const tableBytes = getBase58Decoder().decode(r.TABLE_DISCRIMINATOR);
const PRICES = [18123456789n, 10812345678901n, 389012345678n];
const undelta = (csv: string) => {
  let a = 0n;
  return csv ? csv.split(",").map((v) => (a += BigInt(v))) : [];
};

function feedData(i: number, price: bigint, publishTs: bigint) {
  const d = Buffer.alloc(394);
  Buffer.from([112, 249, 139, 217, 215, 208, 249, 54]).copy(d, 0);
  encodeAddress(ASSETS[i]).copy(d, 8);
  d.writeBigUInt64LE(price, 168);
  d[176] = 248;
  d.writeBigInt64LE(publishTs, 177);
  return d;
}
function mintData(decimals: number) {
  const d = Buffer.alloc(82);
  d[44] = decimals;
  d[45] = 1;
  return d;
}
function programAccount(programData: string) {
  const d = Buffer.alloc(36);
  d.writeUInt32LE(2, 0);
  encodeAddress(programData).copy(d, 4);
  return d;
}
function programDataAccount(authority: string | null) {
  const d = Buffer.alloc(45 + 2000, 7);
  d.writeUInt32LE(3, 0);
  d.writeBigUInt64LE(1234n, 4);
  d.fill(0, 12, 45);
  if (authority) {
    d[12] = 1;
    encodeAddress(authority).copy(d, 13);
  }
  return d;
}
function configData(admin: string, quoteMint: string, ruinMint: string | null) {
  const e = Buffer.from(
    r.getConfigEncoder().encode({
      admin: admin as Address,
      quoteMint: quoteMint as Address,
      ruinMint: (ruinMint as Address) ?? null,
      ruinTokenProgram: ruinMint ? TOKEN_2022 : null,
      markets: devFeeds.map((feed, i) => ({ feed: feed as Address, asset: ASSETS[i] })),
      levMin: 500,
      levMax: 1000,
      kMin: 2,
      kMax: 20,
      eMinBps: 0,
      eMaxBps: 2000,
      expirySecs: 120,
      mMin: 1000000n,
      freeStake: 100000000n,
      ruinPerUsd: 10000000000n,
      delayMin: 9,
      delayMax: 20,
      fillWindow: 4,
      closeWindow: 4,
      staleSecs: 30,
      nextHouseId: 69n,
      bump: 254,
    }),
  );
  return Buffer.concat([e, Buffer.alloc(389 - e.length)]);
}
function houseData(id: bigint, owner: string, extra: Partial<r.HouseArgs> = {}) {
  return Buffer.from(
    r.getHouseEncoder().encode({
      id,
      owner: owner as Address,
      market: 0,
      sides: 3,
      k: 10,
      eBps: 700,
      stake: 100000000n,
      freeStake: 100000000n,
      ruinPerUsd: 10000000000n,
      ruinLocked: 0n,
      accepting: true,
      state: r.HouseState.Idle,
      nextSeq: 0n,
      currentSeq: 0n,
      bump: 255,
      vaultBump: 254,
      lockVaultBump: 253,
      ...extra,
    }),
  );
}
function tableData(house: string, trader: string, extra: Partial<r.TableArgs> = {}) {
  return Buffer.from(
    r.getTableEncoder().encode({
      house: house as Address,
      seq: 0n,
      trader: trader as Address,
      market: 1,
      side: r.Side.Short,
      lev: 1000,
      m: 5000000n,
      k: 10,
      eBps: 700,
      delayMin: 9,
      delayMax: 20,
      fillWindow: 4,
      closeWindow: 4,
      staleSecs: 30,
      expirySecs: 120,
      state: r.TableState.Open,
      requestSlot: 900n,
      requestPublishTs: 1792000000n,
      p0: 10812345678901n,
      fillSlot: 911n,
      fillPublishTs: 1792000004n,
      fillTs: 1792000005n,
      closeRequestSlot: 0n,
      closePublishTs: 0n,
      bump: 255,
      ...extra,
    }),
  );
}
type Acct = { data: Buffer; owner: string; lamports: number };
const raw = (a?: Acct, slice?: { offset: number; length: number }) =>
  a
    ? {
        data: [
          (slice ? a.data.subarray(slice.offset, slice.offset + slice.length) : a.data).toString("base64"),
          "base64",
        ],
        executable: false,
        lamports: a.lamports,
        owner: a.owner,
        rentEpoch: 0,
        space: a.data.length,
      }
    : null;
function chain(options: { ruin?: boolean; authority?: string | null; upgradeable?: boolean } = {}) {
  const accounts = new Map<string, Acct>(),
    calls: { method: string; params: any[]; at: number }[] = [],
    state = { slot: 1000 };
  const ids = {
    admin: key(),
    quote: key(),
    ruin: key(),
    programData: key(),
    authority: options.authority === undefined ? key() : options.authority,
    owner: key(),
    trader: key(),
    house1: key(),
    house2: key(),
    table1: key(),
    table2: key(),
  };
  const put = (k: string, data: Buffer, owner = program, lamports = 1000000) =>
    accounts.set(k, { data, owner, lamports });
  put(program, programAccount(ids.programData), options.upgradeable === false ? "BPFLoader2111111111111111111111111111111111" : LOADER);
  put(ids.programData, programDataAccount(ids.authority), LOADER);
  put(configAddress, configData(ids.admin, ids.quote, options.ruin === false ? null : ids.ruin));
  put(ids.quote, mintData(6), TOKEN);
  put(ids.ruin, mintData(8), TOKEN_2022);
  devFeeds.forEach((f, i) => put(f, feedData(i, PRICES[i], 1792000000n + BigInt(i))));
  put(ids.house1, houseData(1n, ids.owner, { stake: 2n ** 60n + 1n, ruinLocked: 18446744073709551615n }));
  put(ids.house2, houseData(2n, ids.owner, { market: 1, accepting: false, state: r.HouseState.Busy, nextSeq: 1n }));
  put(ids.table1, tableData(ids.house2, ids.trader));
  put(ids.table2, tableData(ids.house2, ids.trader, { seq: 1n, requestSlot: 950n, state: r.TableState.Requested, side: r.Side.Long, market: 0 }));
  function handle(method: string, params: any[]): any {
    calls.push({ method, params, at: Date.now() });
    switch (method) {
      case "getGenesisHash":
        return GENESIS.devnet;
      case "getSlot":
        return state.slot;
      case "getAccountInfo":
        return { context: { slot: state.slot }, value: raw(accounts.get(params[0])) };
      case "getMultipleAccounts":
        return {
          context: { slot: state.slot },
          value: params[0].map((k: string) => raw(accounts.get(k), params[1]?.dataSlice)),
        };
      case "getProgramAccounts": {
        const want = Buffer.from(getBase58Encoder().encode(params[1].filters[0].memcmp.bytes));
        const value = [...accounts]
          .filter(([, a]) => a.owner === program && a.data.subarray(0, 8).equals(want))
          .map(([pubkey, a]) => ({ pubkey, account: raw(a) }));
        return params[1].withContext ? { context: { slot: state.slot }, value } : value;
      }
    }
    throw new Error("unexpected method " + method);
  }
  return {
    accounts,
    calls,
    ids,
    state,
    put,
    handle,
    count: (method: string) => calls.filter((c) => c.method === method).length,
    rpc: { cluster: "devnet" as const, call: async (m: string, p: unknown[] = []) => handle(m, p as any[]) },
  };
}
class FakeWs extends EventEmitter {
  ready = true;
  endpoint = "public";
  subs: { method: string; params: any[]; cb: (v: any) => void }[] = [];
  subscribe(method: string, params: any[], cb: (v: any) => void) {
    const s = { method, params, cb };
    this.subs.push(s);
    return () => {
      this.subs = this.subs.filter((x) => x !== s);
    };
  }
  start() {}
  close() {}
  program(bytes: string, value: any) {
    for (const s of this.subs)
      if (s.method === "programSubscribe" && s.params[1].filters[0].memcmp.bytes === bytes) s.cb(value);
  }
  account(address: string, value: any) {
    for (const s of this.subs) if (s.method === "accountSubscribe" && s.params[0] === address) s.cb(value);
  }
}
const quiet = () => {};

it("S1 decodes Config, House, Table, mints, price accounts and ProgramData into the state.json types", async () => {
  const c = chain(),
    dir = mkdtempSync(resolve(tmpdir(), "ruin-state-")),
    now = 1792000100000;
  const reader = new StateReader(c.rpc, dir, { ws: new FakeWs(), now: () => now, logger: quiet });
  try {
    await reader.refresh();
    expect(reader.tick()).toBe(true);
    const text = readFileSync(resolve(dir, "state.json"), "utf8"),
      s = JSON.parse(text);
    expect(Object.keys(s)).toEqual(["v", "generated", "cluster", "genesis", "program", "upgradeAuthority", "slot", "slotMs", "config", "feeds", "houses", "tables"]);
    expect(s).toMatchObject({
      v: 1,
      generated: now,
      cluster: "devnet",
      genesis: GENESIS.devnet,
      program,
      upgradeAuthority: c.ids.authority,
      slot: "1000",
      slotMs: 400,
    });
    expect(Object.keys(s.config)).toEqual(["address", "admin", "quoteMint", "quoteDecimals", "ruinMint", "ruinTokenProgram", "ruinDecimals", "markets", "levMin", "levMax", "kMin", "kMax", "eMinBps", "eMaxBps", "expirySecs", "mMin", "freeStake", "ruinPerUsd", "delayMin", "delayMax", "fillWindow", "closeWindow", "staleSecs", "nextHouseId"]);
    expect(s.config).toEqual({
      address: configAddress,
      admin: c.ids.admin,
      quoteMint: c.ids.quote,
      quoteDecimals: 6,
      ruinMint: c.ids.ruin,
      ruinTokenProgram: TOKEN_2022,
      ruinDecimals: 8,
      markets: devFeeds.map((feed, i) => ({ feed, asset: ASSETS[i] })),
      levMin: 500,
      levMax: 1000,
      kMin: 2,
      kMax: 20,
      eMinBps: 0,
      eMaxBps: 2000,
      expirySecs: 120,
      mMin: "1000000",
      freeStake: "100000000",
      ruinPerUsd: "10000000000",
      delayMin: 9,
      delayMax: 20,
      fillWindow: 4,
      closeWindow: 4,
      staleSecs: 30,
      nextHouseId: "69",
    });
    expect(s.feeds.map((f: any) => Object.keys(f))).toEqual(Array(3).fill(["market", "address", "price", "publishTs", "slot", "recvMs", "hist"]));
    expect(s.feeds).toEqual(
      devFeeds.map((address, i) => ({
        market: ["SOL", "BTC", "ETH"][i],
        address,
        price: String(PRICES[i]),
        publishTs: String(1792000000 + i),
        slot: "1000",
        recvMs: now,
        hist: { t: String(now), s: "1000", p: String(PRICES[i]) },
      })),
    );
    expect(s.houses.map((h: any) => Object.keys(h))).toEqual(Array(2).fill(["address", "id", "owner", "market", "sides", "k", "eBps", "stake", "freeStake", "ruinPerUsd", "ruinLocked", "lockVault", "accepting", "state", "nextSeq", "currentSeq"]));
    expect(s.houses).toEqual([
      { address: c.ids.house1, id: "1", owner: c.ids.owner, market: 0, sides: 3, k: 10, eBps: 700, stake: "1152921504606846977", freeStake: "100000000", ruinPerUsd: "10000000000", ruinLocked: "18446744073709551615", lockVault: true, accepting: true, state: "Idle", nextSeq: "0", currentSeq: "0" },
      { address: c.ids.house2, id: "2", owner: c.ids.owner, market: 1, sides: 3, k: 10, eBps: 700, stake: "100000000", freeStake: "100000000", ruinPerUsd: "10000000000", ruinLocked: "0", lockVault: (await r.findLockVaultPda(address(c.ids.house2)))[1] === 253, accepting: false, state: "Busy", nextSeq: "1", currentSeq: "0" },
    ]);
    // The u64 values above 2^53 are exact in the file bytes.
    expect(text).toContain('"stake":"1152921504606846977"');
    expect(text).toContain('"ruinLocked":"18446744073709551615"');
    expect(s.tables.map((t: any) => Object.keys(t))).toEqual(Array(2).fill(["address", "house", "seq", "trader", "market", "side", "lev", "m", "k", "eBps", "delayMin", "delayMax", "fillWindow", "closeWindow", "staleSecs", "expirySecs", "state", "requestSlot", "requestPublishTs", "p0", "fillSlot", "fillPublishTs", "fillTs", "closeRequestSlot", "closePublishTs"]));
    expect(s.tables[0]).toEqual({
      address: c.ids.table1, house: c.ids.house2, seq: "0", trader: c.ids.trader, market: 1, side: "Short", lev: 1000, m: "5000000", k: 10, eBps: 700,
      delayMin: 9, delayMax: 20, fillWindow: 4, closeWindow: 4, staleSecs: 30, expirySecs: 120, state: "Open",
      requestSlot: "900", requestPublishTs: "1792000000", p0: "10812345678901", fillSlot: "911", fillPublishTs: "1792000004", fillTs: "1792000005", closeRequestSlot: "0", closePublishTs: "0",
    });
    expect(s.tables[1]).toMatchObject({ address: c.ids.table2, seq: "1", side: "Long", state: "Requested", market: 0, requestSlot: "950" });
    // Field types: u64/i64 strings; u8/u16/u32 and ms values numbers.
    const numbers = (o: any, ks: string[]) => ks.forEach((k) => expect([k, typeof o[k]]).toEqual([k, "number"]));
    const strings = (o: any, ks: string[]) => ks.forEach((k) => expect([k, typeof o[k]]).toEqual([k, "string"]));
    numbers(s, ["generated", "slotMs"]);
    strings(s, ["slot"]);
    numbers(s.config, ["quoteDecimals", "ruinDecimals", "levMin", "levMax", "kMin", "kMax", "eMinBps", "eMaxBps", "expirySecs", "delayMin", "delayMax", "fillWindow", "closeWindow", "staleSecs"]);
    strings(s.config, ["mMin", "freeStake", "ruinPerUsd", "nextHouseId"]);
    numbers(s.feeds[0], ["recvMs"]);
    strings(s.feeds[0], ["price", "publishTs", "slot"]);
    numbers(s.houses[0], ["market", "sides", "k", "eBps"]);
    strings(s.houses[0], ["id", "stake", "freeStake", "ruinPerUsd", "ruinLocked", "nextSeq", "currentSeq"]);
    expect(typeof s.houses[0].accepting).toBe("boolean");
    numbers(s.tables[0], ["market", "lev", "k", "eBps", "delayMin", "delayMax", "fillWindow", "closeWindow", "staleSecs", "expirySecs"]);
    strings(s.tables[0], ["seq", "m", "requestSlot", "requestPublishTs", "p0", "fillSlot", "fillPublishTs", "fillTs", "closeRequestSlot", "closePublishTs"]);
    // One multiple-account read holds every account; ProgramData comes from the program account bytes 4..36 and is sliced.
    const multi = c.calls.filter((x) => x.method === "getMultipleAccounts").at(-1)!;
    expect(multi.params[0]).toEqual([configAddress, ...devFeeds, c.ids.quote, c.ids.ruin, c.ids.programData]);
    expect(multi.params[1]).toEqual({ encoding: "base64", commitment: "processed", dataSlice: { offset: 0, length: 394 } });
    const scans = c.calls.filter((x) => x.method === "getProgramAccounts");
    expect(scans.map((x) => x.params[1].filters)).toEqual([[{ memcmp: { offset: 0, bytes: houseBytes } }], [{ memcmp: { offset: 0, bytes: tableBytes } }]]);
    expect(scans.every((x) => x.params[1].encoding === "base64" && x.params[1].withContext)).toBe(true);
  } finally {
    reader.close();
    rmSync(dir, { recursive: true });
  }
});

it("S2 ProgramData authority None, RUIN unset and a non-upgradeable program give null fields", async () => {
  const none = chain({ authority: null, ruin: false }),
    reader = new StateReader(none.rpc, "", { ws: new FakeWs(), now: () => 5000, write: quiet, logger: quiet });
  await reader.refresh();
  const s = reader.content(5000);
  expect(s.upgradeAuthority).toBeNull();
  expect(s.config).toMatchObject({ ruinMint: null, ruinTokenProgram: null, ruinDecimals: null, quoteDecimals: 6 });
  expect(none.calls.filter((x) => x.method === "getMultipleAccounts").at(-1)!.params[0]).toEqual([configAddress, ...devFeeds, none.ids.quote, none.ids.programData]);
  expect(reader.ready()).toBe(true);

  const some = chain(),
    withAuthority = new StateReader(some.rpc, "", { ws: new FakeWs(), now: () => 5000, write: quiet, logger: quiet });
  await withAuthority.refresh();
  expect(withAuthority.content(5000).upgradeAuthority).toBe(some.ids.authority);
  // An authority change is picked up by the next full read.
  some.put(some.ids.programData, programDataAccount(null), LOADER);
  await withAuthority.refresh();
  expect(withAuthority.content(5000).upgradeAuthority).toBeNull();

  const fixed = chain({ upgradeable: false }),
    immutable = new StateReader(fixed.rpc, "", { ws: new FakeWs(), now: () => 5000, write: quiet, logger: quiet });
  await immutable.refresh();
  expect(immutable.content(5000).upgradeAuthority).toBeNull();
  expect(fixed.calls.filter((x) => x.method === "getMultipleAccounts").at(-1)!.params[0]).not.toContain(fixed.ids.programData);
  expect(fixed.count("getAccountInfo")).toBe(1);
  await immutable.refresh();
  expect(fixed.count("getAccountInfo")).toBe(1);
});

it("S3 closed-account notifications and scans delete accounts; delayed scans neither revive nor delete newer state", async () => {
  const c = chain(),
    ws = new FakeWs(),
    logs: any[] = [];
  const reader = new StateReader(c.rpc, "", { ws, write: quiet, logger: (e) => logs.push(e) });
  try {
    await reader.start();
    expect([reader.houses.size, reader.tables.size]).toEqual([2, 2]);
    // A changed house is decoded from its notification.
    ws.program(houseBytes, { context: { slot: 1000 }, value: { pubkey: c.ids.house2, account: raw({ data: houseData(2n, c.ids.owner, { market: 1, ruinLocked: 500n }), owner: program, lamports: 1 }) } });
    expect(reader.content(Date.now()).houses[1]).toMatchObject({ id: "2", ruinLocked: "500" });
    expect(ws.subs.map((s) => s.method).sort()).toEqual(["accountSubscribe", "accountSubscribe", "accountSubscribe", "accountSubscribe", "programSubscribe", "programSubscribe", "slotSubscribe"]);
    const closed = { data: ["", "base64"], executable: false, lamports: 0, owner: SYSTEM, rentEpoch: 0, space: 0 };
    ws.program(tableBytes, { context: { slot: 1001 }, value: { pubkey: c.ids.table1, account: closed } });
    expect([...reader.tables.keys()]).toEqual([c.ids.table2]);
    // A scan taken before the close cannot bring the table back.
    reader.snapshot("table", [{ pubkey: c.ids.table1, account: raw(c.accounts.get(c.ids.table1)) as any }, { pubkey: c.ids.table2, account: raw(c.accounts.get(c.ids.table2)) as any }], 1000);
    expect([...reader.tables.keys()]).toEqual([c.ids.table2]);
    // A new house from a notification survives an older scan that lacks it, and goes with a newer one.
    const house3 = key();
    ws.program(houseBytes, { context: { slot: 1005 }, value: { pubkey: house3, account: raw({ data: houseData(3n, c.ids.owner), owner: program, lamports: 1 }) } });
    expect(reader.houses.has(house3)).toBe(true);
    reader.snapshot("house", [c.ids.house1, c.ids.house2].map((k) => ({ pubkey: k, account: raw(c.accounts.get(k)) as any })), 1003);
    expect(reader.houses.has(house3)).toBe(true);
    reader.snapshot("house", [c.ids.house1, c.ids.house2].map((k) => ({ pubkey: k, account: raw(c.accounts.get(k)) as any })), 1006);
    expect(reader.houses.has(house3)).toBe(false);
    // Owner no longer the program, and empty data, are closed accounts too.
    ws.program(houseBytes, { context: { slot: 1007 }, value: { pubkey: c.ids.house1, account: { ...raw(c.accounts.get(c.ids.house1)), owner: SYSTEM } } });
    ws.program(houseBytes, { context: { slot: 1007 }, value: { pubkey: c.ids.house2, account: { ...raw(c.accounts.get(c.ids.house2)), data: ["", "base64"] } } });
    expect(reader.houses.size).toBe(0);
    // An account closed without a notification leaves at the next full read.
    c.state.slot = 1010;
    for (const k of [c.ids.house1, c.ids.house2, c.ids.table1, c.ids.table2]) c.accounts.delete(k);
    await reader.refresh();
    expect(reader.tables.size).toBe(0);
    expect(reader.houses.size).toBe(0);
    expect(reader.content(Date.now()).tables).toEqual([]);
    expect(logs.filter((e) => e.event === "state-error")).toEqual([]);
  } finally {
    reader.close();
  }
});

it("S4 reads at start, on ready and every 15 s, and polls accounts and programs regardless of readiness, slots only while disconnected", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
  const c = chain(),
    ws = new FakeWs();
  devFeeds.forEach((f) => c.accounts.delete(f));
  const reader = new StateReader(c.rpc, "", { ws, write: quiet, logger: quiet });
  try {
    await reader.start();
    const t0 = Date.now(),
      at = (method: string, from: number, to: number, size?: number) =>
        c.calls.filter((x) => x.method === method && x.at >= t0 + from && x.at <= t0 + to && (size === undefined || x.params[0].length === size)).length;
    expect([c.count("getAccountInfo"), c.count("getProgramAccounts"), c.count("getMultipleAccounts")]).toEqual([1, 2, 2]);
    ws.emit("ready");
    await vi.advanceTimersByTimeAsync(1);
    expect([c.count("getProgramAccounts"), c.count("getMultipleAccounts")]).toEqual([4, 3]);
    await vi.advanceTimersByTimeAsync(14998);
    expect([c.count("getProgramAccounts"), c.count("getMultipleAccounts"), c.count("getSlot")]).toEqual([8, 10, 0]);
    await vi.advanceTimersByTimeAsync(1);
    expect([at("getProgramAccounts", 15000, 15000), at("getMultipleAccounts", 15000, 15000, 7)]).toEqual([4, 1]);
    ws.ready = false;
    await vi.advanceTimersByTimeAsync(14999);
    // 16..28 s: seven 2 s reads of Config and the three price accounts, seven getSlot; 20 and 25 s: two scans each.
    expect(at("getMultipleAccounts", 15001, 29999, 4)).toBe(7);
    expect(at("getMultipleAccounts", 15001, 29999, 7)).toBe(0);
    expect(at("getSlot", 15001, 29999)).toBe(7);
    expect(c.calls.filter((x) => x.method === "getProgramAccounts" && x.at > t0 + 15000 && x.at < t0 + 30000).map((x) => x.at - t0)).toEqual([20000, 20000, 25000, 25000]);
    ws.ready = true;
    const before = c.calls.length;
    await vi.advanceTimersByTimeAsync(15001);
    const connected = c.calls.slice(before);
    expect(connected.filter(x => x.method === "getSlot")).toHaveLength(0);
    expect(connected.filter(x => x.method === "getProgramAccounts" && [30000, 45000].includes(x.at - t0))).toHaveLength(8);
    expect(connected.filter(x => x.method === "getMultipleAccounts" && x.params[0].length === 4)).toHaveLength(8);
    expect(connected.filter(x => x.method === "getMultipleAccounts" && x.params[0].length === 7)).toHaveLength(2);
  } finally {
    reader.close();
    vi.useRealTimers();
  }
});

it("S5 keeps 180 seconds of price changes and measures slotMs over 60 seconds of slot samples", async () => {
  const c = chain();
  let now = 10_000_000;
  const reader = new StateReader(c.rpc, "", { ws: new FakeWs(), now: () => now, write: quiet, logger: quiet });
  await reader.refresh();
  const sol = devFeeds[0],
    value = (price: bigint, ts: bigint) => raw({ data: feedData(0, price, ts), owner: program, lamports: 1 }) as any;
  await reader.onFeed(0, sol, value(PRICES[0], 1792000000n), 1001, now + 1000); // same value
  await reader.onFeed(0, sol, value(18100000000n, 1792000001n), 1002, now + 60_000);
  await reader.onFeed(0, sol, value(18200000000n, 1792000002n), 1003, now + 120_000);
  await reader.onFeed(0, sol, value(18300000000n, 1792000003n), 1001, now + 121_000); // older slot
  await reader.onFeed(0, sol, value(18400000000n, 1792000004n), 1004, now + 179_000);
  let f = reader.content(now + 180_000).feeds[0];
  expect(undelta(f.hist.t)).toEqual([0, 60_000, 120_000, 179_000].map((x) => BigInt(now + x)));
  expect(undelta(f.hist.s)).toEqual([1000n, 1002n, 1003n, 1004n]);
  expect(undelta(f.hist.p)).toEqual([PRICES[0], 18100000000n, 18200000000n, 18400000000n]);
  expect(f).toMatchObject({ price: "18400000000", publishTs: "1792000004", slot: "1004", recvMs: now + 179_000 });
  f = reader.content(now + 180_001).feeds[0];
  expect(undelta(f.hist.t)).toEqual([60_000, 120_000, 179_000].map((x) => BigInt(now + x)));
  f = reader.content(now + 359_001).feeds[0];
  expect(f.hist).toEqual({ t: "", s: "", p: "" });
  expect(f.price).toBe("18400000000");

  expect(reader.slotMs(now)).toBe(400);
  (reader as any).slots = []; // isolate slot samples from the new account-context samples
  reader.onSlot(2000, now - 61_000);
  reader.onSlot(5000, now);
  expect(reader.slotMs(now)).toBe(400);
  reader.onSlot(5100, now + 24_000);
  expect(reader.slotMs(now + 24_000)).toBe(240);
  expect(reader.content(now + 24_000).slotMs).toBe(240);
  expect(reader.slotMs(now + 24_000 + 60_001)).toBe(400);

  // While polling, getSlot results are the samples.
  const polled = new StateReader(c.rpc, "", { ws: new FakeWs(), now: () => now, write: quiet, logger: quiet });
  c.state.slot = 7000;
  await polled.readSlot();
  now += 2000;
  c.state.slot = 7008;
  await polled.readSlot();
  expect(polled.slotMs(now)).toBe(250);
  expect(polled.slot).toBe(7008);
});

it("S6 writes changed content at least 250 ms apart, unchanged content once per second, and never the same body", async () => {
  expect(shouldWrite(undefined, 0, "c", "b")).toBe(true);
  const last = { at: 1000, content: "c", body: "b" };
  expect(shouldWrite(last, 5000, "c", "b")).toBe(false);
  expect(shouldWrite(last, 5000, "x", "b")).toBe(false);
  expect(shouldWrite(last, 1249, "x", "y")).toBe(false);
  expect(shouldWrite(last, 1250, "x", "y")).toBe(true);
  expect(shouldWrite(last, 1999, "c", "y")).toBe(false);
  expect(shouldWrite(last, 2000, "c", "y")).toBe(true);

  const c = chain(),
    writes: any[] = [];
  let now = 1_000_000;
  const reader = new StateReader(c.rpc, "", { ws: new FakeWs(), now: () => now, write: (v) => writes.push(JSON.parse(json(v))), logger: quiet });
  await reader.refresh();
  expect(reader.tick()).toBe(true);
  reader.onSlot(5000, now);
  now = 1_000_100;
  expect(reader.tick()).toBe(false);
  now = 1_000_249;
  expect(reader.tick()).toBe(false);
  now = 1_000_250;
  expect(reader.tick()).toBe(true);
  for (now = 1_000_300; now < 1_001_250; now += 50) expect(reader.tick()).toBe(false);
  now = 1_001_250;
  expect(reader.tick()).toBe(true);
  expect(reader.tick()).toBe(false);
  now = 1_000_900; // a clock stepping back cannot rewrite an earlier or equal generated time
  expect(reader.tick()).toBe(false);
  now = 1_001_400;
  reader.onSlot(5001, now);
  expect(reader.tick()).toBe(false);
  now = 1_001_500;
  expect(reader.tick()).toBe(true);
  expect(writes.map((w) => w.generated)).toEqual([1_000_000, 1_000_250, 1_001_250, 1_001_500]);
  const strip = ({ generated, ...rest }: any) => rest;
  expect(strip(writes[1])).not.toEqual(strip(writes[0]));
  expect(strip(writes[2])).toEqual(strip(writes[1]));
  expect([writes[0].slot, writes[1].slot, writes[3].slot]).toEqual(["1000", "5000", "5001"]);
  expect(new Set(writes.map((w) => JSON.stringify(w))).size).toBe(writes.length);
});

it("S7 a failure in state work is logged as state-error and leaves the reader running", async () => {
  const c = chain(),
    logs: any[] = [];
  let fail = true;
  const rpc = {
    cluster: "devnet" as const,
    call: async (m: string, p: unknown[] = []) => {
      if (fail && m === "getProgramAccounts") throw new Error("RPC getProgramAccounts: error -32000 at https://rpc.invalid/key");
      return c.handle(m, p as any[]);
    },
  };
  const reader = new StateReader(rpc, "", { ws: new FakeWs(), now: () => 1000, write: quiet, logger: (e) => logs.push(e) });
  await reader.refresh();
  expect(reader.ready()).toBe(false);
  expect(reader.status()).toEqual({ ready: true, endpoint: "public", houses: 0, tables: 0, ageMs: null });
  expect(logs.filter((e) => e.event === "state-error").map((e) => e.error)).toEqual(Array(2).fill("RPC getProgramAccounts: error -32000 at [endpoint]"));
  fail = false;
  await reader.refresh();
  expect(reader.ready()).toBe(true);
  expect(reader.status()).toEqual({ ready: true, endpoint: "public", houses: 2, tables: 2, ageMs: 0 });
  let thrown = 0;
  const broken = new StateReader(c.rpc, "", { ws: new FakeWs(), now: () => 1000, write: () => { thrown++; throw new Error("disk full"); }, logger: (e) => logs.push(e) });
  await broken.refresh();
  expect(broken.tick()).toBe(false);
  expect(thrown).toBe(1);
  expect(logs.at(-1)).toEqual({ event: "state-error", error: "disk full" });
});

it("S8 RUIN row paths: event ends, dp per market, interior records strictly between, two ends without records", () => {
  const base = { p0: "18000000000", pEnd: "17982000000", fillPublishTs: "1792000000", endPublishTs: "1792000010" };
  const samples = [
    { publish_ts: 1792000000, price: "18500000000" },
    { publish_ts: 1792000003, price: "18012345678" },
    { publish_ts: 1792000005, price: "17990000049" },
    { publish_ts: 1792000010, price: "17000000000" },
  ];
  expect(ruinPath({ ...base, market: "0" }, samples)).toEqual({ dp: 4, ts: "0,3,2,5", q: "1800000,1235,-2235,-800" });
  expect(ruinPath({ ...base, market: "1" }, [])).toEqual({ dp: 2, ts: "0,10", q: "18000,-18" });
  expect(ruinPath({ ...base, market: "2" }, [])).toEqual({ dp: 3, ts: "0,10", q: "180000,-180" });
  const long = Array.from({ length: 1000 }, (_, i) => ({ publish_ts: 1792000000 + 1 + i, price: String(18000000000 + i) }));
  const path = ruinPath({ ...base, market: "0", endPublishTs: "1792001001" }, long);
  const ts = undelta(path.ts),
    q = undelta(path.q);
  expect(ts.length).toBe(300);
  expect([ts[0], ts.at(-1), q[0], q.at(-1)]).toEqual([0n, 1001n, 1800000n, 1798200n]);
});

it("S9 tape.json RUIN rows gain dp, ts and q once per signature and event; other fields and status counts stay", () => {
  const s = new Store(":memory:"),
    dir = mkdtempSync(resolve(tmpdir(), "ruin-tape-"));
  try {
    const event = {
      table: key(), house: key(), seq: "0", trader: key(), owner: key(), market: "0", side: "0", lev: "1000", m: "5000000", k: "10", eBps: "700",
      p0: "18000000000", fillSlot: "900", fillPublishTs: "1792000000", fillTs: "1792000001", end: "1", pEnd: "17982000000",
      endPublishTs: "1792000010", endSlot: "940", endTs: "1792000011", fE9: "1000000000", a: "0", b: "105000000", stakeAfter: "105000000",
      sig: "sig-one", houseId: "1", feed: devFeeds[0],
    };
    const quiet2 = { ...event, sig: "sig-two", market: "2", p0: "390000000000", pEnd: "389000000000", endSlot: "930" };
    s.db.prepare("INSERT INTO ruin VALUES(?,?,?,?)").run("sig-one", 0, 940, JSON.stringify(event));
    s.db.prepare("INSERT INTO ruin VALUES(?,?,?,?)").run("sig-two", 2, 930, JSON.stringify(quiet2));
    const dove = s.db.prepare("INSERT INTO doves(market,publish_ts,price,slot,recv_ms,connection) VALUES(?,?,?,?,?,?)");
    dove.run("SOL", 1792000000, "18500000000", 1, 0, "c");
    dove.run("SOL", 1792000003, "18012345678", 2, 0, "c");
    dove.run("SOL", 1792000005, "17990000049", 3, 0, "c");
    dove.run("SOL", 1792000010, "17000000000", 4, 0, "c");
    dove.run("BTC", 1792000004, "10900000000000", 5, 0, "c");
    const metrics = { metrics: { snapshot: () => ({ methods: {} }) } };
    const state = { ready: true, endpoint: "public", houses: 5, tables: 0, ageMs: 12 };
    const p = new Publisher(s, dir, { lastPollMs: 0 } as any, metrics as any, { ...metrics, cluster: "devnet" } as any, () => state);
    p.publish(1792000100);
    const tape = JSON.parse(readFileSync(resolve(dir, "tape.json"), "utf8"));
    expect(Object.keys(tape)).toEqual(["v", "generated", "k", "e_bps", "span", "w0", "rows", "ruin", "refunds"]);
    expect(tape.rows).toEqual([]);
    expect(tape.ruin).toEqual([
      { ...event, dp: 4, ts: "0,3,2,5", q: "1800000,1235,-2235,-800" },
      { ...quiet2, dp: 3, ts: "0,10", q: "3900000,-10000" },
    ]);
    // Computed once: a record arriving later does not change the published path.
    dove.run("SOL", 1792000007, "18100000000", 6, 0, "c");
    expect(p.ruinRow("sig-one", 0, event)).toEqual(tape.ruin[0]);
    // status.json gains state after ruin; the counts1h equality holds.
    s.db.prepare("INSERT INTO trades VALUES(?,?,?,?,?)").run("x1", 1, 1792000050, "close", "{}");
    s.db.prepare("INSERT INTO trades VALUES(?,?,?,?,?)").run("x2", 2, 1792000060, "liquidate", "{}");
    s.db.prepare("INSERT INTO results VALUES(?,?,?,?,?,?)").run("x1", 1792000050, "rows", null, null, null);
    const status = p.status(1792000100);
    expect(Object.keys(status)).toEqual(["v", "generated", "cluster", "program", "doves", "yolo", "ruin", "state", "http", "counts1h", "rpc1h"]);
    expect(JSON.parse(readFileSync(resolve(dir, "status.json"), "utf8")).state).toEqual(state);
    const n = status.counts1h;
    expect([n.exits, n.rows, n.pending]).toEqual([2, 1, 1]);
    expect(n.exits).toBe(n.rows + n.pending + n.unmatched + n.noRecord + n.unresolved + n.expired);
    const failing = new Publisher(s, dir, { lastPollMs: 0 } as any, metrics as any, { ...metrics, cluster: "devnet" } as any, () => { throw new Error("state unavailable"); });
    expect(failing.status(1792000100).state).toBeNull();
  } finally {
    s.close();
    rmSync(dir, { recursive: true });
  }
});

it("S10 HTTP serves /state.json with max-age=1; other paths, methods and headers stay as before", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "ruin-http-")),
    server = httpServer(dir);
  await new Promise<void>((yes, no) => {
    server.once("error", no);
    server.listen(0, "127.0.0.1", yes);
  });
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    expect((await fetch(`${url}/state.json`)).status).toBe(503);
    for (const f of ["tape.json", "window.json", "status.json", "state.json"]) atomicFile(dir, f, { v: 1, name: f });
    for (const f of ["tape.json", "window.json", "status.json", "state.json"]) {
      const response = await fetch(`${url}/${f}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(response.headers.get("cache-control")).toBe(f === "state.json" ? "public, max-age=1" : "public, max-age=2");
      expect(Buffer.from(await response.arrayBuffer())).toEqual(readFileSync(resolve(dir, f)));
      const cached = await fetch(`${url}/${f}`, { headers: { "if-none-match": response.headers.get("etag")! } });
      expect(cached.status).toBe(304);
      expect(cached.headers.get("cache-control")).toBe(f === "state.json" ? "public, max-age=1" : "public, max-age=2");
    }
    for (const path of ["/missing", "/state.json?x=1", "/state", "/public/state.json", "/"]) expect([path, (await fetch(url + path)).status]).toEqual([path, 404]);
    for (const method of ["POST", "PUT", "DELETE"]) {
      for (const f of ["tape.json", "state.json"]) {
        const response = await fetch(`${url}/${f}`, { method });
        expect([method, f, response.status, response.headers.get("allow")]).toEqual([method, f, 405, "GET, HEAD"]);
      }
    }
  } finally {
    server.closeAllConnections();
    server.close();
    rmSync(dir, { recursive: true });
  }
});

async function rpcServer(handle: (method: string, params: any[]) => any) {
  const server = createServer(async (req, res) => {
    let data = "";
    for await (const x of req) data += x;
    const b = JSON.parse(data);
    let result: any, error: any;
    try {
      result = handle(b.method, b.params ?? []);
    } catch (e) {
      error = { code: -32601, message: String(e) };
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: b.id, ...(error ? { error } : { result }) }));
  });
  await new Promise<void>((yes) => server.listen(0, "127.0.0.1", yes));
  return {
    url: `http://127.0.0.1:${(server.address() as any).port}`,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}
async function socketServer() {
  const http = createServer(),
    wss = new WebSocketServer({ noServer: true }),
    subs = new Map<number, { method: string; params: any[]; ws: any }>();
  let next = 100;
  http.on("upgrade", (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws: any) => wss.emit("connection", ws)));
  wss.on("connection", (ws: any) => {
    ws.on("message", (data: any) => {
      const b = JSON.parse(String(data));
      if (b.method.endsWith("Unsubscribe")) {
        subs.delete(b.params[0]);
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: b.id, result: true }));
        return;
      }
      const id = next++;
      subs.set(id, { method: b.method, params: b.params, ws });
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: b.id, result: id }));
    });
    ws.once("close", () => {
      for (const [id, s] of subs) if (s.ws === ws) subs.delete(id);
    });
  });
  await new Promise<void>((yes) => http.listen(0, "127.0.0.1", yes));
  return {
    url: `ws://127.0.0.1:${(http.address() as any).port}`,
    subs,
    notify(match: (s: { method: string; params: any[] }) => boolean, result: any) {
      for (const [id, s] of subs)
        if (match(s))
          s.ws.send(JSON.stringify({ jsonrpc: "2.0", method: s.method.replace("Subscribe", "Notification"), params: { subscription: id, result } }));
    },
    close: async () => {
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((yes) => wss.close(() => http.close(() => yes())));
    },
  };
}
async function until(predicate: () => boolean, timeout = 8000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("Local condition timed out");
    await sleep(20);
  }
}

it("S11 actual pool and WebSocket: a read after ready, notifications, closed accounts, prices and slotMs reach state.json", async () => {
  const c = chain(),
    logs: any[] = [],
    dir = mkdtempSync(resolve(tmpdir(), "ruin-state-live-")),
    http = await rpcServer((m, p) => c.handle(m, p)),
    sockets = await socketServer();
  const pool = new RpcPool("devnet", [{ name: "public", url: http.url, ws: sockets.url }], fetch, (e) => logs.push(e));
  await pool.initialize();
  const reader = new StateReader(pool, dir, { logger: (e) => logs.push({ at: Date.now(), ...e }) });
  const slots = setInterval(() => {
    c.state.slot++;
    sockets.notify((s) => s.method === "slotSubscribe", { slot: c.state.slot, parent: c.state.slot - 1, root: c.state.slot - 32 });
  }, 100);
  const file = () => (existsSync(resolve(dir, "state.json")) ? JSON.parse(readFileSync(resolve(dir, "state.json"), "utf8")) : undefined);
  try {
    await reader.start();
    await until(() => reader.ws.ready && file() !== undefined);
    const ready = logs.find((e) => e.event === "subscription-ready")!;
    expect(ready).toMatchObject({ endpoint: "public", scope: "state" });
    // Both scans run again after the subscription became ready.
    await until(() => c.calls.filter((x) => x.method === "getProgramAccounts" && x.at >= ready.at).length >= 2);
    expect([...sockets.subs.values()].map((s) => s.method).sort()).toEqual(["accountSubscribe", "accountSubscribe", "accountSubscribe", "accountSubscribe", "programSubscribe", "programSubscribe", "slotSubscribe"]);
    expect(file()!.houses.length).toBe(2);
    const house3 = key();
    c.put(house3, houseData(3n, c.ids.owner, { market: 2 }));
    sockets.notify(
      (s) => s.method === "programSubscribe" && s.params[1].filters[0].memcmp.bytes === houseBytes,
      { context: { slot: c.state.slot }, value: { pubkey: house3, account: raw({ data: houseData(3n, c.ids.owner, { market: 2 }), owner: program, lamports: 1 }) } },
    );
    await until(() => file()!.houses.length === 3);
    c.accounts.delete(c.ids.table1);
    expect(file()!.houses[2]).toMatchObject({ address: house3, id: "3", market: 2 });
    sockets.notify(
      (s) => s.method === "programSubscribe" && s.params[1].filters[0].memcmp.bytes === tableBytes,
      { context: { slot: c.state.slot }, value: { pubkey: c.ids.table1, account: { data: ["", "base64"], executable: false, lamports: 0, owner: SYSTEM, rentEpoch: 0, space: 0 } } },
    );
    await until(() => file()!.tables.length === 1);
    expect(file()!.tables[0].address).toBe(c.ids.table2);
    c.put(devFeeds[0], feedData(0, 18200000000n, 1792000009n));
    sockets.notify(
      (s) => s.method === "accountSubscribe" && s.params[0] === devFeeds[0],
      { context: { slot: c.state.slot }, value: raw({ data: feedData(0, 18200000000n, 1792000009n), owner: program, lamports: 1 }) },
    );
    await until(() => file()!.feeds[0].price === "18200000000");
    expect(undelta(file()!.feeds[0].hist.p)).toEqual([PRICES[0], 18200000000n]);
    await sleep(1200);
    const s = file()!;
    expect(s.slotMs).toBeGreaterThan(80);
    expect(s.slotMs).toBeLessThan(130);
    expect(Number(s.slot)).toBeGreaterThan(1010);
    expect(Date.now() - s.generated).toBeLessThan(1300);
    expect(reader.status()).toMatchObject({ ready: true, endpoint: "public", houses: 3, tables: 1 });
    expect(reader.status().ageMs).toBeGreaterThanOrEqual(0);
    expect(logs.filter((e) => e.event === "state-error")).toEqual([]);
    expect(JSON.stringify(logs)).not.toContain("127.0.0.1");
  } finally {
    clearInterval(slots);
    reader.close();
    pool.close();
    http.close();
    await sockets.close();
    rmSync(dir, { recursive: true });
  }
}, 20000);


it("successful read ages freeze the heartbeat after twelve seconds and unchanged reads recover it", async () => {
  vi.useFakeTimers({ now: 1792720000000, toFake: ["Date"] });
  const c = chain(), ws = new FakeWs(), writes: any[] = [];
  const reader = new StateReader(c.rpc, "", { ws, write: v => writes.push(v), logger: quiet });
  try {
    await reader.refresh(); expect(reader.tick()).toBe(true);
    const call = c.rpc.call; c.rpc.call = async () => { throw Error("unavailable"); };
    for (let i = 1; i <= 12; i++) { vi.setSystemTime(1792720000000 + i * 1000); await reader.refresh(); reader.tick(); }
    vi.setSystemTime(1792720012001); expect(reader.tick()).toBe(false);
    const n = writes.length; vi.setSystemTime(1792720016000); expect(reader.tick()).toBe(false); expect(writes).toHaveLength(n);
    c.rpc.call = call; await reader.refresh(); expect(reader.tick()).toBe(true);
    vi.setSystemTime(1792720017000); await reader.refresh(); expect(reader.tick()).toBe(true);
  } finally { reader.close(); vi.useRealTimers(); }
});

it("lock vault presence matches both on-chain conditions without an extra RPC", async () => {
  const c = chain(), ws = new FakeWs(), reader = new StateReader(c.rpc, "", { ws, write: quiet, logger: quiet });
  const [key1, key2] = [c.ids.house1, c.ids.house2], bump = (await r.findLockVaultPda(address(key2)))[1];
  c.accounts.set(key1, { data: houseData(1n, c.ids.owner, { ruinLocked: 1n, lockVaultBump: 0 }), owner: program, lamports: 1 });
  c.accounts.set(key2, { data: houseData(2n, c.ids.owner, { ruinLocked: 0n, lockVaultBump: bump }), owner: program, lamports: 1 });
  await reader.refresh(); expect(reader.content(Date.now()).houses.map(h => h.lockVault)).toEqual([true, true]);
  c.accounts.set(key2, { data: houseData(2n, c.ids.owner, { ruinLocked: 0n, lockVaultBump: bump ^ 1 }), owner: program, lamports: 1 });
  await reader.readProgram("house"); expect(reader.content(Date.now()).houses[1].lockVault).toBe(false); reader.close();
});
