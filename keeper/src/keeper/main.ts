import { resolve } from "node:path";
import { cluster, ROOT, sleep } from "../common/env.js";
import { RpcPool } from "../common/rpc.js";
import { Subscriptions } from "../common/ws.js";
import { signerFile } from "./chain.js";
import { Keeper } from "./engine.js";
import { log, safeError } from "../common/log.js";
const c = cluster();
if (c === "mainnet" && process.env.KEEPER_ALLOW_MAINNET !== "1")
  throw new Error("Mainnet keeper requires KEEPER_ALLOW_MAINNET=1");
const rpc = new RpcPool(c);
await rpc.initialize();
if (!process.env.KEEPER_KEYPAIR) throw new Error("KEEPER_KEYPAIR is required");
const signer = await signerFile(resolve(ROOT, process.env.KEEPER_KEYPAIR));
const keeper = new Keeper(rpc, new Subscriptions(rpc), signer);
for (;;) {
  try {
    await keeper.initialize();
    keeper.start();
    break;
  } catch (e) {
    log({ event: "keeper-start-retry", error: safeError(e) });
    await sleep(10000);
  }
}
let stopping = false;
const close = () => {
  if (stopping) return;
  stopping = true;
  keeper.close();
  setTimeout(() => process.exit(0), 500);
};
process.once("SIGINT", close);
process.once("SIGTERM", close);
