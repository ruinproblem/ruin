import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { cluster, dataDir } from "../common/env.js";
import { log, safeError } from "../common/log.js";
import { RpcPool } from "../common/rpc.js";
import { Store } from "../common/sqlite.js";
import { DovesRecorder } from "./doves.js";
import { YoloReader } from "./yolo.js";
import { ReceiptReader } from "./receipts.js";
import { Publisher } from "./publish.js";
import { httpServer } from "./http.js";
import { ChainReader } from "./chain.js";
import { StateReader } from "./state.js";
const store = new Store(resolve(dataDir(), "tape.sqlite"));
const source = new RpcPool("mainnet"),
  ruin = new RpcPool(cluster());
await Promise.all([source.initialize(), ruin.initialize()]);
const server = httpServer(resolve(dataDir(), "public"));
await new Promise<void>((yes, no) => {
  server.once("error", () => no(new Error("Tape HTTP listener unavailable")));
  server.listen(
    Number(process.env.TAPE_PORT || 8788),
    process.env.TAPE_HOST || "127.0.0.1",
    yes,
  );
});
let state: StateReader | undefined;
try {
  state = new StateReader(ruin, resolve(dataDir(), "public"));
} catch (e) {
  log({ event: "state-error", error: safeError(e) });
}
const recorder = new DovesRecorder(store, source),
  yolo = new YoloReader(store),
  receipts = new ReceiptReader(store, ruin),
  publisher = new Publisher(
    store,
    resolve(dataDir(), "public"),
    yolo,
    source,
    ruin,
    state ? () => state.status() : undefined,
    () => server.stats(),
  );
const chain = new ChainReader(ruin, resolve(dataDir(), "public"), receipts, () =>
  state ? [...state.houses].filter(([, h]) => h.value.accepting).map(([key]) => key) : []);
chain.start();
const runId = randomUUID(),
  started = Date.now();
store.db.prepare("INSERT INTO runs VALUES(?,?,NULL)").run(runId, started);
recorder.start();
void yolo.run();
void receipts.run();
publisher.publish();
publisher.status();
void state?.start();
const timers = [
  setInterval(() => {
    try {
      publisher.calculate();
      publisher.publish();
    } catch (e) {
      log({ event: "publish-error", error: safeError(e) });
    }
  }, 2000),
  setInterval(() => publisher.status(), 5000),
  setInterval(() => {
    publisher.prune();
    const usage = process.resourceUsage();
    log({
      event: "tape-minute",
      runId,
      uptimeMs: Date.now() - started,
      rss: process.memoryUsage().rss,
      userCpuMicros: usage.userCPUTime,
      systemCpuMicros: usage.systemCPUTime,
      source: source.metrics.snapshot(),
      ruin: ruin.metrics.snapshot(),
      status: publisher.status(),
    });
  }, 60000),
];
let closing = false;
function close() {
  if (closing) return;
  closing = true;
  recorder.close();
  yolo.stopped = true;
  receipts.stopped = true;
  state?.close();
  chain.close();
  source.close();
  ruin.close();
  timers.forEach(clearInterval);
  store.db
    .prepare("UPDATE runs SET ended_ms=? WHERE id=?")
    .run(Date.now(), runId);
  publisher.status();
  server.close();
  log({
    event: "tape-stopped",
    runId,
    uptimeMs: Date.now() - started,
    source: source.metrics.snapshot(),
    ruin: ruin.metrics.snapshot(),
    cpu: process.resourceUsage(),
    rss: process.memoryUsage().rss,
  });
  setTimeout(() => process.exit(0), 1000);
}
process.once("SIGINT", close);
process.once("SIGTERM", close);
log({ event: "tape-started", runId, pid: process.pid, cluster: cluster() });
