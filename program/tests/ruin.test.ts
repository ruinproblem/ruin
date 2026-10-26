import { afterAll, describe, it, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import {
  address,
  generateKeyPairSigner,
  getAddressEncoder,
  getAddressDecoder,
  lamports,
} from "@solana/kit";
import * as token from "@solana-program/token";
import * as token22 from "@solana-program/token-2022";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  Harness,
  r,
  TOKEN,
  TOKEN_2022,
  FEEDS,
  USDC,
  JUPUSD,
  DOVES,
  PROGRAM,
  amount,
  accountData,
  ata,
  DEFAULT_PARAMS,
  measurements,
  accountMeasurements,
  eventSamples,
  json,
  type TableRef,
  type HouseRef,
} from "./harness.js";
import { split, lock, delay } from "../client/math.js";
import { readDoves } from "../client/oracle.js";
import { buildSettleInstructions } from "../client/settle.js";
const P0 = 10677218000n,
  M = 10000000n;
async function open(h: Harness, opts: Record<string, any> = {}) {
  const house = await h.post();
  const t = await h.request(house, opts);
  await h.fill(t);
  return t;
}
async function stop(h: Harness, t: TableRef, p: bigint = P0) {
  const before = h.svm.getClock();
  h.price(P0, before.unixTimestamp);
  await h.send("request_close", h.requestCloseIx(t), h.trader);
  const c = h.tableState(t);
  h.clock(c.closeRequestSlot + 10n, before.unixTimestamp + 2n);
  h.hash(c.closeRequestSlot);
  h.price(p, before.unixTimestamp + 2n);
  await h.send("settle_stop", h.settleIx(t));
}
afterAll(() => {
  console.log(
    "P12 MEASUREMENTS " +
      json({ cu: measurements, accounts: accountMeasurements }),
  );
  writeFileSync(
    new URL("../target/litesvm-measurements.json", import.meta.url),
    json({
      cu: measurements,
      accounts: accountMeasurements,
      events: eventSamples,
    }) + "\n",
  );
});

