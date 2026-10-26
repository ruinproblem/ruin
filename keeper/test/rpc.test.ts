import { it, expect, vi } from "vitest";
import { createServer } from "node:http";
import { RpcPool, type Endpoint, endpoints } from "../src/common/rpc.js";
import { GENESIS, PUBLIC } from "../src/common/env.js";
it("devnet fallback selection preserves public first and isolates the mainnet WebSocket", () => {
  vi.stubEnv("RUIN_WS_URL", "");
  vi.stubEnv("DEVNET_RPC_URL_FALLBACK", "https://devnet.invalid/test");
  vi.stubEnv("DEVNET_RPC_WS_URL_FALLBACK", "");
  vi.stubEnv("RPC_URL_FALLBACK", "https://mainnet.invalid/test");
  vi.stubEnv("RPC_WS_URL_FALLBACK", "wss://mainnet.invalid/test");
  for (const name of [
    "DEVNET_RPC_URL_FALLBACK_2",
    "DEVNET_RPC_WS_URL_FALLBACK_2",
    "RPC_URL_FALLBACK_2",
    "RPC_WS_URL_FALLBACK_2",
    "DEVNET_RPC_URL_FALLBACK_3",
    "DEVNET_RPC_WS_URL_FALLBACK_3",
    "RPC_URL_FALLBACK_3",
    "RPC_WS_URL_FALLBACK_3",
  ])
    vi.stubEnv(name, "");
  vi.stubEnv("DEVNET_RPC_URL_FALLBACK_2", "https://devnet2.invalid/test");
  try {
    expect(endpoints("devnet")).toEqual([
      {
        name: "public",
        url: PUBLIC.devnet,
        ws: PUBLIC.devnet.replace("https:", "wss:"),
      },
      {
        name: "fallback",
        url: "https://devnet.invalid/test",
        ws: "wss://devnet.invalid/test",
      },
      {
        name: "fallback2",
        url: "https://devnet2.invalid/test",
        ws: "wss://devnet2.invalid/test",
      },
    ]);
    expect(endpoints("mainnet")[1]).toMatchObject({
      url: "https://mainnet.invalid/test",
      ws: "wss://mainnet.invalid/test",
    });
    vi.stubEnv("RPC_URL_FALLBACK_3", "https://mainnet3.invalid/test");
    vi.stubEnv("RPC_WS_URL_FALLBACK_3", "wss://mainnet3.invalid/custom");
    expect(endpoints("devnet")[3]).toEqual({
      name: "fallback3",
      url: "https://mainnet3.invalid/test",
      ws: "wss://mainnet3.invalid/custom",
    });
    vi.stubEnv("DEVNET_RPC_URL_FALLBACK_3", "https://devnet3.invalid/test");
    expect(endpoints("devnet")).toHaveLength(4);
    expect(endpoints("devnet")[3]).toEqual({
      name: "fallback3",
      url: "https://devnet3.invalid/test",
      ws: "wss://devnet3.invalid/test",
    });
    vi.stubEnv("DEVNET_RPC_WS_URL_FALLBACK_3", "wss://devnet3.invalid/custom");
    expect(endpoints("devnet")[3].ws).toBe("wss://devnet3.invalid/custom");
    expect(endpoints("mainnet").at(-1)).toEqual({
      name: "fallback3",
      url: "https://mainnet3.invalid/test",
      ws: "wss://mainnet3.invalid/custom",
    });
  } finally {
    vi.unstubAllEnvs();
  }
});
async function fake(fn: (method: string, params: any[]) => any, delay = 0) {
  const calls: any[] = [];
  const server = createServer(async (req, res) => {
    let data = "";
    for await (const x of req) data += x;
    const b = JSON.parse(data);
    calls.push({ method: b.method, params: b.params, at: Date.now() });
    const v = fn(b.method, b.params);
    if (v === "hang") return;
    if (delay && b.method !== "getGenesisHash")
      await new Promise((r) => setTimeout(r, delay));
    if (v === 429) {
      res.writeHead(429, { "retry-after": "0" });
      res.end();
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: b.id,
          ...(v?.error ? { error: v.error } : { result: v }),
        }),
      );
    }
  });
  await new Promise<void>((r, no) => {
    server.once("error", no);
    server.listen(0, "127.0.0.1", r);
  });
  const port = (server.address() as any).port;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}
