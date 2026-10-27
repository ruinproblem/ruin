import { describe, it, expect } from "vitest";
import {
  calculate,
  pairTrades,
  delta,
  type Sample,
} from "../src/tape/calculate.js";
import type { Trade } from "../src/tape/yolo.js";
import { validTrade } from "../src/tape/yolo.js";
import { Store } from "../src/common/sqlite.js";
import { DovesRecorder } from "../src/tape/doves.js";
import { Publisher } from "../src/tape/publish.js";
const trade = (
  id: string,
  kind: Trade["kind"],
  at: number,
  price = "100000000000000",
  heldFor: number | null = null,
): Trade => ({
  id,
  signature: id,
  kind,
  market: "SOL",
  owner: "owner",
  side: "long",
  margin: "10000000",
  notional: "10000000000",
  leverage: 1000,
  price,
  executedAt: String(at),
  amount: "0",
  queued: "0",
  heldFor,
});
const sample = (t: number, p = "10000000000"): Sample => ({
  publish_ts: t,
  price: p,
  slot: t,
  recv_ms: t * 1000,
});
const open = trade("open", "open", 1000),
  close = trade("close", "close", 1010, "100000000000000", 10);
it("a changed API schema cannot fabricate missing payout fields", () => {
  expect(validTrade(open)).toBe(true);
  expect(validTrade(close)).toBe(true);
  expect(validTrade({ ...close, amount: undefined })).toBe(false);
  expect(validTrade({ ...close, heldFor: null })).toBe(false);
});
const decode = (v: string) => {
  let a = 0;
  return v.split(",").map((x) => (a += Number(x)));
};
describe("S1 integer counterfactual rows", () => {
  it("close without line uses YOLO price and ends at held/PE", () => {
    const r = calculate(
      close,
      open,
      [sample(1000), sample(1005)],
      () => true,
    ).row;
    expect([r.c, r.d, r.f, r.A, r.B, r.ts, r.q]).toEqual([
      0,
      10,
      0.09091,
      9.36,
      100.64,
      "0,5,5",
      "1000000,0,0",
    ]);
  });
  it.each([
    [1, "10100000000", 103, 7],
    [-1, "9990000000", 0, 110],
  ])("first DOVES line %s fixes amount", (c, p, A, B) => {
    const r = calculate(
      close,
      open,
      [sample(1000), sample(1005, p)],
      () => true,
    ).row;
    expect([r.c, r.d, r.f, r.A, r.B]).toEqual([c, 5, c === 1 ? 1 : 0, A, B]);
    expect(r.ts).toBe("0,5");
    expect(r.q).toBe(c === 1 ? "1000000,10000" : "1000000,-1000");
  });
  it("YOLO exit beyond the house line still terminates the path at YOLO exit", () => {
    const e = { ...close, price: "101000000000000" };
    const r = calculate(e, open, [sample(1000), sample(1005)], () => true).row;
    expect([r.c, r.d, r.f, r.A, r.B, r.ts, r.q]).toEqual([
      1,
      10,
      1,
      103,
      7,
      "0,5,5",
      "1000000,0,10000",
    ]);
  });
  it.each([
    [1003, 3],
    [1014, 14],
  ])(
    "liquidation follows first line at %s before or after YOLO exit",
    (t, d) => {
      const e = { ...close, kind: "liquidate" as const };
      const r = calculate(
        e,
        open,
        [sample(1000), sample(t, "9980000000")],
        () => true,
        1020,
      ).row;
      expect([r.c, r.d, r.f, r.A, r.B]).toEqual([-1, d, 0, 0, 110]);
    },
  );
  it("unresolved, noRecord, unmatched and pending are distinct", () => {
    const e = { ...close, kind: "liquidate" as const };
    expect(calculate(e, open, [sample(1000)], () => true, 4611).status).toBe(
      "unresolved",
    );
    expect(calculate(e, open, [sample(1000)], () => true, 1015).status).toBe(
      "pending",
    );
    expect(calculate(close, open, [sample(1000)], () => false).status).toBe(
      "noRecord",
    );
    expect(calculate(close, undefined, [], () => true).status).toBe(
      "unmatched",
    );
  });
  it("late API ingestion cannot revive a liquidation after its one-hour unresolved deadline", () => {
    const e = { ...close, kind: "liquidate" as const },
      checked: number[] = [];
    const result = calculate(
      e,
      open,
      [sample(1000), sample(5000, "9980000000")],
      (_baseline, end) => {
        checked.push(end);
        return true;
      },
      6000,
    );
    expect(result.status).toBe("unresolved");
    expect(checked).toEqual([4610]);
    expect(
      calculate(
        e,
        open,
        [sample(1000), sample(5000, "9980000000")],
        () => true,
        100000,
      ).status,
    ).toBe("unresolved");
  });
  it.each(["close", "liquidate"] as const)(
    "24-hour %s expiration never uses late YOLO price",
    (kind) => {
      const e = {
        ...close,
        kind,
        heldFor: 90000,
        executedAt: "91000",
        price: "101000000000000",
      };
      expect(
        calculate(e, open, [sample(1000), sample(87400)], () => true, 92000)
          .status,
      ).toBe("expired");
      const r = calculate(
        e,
        open,
        [sample(1000), sample(87399, "10100000000")],
        () => true,
        92000,
      ).row;
      expect([r.c, r.d]).toEqual([1, 86399]);
      expect(
        calculate(e, open, [sample(1000)], () => false, 92000).status,
      ).toBe("noRecord");
    },
  );
  it("downsamples to 300 points while preserving first and deciding points", () => {
    const e = {
      ...close,
      executedAt: "1600",
      heldFor: 600,
      price: "100010000000000",
    };
    const r = calculate(
      e,
      open,
      Array.from({ length: 600 }, (_, i) => sample(1000 + i)),
      () => true,
    ).row;
    expect(decode(r.ts)).toHaveLength(300);
    expect(decode(r.ts).at(-1)).toBe(600);
    expect(decode(r.q).at(-1)).toBe(1000100);
  });
  it.each([
    ["SOL", 1792602263, "108045351060000", "10804640285", 98, "10793723425"],
    [
      "BTC",
      1792602211,
      "84425527177240000",
      "8442138056673",
      503,
      "8433690931544",
    ],
    ["ETH", 1792604373, "2514737519730000", "251474120396", 65, "251726539820"],
  ])(
    "real %s regression uses the first observed line and rejects a missing publication",
    (market, t0, p0, d0, d, hit) => {
      const o = {
        ...open,
        market,
        side: market === "ETH" ? ("short" as const) : ("long" as const),
        executedAt: String(t0),
        price: p0,
      };
      const e = {
        ...close,
        market,
        side: o.side,
        kind: "liquidate" as const,
        executedAt: String(t0 + d - 2),
        heldFor: d - 2,
      };
      const samples = Array.from({ length: Math.floor(d / 2) }, (_, i) =>
        sample(t0 + i * 2, d0),
      );
      if (market === "SOL") samples.push(sample(1792602359, "10793983523"));
      samples.push(sample(t0 + d, hit));
      samples.sort((a, b) => a.publish_ts - b.publish_ts);
      const r = calculate(e, o, samples, () => true, t0 + d + 10).row;
      expect([r.c, r.d, r.f, r.A, r.B]).toEqual([-1, d, 0, 0, 110]);
      expect(calculate(e, o, samples, () => false, t0 + d + 10).status).toBe(
        "noRecord",
      );
    },
  );
  it("window delta decoding has d+1 values and ends at its deciding line", () => {
    const r = calculate(
      { ...close, kind: "liquidate" },
      open,
      [sample(1000), sample(1014, "9980000000")],
      () => true,
      1020,
    );
    expect(decode(r.window.c)).toHaveLength(15);
    expect(decode(r.window.c).at(-1)).toBe(9980);
    expect(r.window.h).toBe(0);
  });
});
describe("S1 peaks past the 10-division line", () => {
  const exit = { ...close, executedAt: "1030", heldFor: 30 };
  const path = (...pts: [number, string][]) => [sample(1000), ...pts.map(([t, p]) => sample(t, p))];
  it("a bet over the house line is followed to the trader's line", () => {
    const r = calculate(exit, open, path([1005, "10050000000"], [1010, "10110000000"], [1015, "10350000000"], [1020, "9980000000"], [1025, "10600000000"]), () => true, 2000);
    expect([r.row.c, r.window.h, r.window.pk]).toEqual([1, 1, 35]);
  });
  it("the peak stops at 100 divisions", () => {
    const r = calculate(exit, open, path([1010, "10110000000"], [1015, "11500000000"]), () => true, 2000);
    expect(r.window.pk).toBe(100);
  });
  it("a gap in the record past the line keeps only the peak up to the line", () => {
    const r = calculate(exit, open, path([1010, "10110000000"], [1015, "10350000000"], [1020, "9980000000"]), (_a, end) => end <= 1010, 2000);
    expect(r.window.pk).toBe(11);
  });
  it("a bet whose trader line came first is not followed after it", () => {
    const r = calculate(exit, open, path([1005, "9980000000"], [1010, "10500000000"]), () => true, 2000);
    expect([r.row.c, r.window.pk]).toEqual([-1, 0]);
  });
  it("the publisher computes no row before it has the program's expiry", () => {
    const store = new Store(":memory:");
    const put = store.db.prepare("INSERT INTO trades VALUES(?,?,?,?,?)");
    put.run("open", 1, 1000, "open", JSON.stringify(open));
    put.run("close", 2, 1010, "close", JSON.stringify(close));
    store.set("yolo-cursor", "2");
    let expiry: number | undefined;
    const publisher = new Publisher(store, "", null as any, null as any, null as any, undefined, undefined, () => expiry);
    const count = () => (store.db.prepare("SELECT COUNT(*) n FROM results").get() as any).n;
    publisher.calculate();
    expect(count()).toBe(0);
    expiry = 259200;
    publisher.calculate();
    expect(count()).toBe(1);
  });
  it("the bet's expiry is the program's", () => {
    const e = { ...close, heldFor: 90000, executedAt: "91000", price: "101000000000000" };
    const samples = [sample(1000), sample(87400)];
    expect(calculate(e, open, samples, () => true, 92000).status).toBe("expired");
    expect(calculate(e, open, samples, () => true, 92000, 259200).status).toBe("rows");
  });
});
describe("S2 matching", () => {
  it("equivalent opens pair in cursor order and ambiguous prices leave opens unused", () => {
    const a = { ...open, id: "a" },
      b = { ...open, id: "b" },
      e = { ...close, id: "e" },
      f = { ...close, id: "f" };
    const input = [
      { trade: a, cursor: 1 },
      { trade: b, cursor: 2 },
      { trade: e, cursor: 3 },
      { trade: f, cursor: 4 },
    ];
    expect([...pairTrades(input)].map(([k, v]) => [k, v.id])).toEqual([
      ["e", "a"],
      ["f", "b"],
    ]);
    input[1].trade = { ...b, price: "99999999999999" };
    expect(pairTrades(input).size).toBe(0);
    input[1].trade = { ...b, leverage: 500 };
    expect(pairTrades(input).size).toBe(0);
  });
});
describe("S1 coverage regressions", () => {
  it("a close waits for the publication watermark and startup rebuilds an older cached path", () => {
    const store = new Store(":memory:");
    store.db
      .prepare(
        "INSERT INTO coverage(connection,start_ms,end_ms) VALUES('live',?,?)",
      )
      .run(999000, 1015000);
    const put = store.db.prepare(
      "INSERT INTO doves(market,publish_ts,price,slot,recv_ms,connection) VALUES('SOL',?,?,?,?, 'live')",
    );
    for (const t of [1000, 1007]) put.run(t, "10000000000", t, t * 1000);
    const publisher = new Publisher(
      store,
      "",
      null as any,
      null as any,
      null as any,
    );
    const get = () =>
      store.db
        .prepare("SELECT * FROM doves ORDER BY publish_ts,slot,id")
        .all() as Sample[];
    expect(
      calculate(
        close,
        open,
        get(),
        (a, end) => publisher.covered("SOL", a, end),
        1012,
      ).status,
    ).toBe("pending");
    const old = calculate(close, open, get(), () => true, 1012);
    store.db
      .prepare("INSERT INTO trades VALUES(?,?,?,?,?)")
      .run(open.id, 0, 1000, "open", JSON.stringify(open));
    store.db
      .prepare("INSERT INTO trades VALUES(?,?,?,?,?)")
      .run(close.id, 1, 1010, "close", JSON.stringify(close));
    store.db
      .prepare("INSERT INTO results VALUES(?,?,?,?,?,?)")
      .run(close.id, 1010, "rows", open.id, JSON.stringify(old.row), null);
    for (const t of [1008, 1009, 1010]) put.run(t, "10000000000", t, t * 1000);
    store.set("yolo-cursor", "2");
    publisher.calculate();
    const saved = JSON.parse(
      (
        store.db
          .prepare("SELECT row FROM results WHERE id=?")
          .get(close.id) as any
      ).row,
    );
    expect(saved.ts).toBe("0,7,1,1,1");
    store.close();
  });
  it("confirmed coverage may wait ten seconds for the next transaction listing", () => {
    const s = new Store(":memory:");
    const now = Date.now();
    s.db.prepare("INSERT INTO coverage(connection,start_ms,end_ms) VALUES(?,?,?)").run("confirmed", now - 20000, now - 5000);
    const p = new Publisher(s, "", null as any, null as any, null as any);
    expect(p.covered("SOL", { publish_ts: Math.floor((now - 15000) / 1000) } as Sample, Math.ceil(now / 1000))).toBe("pending");
    s.close();
  });
});
it.each([
  ["SOL", 1792602263, "108045351060000", "10804640285", 98, 139, "10793723425"],
  [
    "BTC",
    1792602211,
    "84425527177240000",
    "8442138056673",
    503,
    532,
    "8433690931544",
  ],
  [
    "ETH",
    1792604373,
    "2514737519730000",
    "251474120396",
    65,
    69,
    "251726539820",
  ],
])(
  "S1 %s missing first line with a publication-mapped gap cannot become a later line",
  (market, t0, p0, d0, d, later, hit) => {
    const s = new Store(":memory:");
    s.db
      .prepare("INSERT INTO coverage(connection,start_ms,end_ms) VALUES(?,?,?)")
      .run("live", t0 * 1000, (t0 + later + 10) * 1000);
    s.db
      .prepare(
        "INSERT INTO gaps(market,a,b,reason,start_ms,end_ms) VALUES(?,?,?,?,?,?)",
      )
      .run(
        market,
        t0 + d - 2,
        t0 + d + 2,
        "missing-slot-confirmations",
        (t0 + d - 2) * 1000,
        (t0 + d + 2) * 1000,
      );
    const samples = [sample(t0, d0), sample(t0 + later, hit)];
    const o = {
        ...open,
        market,
        side: market === "ETH" ? ("short" as const) : ("long" as const),
        executedAt: String(t0),
        price: p0,
      },
      e = {
        ...close,
        market,
        side: o.side,
        kind: "liquidate" as const,
        executedAt: String(t0 + d - 2),
        heldFor: d - 2,
      };
    const publisher = new Publisher(
      s,
      "",
      null as any,
      null as any,
      null as any,
    );
    expect(calculate(e, o, samples, () => true, t0 + later + 10).row.d).toBe(
      later,
    );
    expect(
      calculate(
        e,
        o,
        samples,
        (base, end) => publisher.covered(market, base, end),
        t0 + later + 10,
      ).status,
    ).toBe("noRecord");
    s.close();
  },
);
it("S1 waits for the next active slot confirmation rather than declaring recent data missing", () => {
  expect(calculate(close, open, [sample(1000)], () => "pending").status).toBe(
    "pending",
  );
});