describe("P1 init and administration", () => {
  it.each([USDC, JUPUSD])(
    "accepts cloned six-decimal quote %s",
    async (quote) => {
      const h = await Harness.create({ quote });
      expect(h.configState().quoteMint).toBe(quote);
      expect(h.configState().markets.map((x) => x.asset)).toEqual([
        "So11111111111111111111111111111111111111112",
        "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh",
        "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs",
      ]);
    },
  );
  it("binds upgrade authority, prevents second init, rejects invalid quote", async () => {
    const h = await Harness.create({ initialize: false });
    await h.send(
      "wrong_upgrade",
      h.initIx({ authority: h.stranger }),
      h.stranger,
      "NotUpgradeAuthority",
    );
    const q9 = await h.createMint(TOKEN);
    await h.send(
      "quote_decimals",
      h.initIx({ quoteMint: q9 }),
      h.admin,
      "QuoteMintInvalid",
    );
    const q22 = await h.createMint(TOKEN_2022);
    const a = h.svm.getAccount(q22);
    if (!a.exists) throw 0;
    const d = Buffer.from(a.data);
    d[44] = 6;
    h.svm.setAccount({ ...a, data: d });
    await h.send(
      "quote_program",
      h.initIx({ quoteMint: q22 }),
      h.admin,
      "QuoteMintInvalid",
    );
    await h.send("init", h.initIx(), h.admin);
    await h.send("duplicate_init", h.initIx(), h.admin, "");
  });
  it.each(["owner", "length", "disc", "exponent", "asset", "zero", "order"])(
    "rejects malformed feeds %s",
    async (kind) => {
      const h = await Harness.create({ initialize: false });
      const a = h.svm.getAccount(FEEDS[0]);
      if (!a.exists) throw 0;
      let d = Buffer.from(a.data);
      let owner = a.programAddress;
      if (kind === "owner") owner = h.admin.address;
      if (kind === "length") d = d.subarray(0, 393);
      if (kind === "disc") d[0] ^= 1;
      if (kind === "exponent") d[176] = 249;
      if (kind === "asset") d.set(getAddressEncoder().encode(USDC), 8);
      if (kind === "zero") d.writeBigUInt64LE(0n, 168);
      h.svm.setAccount({
        ...a,
        data: d,
        programAddress: owner,
        space: BigInt(d.length),
      });
      await h.send(
        "invalid_feed",
        h.initIx(
          kind === "order" ? { solFeed: FEEDS[1], btcFeed: FEEDS[0] } : {},
        ),
        h.admin,
        "FeedInvalid",
      );
    },
  );
  for (const field of ["fillWindow", "closeWindow"])
    for (const [min, max, window, ok] of [
      [10, 10, 4, false],
      [11, 10, 4, false],
      [10, 14, 4, false],
      [10, 15, 4, true],
    ] as const) {
      it(`${field} width ${min}..${max} init/params ${ok}`, async () => {
        const h = await Harness.create({ initialize: false });
        const params = {
          ...DEFAULT_PARAMS,
          delayMin: min,
          delayMax: max,
          [field]: window,
        };
        const args = {
          admin: h.admin.address,
          levMin: 500,
          levMax: 1000,
          kMin: 2,
          kMax: 20,
          eMinBps: 0,
          eMaxBps: 2000,
          expirySecs: 86400,
          params,
        };
        await h.send(
          "init_width",
          h.initIx({ args }),
          h.admin,
          ok ? undefined : "InvalidValue",
        );
        if (!ok) {
          expect(h.svm.getAccount(h.config).exists).toBe(false);
          await h.send("init", h.initIx(), h.admin);
        }
        await h.send(
          "params_width",
          h.paramsIx(params),
          h.admin,
          ok ? undefined : "InvalidValue",
        );
      });
    }
  it("validates all numeric init and mutable ranges", async () => {
    const h = await Harness.create({ initialize: false });
    const base = {
      admin: h.admin.address,
      levMin: 500,
      levMax: 1000,
      kMin: 2,
      kMax: 20,
      eMinBps: 0,
      eMaxBps: 2000,
      expirySecs: 86400,
      params: DEFAULT_PARAMS,
    };
    for (const bad of [
      { levMin: 0 },
      { levMax: 10001 },
      { levMin: 1001 },
      { kMin: 0 },
      { kMax: 101 },
      { kMin: 21 },
      { eMinBps: 2001 },
      { eMaxBps: 10001 },
      { expirySecs: 59 },
    ])
      await h.send(
        "invalid_init",
        h.initIx({ args: { ...base, ...bad } }),
        h.admin,
        "InvalidValue",
      );
    for (const bad of [
      { mMin: 0n },
      { delayMin: 0 },
      { fillWindow: 0 },
      { closeWindow: 0 },
      { delayMax: 253, fillWindow: 4 },
      { delayMax: 253, closeWindow: 4 },
      { staleSecs: 0 },
      { staleSecs: 601 },
    ]) {
      await h.send(
        "invalid_init_params",
        h.initIx({ args: { ...base, params: { ...DEFAULT_PARAMS, ...bad } } }),
        h.admin,
        "InvalidValue",
      );
    }
    await h.send("init", h.initIx(), h.admin);
    for (const bad of [
      { mMin: 0n },
      { staleSecs: 0 },
      { staleSecs: 601 },
      { fillWindow: 0 },
      { closeWindow: 0 },
      { delayMin: 0 },
      { delayMax: 253 },
    ])
      await h.send("invalid_params", h.paramsIx(bad), h.admin, "InvalidValue");
  });
  it("set_ruin is admin-only, one-time, accepts supported mint extensions", async () => {
    const h = await Harness.create({ ruinProgram: TOKEN_2022 });
    await h.send(
      "not_admin",
      h.ruinIx(h.ruinMint, h.stranger),
      h.stranger,
      "NotAdmin",
    );
    for (const [kind, error] of [
      ["hook", "TransferHookActive"],
      ["fee", "TransferFeeMint"],
      ["frozen", "DefaultStateFrozen"],
    ] as const) {
      const mint = await h.createMint(TOKEN_2022, kind);
      await h.send("bad_ruin", h.ruinIx(mint), h.admin, error);
    }
    await h.send("set_ruin", h.ruinIx(), h.admin);
    await h.send("ruin_twice", h.ruinIx(), h.admin, "RuinAlreadySet");
    await h.send(
      "params_admin",
      h.paramsIx({}, h.stranger),
      h.stranger,
      "NotAdmin",
    );
  });
  it("copies house/table settings and replaces a feed within the same asset for a live table", async () => {
    const h = await Harness.create();
    const t = await open(h);
    const oldHouse = h.houseState(t),
      oldTable = h.tableState(t);
    await h.send(
      "set_params",
      h.paramsIx({
        freeStake: 200000000n,
        ruinPerUsd: 7n,
        delayMin: 11,
        delayMax: 25,
        fillWindow: 5,
        closeWindow: 5,
        staleSecs: 40,
        mMin: 2000000n,
      }),
      h.admin,
    );
    expect(h.houseState(t)).toEqual(oldHouse);
    expect(h.tableState(t)).toEqual(oldTable);
    const next = await h.post();
    expect(h.houseState(next).freeStake).toBe(200000000n);
    const newTable = await h.request(next);
    expect(h.tableState(newTable).delayMin).toBe(11);
    const replacement = (await generateKeyPairSigner()).address;
    const old = h.svm.getAccount(FEEDS[0]);
    if (!old.exists) throw 0;
    h.svm.setAccount({ ...old, address: replacement });
    const feedIx = (feed = replacement, admin = h.admin) =>
      r.getSetFeedInstruction({
        admin,
        config: h.config,
        feed,
        market: 0,
        ...h.eventAccounts(),
      });
    await h.send(
      "feed_admin",
      feedIx(replacement, h.stranger),
      h.stranger,
      "NotAdmin",
    );
    await h.send(
      "feed_wrong_asset",
      feedIx(FEEDS[1]),
      h.admin,
      "FeedAssetMismatch",
    );
    const bad = (await generateKeyPairSigner()).address;
    h.svm.setAccount({ ...old, address: bad, programAddress: PROGRAM });
    await h.send("feed_wrong_owner", feedIx(bad), h.admin, "FeedInvalid");
    await h.send("set_feed", feedIx(), h.admin);
    h.price(10783990180n, 1003n, replacement);
    await h.send("old_feed", h.settleIx(t), h.stranger, "FeedNotConfig");
    await h.send("settle_new_feed", h.settleIx(t, { feed: replacement }));
    expect(h.events[0].name).toBe("Settled");
  });
});

describe("P2 authority paths", () => {
  it("admin cannot withdraw, close a house, or request trader close", async () => {
    const h = await Harness.create();
    const house = await h.post();
    const adminQuote = await h.fundToken(h.admin, h.quote, TOKEN, 1n);
    await h.send(
      "admin_withdraw",
      h.fundIx(house, true, { owner: h.admin, destination: adminQuote }),
      h.admin,
      "NotOwner",
    );
    await h.send(
      "admin_close",
      h.closeIx(house, { owner: h.admin, destination: adminQuote }),
      h.admin,
      "NotOwner",
    );
    const t = await h.request(house);
    await h.fill(t);
    await h.send(
      "admin_trader",
      h.requestCloseIx(t, { trader: h.admin }),
      h.admin,
      "NotTrader",
    );
    const idl = JSON.parse(
      readFileSync(new URL("../client/idl/ruin.json", import.meta.url), "utf8"),
    );
    for (const name of ["set_ruin", "set_params", "set_feed"])
      expect(
        idl.instructions
          .find((i: any) => i.name === name)
          .accounts.map((a: any) => a.name),
      ).not.toContain("vault");
  });
});

