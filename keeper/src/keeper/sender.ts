import {
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  address,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import * as errors from "../../../program/client/src/generated/errors/ruin.js";
import { RpcPool, RpcFault, type Endpoint } from "../common/rpc.js";
import { Subscriptions } from "../common/ws.js";
import { log, type Logger } from "../common/log.js";
export type Kind =
  "fill" | "settle-line" | "settle-stop" | "settle-expiry" | "refund";
export type Prepared = {
  signature: string;
  wire: string;
  lastValidBlockHeight: bigint;
  blockhash: string;
  price: bigint;
  kind: Kind;
  target?: bigint;
  end?: bigint;
  limit: number;
  feeKey?: string;
};
export const errorName = (value: any) => {
  const err =
    value instanceof RpcFault ? (value.data?.err ?? value.data) : value;
  const custom =
    err?.InstructionError?.[1]?.Custom ??
    err?.err?.InstructionError?.[1]?.Custom;
  if (typeof custom === "number") {
    const entry = Object.entries(errors).find(
      ([k, v]) => k.startsWith("RUIN_ERROR__") && v === custom,
    );
    if (entry)
      return entry[0]
        .slice("RUIN_ERROR__".length)
        .split("_")
        .map((s) => s[0] + s.slice(1).toLowerCase())
        .join("");
    return `Custom${custom}`;
  }
  if (typeof err === "string") return err;
  return value instanceof RpcFault
    ? `RPC${value.code ?? "Transport"}`
    : "UnknownError";
};
export const benign = new Set([
  "AfterWindow",
  "NotRequested",
  "NotLive",
  "NothingToSettle",
]);
export async function prepareTransaction(
  ixs: readonly Instruction[],
  payer: TransactionSigner,
  latest: { blockhash: any; lastValidBlockHeight: bigint },
  kind: Kind,
  limit: number,
  price: bigint,
  target?: bigint,
  end?: bigint,
): Promise<Prepared> {
  const cu = address("ComputeBudget111111111111111111111111111111"),
    a = Buffer.alloc(5),
    b = Buffer.alloc(9);
  a[0] = 2;
  a.writeUInt32LE(limit, 1);
  b[0] = 3;
  b.writeBigUInt64LE(price, 1);
  const tx = await signTransactionMessageWithSigners(
    pipe(
      createTransactionMessage({ version: 0 }),
      (x) => setTransactionMessageFeePayerSigner(payer, x),
      (x) => setTransactionMessageLifetimeUsingBlockhash(latest, x),
      (x) =>
        appendTransactionMessageInstructions(
          [
            { programAddress: cu, accounts: [], data: a },
            { programAddress: cu, accounts: [], data: b },
            ...ixs,
          ],
          x,
        ),
    ),
  );
  return {
    signature: getSignatureFromTransaction(tx),
    wire: getBase64EncodedWireTransaction(tx),
    lastValidBlockHeight: latest.lastValidBlockHeight,
    blockhash: latest.blockhash,
    price,
    kind,
    target,
    end,
    limit,
  };
}
type Flight = {
  prepared: Prepared;
  started: number;
  accepted: boolean;
  ack: boolean;
  endpoint?: Endpoint["name"];
  unsubscribe?: () => void;
  timer?: ReturnType<typeof setInterval>;
};
export class Sender {
  readonly flights = new Map<string, Flight>();
  constructor(
    readonly rpc: RpcPool,
    readonly ws: Subscriptions,
    readonly slot: () => bigint,
    readonly height: () => bigint,
    readonly failed: (table: string, p: Prepared) => void,
    readonly logger: Logger = log,
  ) {}
  cancel(table: string, result = "state-change", chainSlot?: number) {
    const f = this.flights.get(table);
    if (!f) return;
    if (f.timer) clearInterval(f.timer);
    f.unsubscribe?.();
    this.flights.delete(table);
    this.logger({
      event: "action",
      table,
      kind: f.prepared.kind,
      signature: f.prepared.signature,
      result,
      chainSlot,
    });
  }
  async send(table: string, house: string, seq: bigint, p: Prepared) {
    if (this.flights.has(table)) return;
    const f: Flight = {
      prepared: p,
      started: Date.now(),
      accepted: false,
      ack: false,
    };
    this.flights.set(table, f);
    this.logger({
      event: "action",
      table,
      house,
      seq,
      kind: p.kind,
      targetSlot: p.target,
      firstSendSlot: this.slot(),
      signature: p.signature,
      result: "first-send",
      limit: p.limit,
      price: p.price,
    });
    try {
      const sent = await this.rpc.callAt<string>(
        "sendTransaction",
        [
          p.wire,
          {
            encoding: "base64",
            skipPreflight: false,
            preflightCommitment: "processed",
            maxRetries: 0,
          },
        ],
        p.end !== undefined ? "window" : "normal",
      );
      if (sent.value !== p.signature) throw new Error("RPC signature mismatch");
      if (this.flights.get(table) !== f) return;
      f.accepted = true;
      f.endpoint = sent.endpoint;
      f.unsubscribe = this.ws.subscribe(
        "signatureSubscribe",
        [p.signature, { commitment: "processed" }],
        (notification) => {
          if (this.flights.get(table) !== f) return;
          const err = notification.value?.err;
          if (err) {
            const name = errorName(err);
            this.cancel(table, "chain-error", notification.context?.slot);
            this.failed(table, p);
            this.logger({
              event: "action",
              table,
              kind: p.kind,
              signature: p.signature,
              result: benign.has(name) ? "obsolete" : "retry",
              error: name,
              chainSlot: notification.context?.slot,
            });
          } else {
            f.ack = true;
            if (f.timer) clearInterval(f.timer);
            this.logger({
              event: "action",
              table,
              kind: p.kind,
              signature: p.signature,
              result: "signature-success",
              chainSlot: notification.context?.slot,
            });
          }
        },
      );
      let rebroadcasting = false;
      f.timer = setInterval(() => {
        if (this.flights.get(table) !== f || f.ack) return;
        if (
          (p.end !== undefined && this.slot() > p.end) ||
          this.height() > p.lastValidBlockHeight
        ) {
          this.cancel(table, "expired-attempt");
          this.failed(table, p);
          return;
        }
        if (p.end === undefined && Date.now() - f.started >= 3000) {
          this.cancel(table, "notification-timeout");
          this.failed(table, p);
          return;
        }
        if (rebroadcasting) return;
        rebroadcasting = true;
        void this.rpc
          .callAt(
            "sendTransaction",
            [
              p.wire,
              { encoding: "base64", skipPreflight: true, maxRetries: 0 },
            ],
            p.end !== undefined ? "window" : "normal",
            f.endpoint,
          )
          .catch(() => {})
          .finally(() => {
            rebroadcasting = false;
          });
      }, 400);
      const audit = setTimeout(() => {
        void this.rpc
          .call("getSignatureStatuses", [
            [p.signature],
            { searchTransactionHistory: true },
          ])
          .then((v) =>
            this.logger({
              event: "signature-audit",
              table,
              signature: p.signature,
              status: v.value[0],
            }),
          )
          .catch(() =>
            this.logger({
              event: "signature-audit",
              table,
              signature: p.signature,
              status: "unavailable",
            }),
          );
      }, 20000);
      audit.unref();
    } catch (e) {
      if (this.flights.get(table) === f) this.cancel(table, "preflight-end");
      const name = errorName(e);
      this.failed(table, p);
      this.logger({
        event: "action",
        table,
        house,
        seq,
        kind: p.kind,
        signature: p.signature,
        result: benign.has(name) ? "obsolete" : "retry",
        error: name,
      });
    }
  }
  pendingSignatures() {
    return [...this.flights.values()].filter((f) => f.accepted && !f.ack).map((f) => f.prepared.signature);
  }
  onStatuses(signatures: string[], statuses: any[]) {
    statuses.forEach((status, i) => {
      if (!status) return;
      const entry = [...this.flights].find(([, f]) => f.prepared.signature === signatures[i]);
      if (!entry) return;
      const [table, f] = entry;
      if (status.err) {
        this.cancel(table, "poll-error", status.slot);
        this.failed(table, f.prepared);
      } else {
        f.ack = true;
        if (f.timer) clearInterval(f.timer);
      }
    });
  }
  async pollDisconnected() {
    const signatures = this.pendingSignatures();
    if (!signatures.length) return;
    try {
      const result = await this.rpc.call("getSignatureStatuses", [signatures]);
      this.onStatuses(signatures, result.value);
    } catch {}
  }
  close() {
    for (const table of this.flights.keys()) this.cancel(table, "shutdown");
  }
}
