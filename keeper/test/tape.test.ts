import { it, expect, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { address, getBase58Decoder } from "@solana/kit";
import * as r from "../../program/client/index.js";
import { transactionEvents } from "../src/tape/receipts.js";
import { atomicFile, httpServer } from "../src/tape/http.js";
import { Publisher } from "../src/tape/publish.js";
import { Store } from "../src/common/sqlite.js";
import { RpcFault, RpcPool } from "../src/common/rpc.js";
import { Metrics } from "../src/common/log.js";
const a = address("11111111111111111111111111111111");
const T = 1792000000;
const bet = (n: number) => ({
  t0: T - 600 + n,
  s: 1,
  m: "10000000",
  d: 2,
  h: 0,
  c: `${18000 + n},3,-5`,
  pk: 0.25,
});
/** A window bet whose open trade is stored with signature `S<n>`, or not stored at all. */
function addBet(s: Store, n: number, stored = true) {
  if (stored)
    s.db.prepare("INSERT INTO trades VALUES(?,?,?,?,?)").run(
      `o${n}`,
      n,
      T - 700 + n,
      "open",
      JSON.stringify({
        id: `o${n}`,
        signature: `S${n}`,
        kind: "open",
        market: "SOL",
        side: "long",
        leverage: 1000,
        price: `${180000000000000 + n * 10000}`,
        executedAt: `${T - 700 + n}`,
        heldFor: null,
      }),
    );
  s.db
    .prepare("INSERT INTO results VALUES(?,?,?,?,?,?)")
    .run(`x${n}`, T - 600 + n, "rows", `o${n}`, "{}", JSON.stringify(bet(n)));
}
const published = (n: number, slot: number) => ({
  ...bet(n),
  sig: `S${n}`,
  p: 18000000000 + n,
  slot,
});
const windowFile = (dir: string) =>
  JSON.parse(readFileSync(resolve(dir, "window.json"), "utf8"));
const tapeFile = (dir: string) =>
  JSON.parse(readFileSync(resolve(dir, "tape.json"), "utf8"));
const ruinRpc = { metrics: new Metrics(), cluster: "mainnet" } as any;
/** A real pool whose only endpoint answers getSignatureStatuses from `answer` without a network. */
function statusPool(answer: (sig: string) => unknown) {
  const asked: string[][] = [];
  const rpc = new RpcPool(
    "mainnet",
    [{ name: "public", url: "http://public.invalid", ws: "", verified: true }],
    (async (_url: unknown, init: any) => {
      const body = JSON.parse(init.body);
      expect(body.method).toBe("getSignatureStatuses");
      expect(body.params[1]).toEqual({ searchTransactionHistory: true });
      asked.push(body.params[0]);
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { context: { slot: 1 }, value: body.params[0].map(answer) },
        }),
      );
    }) as typeof fetch,
    () => {},
  );
  return { rpc, asked };
}
const finalized = (slot: number) => ({
  slot,
  confirmations: null,
  err: null,
  confirmationStatus: "finalized",
});
it("T5 a reverted transaction cannot publish a Settled CPI event", () => {
  const data = r.getSettledEventEncoder().encode({
    table: a,
    house: a,
    seq: 0n,
    trader: a,
    owner: a,
    market: 0,
    side: r.Side.Long,
    lev: 1000,
    m: 10000000n,
    k: 10,
    eBps: 700,
    p0: 10000000000n,
    fillSlot: 1n,
    fillPublishTs: 1n,
    fillTs: 1n,
    end: r.End.Stop,
    pEnd: 10000000000n,
    endPublishTs: 2n,
    endSlot: 2n,
    endTs: 2n,
    fE9: 90909090n,
    a: 9363636n,
    b: 100636364n,
    stakeAfter: 100636364n,
  });
  const wire = getBase58Decoder().decode(
    new Uint8Array([
      ...new Uint8Array([228, 69, 165, 46, 81, 203, 154, 29]),
      ...data,
    ]),
  );
  const tx = {
    transaction: { message: { accountKeys: [r.RUIN_PROGRAM_ADDRESS] } },
    meta: {
      err: null,
      innerInstructions: [
        { instructions: [{ programIdIndex: 0, data: wire }] },
      ],
    },
  };
  expect(transactionEvents(tx)[0].name).toBe("Settled");
  tx.meta.err = { InstructionError: [1, { Custom: 6032 }] } as any;
  expect(transactionEvents(tx)).toEqual([]);
});
it("T7 serves byte-identical atomic JSON, headers, 304, 404 and 405", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "ruin-http-"));
  for (const f of ["tape.json", "window.json", "status.json"])
    atomicFile(dir, f, { v: 1, name: f });
  const server = httpServer(dir);
  await new Promise<void>((yes, no) => {
    server.once("error", no);
    server.listen(0, "127.0.0.1", yes);
  });
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    for (const f of ["tape.json", "window.json", "status.json"]) {
      const response = await fetch(`${url}/${f}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "application/json; charset=utf-8",
      );
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(response.headers.get("cache-control")).toBe("public, max-age=2");
      expect(Buffer.from(await response.arrayBuffer())).toEqual(
        readFileSync(resolve(dir, f)),
      );
      const cached = await fetch(`${url}/${f}`, {
        headers: { "if-none-match": response.headers.get("etag")! },
      });
      expect(cached.status).toBe(304);
    }
    expect((await fetch(`${url}/missing`)).status).toBe(404);
    expect((await fetch(`${url}/tape.json`, { method: "POST" })).status).toBe(
      405,
    );
  } finally {
    server.closeAllConnections();
    server.close();
    rmSync(dir, { recursive: true });
  }
});
it("T9 a window bet without a slot or a stored open is left out while the others carry sig, p and slot", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "ruin-window-")),
    s = new Store(":memory:");
  vi.useFakeTimers({ now: T * 1000, toFake: ["Date"] });
  try {
    for (const n of [1, 2, 3]) addBet(s, n);
    addBet(s, 4, false);
    const { rpc, asked } = statusPool((sig) =>
      sig === "S1"
        ? finalized(457263940)
        : sig === "S3"
          ? { ...finalized(457263941), err: { InstructionError: [0, "Custom"] } }
          : null,
    );
    const p = new Publisher(s, dir, { lastPollMs: 0 } as any, rpc, ruinRpc);
    await p.publish();
    const window = windowFile(dir);
    expect(Object.keys(window)).toEqual(["v", "generated", "src", "bets"]);
    expect([window.v, window.generated, window.src]).toEqual([1, T, "doves"]);
    expect(window.bets).toEqual([published(1, 457263940)]);
    expect(Object.keys(window.bets[0])).toEqual([
      ...Object.keys(bet(1)),
      "sig",
      "p",
      "slot",
    ]);
    // The bet without a stored open has no signature to ask.
    expect(asked).toEqual([["S1", "S2", "S3"]]);
    expect(p.status().rpc1h.getSignatureStatuses).toBe(1);
  } finally {
    vi.useRealTimers();
    s.close();
    rmSync(dir, { recursive: true });
  }
});
it("T10 a signature is asked once; later rounds ask only new or unanswered signatures, every 60 s", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "ruin-window-")),
    s = new Store(":memory:");
  vi.useFakeTimers({ now: T * 1000, toFake: ["Date"] });
  try {
    const ready = new Set(["S1"]);
    const { rpc, asked } = statusPool((sig) =>
      ready.has(sig) ? finalized(457263900 + Number(sig.slice(1))) : null,
    );
    const p = new Publisher(s, dir, { lastPollMs: 0 } as any, rpc, ruinRpc);
    addBet(s, 1);
    addBet(s, 2);
    await p.publish();
    expect(windowFile(dir).bets).toEqual([published(1, 457263901)]);
    vi.setSystemTime((T + 2) * 1000);
    addBet(s, 3);
    expect(p.publish()).toBeUndefined();
    expect(asked).toEqual([["S1", "S2"]]);
    vi.setSystemTime((T + 62) * 1000);
    ready.add("S2").add("S3");
    await p.publish();
    expect(asked).toEqual([
      ["S1", "S2"],
      ["S2", "S3"],
    ]);
    expect(windowFile(dir).bets).toEqual([
      published(1, 457263901),
      published(2, 457263902),
      published(3, 457263903),
    ]);
    vi.setSystemTime((T + 122) * 1000);
    await p.publish();
    expect(asked.length).toBe(2);
    expect(windowFile(dir).generated).toBe(T + 122);
    // Signatures that leave the window are forgotten.
    s.db.prepare("DELETE FROM results WHERE id='x1'").run();
    vi.setSystemTime((T + 182) * 1000);
    await p.publish();
    expect(asked.length).toBe(2);
    expect([...(p as any).slots.keys()]).toEqual(["S2", "S3"]);
    expect(windowFile(dir).bets).toEqual([
      published(2, 457263902),
      published(3, 457263903),
    ]);
    // After a restart the first round asks once for every signature.
    const restarted = new Publisher(s, dir, { lastPollMs: 0 } as any, rpc, ruinRpc);
    await restarted.publish();
    expect(asked.at(-1)).toEqual(["S2", "S3"]);
    expect(asked.length).toBe(3);
    expect(p.status().rpc1h.getSignatureStatuses).toBe(3);
  } finally {
    vi.useRealTimers();
    s.close();
    rmSync(dir, { recursive: true });
  }
});
it("T11 a failing or hanging status lookup does not stop tape.json or status.json, and only one lookup runs at a time", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "ruin-window-")),
    s = new Store(":memory:"),
    logged: any[] = [];
  vi.useFakeTimers({ now: T * 1000, toFake: ["Date"] });
  const quiet = vi
    .spyOn(console, "log")
    .mockImplementation((line: string) => logged.push(JSON.parse(line)));
  try {
    let mode: "fail" | "hang" | "answer" = "fail";
    const asked: string[][] = [];
    const rpc = {
      metrics: new Metrics(),
      call: async (_method: string, params: any[]) => {
        asked.push(params[0]);
        if (mode === "fail") throw new RpcFault("getSignatureStatuses");
        if (mode === "hang") return new Promise(() => {});
        return {
          value: params[0].map((sig: string) =>
            finalized(457263900 + Number(sig.slice(1))),
          ),
        };
      },
    } as any;
    const p = new Publisher(s, dir, { lastPollMs: 0 } as any, rpc, ruinRpc);
    p.windowTimeoutMs = 200;
    addBet(s, 1);
    addBet(s, 2);
    const failed = p.publish();
    expect(tapeFile(dir).generated).toBe(T);
    await failed;
    expect(windowFile(dir).bets).toEqual([]);
    expect(logged.some((x) => x.event === "window-error")).toBe(true);
    vi.setSystemTime((T + 60) * 1000);
    mode = "answer";
    await p.publish();
    expect(windowFile(dir).bets).toEqual([
      published(1, 457263901),
      published(2, 457263902),
    ]);
    vi.setSystemTime((T + 120) * 1000);
    mode = "hang";
    addBet(s, 3);
    const hung = p.publish();
    expect(hung).toBeDefined();
    // The tape keeps publishing while the lookup is outstanding.
    s.db
      .prepare("INSERT INTO results VALUES(?,?,?,?,?,?)")
      .run("x9", T + 121, "rows", null, JSON.stringify({ id: "x9" }), null);
    vi.setSystemTime((T + 122) * 1000);
    expect(p.publish()).toBe(hung);
    const tape = tapeFile(dir);
    expect([tape.generated, tape.rows.at(-1)]).toEqual([T + 122, { id: "x9" }]);
    expect(p.status().generated).toBe(T + 122);
    expect(
      JSON.parse(readFileSync(resolve(dir, "status.json"), "utf8")).generated,
    ).toBe(T + 122);
    // Sixty seconds later the outstanding lookup still blocks a second one.
    vi.setSystemTime((T + 180) * 1000);
    expect(p.publish()).toBe(hung);
    expect(asked.length).toBe(3);
    await hung;
    const window = windowFile(dir);
    expect(window.generated).toBe(T + 120);
    expect(window.bets).toEqual([
      published(1, 457263901),
      published(2, 457263902),
    ]);
    vi.setSystemTime((T + 182) * 1000);
    mode = "answer";
    await p.publish();
    expect(asked.at(-1)).toEqual(["S3"]);
    expect(windowFile(dir).bets.map((b: any) => b.sig)).toEqual(["S1", "S2", "S3"]);
  } finally {
    quiet.mockRestore();
    vi.useRealTimers();
    s.close();
    rmSync(dir, { recursive: true });
  }
});