describe("P3 houses and locks", () => {
  it("enforces free cap, disabled houses, rounding and insufficient lock", async () => {
    const h = await Harness.create();
    let ref = await h.ref();
    await h.send(
      "over_free",
      h.postIx(ref, { stake: 100000001n }),
      h.owner,
      "StakeOverFree",
    );
    const house = await h.post();
    await h.send("set_ruin", h.ruinIx(), h.admin);
    await h.send(
      "set_params",
      h.paramsIx({ ruinPerUsd: 10000000000n }),
      h.admin,
    );
    await h.send(
      "disabled_ruin",
      h.fundIx(house, false, {
        ...h.lockAccounts(house),
        quoteAmount: 0n,
        ruinAmount: 1n,
      }),
      h.owner,
      "RuinNotEnabled",
    );
    ref = await h.ref();
    await h.send(
      "short_lock",
      h.postIx(ref, {
        stake: 1000000000n,
        ruinAmount: 9999999999999n,
        ...h.lockAccounts(ref),
      }),
      h.owner,
      "LockShort",
    );
    await h.send(
      "post_house",
      h.postIx(ref, {
        stake: 1000000000n,
        ruinAmount: 10000000000000n,
        ...h.lockAccounts(ref),
      }),
      h.owner,
    );
    expect(h.houseState(ref).ruinLocked).toBe(10000000000000n);
    expect(lock(1000001n, 1000000n, 3n)).toBe(4n);
    await h.send(
      "set_params",
      h.paramsIx({ freeStake: 1000000n, ruinPerUsd: 3n }),
      h.admin,
    );
    ref = await h.ref();
    await h.send(
      "round_short",
      h.postIx(ref, {
        stake: 1000001n,
        ruinAmount: 3n,
        ...h.lockAccounts(ref),
      }),
      h.owner,
      "LockShort",
    );
    await h.send(
      "round_up",
      h.postIx(ref, {
        stake: 1000001n,
        ruinAmount: 4n,
        ...h.lockAccounts(ref),
      }),
      h.owner,
    );
  });
  it.each([TOKEN, TOKEN_2022])(
    "deposits, locks, withdrawals, donations and closure %s",
    async (ruinProgram) => {
      const h = await Harness.create({ ruinProgram });
      await h.send("set_ruin", h.ruinIx(), h.admin);
      await h.send(
        "set_params",
        h.paramsIx({ ruinPerUsd: 10000000000n }),
        h.admin,
      );
      const ref = await h.ref();
      const before = h.svm.getAccount(h.owner.address);
      if (!before.exists) throw 0;
      let fees = 0n;
      await h.send(
        "post_house",
        h.postIx(ref, {
          stake: 1000000000n,
          ruinAmount: 10000000000000n,
          ...h.lockAccounts(ref),
        }),
        h.owner,
      );
      fees += h.lastFee;
      h.measure("Config", h.config);
      h.measure("House", ref.house);
      h.measure("House vault", ref.vault);
      h.measure(
        `Lock vault ${ruinProgram === TOKEN ? "classic" : "2022"}`,
        ref.lockVault,
      );
      await h.send(
        "top_short",
        h.fundIx(ref, false, { quoteAmount: 1n }),
        h.owner,
        "LockShort",
      );
      fees += h.lastFee;
      await h.send(
        "top_up",
        h.fundIx(ref, false, {
          quoteAmount: 1000000n,
          ruinAmount: 10000000000n,
        }),
        h.owner,
      );
      fees += h.lastFee;
      await h.send(
        "withdraw_short",
        h.fundIx(ref, true, { quoteAmount: 0n, ruinAmount: 1n }),
        h.owner,
        "LockShort",
      );
      fees += h.lastFee;
      await h.send(
        "withdraw",
        h.fundIx(ref, true, {
          quoteAmount: 1000000n,
          ruinAmount: 10000000000n,
        }),
        h.owner,
      );
      fees += h.lastFee;
      await h.donate(h.ownerQuote, ref.vault, h.quote, TOKEN, h.owner, 17n);
      fees += h.lastFee;
      await h.donate(
        h.ownerRuin,
        ref.lockVault,
        h.ruinMint,
        ruinProgram,
        h.owner,
        19n,
      );
      fees += h.lastFee;
      const t = await h.request(ref);
      h.measure("Table", t.table);
      for (const [name, ix] of [
        ["top_up", h.fundIx(ref)],
        ["withdraw", h.fundIx(ref, true)],
        ["close_house", h.closeIx(ref)],
      ] as const) {
        await h.send(`busy_${name}`, ix, h.owner, "NotIdle");
        fees += h.lastFee;
      }
      await h.send("accepting", h.acceptingIx(ref, false), h.owner);
      fees += h.lastFee;
      await h.fill(t);
      h.price(10666540782n, 1003n);
      await h.send("settle_line", h.settleIx(t));
      const next = await h.tableRef(ref);
      await h.send(
        "not_accepting",
        h.requestIx(next),
        h.trader,
        "NotAccepting",
      );
      const q = amount(h.svm, h.ownerQuote),
        ru = amount(h.svm, h.ownerRuin),
        v = amount(h.svm, ref.vault),
        l = amount(h.svm, ref.lockVault);
      await h.send("close_house", h.closeIx(ref), h.owner);
      fees += h.lastFee;
      expect(amount(h.svm, h.ownerQuote) - q).toBe(v);
      expect(amount(h.svm, h.ownerRuin) - ru).toBe(l);
      for (const a of [ref.house, ref.vault, ref.lockVault])
        expect(h.svm.getAccount(a).exists).toBe(false);
      const after = h.svm.getAccount(h.owner.address);
      if (!after.exists) throw 0;
      expect(before.lamports - after.lamports).toBe(fees);
    },
  );
  it("a win can leave a short lock without preventing settlement", async () => {
    const h = await Harness.create();
    await h.send("set_ruin", h.ruinIx(), h.admin);
    await h.send("set_params", h.paramsIx({ ruinPerUsd: 1n }), h.admin);
    const house = await h.ref();
    await h.send(
      "post_house",
      h.postIx(house, { ...h.lockAccounts(house), ruinAmount: 0n }),
      h.owner,
    );
    const t = await h.request(house);
    await h.fill(t);
    h.price(10666540782n, 1003n);
    await h.send("settle_line", h.settleIx(t));
    expect(h.houseState(house).stake).toBe(110000000n);
    const next = await h.tableRef(house);
    await h.send(
      "lock_short_request",
      h.requestIx(next),
      h.trader,
      "LockShort",
    );
    await h.send(
      "repair_lock",
      h.fundIx(house, false, {
        quoteAmount: 0n,
        ruinAmount: 110n,
        ...h.lockAccounts(house),
      }),
      h.owner,
    );
    await h.send("request_open", h.requestIx(next), h.trader);
  });
});

