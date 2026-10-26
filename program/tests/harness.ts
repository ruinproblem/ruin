import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect } from "vitest";
import { LiteSVM, FailedTransactionMetadata } from "litesvm";
import {
  address,
  generateKeyPairSigner,
  getAddressEncoder,
  getAddressDecoder,
  getProgramDerivedAddress,
  lamports,
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  signTransactionMessageWithSigners,
  getCompiledTransactionMessageDecoder,
  getBase58Decoder,
  type Address,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import * as token from "@solana-program/token-2022";
import {
  getCreateAssociatedTokenIdempotentInstructionAsync,
  findAssociatedTokenPda,
} from "@solana-program/token";
import { getCreateAccountInstruction } from "@solana-program/system";
import * as r from "../client/src/generated/index.js";
import {
  TOKEN,
  TOKEN_2022,
  LOADER,
  FEEDS,
  USDC,
  JUPUSD,
  DOVES,
} from "../client/constants.js";
import { decodeEvents } from "../client/events.js";
import {
  findConfigPda,
  findHousePda,
  findHouseVaultPda,
  findLockVaultPda,
  findTablePda,
} from "../client/pdas.js";
export { r, TOKEN, TOKEN_2022, FEEDS, USDC, JUPUSD, DOVES };
export const PROGRAM = r.RUIN_PROGRAM_ADDRESS;
export const json = (v: unknown) =>
  JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));
export type Wallet = Awaited<ReturnType<typeof generateKeyPairSigner>>;
export type HouseRef = {
  id: bigint;
  house: Address;
  vault: Address;
  lockVault: Address;
};
export type TableRef = HouseRef & { table: Address; seq: bigint };
export const accountData = (s: LiteSVM, a: Address) => {
  const x = s.getAccount(a);
  if (!x.exists) throw new Error(`Missing ${a}`);
  return Buffer.from(x.data);
};
export const amount = (s: LiteSVM, a: Address) =>
  s.getAccount(a).exists ? accountData(s, a).readBigUInt64LE(64) : 0n;
export const ata = async (
  owner: Address,
  mint: Address,
  program: Address = TOKEN,
) => (await findAssociatedTokenPda({ owner, mint, tokenProgram: program }))[0];
export const DEFAULT_PARAMS = {
  mMin: 1000000n,
  freeStake: 100000000n,
  ruinPerUsd: 0n,
  delayMin: 10,
  delayMax: 23,
  fillWindow: 4,
  closeWindow: 4,
  staleSecs: 30,
};
export const measurements: Record<string, string[]> = {};
export const accountMeasurements: Record<
  string,
  { bytes: number; rent: string }
