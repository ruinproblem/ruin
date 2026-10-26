import { it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { address, generateKeyPairSigner, getAddressEncoder } from "@solana/kit";
import * as r from "../../program/client/index.js";
import { TOKEN } from "../../program/client/constants.js";
import { Keeper, chooseAction } from "../src/keeper/engine.js";
import { RpcPool, RpcFault } from "../src/common/rpc.js";
import {
  Sender,
  errorName,
  prepareTransaction,
  benign,
} from "../src/keeper/sender.js";
import { buildRefund } from "../src/keeper/chain.js";
import { selectPriorityFee } from "../src/keeper/priority.js";
const pause = (n: number) => new Promise((r) => setTimeout(r, n));
async function until(fn: () => boolean, ms = 4000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("Condition timed out");
    await pause(10);
  }
}
class FakeWs extends EventEmitter {
  ready = true;
  subs: { method: string; params: any[]; cb: (v: any) => void }[] = [];
  subscribe(method: string, params: any[], cb: (v: any) => void) {
    const s = { method, params, cb };
    this.subs.push(s);
    return () => {
      this.subs = this.subs.filter((x) => x !== s);
    };
  }
  close() {}
}
async function fixture() {
  const payer = await generateKeyPairSigner(),
    trader = await generateKeyPairSigner(),
    house = (await generateKeyPairSigner()).address,
    key = (await generateKeyPairSigner()).address,
    feed = (await generateKeyPairSigner()).address;
  const t: r.Table = {
    discriminator: r.TABLE_DISCRIMINATOR,
    house,
    seq: 0n,
    trader: trader.address,
    market: 0,
    side: r.Side.Long,
    lev: 1000,
    m: 10000000n,
    k: 10,
    eBps: 700,
    delayMin: 9,
    delayMax: 20,
    fillWindow: 4,
    closeWindow: 4,
    staleSecs: 30,
    expirySecs: 120,
    state: r.TableState.Requested,
    requestSlot: 100n,
    requestPublishTs: 1000n,
    p0: 10000000000n,
    fillSlot: 110n,
    fillPublishTs: 1001n,
    fillTs: 1001n,
    closeRequestSlot: 200n,
    closePublishTs: 1002n,
    bump: 255,
  };
  return { payer, trader, house, key, feed, t };
}
it("S3 a delayed program snapshot cannot delete a newer subscribed request", async () => {
  const f = await fixture(),
    ws = new FakeWs(),
    configAddress = (await r.findConfigPda())[0];
  const config = Buffer.from(
    r.getConfigEncoder().encode({
      admin: f.payer.address,
      quoteMint: f.feed,
      ruinMint: null,
      ruinTokenProgram: null,
      markets: Array.from({ length: 3 }, () => ({
        feed: f.feed,
        asset: f.feed,
      })),
      levMin: 500,
      levMax: 1000,
      kMin: 10,
      kMax: 10,
      eMinBps: 700,
      eMaxBps: 700,
      expirySecs: 120,
      mMin: 1n,
      freeStake: 100000000n,
      ruinPerUsd: 0n,
      delayMin: 9,
      delayMax: 20,
      fillWindow: 4,
      closeWindow: 4,
      staleSecs: 30,
      nextHouseId: 0n,
      bump: 1,
    }),
  ).toString("base64");
  const hashes = Buffer.alloc(48);
  hashes.writeBigUInt64LE(1n);
  hashes.writeBigUInt64LE(100n, 8);
  let deliver: ((value: any) => void) | undefined,
    snapshotSlot = 100;
  const rpc: any = {
    cluster: "devnet",
    metrics: { snapshot: () => ({}) },
    close() {},
    call: async (method: string, params: any[]) => {
      if (method === "getAccountInfo")
        return {
          value:
            params[0] === configAddress
              ? { owner: r.RUIN_PROGRAM_ADDRESS, data: [config, "base64"] }
              : params[0].startsWith("SysvarS1otHashes")
                ? { data: [hashes.toString("base64"), "base64"] }
                : null,
        };
      if (method === "getProgramAccounts")
        return snapshotSlot === 100
          ? new Promise((resolve) => {
              deliver = resolve;
            })
          : { context: { slot: snapshotSlot }, value: [] };
      if (method === "getMultipleAccounts")
        return { context: { slot: snapshotSlot }, value: [] };
      throw new Error("Unexpected method");
    },
  };
  const keeper = new Keeper(rpc, ws as any, f.payer, () => {});
  keeper.configAddress = configAddress;
  const scan = keeper.rescan();
  await until(() => !!deliver);
  keeper.onTable(
    f.key,
    {
      owner: r.RUIN_PROGRAM_ADDRESS,
      lamports: 1,
      data: [
        Buffer.from(r.getTableEncoder().encode(f.t)).toString("base64"),
        "base64",
      ],
    },
    101,
  );
  const subscribed = keeper.tables.get(f.key);
  deliver!({ context: { slot: 100 }, value: [] });
  await scan;
  expect(keeper.tables.get(f.key)).toBe(subscribed);
  snapshotSlot = 102;
  await keeper.rescan();
  expect(keeper.tables.has(f.key)).toBe(false);
  keeper.close();
});
it.each(["request", "close"] as const)(
  "S3 %s production preparation finishes before delay_min and window sending only calls sendTransaction",
  async (state) => {
    const f = await fixture(),
      calls: { method: string; at: number; name: string }[] = [],
      logs: any[] = [],
      ws = new FakeWs();
    let signature = "";
    const hashes = Buffer.alloc(48);
    hashes.writeBigUInt64LE(1n);
    hashes.writeBigUInt64LE(100n, 8);
    const token = Buffer.alloc(165);
    Buffer.from(getAddressEncoder().encode(f.trader.address)).copy(token, 32);
    Buffer.from(getAddressEncoder().encode(f.feed)).copy(token, 0);
    const transport: typeof fetch = async (url, opts) => {
      const b = JSON.parse(String(opts?.body)),
        name = String(url) === "http://public.invalid" ? "public" : "fallback";
      calls.push({ method: b.method, at: Date.now(), name });
      if (name === "public") return new Promise(() => {});
      await pause(200);
      return Response.json({
        jsonrpc: "2.0",
        id: 1,
        result:
          b.method === "getAccountInfo"
            ? {
                value: {
                  owner: TOKEN,
                  data: [
                    (b.params[0].startsWith("SysvarS1otHashes")
                      ? hashes
                      : token
                    ).toString("base64"),
                    "base64",
                  ],
                },
              }
            : signature,
      });
    };
    const list: any[] = [
      { name: "public", url: "http://public.invalid", ws: "", verified: true },
      {
        name: "fallback",
        url: "http://fallback.invalid",
        ws: "",
        verified: true,
      },
    ];
    const rpc = new RpcPool("devnet", list, transport, (x) => logs.push(x)),
      keeper = new Keeper(rpc, ws as any, f.payer, (x) => logs.push(x));
    keeper.config = { quoteMint: f.feed, markets: [{ feed: f.feed }] } as any;
    keeper.configAddress = (await r.findConfigPda())[0];
    keeper.latest = {
      blockhash: address("11111111111111111111111111111111"),
      lastValidBlockHeight: 999n,
    };
    keeper.rent = 2039280n;
    keeper.slot = 101n;
    keeper.prices.set(0, {
      price: f.t.p0,
      publishTs: 1003n,
      slot: 101,
      recvMs: Date.now(),
    });
    const table =
      state === "request"
        ? f.t
        : {
            ...f.t,
            state: r.TableState.CloseRequested,
            closeRequestSlot: 100n,
          };
    const start = Date.now();
    keeper.onTable(
      f.key,
      {
        owner: r.RUIN_PROGRAM_ADDRESS,
        lamports: 1,
        data: [
          Buffer.from(r.getTableEncoder().encode(table)).toString("base64"),
          "base64",
        ],
      },
      101,
    );
    const e = keeper.tables.get(f.key)!;
    await until(() => e.ready && e.jobs.size === (state === "request" ? 2 : 3));
    const prepareMs = Date.now() - start;
    expect(prepareMs).toBeLessThan(9 * 238);
    expect(state === "request" ? e.target : e.closeTarget).toBe(109n);
    if (state === "request") expect(e.jobs.get("refund")!.limit).toBe(60000);
    signature = e.jobs.get(
      state === "request" ? "fill" : "settle-stop",
    )!.signature;
    list[0].hold = 0;
    keeper.onSlot(108n);
    expect(logs.filter((x) => x.result === "first-send")).toHaveLength(0);
    const before = calls.length,
      at = Date.now();
    keeper.onSlot(109n);
    await until(() => keeper.sender.flights.get(f.key)?.accepted === true);
    expect(
      calls.slice(before).every((x) => x.method === "sendTransaction"),
    ).toBe(true);
    const fallbackReachedMs =
      calls.slice(before).find((x) => x.name === "fallback")!.at - at;
    expect(fallbackReachedMs).toBeLessThanOrEqual(450);
    console.log(
      JSON.stringify({
        test: "S3",
        state,
        prepareMs,
        prepareDeadlineMs: 9 * 238,
        fallbackReachedMs,
        fallbackDeadlineMs: 450,
        windowMethods: [...new Set(calls.slice(before).map((x) => x.method))],
      }),
    );
    expect(logs.find((x) => x.result === "first-send").firstSendSlot).toBe(
      109n,
    );
    keeper.onTable(
      f.key,
      {
        owner: r.RUIN_PROGRAM_ADDRESS,
        lamports: 1,
        data: [
          Buffer.from(
            r.getTableEncoder().encode({ ...f.t, state: r.TableState.Open }),
          ).toString("base64"),
          "base64",
        ],
      },
      110,
    );
    expect(keeper.sender.flights.size).toBe(0);
    keeper.close();
  },
  10000,
);
it("S3 requested, line, Stop, expiry, refund priorities and publication boundaries", async () => {
  const { t } = await fixture();
  const p = { price: 10000000000n, publishTs: 1003n, slot: 0, recvMs: 0 };
  expect(chooseAction(t, p, 109n, 1000n, 109n)?.kind).toBe("fill");
  expect(chooseAction(t, p, 125n, 1000n, 109n)?.kind).toBe("refund");
  const live = { ...t, state: r.TableState.CloseRequested };
  expect(
    chooseAction(
      live,
      { ...p, price: 10100000000n },
      210n,
      2000n,
      undefined,
      209n,
    )?.kind,
  ).toBe("settle-line");
  expect(chooseAction(live, p, 209n, 2000n, undefined, 209n)?.kind).toBe(
    "settle-stop",
  );
  expect(
    chooseAction(live, { ...p, publishTs: 1002n }, 209n, 2000n, undefined, 209n)
      ?.kind,
  ).toBe("settle-expiry");
  expect(chooseAction(live, p, 214n, 1100n, undefined, 209n)).toBeUndefined();
  expect(
    chooseAction({ ...live, state: r.TableState.Open }, p, 300n, 1121n)?.kind,
  ).toBe("settle-expiry");
});
it("S3 all named preflight errors release attempts; accepted chain error retries different bytes with an unchanged blockhash", async () => {
  const f = await fixture(),
    ws = new FakeWs(),
    logs: any[] = [],
    attempts: string[] = [],
    failed: any[] = [];
  const rpc: any = {
    callAt: async (_m: string, p: any[]) => {
      attempts.push(p[0]);
      if (failed.length)
        throw new RpcFault(
          "sendTransaction",
          -32002,
          { err: { InstructionError: [2, { Custom: failed.shift() }] } },
          true,
        );
      return { value: current.signature, endpoint: "public" };
    },
    call: async () => ({ value: [] }),
  };
  let current = await prepareTransaction(
    [],
    f.payer,
    {
      blockhash: address("11111111111111111111111111111111"),
      lastValidBlockHeight: 999n,
    },
    "settle-line",
    80000,
    10000n,
  );
  let nonce = 0;
  const sender = new Sender(
    rpc,
    ws as any,
    () => 109n,
    () => 1n,
    () => {
      nonce++;
    },
    (x) => logs.push(x),
  );
  const codes = [
    r.RUIN_ERROR__BEFORE_WINDOW,
    r.RUIN_ERROR__FEED_NOT_NEWER,
    r.RUIN_ERROR__FEED_STALE,
    r.RUIN_ERROR__AFTER_WINDOW,
    r.RUIN_ERROR__NOT_REQUESTED,
    r.RUIN_ERROR__NOT_LIVE,
    r.RUIN_ERROR__NOTHING_TO_SETTLE,
    r.RUIN_ERROR__WRONG_OWNER,
  ];
  for (const code of codes) {
    failed.push(code);
    await sender.send(f.key, f.house, 0n, current);
    expect(sender.flights.size).toBe(0);
    expect(errorName({ InstructionError: [0, { Custom: code }] })).not.toMatch(
      /^Custom/,
    );
  }
  await sender.send(f.key, f.house, 0n, current);
  const subscription = ws.subs.find((s) => s.method === "signatureSubscribe")!;
  subscription.cb({
    context: { slot: 110 },
    value: {
      err: {
        InstructionError: [0, { Custom: r.RUIN_ERROR__NOTHING_TO_SETTLE }],
      },
    },
  });
  expect(sender.flights.size).toBe(0);
  const old = current;
  current = await prepareTransaction(
    [],
    f.payer,
    { blockhash: address(old.blockhash), lastValidBlockHeight: 999n },
    "settle-line",
    80000,
    10000n + BigInt(nonce),
  );
  expect(current.wire).not.toBe(old.wire);
  await sender.send(f.key, f.house, 0n, current);
  expect(sender.flights.size).toBe(1);
  sender.close();
});
it("S3 receiving account creation is assembled from a cache for refund and settle", async () => {
  const f = await fixture(),
    t = { ...f.t, state: r.TableState.Open };
  let calls = 0;
  const getAccount = async () => {
    calls++;
    return null;
  };
  const refund = await buildRefund({
    table: t,
    tableAddress: f.key,
    payer: f.payer,
    quoteMint: f.feed,
    getAccount,
    rent: 2039280n,
  });
  expect(refund).toHaveLength(2);
  const settle = await r.buildSettleInstructions({
    payer: f.payer,
    tableAddress: f.key,
    table: t,
    quoteMint: f.feed,
    feed: f.feed,
    price: t.p0,
    getAccount,
    rent: 2039280n,
  });
  expect(settle).toHaveLength(2);
  expect(calls).toBe(2);
  const wrong = await buildRefund({
    table: t,
    tableAddress: f.key,
    payer: f.payer,
    quoteMint: f.feed,
    getAccount: async () => ({ owner: f.payer.address, mint: f.feed }),
    rent: 2039280n,
  });
  expect(wrong).toHaveLength(3);
});
it("positive nearest-rank priority p75 clamps and zero samples fall back", () => {
  expect(
    selectPriorityFee(
      [
        { prioritizationFee: 0 },
        { prioritizationFee: 20 },
        { prioritizationFee: 40 },
        { prioritizationFee: 60 },
        { prioritizationFee: 80 },
      ],
      10n,
      100n,
    ),
  ).toBe(60n);
  expect(selectPriorityFee([], 10n, 100n)).toBe(10n);
  expect(selectPriorityFee([{ prioritizationFee: 200 }], 10n, 100n)).toBe(100n);
});
it("S3 actual engine retries an unchanged line on the next slot and clears a failed accepted signature", async () => {
  const f = await fixture(),
    ws = new FakeWs(),
    records: any[] = [],
    wires: string[] = [],
    t = { ...f.t, state: r.TableState.Open };
  const bytes = Buffer.alloc(165);
  Buffer.from(getAddressEncoder().encode(f.feed)).copy(bytes);
  Buffer.from(getAddressEncoder().encode(f.trader.address)).copy(bytes, 32);
  let preflightFailure = true;
  let keeper: Keeper;
  const rpc: any = {
    cluster: "devnet",
    metrics: { snapshot: () => ({}) },
    close() {},
    call: async () => ({
      value: { owner: TOKEN, data: [bytes.toString("base64"), "base64"] },
    }),
    callAt: async (_m: string, params: any[]) => {
      wires.push(params[0]);
      if (preflightFailure) {
        preflightFailure = false;
        throw new RpcFault(
          "sendTransaction",
          -32002,
          {
            err: {
              InstructionError: [0, { Custom: r.RUIN_ERROR__FEED_STALE }],
            },
          },
          true,
        );
      }
      return {
        value: keeper.tables.get(f.key)!.jobs.get("settle-line")!.signature,
        endpoint: "public",
      };
    },
  };
  keeper = new Keeper(rpc, ws as any, f.payer, (x) => records.push(x));
  keeper.config = { quoteMint: f.feed, markets: [{ feed: f.feed }] } as any;
  keeper.configAddress = (await r.findConfigPda())[0];
  keeper.latest = {
    blockhash: address("11111111111111111111111111111111"),
    lastValidBlockHeight: 999n,
  };
  keeper.rent = 2039280n;
  keeper.slot = 110n;
  keeper.prices.set(0, {
    price: 10100000000n,
    publishTs: 1003n,
    slot: 110,
    recvMs: Date.now(),
  });
  keeper.onTable(
    f.key,
    {
      owner: r.RUIN_PROGRAM_ADDRESS,
      lamports: 1,
      data: [
        Buffer.from(r.getTableEncoder().encode(t)).toString("base64"),
        "base64",
      ],
    },
    110,
  );
  await until(() => records.some((x) => x.error === "FeedStale"));
  await until(() => keeper.tables.get(f.key)!.jobs.size === 3);
  keeper.onSlot(111n);
  await until(() => keeper.sender.flights.get(f.key)?.accepted === true);
  expect(wires).toHaveLength(2);
  expect(wires[0]).not.toBe(wires[1]);
  ws.subs
    .find((s) => s.method === "signatureSubscribe")!
    .cb({
      context: { slot: 112 },
      value: {
        err: {
          InstructionError: [0, { Custom: r.RUIN_ERROR__NOTHING_TO_SETTLE }],
        },
      },
    });
  expect(keeper.sender.flights.size).toBe(0);
  await until(() => keeper.tables.get(f.key)!.jobs.size === 3);
  keeper.onSlot(112n);
  await until(() => keeper.sender.flights.get(f.key)?.accepted === true);
  expect(wires).toHaveLength(3);
  expect(new Set(wires).size).toBe(3);
  const failAccepted = () =>
    ws.subs
      .find((s) => s.method === "signatureSubscribe")!
      .cb({
        context: { slot: Number(keeper.slot) },
        value: {
          err: {
            InstructionError: [0, { Custom: r.RUIN_ERROR__NOTHING_TO_SETTLE }],
          },
        },
      });
  keeper.latest = { ...keeper.latest, blockhash: f.feed };
  failAccepted();
  await until(() => keeper.tables.get(f.key)!.jobs.size === 3);
  keeper.onSlot(113n);
  await until(
    () =>
      wires.length === 4 && keeper.sender.flights.get(f.key)?.accepted === true,
  );
  keeper.latest = {
    ...keeper.latest,
    blockhash: address("11111111111111111111111111111111"),
  };
  failAccepted();
  keeper.onSlot(300n);
  keeper.onTable(
    f.key,
    {
      owner: r.RUIN_PROGRAM_ADDRESS,
      lamports: 1,
      data: [
        Buffer.from(
          r
            .getTableEncoder()
            .encode({ ...t, state: r.TableState.CloseRequested }),
        ).toString("base64"),
        "base64",
      ],
    },
    300,
  );
  await until(
    () =>
      wires.length === 5 && keeper.sender.flights.get(f.key)?.accepted === true,
  );
  expect(new Set(wires).size).toBe(5);
  keeper.close();
});