describe("P4 reservation and request limits", () => {
  it("rejects all request limits and protects owner funds while requested", async () => {
    const h = await Harness.create();
    const house = await h.post({ sides: 1 });
    let t = await h.tableRef(house);
    for (const [o, error] of [
      [{ side: r.Side.Short }, "SideNotAllowed"],
      [{ lev: 499 }, "LeverageOutOfRange"],
      [{ lev: 1001 }, "LeverageOutOfRange"],
      [{ m: 999999n }, "MarginTooSmall"],
      [{ m: 10000001n }, "HouseTooSmall"],
      [{ feed: FEEDS[1] }, "FeedNotConfig"],
    ] as const)
      await h.send("request_limit", h.requestIx(t, o), h.trader, error);
    h.price(P0, 969n);
    await h.send("stale_request", h.requestIx(t), h.trader, "FeedStale");
    h.price(P0, 1000n);
    for (const lev of [500, 1000]) {
      await h.send("request_open", h.requestIx(t, { lev }), h.trader);
      expect(h.houseState(house).state).toBe(r.HouseState.Busy);
      await h.send("second_request", h.requestIx(t), h.trader, "NotIdle");
      await h.send(
        "owner_withdraw_requested",
        h.fundIx(house, true),
        h.owner,
        "NotIdle",
      );
      await h.send(
        "owner_close_requested",
        h.closeIx(house),
        h.owner,
        "NotIdle",
      );
      h.clock(h.tableState(t).requestSlot + 28n);
      await h.send("refund_open", h.refundIx(t));
      t = await h.tableRef(house);
    }
    expect(t.seq).toBe(2n);
    const other = await h.post();
    expect((await h.tableRef(other)).seq).toBe(0n);
  });
});

describe("P5 fill delay and freshness", () => {
  it.each([
    [0n, 10n],
    [13n, 23n],
    [14n, 10n],
    [(1n << 64n) - 1n, 11n],
  ])("derives hash %s delay %s", async (hash, d) => {
    const h = await Harness.create();
    const t = await h.request(await h.post());
    const ts = h.tableState(t);
    const b = Buffer.alloc(32);
    b.writeBigUInt64LE(hash);
    expect(delay(b, 10, 23)).toBe(d);
    h.clock(ts.requestSlot + d, 1002n);
    h.hash(ts.requestSlot, hash);
    h.price(P0, 1002n);
    const before = amount(h.svm, t.vault);
    await h.send("fill_open", h.fillIx(t), h.trader);
    expect(amount(h.svm, t.vault)).toBe(before);
    expect(h.events[0]).toMatchObject({
      name: "Opened",
      data: {
        delay: d,
        p0: P0,
        fillSlot: ts.requestSlot + d,
        fillPublishTs: 1002n,
        fillTs: 1002n,
      },
    });
    expect(h.tableState(t).p0).toBe(P0);
  });
  it.each([
    [-1n, "BeforeWindow"],
    [0n, null],
    [4n, null],
    [5n, "AfterWindow"],
  ])("window endpoint %s", async (edge, error) => {
    const h = await Harness.create();
    const t = await h.request(await h.post());
    h.clock(1010n + edge, 1002n);
    h.hash(1000n);
    h.price(P0, 1002n);
    await h.send("fill_boundary", h.fillIx(t), h.stranger, error ?? undefined);
  });
  it("requires newer and fresh values, accepts negative age, rejects missing hashes", async () => {
    const h = await Harness.create();
    const t = await h.request(await h.post());
    h.clock(1010n, 1002n);
    h.hash(1000n);
    await h.send("fill_not_newer", h.fillIx(t), h.stranger, "FeedNotNewer");
    h.price(P0, 1001n);
    h.clock(1010n, 1032n);
    await h.send("fill_stale", h.fillIx(t), h.stranger, "FeedStale");
    h.clock(1010n, 1031n);
    h.svm.setSlotHashes([]);
    await h.send(
      "fill_missing_hash",
      h.fillIx(t),
      h.stranger,
      "SlotHashMissing",
    );
    h.hash(1000n);
    await h.send("fill_fresh_boundary", h.fillIx(t));
    const h2 = await Harness.create();
    const t2 = await h2.request(await h2.post());
    h2.clock(1010n, 1000n);
    h2.hash(1000n);
    h2.price(P0, 1001n);
    await h2.send("fill_future_second", h2.fillIx(t2));
  });
});

