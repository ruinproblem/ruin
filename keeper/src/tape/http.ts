import { createServer } from "node:http";
import { writeFileSync, renameSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { json } from "../common/env.js";
export function atomicFile(dir: string, name: string, value: unknown) {
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, name),
    tmp = path + ".tmp";
  writeFileSync(tmp, json(value) + "\n");
  renameSync(tmp, path);
}
export function httpServer(dir: string, read: (path: string) => Promise<Buffer> = readFile) {
  let active = 0;
  const totals: Record<string, number> = {}, events: { at: number; path: string; unavailable: boolean }[] = [];
  const stats = () => {
    const now = Date.now();
    while (events[0] && events[0].at < now - 60000) events.shift();
    const minute: Record<string, number> = {};
    for (const e of events) minute[e.path] = (minute[e.path] ?? 0) + 1;
    return { active, total: { ...totals }, minute, unavailable1m: events.filter((e) => e.unavailable).length };
  };
  const server = createServer(async (req, res) => {
    const path = req.url ?? "";
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD" }); res.end(); return;
    }
    if (!["/tape.json", "/window.json", "/status.json", "/state.json", "/chain.json"].includes(path)) {
      res.writeHead(404); res.end(); return;
    }
    totals[path] = (totals[path] ?? 0) + 1;
    const event = { at: Date.now(), path, unavailable: false };
    events.push(event);
    if (active >= 64) {
      event.unavailable = true;
      res.writeHead(503, { "retry-after": "2" }); res.end(); return;
    }
    active++;
    let finished = false;
    const done = () => { if (!finished) { finished = true; active--; } };
    res.once("finish", done); res.once("close", done);
    let bytes: Buffer;
    try { bytes = await read(resolve(dir, path.slice(1))); }
    catch { event.unavailable = true; res.writeHead(503, { "retry-after": "2" }); res.end(); return; }
    const etag = '"' + createHash("sha1").update(bytes).digest("hex") + '"';
    const headers = {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": ["/state.json", "/chain.json"].includes(path) ? "public, max-age=1" : "public, max-age=2",
      etag,
    };
    if (req.headers["if-none-match"] === etag) { res.writeHead(304, headers); res.end(); return; }
    res.writeHead(200, headers);
    res.end(req.method === "HEAD" ? undefined : bytes);
  });
  return Object.assign(server, { stats });
}