it("S4 actual HTTP: 429 and timeout fail over identical wire; deterministic errors do not; genesis mismatch is disabled", async () => {
  let mode = "429";
  const logs: any[] = [];
  const primary = await fake((method) =>
    method === "getGenesisHash"
      ? GENESIS.devnet
      : mode === "429"
        ? 429
        : mode === "timeout"
          ? "hang"
          : { error: { code: -32002, data: { err: "BeforeWindow" } } },
  );
  const fallback = await fake(
    (method) => (method === "getGenesisHash" ? GENESIS.devnet : "signature"),
    200,
  );
  const wrong = await fake(() => GENESIS.mainnet);
  const list: Endpoint[] = [
    { name: "public", url: primary.url, ws: "" },
    { name: "fallback", url: fallback.url, ws: "" },
    { name: "fallback2", url: wrong.url, ws: "" },
  ];
  try {
    const rpc = new RpcPool("devnet", list, fetch, (x) => logs.push(x));
    await rpc.initialize();
    expect(list[2].disabled).toBe(true);
    const wire = "same-signed-bytes";
    await rpc.call("sendTransaction", [wire], "window");
    expect(primary.calls.at(-1).params).toEqual(fallback.calls.at(-1).params);
    mode = "timeout";
    list[0].hold = 0;
    const at = Date.now();
    await rpc.call("sendTransaction", [wire], "window");
    expect(fallback.calls.at(-1).at - at).toBeLessThanOrEqual(450);
    mode = "deterministic";
    list[0].hold = 0;
    const previous = fallback.calls.length;
    await expect(
      rpc.call("sendTransaction", [wire], "window"),
    ).rejects.toMatchObject({ code: -32002 });
    expect(fallback.calls.length).toBe(previous);
    expect(JSON.stringify(logs)).not.toContain("127.0.0.1");
    expect(wrong.calls).toHaveLength(1);
  } finally {
    primary.close();
    fallback.close();
    wrong.close();
  }
}, 10000);
it("S4 an unavailable primary genesis is retried off the transaction path after cooldown", async () => {
  let available = false;
  const first = await fake((method) =>
    method === "getGenesisHash"
      ? available
        ? GENESIS.devnet
        : 429
      : "primary",
  );
  const second = await fake((method) =>
    method === "getGenesisHash" ? GENESIS.devnet : "fallback",
  );
  const list: Endpoint[] = [
    { name: "public", url: first.url, ws: "" },
    { name: "fallback", url: second.url, ws: "" },
  ];
  const rpc = new RpcPool("devnet", list, fetch, () => {});
  try {
    await rpc.initialize();
    expect(await rpc.call("getSlot")).toBe("fallback");
    available = true;
    list[0].hold = 0;
    await rpc.recheck();
    expect(await rpc.call("getSlot")).toBe("primary");
    expect(list[0].verified).toBe(true);
  } finally {
    rpc.close();
    first.close();
    second.close();
  }
});
it("S4 two fallbacks receive the identical signed bytes in order and a deterministic first-fallback error stops the chain", async () => {
  const order: string[] = [];
  let deterministic = false;
  const servers = await Promise.all(
    ["public", "fallback", "fallback2"].map((name) =>
      fake((method) => {
        if (method === "getGenesisHash") return GENESIS.devnet;
        order.push(name);
        if (name === "public") return 429;
        if (name === "fallback")
          return deterministic ? { error: { code: -32002 } } : 429;
        return "signature";
      }),
    ),
  );
  const rpc = new RpcPool(
    "devnet",
    servers.map((s, i) => ({
      name: (["public", "fallback", "fallback2"] as const)[i],
      url: s.url,
      ws: "",
    })),
    fetch,
    () => {},
  );
  try {
    await rpc.initialize();
    await rpc.call("sendTransaction", ["same-signed-bytes"], "window");
    expect(order).toEqual(["public", "fallback", "fallback2"]);
    expect(servers.map((s) => s.calls.at(-1).params)).toEqual(
      Array(3).fill(["same-signed-bytes"]),
    );
    deterministic = true;
    order.length = 0;
    await expect(
      rpc.call("sendTransaction", ["same-signed-bytes"], "window"),
    ).rejects.toMatchObject({ code: -32002 });
    expect(order).toEqual(["public", "fallback"]);
  } finally {
    rpc.close();
    servers.forEach((s) => s.close());
  }
});
it("S4 three fallbacks receive identical signed bytes in order and a deterministic second-fallback error stops before fallback3", async () => {
  const names = ["public", "fallback", "fallback2", "fallback3"] as const;
  const order: string[] = [];
  let deterministic = false;
  const servers = await Promise.all(names.map(name => fake(method => {
    if (method === "getGenesisHash") return GENESIS.devnet;
    order.push(name);
    if (name === "fallback2" && deterministic) return { error: { code: -32002 } };
    return name === "fallback3" ? "fourth-signature" : 429;
  })));
  const rpc = new RpcPool("devnet", servers.map((s, i) => ({
    name: names[i], url: s.url, ws: "",
  })), fetch, () => {});
  try {
    await rpc.initialize();
    expect(await rpc.call("sendTransaction", ["same-signed-bytes"], "window")).toBe("fourth-signature");
    expect(order).toEqual(names);
    expect(servers.map(s => s.calls.at(-1).params)).toEqual(Array(4).fill(["same-signed-bytes"]));
    order.length = 0;
    deterministic = true;
    const fourthCalls = servers[3].calls.length;
    await expect(rpc.call("sendTransaction", ["same-signed-bytes"], "window")).rejects.toMatchObject({ code: -32002 });
    expect(order).toEqual(["public", "fallback", "fallback2"]);
    expect(servers[3].calls).toHaveLength(fourthCalls);
  } finally {
    rpc.close();
    servers.forEach(s => s.close());
  }
});