describe("P6 refund", () => {
  it.each([28n, 600n])(
    "refund by a third party at offset %s, without SlotHashes",
    async (offset) => {
      const h = await Harness.create();
      const house = await h.post();
      const before = h.svm.getAccount(h.trader.address);
      if (!before.exists) throw 0;
      const balance = amount(h.svm, h.traderQuote);
      const t = await h.request(house);
      const fee = h.lastFee;
      h.clock(1027n);
      h.svm.setSlotHashes([]);
      await h.send(
        "refund_boundary",
        h.refundIx(t),
        h.stranger,
        "WindowNotPassed",
      );
      h.clock(1000n + offset);
      await h.send("refund_open", h.refundIx(t));
      expect(amount(h.svm, h.traderQuote)).toBe(balance);
      expect(h.svm.getAccount(t.table).exists).toBe(false);
      expect(h.houseState(t).state).toBe(r.HouseState.Idle);
      const after = h.svm.getAccount(h.trader.address);
      if (!after.exists) throw 0;
      expect(before.lamports - after.lamports).toBe(fee);
    },
  );
});
const vectors = [
  ["Long", 10677218000n, 10677218000n, 9363636n, 100636364n, 90909090n, "Stop"],
  [
    "Long",
    10677218000n,
    10783990180n,
    103000000n,
    7000000n,
    1000000000n,
    "HouseLine",
  ],
  [
    "Long",
    10677218000n,
    10783990179n,
    102999999n,
    7000001n,
    999999991n,
    "Stop",
  ],
  ["Long", 10677218000n, 10666540782n, 0n, 110000000n, 0n, "TraderLine"],
  ["Long", 10677218000n, 10666540783n, 0n, 110000000n, 8n, "Stop"],
  [
    "Short",
    10677218000n,
    10570445820n,
    103000000n,
    7000000n,
    1000000000n,
    "HouseLine",
  ],
  ["Short", 10677218000n, 10687895218n, 0n, 110000000n, 0n, "TraderLine"],
  [
    "Long",
    10186000000n,
    10202000000n,
    24071881n,
    85928119n,
    233707584n,
    "Stop",
  ],
  [
    "Short",
    10186000000n,
    10170000000n,
    24071881n,
    85928119n,
    233707584n,
    "Stop",
  ],
] as const;
describe("P7 exact split vectors", () => {
  it.each(vectors)(
    "%s %s -> %s A %s B %s f %s %s",
    async (side, p0, p, a, b, f, end) => {
      const h = await Harness.create();
      const house = await h.post();
      const before = h.svm.getAccount(h.trader.address);
      if (!before.exists) throw 0;
      const balance = amount(h.svm, h.traderQuote);
      const t = await h.request(house, {
        side: side === "Long" ? r.Side.Long : r.Side.Short,
      });
      const fee = h.lastFee;
      await h.fill(t, p0);
      expect(
        split({ side, lev: 1000, m: M, k: 10, eBps: 700, p0, p }),
      ).toMatchObject({ a, b, fE9: f });
      if (end === "Stop") {
        await h.send("request_close", h.requestCloseIx(t), h.trader);
        h.clock(1020n, 1004n);
        h.hash(1010n);
      } else h.clock(1011n, 1003n);
      h.price(p, 1004n);
      await h.send("settle_vector", h.settleIx(t));
      expect(h.events[0]).toMatchObject({
        name: "Settled",
        data: {
          a,
          b,
          fE9: f,
          end: r.End[end],
          stakeAfter: 100000000n + M - a,
          pEnd: p,
        },
      });
      expect(a + b).toBe(110000000n);
      expect(amount(h.svm, h.traderQuote) - balance).toBe(a - M);
      expect(h.houseState(t).stake).toBe(100000000n + M - a);
      expect(h.svm.getAccount(t.table).exists).toBe(false);
      const after = h.svm.getAccount(h.trader.address);
      if (!after.exists) throw 0;
      expect(before.lamports - after.lamports).toBe(
        fee + (end === "Stop" ? 5000n : 0n),
      );
      await h.send("second_settle", h.settleIx(t), h.stranger, "");
    },
  );
  it.each(vectors.filter((x) => x[6] === "Stop"))(
    "expiry uses the same split %s %s -> %s",
    async (side, p0, p, a, b, f) => {
      const h = await Harness.create();
      const house = await h.post();
      const t = await h.request(house, {
        side: side === "Long" ? r.Side.Long : r.Side.Short,
      });
      await h.fill(t, p0);
      h.clock(500000n, 87402n);
      h.price(p, 87402n);
      await h.send("settle_expiry", h.settleIx(t));
      expect(h.events[0]).toMatchObject({
        name: "Settled",
        data: { a, b, fE9: f, end: r.End.Expiry },
      });
    },
  );
});

describe("P7 k at the program limits", () => {
  it.each([
    [100, "Long", 1000, 1000000n, 11744939800n, 94000000n, 7000000n, "HouseLine"],
    [100, "Short", 500, 1000000n, 8541774400n, 94000000n, 7000000n, "HouseLine"],
    [100, "Long", 1000, 1000000n, 10666540782n, 0n, 101000000n, "TraderLine"],
    [100, "Long", 1000, 1000000n, 11211078900n, null, null, "Expiry"],
    [1, "Long", 1000, 10000000n, 10687895218n, 19300000n, 700000n, "HouseLine"],
    [1, "Long", 1000, 10000000n, 10666540782n, 0n, 20000000n, "TraderLine"],
    [1, "Short", 500, 10000000n, P0, 9650000n, 10350000n, "Expiry"],
  ] as const)(
    "k = %s %s %sx m %s to %s -> A %s B %s %s",
    async (k, side, lev, m, p, a, b, end) => {
      const h = await Harness.create({ initialize: false });
      await h.send("init_k", h.initIx({ kMin: 1, kMax: 100 }), h.admin);
      const house = await h.post({ k });
      const t = await h.request(house, { side: r.Side[side], lev, m });
      await h.fill(t, P0);
      const want = split({ side, lev, m, k, eBps: 700, p0: P0, p });
      if (a !== null) expect(want).toMatchObject({ a, b });
      if (end === "Expiry") {
        h.clock(500000n, 87402n);
        h.price(p, 87402n);
      } else {
        h.clock(1011n, 1003n);
        h.price(p, 1004n);
      }
      await h.send("settle_k", h.settleIx(t));
      expect(h.events[0]).toMatchObject({
        name: "Settled",
        data: { a: want.a, b: want.b, end: r.End[end] },
      });
      expect(want.a + want.b).toBe(BigInt(1 + k) * m);
      expect(h.houseState(t).stake).toBe(100000000n + m - want.a);
    },
  );
});

