import { EventEmitter } from "node:events";
import { RpcPool, type Endpoint } from "./rpc.js";
import { log, type Logger } from "./log.js";
type Spec = {
  method: string;
  params: unknown[];
  callback: (value: any) => void;
};
type Connection = {
  endpoint: Endpoint;
  socket: WebSocket;
  servers: Map<number, number>;
  installing: Map<number, Promise<void>>;
  waiting: Map<number, {
    resolve: (v: any) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>;
  ended: Promise<void>;
  finish: () => void;
  closed: boolean;
  lastNotification: number;
  lastSlot: number;
};
export class Subscriptions extends EventEmitter {
  private specs = new Map<number, Spec>();
  private serial = 1;
  private active?: Connection;
  private connections = new Set<Connection>();
  private stopped = false;
  private started = false;
  private wake?: () => void;
  ready = false;
  endpoint?: Endpoint["name"];
  lastNotification = 0;
  lastSlot = 0;
  constructor(
    readonly rpc: RpcPool,
    private slotTimeoutMs = 10000,
    private logger: Logger = log,
  ) { super(); }
  subscribe(method: string, params: unknown[], callback: (v: any) => void) {
    const id = this.serial++;
    this.specs.set(id, { method, params, callback });
    if (this.ready && this.active) {
      const c = this.active;
      void this.install(c, id).catch(() => c.finish());
    }
    return () => {
      this.specs.delete(id);
      for (const c of this.connections) {
        const server = c.servers.get(id);
        c.servers.delete(id);
        if (server !== undefined && !c.closed)
          void this.request(c, method.replace("Subscribe", "Unsubscribe"), [server]).catch(() => {});
      }
    };
  }
  private request(c: Connection, method: string, params: unknown[]): Promise<any> {
    if (c.closed) return Promise.reject(new Error("WebSocket disconnected"));
    const id = this.serial++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        c.waiting.delete(id);
        reject(new Error("Subscription timeout"));
      }, 3000);
      c.waiting.set(id, { resolve, reject, timer });
      this.rpc.metrics.add(c.endpoint.name, method);
      this.logger({ event: "ws-call", endpoint: c.endpoint.name, method });
      try { c.socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params })); }
      catch { c.finish(); }
    });
  }
  private install(c: Connection, id: number): Promise<void> {
    if (c.servers.has(id)) return Promise.resolve();
    const pending = c.installing.get(id);
    if (pending) return pending;
    const spec = this.specs.get(id);
    if (!spec) return Promise.resolve();
    const task = this.request(c, spec.method, spec.params).then((server) => {
      if (this.specs.has(id)) c.servers.set(id, server);
      else void this.request(c, spec.method.replace("Subscribe", "Unsubscribe"), [server]).catch(() => {});
    }).finally(() => c.installing.delete(id));
    c.installing.set(id, task);
    return task;
  }
  start() {
    if (this.started) return;
    this.started = true;
    void this.loop();
  }
  private failed(e: Endpoint) {
    this.rpc.metrics.add(e.name, "websocket", "errors");
    this.rpc.metrics.add(e.name, "websocket", "failovers");
  }
  private async loop() {
    let delay = 1000;
    while (!this.stopped) {
      let hadReady = false;
      for (const e of this.rpc.list) {
        if (this.stopped) break;
        if (!e.verified || e.disabled) continue;
        let c: Connection;
        try { c = await this.connection(e); }
        catch { if (!this.stopped) this.failed(e); continue; }
        if (this.stopped) { c.finish(); break; }
        hadReady = true;
        this.activate(c);
        await this.maintain(c);
        break;
      }
      if (hadReady) delay = 1000;
      if (!this.stopped) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => { this.wake = undefined; resolve(); }, delay);
          this.wake = () => { clearTimeout(timer); this.wake = undefined; resolve(); };
        });
      }
      if (!hadReady) delay = Math.min(30000, delay * 2);
    }
  }
  private activate(c: Connection) {
    this.active = c;
    this.endpoint = c.endpoint.name;
    this.lastNotification = c.lastNotification;
    this.lastSlot = c.lastSlot;
    this.ready = true;
    this.logger({ event: "subscription-ready", endpoint: c.endpoint.name, count: this.specs.size });
    this.emit("ready");
  }
  private async maintain(initial: Connection) {
    let c = initial;
    let nextProbe = Date.now() + 10000;
    while (!this.stopped && !c.closed) {
      if (c.endpoint.name === "public") { await c.ended; break; }
      let timer: ReturnType<typeof setTimeout>;
      const action = await Promise.race([
        c.ended.then(() => "ended"),
        new Promise<string>((resolve) => { timer = setTimeout(() => resolve("probe"), Math.max(0, nextProbe - Date.now())); }),
      ]);
      clearTimeout(timer!);
      if (action === "ended" || this.stopped) break;
      nextProbe = Date.now() + 10000;
      const primary = this.rpc.list.find((e) => e.name === "public" && e.verified && !e.disabled);
      if (!primary) continue;
      const abort = new AbortController();
      const opened = this.connection(primary, abort.signal).catch(() => undefined);
      const candidate = await Promise.race([opened, c.ended.then(() => undefined)]);
      if (!candidate || c.closed || this.stopped) {
        abort.abort();
        const unused = await opened;
        unused?.finish();
        if (!c.closed && !this.stopped) this.failed(primary);
        continue;
      }
      // Dispatch only from the active socket; install all subscriptions before switching.
      this.activate(candidate);
      c.finish();
      c = candidate;
    }
  }
  private async connection(e: Endpoint, signal?: AbortSignal): Promise<Connection> {
    const socket = new WebSocket(e.ws);
    let end!: () => void;
    const ended = new Promise<void>((resolve) => { end = resolve; });
    const c: Connection = {
      endpoint: e, socket, servers: new Map(), installing: new Map(), waiting: new Map(),
      ended, closed: false, finish: () => {}, lastNotification: Date.now(), lastSlot: Date.now(),
    };
    let watchdog: ReturnType<typeof setInterval> | undefined;
    c.finish = () => {
      if (c.closed) return;
      c.closed = true;
      if (watchdog) clearInterval(watchdog);
      signal?.removeEventListener("abort", c.finish);
      for (const p of c.waiting.values()) { clearTimeout(p.timer); p.reject(new Error("WebSocket disconnected")); }
      c.waiting.clear();
      this.connections.delete(c);
      if (this.active === c) {
        this.active = undefined;
        this.ready = false;
        this.logger({ event: "subscription-disconnect", endpoint: e.name });
        this.emit("disconnect");
      }
      end();
      socket.close();
    };
    this.connections.add(c);
    socket.addEventListener("close", c.finish, { once: true });
    socket.addEventListener("error", c.finish, { once: true });
    signal?.addEventListener("abort", c.finish, { once: true });
    socket.addEventListener("message", (event) => {
      let b: any;
      try { b = JSON.parse(String(event.data)); } catch { return; }
      if (b.id !== undefined) {
        const p = c.waiting.get(b.id);
        if (p) {
          clearTimeout(p.timer); c.waiting.delete(b.id);
          if (b.error) p.reject(new Error("Subscription rejected")); else p.resolve(b.result);
        }
        return;
      }
      c.lastNotification = Date.now();
      if (b.method === "slotNotification") c.lastSlot = Date.now();
      if (this.active !== c) return;
      this.lastNotification = c.lastNotification; this.lastSlot = c.lastSlot;
      for (const [id, spec] of this.specs) if (c.servers.get(id) === b.params?.subscription) {
        try { spec.callback(b.params.result); }
        catch { this.logger({ event: "subscription-invalid", method: spec.method, endpoint: e.name }); }
      }
    });
    try {
      let timer: ReturnType<typeof setTimeout>;
      try {
        await Promise.race([
          new Promise<void>((resolve) => socket.addEventListener("open", () => resolve(), { once: true })),
          c.ended.then(() => { throw new Error("WebSocket unavailable"); }),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("WebSocket timeout")), 3000); }),
        ]);
      } finally { clearTimeout(timer!); }
      do {
        await Promise.all([...this.specs.keys()].map((id) => this.install(c, id)));
      } while ([...this.specs.keys()].some((id) => !c.servers.has(id)) && !c.closed);
      if (c.closed || this.stopped || signal?.aborted) throw new Error("WebSocket disconnected");
      watchdog = setInterval(() => {
        if (Date.now() - c.lastNotification > 10000 || Date.now() - c.lastSlot > this.slotTimeoutMs) c.finish();
      }, 200);
      return c;
    } catch (error) { c.finish(); throw error; }
  }
  close() {
    this.stopped = true;
    this.wake?.();
    for (const c of this.connections) c.finish();
  }
}
