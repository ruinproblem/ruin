import { it, expect } from "vitest";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { Subscriptions } from "../src/common/ws.js";
import { sleep } from "../src/common/env.js";
const { WebSocketServer } = createRequire(import.meta.url)("ws");

async function server(name: string, accept = true, lifetime = 0) {
  const http = createServer(), wss = new WebSocketServer({ noServer: true });
  const attempts: number[] = [], opens: number[] = [], closes: number[] = [];
  const state = { accept, lifetime };
  http.on("upgrade", (req, socket, head) => {
    attempts.push(Date.now());
    if (!state.accept) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws: any) => wss.emit("connection", ws));
  });
  wss.on("connection", (ws: any) => {
    opens.push(Date.now());
    ws.on("message", (raw: any) => {
      const b = JSON.parse(String(raw));
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: b.id, result: 1 }));
    });
    const interval = setInterval(() => ws.send(JSON.stringify({
      jsonrpc: "2.0", method: "slotNotification", params: { subscription: 1, result: { slot: Date.now() } },
    })), 100);
    const timer = state.lifetime ? setTimeout(() => ws.close(), state.lifetime) : undefined;
    ws.once("close", () => { closes.push(Date.now()); clearInterval(interval); if (timer) clearTimeout(timer); });
  });
  await new Promise<void>((yes) => http.listen(0, "127.0.0.1", yes));
  return {
    name, state, attempts, opens, closes,
    endpoint: { name, ws: `ws://127.0.0.1:${(http.address() as any).port}`, verified: true, disabled: false },
    close: async () => {
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((yes) => wss.close(() => http.close(() => yes())));
    },
  };
}
async function until(predicate: () => boolean, timeout = 15000) {
  const end = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > end) throw new Error("Local socket condition timed out"); await sleep(20); }
}
function subscriptions(servers: Awaited<ReturnType<typeof server>>[]) {
  const events: any[] = [];
  const ws = new Subscriptions({ list: servers.map((s) => s.endpoint), metrics: { add() {} } } as any, 2000, (e) => events.push({ at: Date.now(), ...e }));
  return { ws, events };
}
it("R1 ready disconnects always retry public after one second for twenty seconds", async () => {
  const publicServer = await server("public", true, 800), fallback = await server("fallback2", true, 800);
  const { ws, events } = subscriptions([publicServer, fallback]);
  ws.subscribe("slotSubscribe", [], () => {});
  const start = Date.now();
  try {
    ws.start();
    await sleep(20000);
    const ready = events.filter((e) => e.event === "subscription-ready");
    const gaps = publicServer.opens.slice(1).map((at, i) => at - publicServer.closes[i]);
    console.log(JSON.stringify({ case: "R1", ready: ready.map((e) => [e.endpoint, e.at - start]), disconnectToPublicMs: gaps }));
    expect(ready.length).toBeGreaterThanOrEqual(10);
    expect(ready.every((e) => e.endpoint === "public")).toBe(true);
    expect(gaps.every((ms) => ms <= 1500)).toBe(true);
  } finally { ws.close(); await Promise.all([publicServer.close(), fallback.close()]); }
}, 25000);
it("R2 public recovery replaces fallback within thirteen seconds without a slot gap", async () => {
  const publicServer = await server("public", false), fallback = await server("fallback2");
  const { ws, events } = subscriptions([publicServer, fallback]);
  const slots: number[] = [];
  ws.subscribe("slotSubscribe", [], () => slots.push(Date.now()));
  try {
    ws.start(); await until(() => ws.ready && ws.endpoint === "fallback2");
    await sleep(500);
    const recovered = Date.now(); publicServer.state.accept = true;
    await until(() => ws.ready && ws.endpoint === "public", 13000);
    await sleep(500);
    const gaps = slots.slice(1).map((at, i) => at - slots[i]);
    console.log(JSON.stringify({ case: "R2", recoveredInMs: Date.now() - recovered - 500, maxSlotGapMs: Math.max(...gaps), ready: events.filter((e) => e.event === "subscription-ready") }));
    expect(Date.now() - recovered - 500).toBeLessThanOrEqual(13000);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(400);
    expect(fallback.closes.length).toBe(1);
  } finally { ws.close(); await Promise.all([publicServer.close(), fallback.close()]); }
}, 18000);
it("R3 all-failed rounds back off 1/2/4 seconds and ready resets the next delay", async () => {
  const publicServer = await server("public", false), fallback = await server("fallback2", false);
  const { ws } = subscriptions([publicServer, fallback]);
  ws.subscribe("slotSubscribe", [], () => {});
  try {
    ws.start(); await until(() => publicServer.attempts.length >= 3);
    publicServer.state.accept = true; publicServer.state.lifetime = 800;
    await until(() => publicServer.opens.length >= 2, 12000);
    const waits = publicServer.attempts.slice(1, 4).map((at, i) => at - publicServer.attempts[i]);
    const reset = publicServer.opens[1] - publicServer.closes[0];
    console.log(JSON.stringify({ case: "R3", failedRoundWaitMs: waits, afterReadyMs: reset }));
    for (let i = 0; i < 3; i++) expect(waits[i]).toBeGreaterThanOrEqual(1000 * 2 ** i - 50);
    for (let i = 0; i < 3; i++) expect(waits[i]).toBeLessThan(1000 * 2 ** i + 500);
    expect(reset).toBeGreaterThanOrEqual(950); expect(reset).toBeLessThanOrEqual(1500);
  } finally { ws.close(); await Promise.all([publicServer.close(), fallback.close()]); }
}, 15000);
it("R4 public and two alternatives fail before fallback3 connects, then public recovery replaces it within thirteen seconds", async () => {
  const servers = await Promise.all([
    server("public", false), server("fallback", false), server("fallback2", false), server("fallback3"),
  ]);
  const { ws, events } = subscriptions(servers);
  const slots: number[] = [];
  ws.subscribe("slotSubscribe", [], () => slots.push(Date.now()));
  try {
    ws.start();
    await until(() => ws.ready && ws.endpoint === "fallback3");
    expect(servers.slice(0, 3).every(s => s.attempts.length > 0 && s.opens.length === 0)).toBe(true);
    expect(events.find(e => e.event === "subscription-ready")?.endpoint).toBe("fallback3");
    await sleep(500);
    const recovered = Date.now();
    servers[0].state.accept = true;
    await until(() => ws.ready && ws.endpoint === "public", 13000);
    const recoveredInMs = Date.now() - recovered;
    await sleep(500);
    const gaps = slots.slice(1).map((at, i) => at - slots[i]);
    console.log(JSON.stringify({ case: "R4", recoveredInMs, maxSlotGapMs: Math.max(...gaps), ready: events.filter(e => e.event === "subscription-ready") }));
    expect(recoveredInMs).toBeLessThanOrEqual(13000);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(400);
    expect(servers[3].closes).toHaveLength(1);
  } finally { ws.close(); await Promise.all(servers.map(s => s.close())); }
}, 18000);