describe("P8 close and priority", () => {
  it("close is trader-only; stop needs a newer publication and window; retries only after max end", async () => {
    const h = await Harness.create();
    const t = await open(h);
    await h.send(
      "not_trader",
      h.requestCloseIx(t, { trader: h.stranger }),
      h.stranger,
      "NotTrader",
    );
    await h.send("request_close", h.requestCloseIx(t), h.trader);
    await h.send(
      "close_too_soon",
      h.requestCloseIx(t),
      h.trader,
      "WindowNotPassed",
    );
    h.clock(1019n, 1004n);
    h.hash(1010n);
    h.price(P0, 1004n);
    await h.send("stop_before", h.settleIx(t), h.stranger, "NothingToSettle");
    h.clock(1020n, 1004n);
    h.price(P0, 1002n);
    await h.send("stop_old", h.settleIx(t), h.stranger, "NothingToSettle");
    h.clock(1025n, 1005n);
    h.price(P0, 1005n);
    await h.send("stop_after", h.settleIx(t), h.stranger, "NothingToSettle");
    h.clock(1037n, 1006n);
    await h.send(
      "close_max_end",
      h.requestCloseIx(t),
      h.trader,
      "WindowNotPassed",
    );
    h.clock(1038n, 1006n);
    await h.send("request_close", h.requestCloseIx(t), h.trader);
    h.clock(1048n, 1008n);
    h.hash(1038n);
    h.price(P0, 1008n);
    await h.send("settle_stop", h.settleIx(t));
    expect(h.events[0]).toMatchObject({
      name: "Settled",
      data: { end: r.End.Stop },
    });
  });
  it.each([
    ["TraderLine", 10666540782n],
    ["HouseLine", 10783990180n],
  ] as const)("line %s wins over Stop and Expiry", async (end, p) => {
    const h = await Harness.create();
    const t = await open(h);
    h.clock(500000n, 87402n);
    h.price(P0, 87402n);
    await h.send("request_close", h.requestCloseIx(t), h.trader);
    h.clock(500010n, 87404n);
    h.hash(500000n);
    h.price(p, 87404n);
    await h.send("settle_line", h.settleIx(t));
    expect(h.events[0]).toMatchObject({
      name: "Settled",
      data: { end: r.End[end] },
    });
  });
  it.each([false, true])(
    "expiry boundary and publication rollback CloseRequested=%s",
    async (close) => {
      const h = await Harness.create();
      const t = await open(h);
      if (close) await h.send("request_close", h.requestCloseIx(t), h.trader);
      h.clock(500000n, 87401n);
      h.price(P0, 87401n);
      await h.send(
        "expiry_before",
        h.settleIx(t),
        h.stranger,
        "NothingToSettle",
      );
      h.clock(500001n, 87402n);
      h.price(P0, 1001n);
      await h.send("backwards_publish", h.settleIx(t), h.stranger, "FeedStale");
      h.clock(1020n, 1003n);
      h.price(P0, 1001n);
      await h.send(
        "backwards_fresh",
        h.settleIx(t),
        h.stranger,
        "FeedNotNewer",
      );
      h.clock(500001n, 87402n);
      h.price(P0, 87402n);
      await h.send("settle_expiry", h.settleIx(t));
      expect(h.events[0]).toMatchObject({
        name: "Settled",
        data: { end: r.End.Expiry },
      });
    },
  );
});

describe("P9 recipient recovery", () => {
  it.each(["closed", "reassigned"])(
    "atomically creates a trader recipient when ATA is %s",
    async (kind) => {
      const h = await Harness.create();
      const t = await open(h);
      await h.send(
        "empty_trader",
        token.getTransferCheckedInstruction({
          source: h.traderQuote,
          destination: h.ownerQuote,
          mint: h.quote,
          authority: h.trader,
          amount: amount(h.svm, h.traderQuote),
          decimals: 6,
        }),
        h.trader,
      );
      if (kind === "closed")
        await h.send(
          "close_trader_ata",
          token.getCloseAccountInstruction({
            account: h.traderQuote,
            destination: h.trader.address,
            owner: h.trader,
          }),
          h.trader,
        );
      else
        await h.send(
          "reassign_ata",
          token.getSetAuthorityInstruction({
            owned: h.traderQuote,
            owner: h.trader,
            authorityType: token.AuthorityType.AccountOwner,
            newAuthority: h.stranger.address,
          }),
          h.trader,
        );
      h.price(10783990180n, 1003n);
      const ixs = await buildSettleInstructions({
        payer: h.stranger,
        tableAddress: t.table,
        table: h.tableState(t),
        quoteMint: h.quote,
        feed: FEEDS[0],
        price: 10783990180n,
        rent: h.svm.minimumBalanceForRentExemption(165n),
        getAccount: async (a) =>
          h.svm.getAccount(a).exists
            ? {
                owner: getAddressDecoder().decode(
                  accountData(h.svm, a).subarray(32, 64),
                ),
                mint: getAddressDecoder().decode(
                  accountData(h.svm, a).subarray(0, 32),
                ),
              }
            : null,
      });
      await h.send("settle_recovered", ixs);
      expect(h.svm.getAccount(t.table).exists).toBe(false);
    },
  );
  it("A=0 needs no token recipient; invalid owner/mint and missing A>0 recipient fail", async () => {
    const h = await Harness.create();
    const t = await open(h);
    h.price(10783990180n, 1003n);
    await h.send(
      "missing_trader",
      h.settleIx(t, { destination: null }),
      h.stranger,
      "MissingTraderAccount",
    );
    await h.send(
      "wrong_owner",
      h.settleIx(t, { destination: h.ownerQuote }),
      h.stranger,
      "WrongOwner",
    );
    const wrong = await h.fundToken(h.trader, h.ruinMint, TOKEN, 1n);
    await h.send(
      "wrong_mint",
      h.settleIx(t, { destination: wrong }),
      h.stranger,
      "WrongMint",
    );
    h.price(10666540782n, 1003n);
    await h.send("settle_zero", h.settleIx(t, { destination: null }));
  });
});

