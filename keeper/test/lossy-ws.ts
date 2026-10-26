import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const { WebSocketServer } = createRequire(import.meta.url)('ws');
export function lossyRelay(port = 8790) {
  const server = new WebSocketServer({ port, host: '127.0.0.1' });
  const counts = { connections: 0, acknowledgements: 0, program: 0, account: 0, signature: 0, slots: 0, slotsForwarded: 0 };
  const upstreams = new Set<WebSocket>();
  server.on('connection', (down: any) => {
    counts.connections++;
    const up = new WebSocket('wss://api.devnet.solana.com'); upstreams.add(up);
    const queued: string[] = []; let slots = 0;
    down.on('message', (bytes: Buffer) => { if (up.readyState === WebSocket.OPEN) up.send(bytes.toString()); else if (up.readyState === WebSocket.CONNECTING) queued.push(bytes.toString()); });
    up.addEventListener('open', () => queued.splice(0).forEach(message => up.send(message)));
    up.addEventListener('message', event => {
      let value: any; try { value = JSON.parse(String(event.data)); } catch { return; }
      if (value.id !== undefined) { counts.acknowledgements++; if (down.readyState === 1) down.send(String(event.data)); return; }
      if (value.method === 'programNotification') { counts.program++; return; }
      if (value.method === 'accountNotification') { counts.account++; return; }
      if (value.method === 'signatureNotification') { counts.signature++; return; }
      if (value.method === 'slotNotification') { counts.slots++; if (++slots % 5) return; counts.slotsForwarded++; }
      if (down.readyState === 1) down.send(String(event.data));
    });
    const close = () => { upstreams.delete(up); try { up.close(); } catch {} if (down.readyState === 1) down.close(); };
    down.on('close', close); down.on('error', close); up.addEventListener('close', close); up.addEventListener('error', close);
  });
  return { server, counts, close() { for (const up of upstreams) up.close(); for (const down of server.clients) down.terminate(); server.close(); } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const index = process.argv.indexOf('--port'), port = index >= 0 ? Number(process.argv[index + 1]) : 8790, relay = lossyRelay(port);
  const timer = setInterval(() => console.log(JSON.stringify({ event: 'lossy-minute', ...relay.counts })), 60000);
  relay.server.on('listening', () => console.log(JSON.stringify({ event: 'lossy-ready', port })));
  relay.server.on('error', (e: any) => { console.error(JSON.stringify({ event: 'lossy-error', code: e.code })); clearInterval(timer); process.exitCode = 1; });
  const close = () => { clearInterval(timer); console.log(JSON.stringify({ event: 'lossy-ended', ...relay.counts })); relay.close(); setTimeout(() => process.exit(0), 500); };
  process.once('SIGINT', close); process.once('SIGTERM', close);
}
