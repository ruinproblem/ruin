import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { RUIN_PROGRAM_ADDRESS, findConfigPda } from "../../program/client/index.js";
import { FEEDS } from "../../program/client/constants.js";
import { RpcPool } from "../src/common/rpc.js";
import { Subscriptions } from "../src/common/ws.js";
import { parseFeed } from "../src/common/oracle.js";
import { Overlay } from "../src/keeper/overlay.js";
import { tableFilters } from "../src/keeper/engine.js";
import { log } from "../src/common/log.js";
const arg = (key: string, fallback: string) => process.argv.includes(key) ? process.argv[process.argv.indexOf(key) + 1]! : fallback;
const duration = Number(arg("--seconds", "1800")) * 1000, switchAt = Number(arg("--switch-after", "0")) * 1000;
const started = Date.now();
let windows = arg("--windows", "off") === "on", inWs = false;
const notifications: Record<string, number> = {}, intervals: Record<string, number[]> = {}, last: Record<string, number> = {};
const logger = (category: string) => (e: Record<string, unknown>) => log({ ...e, category });
const transport = (category: string): typeof fetch => (async (url: any, options: any) => {
  const body = JSON.parse(String(options.body)), at = Date.now();
  const response = await fetch(url, options);
  log({ event: "observe-response", category, method: body.method, at, received: Date.now(), status: response.status });
  return response;
}) as typeof fetch;
const rpc = new RpcPool("mainnet", undefined, transport("observe"), logger("observe"));
const compare = new RpcPool("mainnet", undefined, transport("compare"), logger("compare"));
await Promise.all([rpc.initialize(), compare.initialize()]);
class ObservedSubscriptions extends Subscriptions {
  override subscribe(method: string, params: unknown[], callback: (v: any) => void) {
    return super.subscribe(method, params, v => {
      notifications[method] = (notifications[method] ?? 0) + 1;
      if (method === "slotSubscribe") {
        const at = Date.now();
        if (last.wsSlot) (intervals.wsSlot ??= []).push(at - last.wsSlot);
        last.wsSlot = at;
      }
      inWs = true; try { callback(v); } finally { inWs = false; }
    });
  }
}
const ws = new ObservedSubscriptions(rpc, undefined, logger("observe"));
const value = async (market: number, feed: string, raw: any, slot: number, source: string) => {
  const price = await parseFeed(feed, raw, market, "mainnet");
  log({ event: "observe-price", source, market, slot, publishTs: price.publishTs, price: price.price, received: Date.now(), windows });
};
const overlay: Overlay = new Overlay(rpc, ws, RUIN_PROGRAM_ADDRESS, FEEDS, {
  onSlot: () => {}, onTable: () => {},
  onPrice: (i, feed, raw, slot) => {
    const source = inWs ? "ws" : "overlay", at = Date.now();
    if (source === "overlay" && i === 0) {
      const key = windows ? "onFeeds" : "offFeeds";
      if (last[key]) (intervals[key] ??= []).push(at - last[key]);
      last[key] = at;
    }
    return value(i, feed, raw, slot, source);
  },
  windows: () => windows ? [{ target: overlay.slot, end: overlay.slot + 4n }] : [],
  openCount: () => windows ? 1 : 0, signatures: () => [], onStatuses: () => {},
}, logger("observe"));
overlay.start(); ws.start();
const config = (await findConfigPda())[0], timers: ReturnType<typeof setInterval>[] = [], pending = new Set<string>();
const every = (ms: number, key: string, work: () => Promise<unknown>) => timers.push(setInterval(() => {
  if (pending.has(key)) return;
  pending.add(key);
  void work().catch(() => log({ event: "observe-read-error", key })).finally(() => pending.delete(key));
}, ms));
every(2000, "blockhash", () => Promise.all([
  rpc.call("getLatestBlockhash", [{ commitment: "confirmed" }]), rpc.call("getBlockHeight", [{ commitment: "processed" }]),
]));
every(10000, "clock", () => rpc.call("getAccountInfo", ["SysvarC1ock11111111111111111111111111111111", { encoding: "base64", commitment: "processed" }]));
every(15000, "rescan", () => Promise.allSettled([
  rpc.call("getAccountInfo", [config, { encoding: "base64", commitment: "processed" }]),
  rpc.call("getProgramAccounts", [RUIN_PROGRAM_ADDRESS, { encoding: "base64", commitment: "processed", filters: tableFilters, withContext: true }]),
  rpc.call("getMultipleAccounts", [FEEDS, { encoding: "base64", commitment: "processed" }]),
]));
if (process.argv.includes("--compare-poll")) every(400, "compare", async () => {
  const v = await compare.call("getMultipleAccounts", [FEEDS, { encoding: "base64", commitment: "processed" }], "normal", "comparison");
  await Promise.all(v.value.map((raw: any, i: number) => value(i, FEEDS[i]!, raw, v.context.slot, "comparison")));
});
const chainPath = arg("--chain", "");
if (chainPath) every(60000, "height-comparison", async () => {
  const height = await compare.call("getBlockHeight", [{ commitment: "confirmed" }]);
  const chain = JSON.parse(readFileSync(resolve(chainPath), "utf8"));
  log({ event: "chain-comparison", height, estimated: chain.blockHeight, difference: height - chain.blockHeight, generated: chain.generated, hashAt: chain.hashAt, fee: chain.fee });
});
const describe = (samples: number[]) => { const s = [...samples].sort((a, b) => a - b); return { n: s.length, median: s[Math.floor(s.length / 2)] ?? null, max: s.at(-1) ?? null }; };
const report = () => log({ event: "observe-minute", uptimeMs: Date.now() - started, windows, notifications, wsLoss: overlay.wsLoss,
  intervals: Object.fromEntries(Object.entries(intervals).map(([key, samples]) => [key, describe(samples)])), rpc: rpc.metrics.snapshot(), comparison: compare.metrics.snapshot() });
timers.push(setInterval(report, 60000));
let switching: ReturnType<typeof setTimeout> | undefined;
if (switchAt) switching = setTimeout(() => { windows = !windows; log({ event: "observe-phase", windows }); }, switchAt);
let closed = false;
const close = () => { if (closed) return; closed = true; report(); timers.forEach(clearInterval); if (switching) clearTimeout(switching); overlay.close(); ws.close(); rpc.close(); compare.close(); log({ event: "observe-ended", durationMs: Date.now() - started }); setTimeout(() => process.exit(0), 1000); };
process.once("SIGINT", close); process.once("SIGTERM", close); setTimeout(close, duration);
log({ event: "observe-started", program: RUIN_PROGRAM_ADDRESS, windows, durationMs: duration, switchAfterMs: switchAt, signer: false });