describe("P10 adversarial account interference", () => {
  it("prefunded PDAs do not block house, vault, lock or table creation", async () => {
    const h = await Harness.create();
    await h.send("set_ruin", h.ruinIx(), h.admin);
    await h.send("set_params", h.paramsIx({ ruinPerUsd: 1n }), h.admin);
    const ref = await h.ref();
    for (const a of [ref.house, ref.vault, ref.lockVault])
      await h.send(
        "prefund_pda",
        getTransferSolInstruction({
          source: h.stranger,
          destination: a,
          amount: lamports(h.svm.minimumBalanceForRentExemption(0n)),
        }),
        h.stranger,
      );
    await h.send("post_house", h.postIx(ref), h.owner);
    await h.send(
      "top_first_ruin",
      h.fundIx(ref, false, {
        quoteAmount: 0n,
        ruinAmount: 1n,
        ...h.lockAccounts(ref),
      }),
      h.owner,
    );
    const t = await h.tableRef(ref);
    await h.send(
      "prefund_table",
      getTransferSolInstruction({
        source: h.stranger,
        destination: t.table,
        amount: lamports(h.svm.minimumBalanceForRentExemption(0n)),
      }),
      h.stranger,
    );
    await h.send("request_open", h.requestIx(t), h.trader);
    await h.fill(t);
    await stop(h, t);
    await h.send("close_house", h.closeIx(ref), h.owner);
  });
  it("rejects substitutions, duplicate id and simultaneous requests with no account mutations", async () => {
    const h = await Harness.create();
    const a = await h.post(),
      b = await h.post();
    await h.send("duplicate_id", h.postIx(a), h.owner, "IdMismatch");
    const t = await h.tableRef(a);
    await h.send(
      "other_vault",
      h.requestIx(t, { vault: b.vault }),
      h.trader,
      "",
    );
    await h.send(
      "other_source",
      h.requestIx(t, { source: h.ownerQuote }),
      h.trader,
      "WrongOwner",
    );
    await h.send(
      "quote_substitute",
      h.requestIx(t, { quoteMint: JUPUSD }),
      h.trader,
      "WrongMint",
    );
    await h.send("request_open", h.requestIx(t), h.trader);
    const strangerQuote = await h.fundToken(h.stranger, h.quote, TOKEN, M);
    await h.send(
      "simultaneous",
      h.requestIx(t, { trader: h.stranger, source: strangerQuote }),
      h.stranger,
      "NotIdle",
    );
    const tb = await h.request(b);
    await h.send(
      "other_table",
      h.fillIx(t, { table: tb.table }),
      h.stranger,
      "",
    );
    h.clock(1028n);
    await h.send(
      "refund_receiver",
      h.refundIx(t, { trader: h.stranger.address }),
      h.stranger,
      "ReceiverMismatch",
    );
    await h.send(
      "refund_wrong_owner",
      h.refundIx(t, { destination: h.ownerQuote }),
      h.stranger,
      "WrongOwner",
    );
    await h.send("refund_open", h.refundIx(t));
    await h.send(
      "close_wrong_owner_destination",
      h.closeIx(a, { destination: h.traderQuote }),
      h.owner,
      "WrongOwner",
    );
    const rogue = (await generateKeyPairSigner()).address;
    const original = h.svm.getAccount(FEEDS[0]);
    if (!original.exists) throw 0;
    h.svm.setAccount({ ...original, address: rogue });
    const t2 = await h.tableRef(a);
    await h.send(
      "unconfigured_feed",
      h.requestIx(t2, { feed: rogue }),
      h.trader,
      "FeedNotConfig",
    );
  });
  it("donations preserve refund, partial withdrawal and complete owner return", async () => {
    const h = await Harness.create();
    const house = await h.post();
    await h.donate(h.ownerQuote, house.vault, h.quote, TOKEN, h.owner, 37n);
    const t = await h.request(house);
    h.clock(1028n);
    await h.send("refund_open", h.refundIx(t));
    await h.send(
      "withdraw",
      h.fundIx(house, true, { quoteAmount: 1000000n }),
      h.owner,
    );
    expect(amount(h.svm, house.vault)).toBe(h.houseState(house).stake + 37n);
    await h.send("close_house", h.closeIx(house), h.owner);
    expect(h.events[0]).toMatchObject({
      name: "HouseClosed",
      data: { quoteReturned: 99000037n },
    });
  });
});

