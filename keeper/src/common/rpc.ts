import { GENESIS, PUBLIC, type Cluster } from "./env.js";
import { log, Metrics, type Logger } from "./log.js";
export const DETERMINISTIC = new Set([
  -32600, -32602, -32002, -32003, -32006, -32013, -32015,
]);
export type Mode = "normal" | "prepare" | "window";
export type Endpoint = {
  name: "public" | "fallback" | "fallback2" | "fallback3";
  url: string;
  ws: string;
  verified?: boolean;
  disabled?: boolean;
  hold?: number;
};
export class RpcFault extends Error {
  constructor(
    readonly method: string,
    readonly code?: number,
    readonly data?: any,
    readonly deterministic = false,
    readonly retryMs = 10000,
  ) {
    super(
      `RPC ${method}: ${code === undefined ? "transport unavailable" : `error ${code}`}`,
    );
  }
}
export function endpoints(c: Cluster): Endpoint[] {
  const out: Endpoint[] = [
    { name: "public", url: PUBLIC[c], ws: process.env.RUIN_WS_URL || PUBLIC[c].replace("https:", "wss:") },
  ];
  for (const [suffix, name] of [
    ["", "fallback"],
    ["_2", "fallback2"],
    ["_3", "fallback3"],
  ] as const) {
    const devnetUrl =
      c === "devnet"
        ? process.env[`DEVNET_RPC_URL_FALLBACK${suffix}`]
        : undefined;
    const url = devnetUrl || process.env[`RPC_URL_FALLBACK${suffix}`];
    if (url && !out.some((e) => e.url === url))
      out.push({
        name,
        url,
        ws:
          (devnetUrl
            ? process.env[`DEVNET_RPC_WS_URL_FALLBACK${suffix}`]
            : process.env[`RPC_WS_URL_FALLBACK${suffix}`]) ||
          url.replace(/^http/, "ws"),
      });
  }
  return out;
}
export class RpcPool {
  readonly metrics = new Metrics();
  private starts = new Map<string, number>();
  constructor(
    readonly cluster: Cluster,
    readonly list = endpoints(cluster),
    private transport: typeof fetch = fetch,
    readonly logger: Logger = log,
  ) {}
  private verificationTimer?: ReturnType<typeof setInterval>;
  private verifying = new Map<string, Promise<void>>();
  private verify(e: Endpoint) {
    const existing = this.verifying.get(e.name);
    if (existing) return existing;
    const work = (async () => {
      try {
        const hash = await this.request<string>(
          e,
          "getGenesisHash",
          [],
          "normal",
        );
        e.verified = hash === GENESIS[this.cluster];
        e.disabled = !e.verified;
        e.hold = 0;
        this.logger({
          event: "rpc-genesis",
          endpoint: e.name,
          cluster: this.cluster,
          result: e.verified ? "verified" : "disabled-mismatch",
        });
      } catch {
        e.verified = false;
        e.hold = Date.now() + 10000;
        this.metrics.add(e.name, "getGenesisHash", "errors");
        this.logger({
          event: "rpc-genesis",
          endpoint: e.name,
          result: "unavailable",
        });
      }
    })().finally(() => this.verifying.delete(e.name));
    this.verifying.set(e.name, work);
    return work;
  }
  async initialize() {
    await Promise.all(
      this.list.filter((e) => !e.disabled).map((e) => this.verify(e)),
    );
    if (!this.list.some((e) => e.verified && !e.disabled))
      throw new Error("No verified RPC on configured cluster");
    this.verificationTimer ??= setInterval(() => {
      void this.recheck();
    }, 10000);
    this.verificationTimer.unref();
  }
  async recheck() {
    await Promise.all(
      this.list
        .filter(
          (e) => !e.verified && !e.disabled && (e.hold ?? 0) <= Date.now(),
        )
        .map((e) => this.verify(e)),
    );
  }
  close() {
    if (this.verificationTimer) clearInterval(this.verificationTimer);
  }
  private async request<T>(
    e: Endpoint,
    method: string,
    params: unknown[],
    mode: Mode,
    lane?: string,
  ): Promise<T> {
    const ms =
      mode === "window"
        ? 250
        : mode === "prepare"
          ? 500
          : ["sendTransaction", "simulateTransaction"].includes(method)
            ? e.name === "public"
              ? 1000
              : 3000
            : e.name === "public"
              ? 3000
              : 8000;
    this.metrics.add(e.name, method);
    this.logger({ event: "rpc-call", endpoint: e.name, method, mode });
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        abort.abort();
        reject(new RpcFault(method));
      }, ms);
    });
    const work = async () => {
      const now = Date.now(),
        paceKey =
          e.name +
          ":" +
          (lane ? `lane:${lane}` : mode === "prepare"
            ? "prepare"
            : method === "sendTransaction"
              ? "send"
              : "query"),
        spacing =
          mode === "prepare" ? 125 : method === "sendTransaction" ? 100 : 250,
        at =
          (mode === "window" || lane)
            ? now
            : Math.max(now, this.starts.get(paceKey) ?? now);
      this.starts.set(
        paceKey,
        Math.max(at + spacing, this.starts.get(paceKey) ?? 0),
      );
      if (at > now) await new Promise((r) => setTimeout(r, at - now));
      if (abort.signal.aborted) throw new RpcFault(method);
      let response: Response;
      try {
        response = await this.transport(e.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: abort.signal,
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        });
      } catch {
        throw new RpcFault(method);
      }
      const h = response.headers.get("retry-after"),
        seconds = h === null ? 10 : Number(h),
        retry = Number.isFinite(seconds)
          ? Math.max(0, Math.min(10000, seconds * 1000))
          : 10000;
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new RpcFault(
          method,
          undefined,
          { httpStatus: response.status },
          false,
          retry,
        );
      }
      let b: any;
      try {
        b = await response.json();
      } catch {
        throw new RpcFault(method, undefined, undefined, false, retry);
      }
      if (b?.error)
        throw new RpcFault(
          method,
          b.error.code,
          b.error.data,
          DETERMINISTIC.has(b.error.code),
          retry,
        );
      if (!b || !Object.hasOwn(b, "result")) throw new RpcFault(method);
      return b.result as T;
    };
    try {
      return await Promise.race([work(), timeout]);
    } finally {
      clearTimeout(timer!);
      abort.abort();
    }
  }
  async callAt<T = any>(
    method: string,
    params: unknown[] = [],
    mode: Mode = "normal",
    preferred?: Endpoint["name"],
    lane?: string,
  ): Promise<{ value: T; endpoint: Endpoint["name"] }> {
    const available = this.list.filter((e) => e.verified && !e.disabled),
      ordered = preferred
        ? [
            ...available.filter((e) => e.name === preferred),
            ...available.filter((e) => e.name !== preferred),
          ]
        : available;
    let last = new RpcFault(method);
    for (const e of ordered) {
      if ((e.hold ?? 0) > Date.now()) continue;
      try {
        return {
          value: await this.request<T>(e, method, params, mode, lane),
          endpoint: e.name,
        };
      } catch (error) {
        const fault = error instanceof RpcFault ? error : new RpcFault(method);
        this.metrics.add(e.name, method, "errors");
        this.logger({
          event: "rpc-error",
          endpoint: e.name,
          method,
          code: fault.code,
          httpStatus: fault.data?.httpStatus,
          deterministic: fault.deterministic,
        });
        if (fault.deterministic) throw fault;
        e.hold = Date.now() + Math.min(10000, fault.retryMs);
        this.metrics.add(e.name, method, "failovers");
        last = fault;
      }
    }
    throw last;
  }
  async call<T = any>(
    method: string,
    params: unknown[] = [],
    mode: Mode = "normal",
    lane?: string,
  ): Promise<T> {
    return (await this.callAt<T>(method, params, mode, undefined, lane)).value;
  }
}
