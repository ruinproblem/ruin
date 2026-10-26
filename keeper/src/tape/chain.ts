import { RUIN_PROGRAM_ADDRESS } from "../../../program/client/index.js";
import type { RpcPool } from "../common/rpc.js";
import type { ReceiptReader } from "./receipts.js";
import { atomicFile } from "./http.js";
import { log } from "../common/log.js";

export function fee75(samples: { prioritizationFee: number }[]) {
  const values = samples.map((x) => x.prioritizationFee).filter((x) => x > 0).sort((a, b) => a - b);
  return values.length ? values[Math.ceil(values.length * .75) - 1]! : 0;
}
export class ChainReader {
  hash?: { blockhash: string; lastValidBlockHeight: number };
  hashAt = 0;
  fee = 0;
  feeAt = 0;
  slot = 0;
  private busy = new Set<string>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private stopped = false;
  constructor(readonly rpc: Pick<RpcPool, "call" | "cluster">, readonly dir: string,
    readonly receipts: Pick<ReceiptReader, "listedAt" | "recentRows">,
    readonly houses: () => string[], readonly now = () => Date.now(),
    readonly write = (value: unknown) => atomicFile(dir, "chain.json", value)) {}
  private async job(name: string, work: () => Promise<void>) {
    if (this.stopped || this.busy.has(name)) return;
    this.busy.add(name);
    try { await work(); }
    catch { log({ event: "chain-read-error", method: name }); }
    finally { this.busy.delete(name); }
  }
  readHash() {
    return this.job("getLatestBlockhash", async () => {
      const v = await this.rpc.call("getLatestBlockhash", [{ commitment: "confirmed" }]);
      if (this.stopped) return;
      this.hash = v.value;
      this.slot = Number(v.context.slot);
      this.hashAt = this.now();
    });
  }
  readFee() {
    return this.job("getRecentPrioritizationFees", async () => {
      const samples = await this.rpc.call("getRecentPrioritizationFees", [this.houses().slice(0, 128)]);
      if (this.stopped) return;
      this.fee = fee75(samples);
      this.feeAt = this.now();
    });
  }
  tick() {
    if (this.stopped || !this.hash || this.now() - this.hashAt > 15000) return false;
    log({ event: "chain-published", generated: this.now(), hashAt: this.hashAt, feeAt: this.feeAt, fee: this.fee, blockHeight: this.hash.lastValidBlockHeight - 150, listedAt: this.receipts.listedAt });
    this.write({ v: 1, generated: this.now(), cluster: this.rpc.cluster, program: RUIN_PROGRAM_ADDRESS,
      ...this.hash, hashAt: this.hashAt, blockHeight: this.hash.lastValidBlockHeight - 150,
      fee: this.fee, feeAt: this.feeAt, recent: this.receipts.recentRows(this.slot), listedAt: this.receipts.listedAt });
    return true;
  }
  start() {
    void this.readHash();
    void this.readFee();
    this.timers.push(setInterval(() => void this.readHash(), 5000), setInterval(() => void this.readFee(), 15000), setInterval(() => this.tick(), 1000));
  }
  close() { this.stopped = true; this.timers.forEach(clearInterval); }
}