describe("P11 events and conservation", () => {
  it("covers every public instruction with exactly one decoded event and verifies state fields", async () => {
    const h = await Harness.create();
    expect(h.events[0]).toMatchObject({
      name: "Initialized",
      data: {
        quoteMint: h.quote,
        admin: h.admin.address,
        ...DEFAULT_PARAMS,
      },
    });
    await h.send("set_ruin", h.ruinIx(), h.admin);
    expect(h.events[0]).toMatchObject({
      name: "RuinSet",
      data: { ruinMint: h.ruinMint, ruinTokenProgram: TOKEN },
    });
    await h.send("set_params", h.paramsIx({ freeStake: 200000000n }), h.admin);
    expect(h.events[0]).toMatchObject({
      name: "ParamsSet",
      data: { ...DEFAULT_PARAMS, freeStake: 200000000n },
    });
    const house = await h.post();
    expect(h.events[0]).toMatchObject({
      name: "HousePosted",
      data: {
        house: house.house,
        id: house.id,
        stake: 100000000n,
        ruinLocked: 0n,
      },
    });
    await h.send(
      "top_up",
      h.fundIx(house, false, { quoteAmount: 10n }),
      h.owner,
    );
    expect(h.events[0]).toMatchObject({
      name: "HouseFunded",
      data: { quoteIn: 10n, stake: 100000010n },
    });
    await h.send(
      "withdraw",
      h.fundIx(house, true, { quoteAmount: 10n }),
      h.owner,
    );
    expect(h.events[0]).toMatchObject({
      name: "HouseFunded",
      data: { quoteOut: 10n, stake: 100000000n },
    });
    const t = await h.request(house);
    expect(h.events[0]).toMatchObject({
      name: "OpenRequested",
      data: {
        table: t.table,
        house: t.house,
        seq: 0n,
        trader: h.trader.address,
        requestSlot: 1000n,
        requestPrice: P0,
      },
    });
    await h.fill(t);
    await stop(h, t);
    expect(h.events[0]).toMatchObject({
      name: "Settled",
      data: {
        trader: h.trader.address,
        owner: h.owner.address,
        market: 0,
        m: M,
        k: 10,
        eBps: 700,
        p0: P0,
        a: 9363636n,
        b: 100636364n,
      },
    });
  });
  it("client oracle enforces configured address, owner/layout/asset and signed freshness", async () => {
    const h = await Harness.create();
    const data = accountData(h.svm, FEEDS[0]);
    const input = { address: FEEDS[0], owner: DOVES, data },
      e = {
        feed: FEEDS[0],
        asset: h.configState().markets[0].asset,
        now: 999n,
        staleSecs: 30,
      };
    expect(readDoves(input, e)).toMatchObject({
      price: P0,
      publishTs: 1000n,
      exponent: -8,
    });
    expect(() => readDoves(input, { ...e, now: 1031n })).toThrow("FeedStale");
    expect(() => readDoves({ ...input, address: FEEDS[1] }, e)).toThrow(
      "FeedNotConfig",
    );
    expect(() => readDoves({ ...input, owner: TOKEN }, e)).toThrow(
      "FeedInvalid",
    );
  });
});

describe("arithmetic capacity and remaining issuer trust", () => {
  it("fill rejects a u128 claim product overflow with unchanged accounts", async () => {
    const h = await Harness.create();
    await h.send(
      "set_params",
      h.paramsIx({ freeStake: (1n << 64n) - 1n }),
      h.admin,
    );
    const hq = h.svm.getAccount(h.ownerQuote);
    if (!hq.exists) throw 0;
    const q = Buffer.from(hq.data);
    q.writeBigUInt64LE((1n << 64n) - 1n, 64);
    h.svm.setAccount({ ...hq, data: q });
    const house = await h.post({ stake: 10000000000000000000n });
    const tq = h.svm.getAccount(h.traderQuote);
    if (!tq.exists) throw 0;
    const td = Buffer.from(tq.data);
    td.writeBigUInt64LE(1000000000000000000n, 64);
    h.svm.setAccount({ ...tq, data: td });
    const t = await h.request(house, { m: 1000000000000000000n });
    h.clock(1010n, 1002n);
    h.hash(1000n);
    h.price((1n << 64n) - 1n, 1002n);
    await h.send("fill_overflow", h.fillIx(t), h.stranger, "Overflow");
  });
  it("a frozen quote vault blocks withdrawal until the issuer thaws it", async () => {
    const h = await Harness.create();
    const house = await h.post();
    const a = h.svm.getAccount(house.vault);
    if (!a.exists) throw 0;
    const frozen = Buffer.from(a.data);
    frozen[108] = 2;
    h.svm.setAccount({ ...a, data: frozen });
    await h.send("issuer_frozen", h.fundIx(house, true), h.owner, "");
    frozen[108] = 1;
    h.svm.setAccount({ ...a, data: frozen });
    await h.send("withdraw", h.fundIx(house, true), h.owner);
  });
  it("accepts a permanent delegate mint and demonstrates external delegate removal from the lock vault", async () => {
    const h = await Harness.create({ ruinProgram: TOKEN_2022 });
    h.ruinMint = await h.createMint(TOKEN_2022, "delegate");
    h.ownerRuin = await h.fundToken(
      h.owner,
      h.ruinMint,
      TOKEN_2022,
      10000000000000n,
    );
    await h.send("set_ruin", h.ruinIx(), h.admin);
    await h.send(
      "set_params",
      h.paramsIx({ ruinPerUsd: 10000000000n }),
      h.admin,
    );
    const house = await h.ref();
    await h.send(
      "post_house",
      h.postIx(house, {
        stake: 1000000000n,
        ruinAmount: 10000000000000n,
        ...h.lockAccounts(house),
      }),
      h.owner,
    );
    const receiver = await h.fundToken(h.admin, h.ruinMint, TOKEN_2022, 1n);
    await h.send(
      "external_delegate",
      token22.getTransferCheckedInstruction({
        source: house.lockVault,
        mint: h.ruinMint,
        destination: receiver,
        authority: h.admin,
        amount: 1n,
        decimals: 8,
      }),
      h.admin,
    );
    expect(amount(h.svm, house.lockVault)).toBe(9999999999999n);
    expect(h.houseState(house).ruinLocked).toBe(10000000000000n);
  });
});

it("P3 closes an empty initialized lock vault and rejects omitting it after all RUIN is withdrawn", async () => {
  const h = await Harness.create();
  await h.send("set_ruin", h.ruinIx(), h.admin);
  await h.send("set_params", h.paramsIx({ ruinPerUsd: 1n }), h.admin);
  const house = await h.ref();
  await h.send(
    "post_house",
    h.postIx(house, { ruinAmount: 1n, ...h.lockAccounts(house) }),
    h.owner,
  );
  await h.send(
    "withdraw_all_ruin",
    h.fundIx(house, true, { quoteAmount: 0n, ruinAmount: 1n }),
    h.owner,
  );
  expect(h.houseState(house).ruinLocked).toBe(0n);
  await h.send(
    "omit_lock",
    h.closeIx(house, { ...h.lockAccounts(house, false) }),
    h.owner,
    "RuinNotSet",
  );
  await h.send("close_empty_lock", h.closeIx(house), h.owner);
  expect(h.svm.getAccount(house.lockVault).exists).toBe(false);
});
