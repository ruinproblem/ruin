import { json } from "./env.js";
export type Logger = (event: Record<string, unknown>) => void;
export const log: Logger = (event) =>
  console.log(json({ at: new Date().toISOString(), ...event }));
export const safeError = (e: unknown) =>
  (e instanceof Error ? e.message : "Operation failed").replace(
    /(?:https?|wss?):\/\/[^\s"'\\]+/g,
    "[endpoint]",
  );
export class Metrics {
  private totals: Record<string, Record<string, number>> = {};
  private methodTotals: Record<string, number> = {};
  private events: {
    at: number;
    endpoint: string;
    method: string;
    kind: string;
  }[] = [];
  add(endpoint: string, method: string, kind = "calls") {
    this.events.push({ at: Date.now(), endpoint, method, kind });
    const p = (this.totals[endpoint] ??= { calls: 0, errors: 0, failovers: 0 });
    p[kind] = (p[kind] ?? 0) + 1;
    if (kind === "calls")
      this.methodTotals[method] = (this.methodTotals[method] ?? 0) + 1;
  }
  snapshot() {
    this.events = this.events.filter((x) => x.at >= Date.now() - 3600000);
    const methods: Record<string, number> = {},
      endpoints: Record<string, Record<string, number>> = {};
    for (const x of this.events) {
      const p = (endpoints[x.endpoint] ??= {
        calls: 0,
        errors: 0,
        failovers: 0,
      });
      p[x.kind] = (p[x.kind] ?? 0) + 1;
      if (x.kind === "calls") methods[x.method] = (methods[x.method] ?? 0) + 1;
    }
    return {
      methods,
      endpoints,
      total: {
        methods: { ...this.methodTotals },
        endpoints: structuredClone(this.totals),
      },
    };
  }
}