> = {};
export const eventSamples: Record<string, unknown> = {};
export class Harness {
  svm = new LiteSVM().withTransactionHistory(0n);
  admin!: Wallet;
  owner!: Wallet;
  trader!: Wallet;
  stranger!: Wallet;
  config!: Address;
  programData!: Address;
  eventAuthority!: Address;
  quote: Address = USDC;
  ruinMint!: Address;
  ruinProgram: Address = TOKEN;
  ownerQuote!: Address;
  traderQuote!: Address;
  ownerRuin!: Address;
  events: ReturnType<typeof decodeEvents> = [];
  lastFee = 0n;
  createSigner: () => Promise<Wallet> = generateKeyPairSigner;
  static async create(
    o: {
      initialize?: boolean;
      quote?: Address;
      ruinProgram?: Address;
      binary?: string;
      createSigner?: () => Promise<Wallet>;
    } = {},
  ) {
    const h = new Harness();
    h.createSigner = o.createSigner ?? generateKeyPairSigner;
    const manifest = JSON.parse(
      readFileSync(
        new URL("./fixtures/manifest.json", import.meta.url),
        "utf8",
      ),
    );
    for (const row of manifest.programs) {
      const bytes = readFileSync(
        new URL(`./fixtures/${row.file}`, import.meta.url),
      );
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(row.sha256);
      h.svm.addProgram(address(row.program), bytes);
    }
    h.svm.addProgramWithLoader(
      PROGRAM,
      readFileSync(
        new URL(o.binary ?? "../target/deploy/ruin.so", import.meta.url),
      ),
      LOADER,
    );
    [h.admin, h.owner, h.trader, h.stranger] = await Promise.all(
      Array.from({ length: 4 }, () => h.createSigner()),
    );
    for (const w of [h.admin, h.owner, h.trader, h.stranger])
      h.svm.airdrop(w.address, lamports(100000000000n));
    h.programData = (
      await getProgramDerivedAddress({
        programAddress: LOADER,
        seeds: [getAddressEncoder().encode(PROGRAM)],
      })
    )[0];
    const pd = h.svm.getAccount(h.programData);
    if (!pd.exists) throw new Error("Missing ProgramData");
    const d = Buffer.from(pd.data);
    d[12] = 1;
    d.set(getAddressEncoder().encode(h.admin.address), 13);
    h.svm.setAccount({ ...pd, data: d });
    h.config = (await findConfigPda())[0];
    h.eventAuthority = (
      await getProgramDerivedAddress({
        programAddress: PROGRAM,
        seeds: ["__event_authority"],
      })
    )[0];
    const fixtureBytes = readFileSync(
      new URL("./fixtures/accounts/accounts.json", import.meta.url),
    );
    expect(createHash("sha256").update(fixtureBytes).digest("hex")).toBe(
      manifest.accounts.sha256,
    );
    const fixtures = JSON.parse(fixtureBytes.toString());
    for (const [key, raw] of Object.entries(fixtures.accounts) as [
      string,
      any,
    ][]) {
      const data = Buffer.from(raw.data[0], "base64");
      if (key === USDC || key === JUPUSD)
        data.set(getAddressEncoder().encode(h.admin.address), 4);
      h.svm.setAccount({
        address: address(key),
        programAddress: address(raw.owner),
        executable: false,
        lamports: lamports(BigInt(raw.lamports)),
        data,
        space: BigInt(data.length),
      });
    }
    h.clock(1000n, 1000n);
    for (const f of FEEDS) h.price(10677218000n, 1000n, f);
    h.quote = o.quote ?? USDC;
    h.ruinProgram = o.ruinProgram ?? TOKEN;
    h.ownerQuote = await h.fundToken(
      h.owner,
      h.quote,
      TOKEN,
      1000000000000000n,
    );
    h.traderQuote = await h.fundToken(
      h.trader,
      h.quote,
      TOKEN,
      1000000000000000n,
    );
    h.ruinMint = await h.createMint(
      h.ruinProgram,
      h.ruinProgram === TOKEN_2022 ? "metadata" : "classic",
    );
    h.ownerRuin = await h.fundToken(
      h.owner,
      h.ruinMint,
      h.ruinProgram,
      1000000000000000000n,
    );
    if (o.initialize !== false) await h.send("init", h.initIx(), h.admin);
    return h;
  }
  eventAccounts() {
    return { eventAuthority: this.eventAuthority, program: PROGRAM };
  }
  initIx(overrides: Record<string, any> = {}) {
    return r.getInitInstruction({
      authority: this.admin,
      deployment: PROGRAM,
      programData: this.programData,
      config: this.config,
      quoteMint: this.quote,
      solFeed: FEEDS[0],
      btcFeed: FEEDS[1],
      ethFeed: FEEDS[2],
      admin: this.admin.address,
      levMin: 500,
      levMax: 1000,
      kMin: 2,
      kMax: 20,
      eMinBps: 0,
      eMaxBps: 2000,
      expirySecs: 86400,
      ...DEFAULT_PARAMS,
      ...this.eventAccounts(),
      ...overrides,
      ...overrides.args,
      ...overrides.args?.params,
    });
  }
  paramsIx(
    params: Record<string, any> = {},
    admin: TransactionSigner = this.admin,
  ) {
    return r.getSetParamsInstruction({
      admin,
      config: this.config,
      ...DEFAULT_PARAMS,
      ...params,
      ...this.eventAccounts(),
    });
  }
  ruinIx(mint = this.ruinMint, admin: TransactionSigner = this.admin) {
    return r.getSetRuinInstruction({
      admin,
      config: this.config,
      ruinMint: mint,
      ...this.eventAccounts(),
    });
  }
  configState() {
    return r.getConfigDecoder().decode(accountData(this.svm, this.config));
  }
  houseState(h: HouseRef) {
    return r.getHouseDecoder().decode(accountData(this.svm, h.house));
  }
  tableState(t: TableRef) {
    return r.getTableDecoder().decode(accountData(this.svm, t.table));
  }
  clock(slot: bigint, ts: bigint = 1000n) {
    const c = this.svm.getClock();
    c.slot = slot;
    c.unixTimestamp = ts;
    this.svm.setClock(c);
  }
  hash(slot: bigint, value: bigint = 0n) {
    const b = Buffer.alloc(32);
    b.writeBigUInt64LE(value);
    const now = this.svm.getClock().slot;
    this.svm.setSlotHashes(
      Array.from({ length: 512 }, (_, i) => {
        const s = now - 1n - BigInt(i);
        return {
          slot: s,
          hash: getBase58Decoder().decode(s === slot ? b : Buffer.alloc(32)),
        };
      }),
    );
  }
  price(price: bigint, publishTs: bigint, feed: Address = FEEDS[0]) {
    const a = this.svm.getAccount(feed);
    if (!a.exists) throw new Error("Missing feed");
    const d = Buffer.from(a.data);
    d.writeBigUInt64LE(price, 168);
    d.writeBigInt64LE(publishTs, 177);
    this.svm.setAccount({ ...a, data: d });
  }
  async ref(id = this.configState().nextHouseId): Promise<HouseRef> {
    const house = (await findHousePda(id))[0];
    return {
      id,
      house,
      vault: (await findHouseVaultPda(house))[0],
      lockVault: (await findLockVaultPda(house))[0],
    };
  }
  lockAccounts(h: HouseRef, on = true) {
    return on
      ? {
          ruinMint: this.ruinMint,
          ruinTokenProgram: this.ruinProgram,
          lockVault: h.lockVault,
          ruinAccount: this.ownerRuin,
        }
      : {
          ruinMint: undefined,
          ruinTokenProgram: undefined,
          lockVault: undefined,
          ruinAccount: undefined,
        };
  }
  postIx(h: HouseRef, overrides: Record<string, any> = {}) {
    return r.getPostHouseInstruction({
      config: this.config,
      owner: this.owner,
      house: h.house,
      quoteMint: this.quote,
      vault: h.vault,
      source: this.ownerQuote,
      tokenProgram: TOKEN,
      id: h.id,
      market: 0,
      sides: 3,
      k: 10,
      eBps: 700,
      stake: 100000000n,
      ruinAmount: 0n,
      ...this.lockAccounts(h, false),
      ...this.eventAccounts(),
      ...overrides,
    });
  }
  async post(overrides: Record<string, any> = {}) {
    const h = await this.ref();
    await this.send("post_house", this.postIx(h, overrides), this.owner);
    return h;
  }
  fundIx(h: HouseRef, withdraw = false, overrides: Record<string, any> = {}) {
    const input = {
      config: this.config,
      house: h.house,
      owner: this.owner,
      quoteMint: this.quote,
      vault: h.vault,
      source: this.ownerQuote,
      destination: this.ownerQuote,
      tokenProgram: TOKEN,
      quoteAmount: 1n,
      ruinAmount: 0n,
      ...this.lockAccounts(h, this.svm.getAccount(h.lockVault).exists),
      ...this.eventAccounts(),
      ...overrides,
    };
    return withdraw
      ? r.getWithdrawInstruction(input)
      : r.getTopUpInstruction(input);
  }
  closeIx(h: HouseRef, overrides: Record<string, any> = {}) {
    return r.getCloseHouseInstruction({
      config: this.config,
      house: h.house,
      owner: this.owner,
      quoteMint: this.quote,
      vault: h.vault,
      destination: this.ownerQuote,
      tokenProgram: TOKEN,
      ...this.lockAccounts(h, this.svm.getAccount(h.lockVault).exists),
      ...this.eventAccounts(),
      ...overrides,
    });
  }
  acceptingIx(h: HouseRef, accepting: boolean) {
    return r.getSetAcceptingInstruction({
      owner: this.owner,
      house: h.house,
      accepting,
      ...this.eventAccounts(),
    });
  }
  async tableRef(h: HouseRef): Promise<TableRef> {
    const seq = this.houseState(h).nextSeq;
    return { ...h, seq, table: (await findTablePda(h.house, seq))[0] };
  }
  requestIx(t: TableRef, overrides: Record<string, any> = {}) {
    return r.getRequestOpenInstruction({
      config: this.config,
      house: t.house,
      trader: this.trader,
      table: t.table,
      quoteMint: this.quote,
      vault: t.vault,
      source: this.traderQuote,
      tokenProgram: TOKEN,
      feed: FEEDS[this.houseState(t).market],
      side: r.Side.Long,
      lev: 1000,
      m: 10000000n,
      ...this.eventAccounts(),
      ...overrides,
    });
  }
  async request(h: HouseRef, overrides: Record<string, any> = {}) {
    const t = await this.tableRef(h);
    await this.send("request_open", this.requestIx(t, overrides), this.trader);
    return t;
  }
  fillIx(t: TableRef, overrides: Record<string, any> = {}) {
    return r.getFillOpenInstruction({
      config: this.config,
      house: t.house,
      table: t.table,
      feed: FEEDS[this.houseState(t).market],
      ...this.eventAccounts(),
      ...overrides,
    });
  }
  async fill(t: TableRef, price = 10677218000n, hash = 0n, edge = 0n) {
    const state = this.tableState(t);
    const d = 10n + (hash % 14n);
    this.clock(state.requestSlot + d + edge, 1002n);
    this.hash(state.requestSlot, hash);
    this.price(price, 1002n, FEEDS[state.market]);
    await this.send("fill_open", this.fillIx(t), this.stranger);
  }
  refundIx(t: TableRef, overrides: Record<string, any> = {}) {
    return r.getRefundOpenInstruction({
      config: this.config,
      house: t.house,
      table: t.table,
      quoteMint: this.quote,
      vault: t.vault,
      destination: this.traderQuote,
      trader: this.trader.address,
      tokenProgram: TOKEN,
      ...this.eventAccounts(),
      ...overrides,
    });
  }
  requestCloseIx(t: TableRef, overrides: Record<string, any> = {}) {
    return r.getRequestCloseInstruction({
      config: this.config,
      house: t.house,
      table: t.table,
      trader: this.trader,
      feed: FEEDS[this.houseState(t).market],
      ...this.eventAccounts(),
      ...overrides,
    });
  }
  settleIx(t: TableRef, overrides: Record<string, any> = {}) {
    return r.getSettleInstruction({
      config: this.config,
      house: t.house,
      table: t.table,
      quoteMint: this.quote,
      vault: t.vault,
      trader: this.trader.address,
      tokenProgram: TOKEN,
      feed: FEEDS[this.houseState(t).market],
      ...this.eventAccounts(),
      ...overrides,
      destination:
        overrides.destination === null
          ? undefined
          : (overrides.destination ?? this.traderQuote),
    });
  }
  totals() {
    const balances: Record<string, bigint> = {};
    for (const p of [TOKEN, TOKEN_2022])
      for (const a of this.svm.getProgramAccounts(p)) {
        const d = Buffer.from(a.data);
        if (d.length === 165 || (d.length >= 166 && d[165] === 2)) {
          const mint = getAddressDecoder().decode(d.subarray(0, 32));
          balances[mint] = (balances[mint] ?? 0n) + d.readBigUInt64LE(64);
        }
      }
    return balances;
  }
  async transaction(ixs: readonly Instruction[], payer: TransactionSigner) {
    this.svm.expireBlockhash();
    return signTransactionMessageWithSigners(
      pipe(
        createTransactionMessage({ version: 0 }),
        (x) => setTransactionMessageFeePayerSigner(payer, x),
        (x) =>
          setTransactionMessageLifetimeUsingBlockhash(
            {
              blockhash: this.svm.latestBlockhash(),
              lastValidBlockHeight: 10n ** 12n,
            },
            x,
          ),
        (x) => appendTransactionMessageInstructions(ixs, x),
      ),
    );
  }
  async send(
    label: string,
    input: Instruction | readonly Instruction[],
    payer: TransactionSigner = this.stranger,
    failure?: string,
  ) {
    const ixs = Array.isArray(input) ? input : [input as Instruction],
      tx = await this.transaction(ixs, payer),
      keys = getCompiledTransactionMessageDecoder().decode(
        tx.messageBytes,
      ).staticAccounts,
      before = keys.map((k) => this.svm.getAccount(k)),
      totals = this.totals();
    const result = this.svm.sendTransaction(tx);
    this.lastFee = keys.reduce((n, key, i) => {
      const a = this.svm.getAccount(key),
        b = before[i];
      return n + (b.exists ? b.lamports : 0n) - (a.exists ? a.lamports : 0n);
    }, 0n);
    if (failure !== undefined) {
      expect(result, label).toBeInstanceOf(FailedTransactionMetadata);
      if (!(result instanceof FailedTransactionMetadata))
        throw new Error("Expected failure");
      if (failure)
        expect(result.meta().logs().join("\n"), label).toContain(
          `Error Code: ${failure}.`,
        );
      keys.forEach((key, i) => {
        const a = this.svm.getAccount(key),
          b = before[i];
        expect(a.exists, `${label}:${key}`).toBe(b.exists);
        if (a.exists && b.exists) {
          expect(Buffer.from(a.data).equals(Buffer.from(b.data)), label).toBe(
            true,
          );
          if (key !== payer.address) expect(a.lamports, label).toBe(b.lamports);
        }
      });
      expect(this.totals()).toEqual(totals);
      return result.meta();
    }
    if (result instanceof FailedTransactionMetadata)
      throw new Error(
        `${label}: ${String(result.err())}\n${result.meta().logs().join("\n")}`,
      );
    this.lastFee = keys.reduce((n, key, i) => {
      const a = this.svm.getAccount(key),
        b = before[i];
      return n + (b.exists ? b.lamports : 0n) - (a.exists ? a.lamports : 0n);
    }, 0n);
    if (ixs.some((i) => i.programAddress === PROGRAM)) {
      expect(this.totals(), `${label}:conservation`).toEqual(totals);
      this.events = decodeEvents(
        result
          .innerInstructions()
          .flat()
          .map((i) => ({
            programAddress: keys[i.instruction().programIdIndex()],
            data: i.instruction().data(),
          })),
      );
      expect(this.events).toHaveLength(
        ixs.filter((i) => i.programAddress === PROGRAM).length,
      );
      const own = ixs.filter((i) => i.programAddress === PROGRAM);
      this.events.forEach((e, i) =>
        this.verifyEvent(
          e,
          own[i],
          new Map(keys.map((key, i) => [key, before[i]])),
        ),
      );
      for (const e of this.events) eventSamples[e.name] ??= e.data;
      (measurements[label] ??= []).push(
        result.computeUnitsConsumed().toString(),
      );
    }
    return result;
  }
  measure(name: string, a: Address) {
    const x = this.svm.getAccount(a);
    if (!x.exists) throw new Error("Missing measurement");
    accountMeasurements[name] = {
      bytes: x.data.length,
      rent: x.lamports.toString(),
    };
  }
  verifyEvent(
    event: ReturnType<typeof decodeEvents>[number],
    ix: Instruction,
    prior: Map<Address, ReturnType<LiteSVM["getAccount"]>>,
  ) {
    const getPrior = (a: Address) => {
      const p = prior.get(a);
      if (!p?.exists) throw new Error(`Missing prior ${a}`);
      return Buffer.from(p.data);
    };
    const getPriorAmount = (a: Address) => {
      const p = prior.get(a);
      return p?.exists ? Buffer.from(p.data).readBigUInt64LE(64) : 0n;
    };
    const now = this.svm.getClock();
    switch (event.name) {
      case "Initialized": {
        const c = this.configState();
        expect(event.data).toEqual({
          admin: c.admin,
          quoteMint: c.quoteMint,
          markets: c.markets,
          levMin: c.levMin,
          levMax: c.levMax,
          kMin: c.kMin,
          kMax: c.kMax,
          eMinBps: c.eMinBps,
          eMaxBps: c.eMaxBps,
          expirySecs: c.expirySecs,
          mMin: c.mMin,
          freeStake: c.freeStake,
          ruinPerUsd: c.ruinPerUsd,
          delayMin: c.delayMin,
          delayMax: c.delayMax,
          fillWindow: c.fillWindow,
          closeWindow: c.closeWindow,
          staleSecs: c.staleSecs,
        });
        break;
      }
      case "RuinSet": {
        const c = this.configState();
        expect(c.ruinMint).toEqual({
          __option: "Some",
          value: event.data.ruinMint,
        });
        expect(c.ruinTokenProgram).toEqual({
          __option: "Some",
          value: event.data.ruinTokenProgram,
        });
        break;
      }
      case "ParamsSet": {
        const c = this.configState();
        for (const [k, v] of Object.entries(event.data))
          expect(c[k as keyof typeof c]).toEqual(v);
        const args = r.getSetParamsInstructionDataDecoder().decode(ix.data!);
        const { discriminator: _disc, ...values } = args;
        expect(event.data).toEqual(values);
        break;
      }
      case "FeedSet": {
        const c = this.configState(),
          old = r.getConfigDecoder().decode(getPrior(this.config));
        expect(event.data.oldFeed).toBe(old.markets[event.data.market].feed);
        expect(event.data.newFeed).toBe(c.markets[event.data.market].feed);
        break;
      }
      case "HousePosted": {
        const d = event.data,
          h = r.getHouseDecoder().decode(accountData(this.svm, d.house));
        expect(d).toEqual({
          house: d.house,
          id: h.id,
          owner: h.owner,
          market: h.market,
          sides: h.sides,
          k: h.k,
          eBps: h.eBps,
          stake: h.stake,
          freeStake: h.freeStake,
          ruinPerUsd: h.ruinPerUsd,
          ruinLocked: h.ruinLocked,
        });
        break;
      }
      case "HouseFunded": {
        const d = event.data,
          h = r.getHouseDecoder().decode(accountData(this.svm, d.house)),
          old = r.getHouseDecoder().decode(getPrior(d.house)),
          withdraw =
            r.identifyRuinInstruction(
              ix as Instruction & { data: Uint8Array },
            ) === r.RuinInstruction.Withdraw;
        const args = (
          withdraw
            ? r.getWithdrawInstructionDataDecoder()
            : r.getTopUpInstructionDataDecoder()
        ).decode(ix.data!);
        expect(d).toEqual({
          house: d.house,
          quoteIn: withdraw ? 0n : args.quoteAmount,
          ruinIn: withdraw ? 0n : args.ruinAmount,
          quoteOut: withdraw ? args.quoteAmount : 0n,
          ruinOut: withdraw ? args.ruinAmount : 0n,
          stake: h.stake,
          ruinLocked: h.ruinLocked,
        });
        expect(h.stake).toBe(old.stake + d.quoteIn - d.quoteOut);
        expect(h.ruinLocked).toBe(old.ruinLocked + d.ruinIn - d.ruinOut);
        break;
      }
      case "HouseAccepting": {
        expect(event.data.accepting).toBe(
          r.getHouseDecoder().decode(accountData(this.svm, event.data.house))
            .accepting,
        );
        expect(event.data.accepting).toBe(
          r.getSetAcceptingInstructionDataDecoder().decode(ix.data!).accepting,
        );
        break;
      }
      case "HouseClosed": {
        const d = event.data,
          old = r.getHouseDecoder().decode(getPrior(d.house));
        expect(d.owner).toBe(old.owner);
        const vault = ix.accounts![4].address;
        expect(d.quoteReturned).toBe(getPriorAmount(vault));
        const lock = ix.accounts![9].address;
        expect(d.ruinReturned).toBe(
          lock === PROGRAM ? 0n : getPriorAmount(lock),
        );
        expect(this.svm.getAccount(d.house).exists).toBe(false);
        expect(this.svm.getAccount(vault).exists).toBe(false);
        break;
      }
      case "OpenRequested": {
        const d = event.data,
          t = r.getTableDecoder().decode(accountData(this.svm, d.table)),
          h = r.getHouseDecoder().decode(accountData(this.svm, d.house));
        const p = accountData(this.svm, ix.accounts![7].address);
        expect(d).toEqual({
          table: d.table,
          house: t.house,
          seq: t.seq,
          trader: t.trader,
          owner: h.owner,
          market: t.market,
          side: t.side,
          lev: t.lev,
          m: t.m,
          k: t.k,
          eBps: t.eBps,
          requestSlot: t.requestSlot,
          requestPublishTs: t.requestPublishTs,
          requestPrice: p.readBigUInt64LE(168),
        });
        break;
      }
      case "Opened": {
        const d = event.data,
          t = r.getTableDecoder().decode(accountData(this.svm, d.table));
        expect(d).toEqual({
          table: d.table,
          house: t.house,
          seq: t.seq,
          delay: d.delay,
          p0: t.p0,
          fillSlot: t.fillSlot,
          fillPublishTs: t.fillPublishTs,
          fillTs: t.fillTs,
        });
        expect(
          t.fillSlot >= t.requestSlot + d.delay &&
            t.fillSlot <= t.requestSlot + d.delay + BigInt(t.fillWindow),
        ).toBe(true);
        break;
      }
      case "OpenRefunded": {
        const d = event.data,
          t = r.getTableDecoder().decode(getPrior(d.table));
        expect(d).toEqual({
          table: d.table,
          house: t.house,
          seq: t.seq,
          trader: t.trader,
          m: t.m,
          slot: now.slot,
        });
        expect(this.svm.getAccount(d.table).exists).toBe(false);
        break;
      }
      case "CloseRequested": {
        const d = event.data,
          t = r.getTableDecoder().decode(accountData(this.svm, d.table));
        const price = accountData(
          this.svm,
          ix.accounts![4].address,
        ).readBigUInt64LE(168);
        expect(d).toEqual({
          table: d.table,
          house: t.house,
          seq: t.seq,
          closeRequestSlot: t.closeRequestSlot,
          closePublishTs: t.closePublishTs,
          price,
        });
        break;
      }
      case "Settled": {
        const d = event.data,
          t = r.getTableDecoder().decode(getPrior(d.table)),
          h = r.getHouseDecoder().decode(accountData(this.svm, d.house));
        expect(d).toEqual({
          table: d.table,
          house: t.house,
          seq: t.seq,
          trader: t.trader,
          owner: h.owner,
          market: t.market,
          side: t.side,
          lev: t.lev,
          m: t.m,
          k: t.k,
          eBps: t.eBps,
          p0: t.p0,
          fillSlot: t.fillSlot,
          fillPublishTs: t.fillPublishTs,
          fillTs: t.fillTs,
          end: d.end,
          pEnd: d.pEnd,
          endPublishTs: d.endPublishTs,
          endSlot: now.slot,
          endTs: now.unixTimestamp,
          fE9: d.fE9,
          a: d.a,
          b: d.b,
          stakeAfter: h.stake,
        });
        const p = accountData(this.svm, ix.accounts![8].address);
        expect(d.pEnd).toBe(p.readBigUInt64LE(168));
        expect(d.endPublishTs).toBe(p.readBigInt64LE(177));
        expect(d.a + d.b).toBe(BigInt(1 + t.k) * t.m);
        expect(h.stake).toBe(
          r.getHouseDecoder().decode(getPrior(d.house)).stake + t.m - d.a,
        );
        expect(this.svm.getAccount(d.table).exists).toBe(false);
        break;
      }
    }
  }
  async createMint(
    program: Address,
    kind:
      | "classic"
      | "metadata"
      | "hook"
      | "fee"
      | "frozen"
      | "delegate" = "classic",
  ) {
    const mint = await this.createSigner();
    const extensions: token.ExtensionArgs[] =
      kind === "metadata"
        ? [
            {
              __kind: "MetadataPointer",
              authority: this.admin.address,
              metadataAddress: mint.address,
            },
            {
              __kind: "TokenMetadata",
              updateAuthority: this.admin.address,
              mint: mint.address,
              name: "Ruin Test",
              symbol: "RUINT",
              uri: "",
              additionalMetadata: new Map(),
            },
          ]
        : [];
    const size =
      kind === "delegate"
        ? 202
        : kind === "hook"
          ? 234
          : kind === "fee"
            ? 278
            : kind === "frozen"
              ? 171
              : token.getMintSize(extensions.length ? extensions : undefined);
    const ixs: Instruction[] = [
      getCreateAccountInstruction({
        payer: this.admin,
        newAccount: mint,
        space: BigInt(
          kind === "metadata"
            ? token.getMintSize(extensions.slice(0, 1))
            : size,
        ),
        lamports: this.svm.minimumBalanceForRentExemption(BigInt(size)),
        programAddress: program,
      }),
    ];
    if (kind === "metadata")
      ixs.push(
        token.getInitializeMetadataPointerInstruction({
          mint: mint.address,
          authority: this.admin.address,
          metadataAddress: mint.address,
        }),
      );
    if (kind === "delegate")
      ixs.push(
        token.getInitializePermanentDelegateInstruction({
          mint: mint.address,
          delegate: this.admin.address,
        }),
      );
    if (kind === "hook")
      ixs.push(
        token.getInitializeTransferHookInstruction({
          mint: mint.address,
          authority: this.admin.address,
          programId: this.stranger.address,
        }),
      );
    if (kind === "fee")
      ixs.push(
        token.getInitializeTransferFeeConfigInstruction({
          mint: mint.address,
          transferFeeConfigAuthority: this.admin.address,
          withdrawWithheldAuthority: this.admin.address,
          transferFeeBasisPoints: 100,
          maximumFee: 100n,
        }),
      );
    if (kind === "frozen")
      ixs.push(
        token.getInitializeDefaultAccountStateInstruction({
          mint: mint.address,
          state: token.AccountState.Frozen,
        }),
      );
    ixs.push(
      token.getInitializeMint2Instruction(
        {
          mint: mint.address,
          mintAuthority: this.admin.address,
          decimals: 8,
          freezeAuthority: this.admin.address,
        },
        { programAddress: program },
      ),
    );
    if (kind === "metadata")
      ixs.push(
        token.getInitializeTokenMetadataInstruction({
          metadata: mint.address,
          updateAuthority: this.admin.address,
          mint: mint.address,
          mintAuthority: this.admin,
          name: "Ruin Test",
          symbol: "RUINT",
          uri: "",
        }),
      );
    await this.send(`create_${kind}_mint`, ixs, this.admin);
    return mint.address;
  }
  async fundToken(
    owner: Wallet,
    mint: Address,
    program: Address,
    value: bigint,
  ) {
    const destination = await ata(owner.address, mint, program);
    const prepare: Instruction[] = [
      await getCreateAssociatedTokenIdempotentInstructionAsync({
        payer: this.admin,
        owner: owner.address,
        mint,
        tokenProgram: program,
      }),
    ];
    if (!this.svm.getAccount(destination).exists && program === TOKEN_2022) {
      const d = accountData(this.svm, mint);
      for (let offset = 166; offset + 4 <= d.length;) {
        const type = d.readUInt16LE(offset),
          size = d.readUInt16LE(offset + 2);
        if (type === 6 && d[offset + 4] === 2)
          prepare.push(
            token.getThawAccountInstruction({
              account: destination,
              mint,
              owner: this.admin,
            }),
          );
        if (type === 0) break;
        offset += 4 + size;
      }
    }
    await this.send(
      "fund_token",
      [
        ...prepare,
        token.getMintToCheckedInstruction(
          {
            mint,
            token: destination,
            mintAuthority: this.admin,
            amount: value,
            decimals: accountData(this.svm, mint)[44],
          },
          { programAddress: program },
        ),
      ],
      this.admin,
    );
    return destination;
  }
  async donate(
    source: Address,
    destination: Address,
    mint: Address,
    program: Address,
    signer: Wallet,
    value = 1n,
  ) {
    await this.send(
      "donate",
      token.getTransferCheckedInstruction(
        {
          source,
          destination,
          mint,
          authority: signer,
          amount: value,
          decimals: accountData(this.svm, mint)[44],
        },
        { programAddress: program },
      ),
      signer,
    );
  }
}
