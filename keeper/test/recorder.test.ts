import { afterEach, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { Store } from "../src/common/sqlite.js";
import { DovesRecorder } from "../src/tape/doves.js";
import { decodeDovesTransaction } from "../src/tape/doves-tx.js";
import { FEEDS } from "../../program/client/constants.js";
import { MARKETS } from "../src/common/oracle.js";
import { Publisher } from "../src/tape/publish.js";
import { calculate, type Sample } from "../src/tape/calculate.js";
import type { Trade } from "../src/tape/yolo.js";
const fixtures = [1, 2].map((n) => JSON.parse(readFileSync(new URL(`./fixtures/doves-460093488-${n}.json`, import.meta.url), "utf8")));
const t0 = fixtures[0].tx.blockTime * 1000;
afterEach(() => vi.useRealTimers());
function setup() {
  vi.useFakeTimers({ now: t0 + 4000, toFake: ["Date"] });
  const s = new Store(":memory:");
  const flags = { list: false, body: false, decode: false };
  const calls: any[] = [];
  const rpc: any = { call: async (method: string, params: any[]) => {
    calls.push({ method, params });
    if (method === "getSignaturesForAddress") {
      if (flags.list) throw Error("unavailable");
      return params[1].until === "s2" ? [] : [2, 1].map(n => ({ signature: `s${n}`, slot: 460093488, blockTime: t0 / 1000, err: null }));
    }
    if (flags.body) throw Error("unavailable");
    const tx = structuredClone(fixtures[params[0] === "s1" ? 0 : 1].tx);
    if (flags.decode) tx.meta.logMessages = tx.meta.logMessages.filter((l: string) => l !== "Program log: Instruction: UpdateAgPrice2");
    return tx;
  } };
  return { s, rpc, flags, calls };
}
it("real transaction selected-source values, including two updates in slot 460093488", () => {
  const values = fixtures.flatMap(({ tx, expected }) => {
    const got = decodeDovesTransaction(tx);
    expect(got.map(({ feed, price, publish_ts }) => ({ feed, price, publish_ts }))).toEqual(expected.filter((x: any) => FEEDS.includes(x.feed)));
    expect(got.every(x => x.recv_ms === tx.blockTime * 1000)).toBe(true);
    return got;
  });
  expect(values.filter(x => x.market === "SOL").map(x => x.publish_ts)).toEqual([1792684448, 1792684449]);
});
it("a top-level instruction/log count mismatch fails closed", () => {
  const tx = structuredClone(fixtures[0].tx);
  tx.meta.logMessages.splice(tx.meta.logMessages.indexOf("Program log: Instruction: UpdateAgPrice2"), 1);
  expect(() => decodeDovesTransaction(tx)).toThrow("count mismatch");
});
it("union decoding is deduplicated, same-slot rows are ordered, and a restart resumes persisted cursors without a gap", async () => {
  const { s, rpc, calls } = setup();
  const d = new DovesRecorder(s, rpc); await d.poll();
  expect(calls.filter(x => x.method === "getTransaction")).toHaveLength(2);
  expect((s.db.prepare("SELECT publish_ts FROM doves WHERE market='SOL' ORDER BY publish_ts,slot,id").all() as any[]).map(x => x.publish_ts)).toEqual([1792684448, 1792684449]);
  expect(s.db.prepare("SELECT * FROM gaps").all()).toHaveLength(0);
  vi.setSystemTime(t0 + 8000);
  const restarted = new DovesRecorder(s, rpc); await restarted.poll();
  expect(calls.slice(-3).every(x => x.method === "getSignaturesForAddress" && x.params[1].until === "s2")).toBe(true);
  expect(s.db.prepare("SELECT * FROM gaps").all()).toHaveLength(0);
  expect(s.db.prepare("SELECT * FROM doves_arrivals").all()).toHaveLength(6);
  s.close();
});
it.each(["list", "body", "decode"] as const)("%s failure opens a gap without advancing its cursor; recovery closes it", async kind => {
  const { s, rpc, flags } = setup();
  const d = new DovesRecorder(s, rpc);
  flags[kind] = true; await d.poll();
  expect(s.get("doves-cursor:SOL")).toBeUndefined();
  const gap = s.db.prepare("SELECT * FROM gaps WHERE market='SOL'").get() as any;
  expect(gap.reason).toBe(kind === "decode" ? "decode" : "listing"); expect(gap.b).toBe(null);
  flags[kind] = false; await d.poll();
  expect((s.db.prepare("SELECT b FROM gaps WHERE market='SOL'").get() as any).b).toBe(1792684449);
  expect(JSON.parse(s.get("doves-cursor:SOL")!).sig).toBe("s2");
  s.close();
});
it("a listing past the retained cursor preserves it for nine failures and resets it on the tenth", async () => {
  const { s, rpc } = setup();
  for (const market of MARKETS) s.set(`doves-cursor:${market}`, JSON.stringify({ sig: "missing", slot: 460093489, at: t0, end: t0 }));
  const d = new DovesRecorder(s, rpc);
  for (let n = 0; n < 9; n++) { await d.poll(); expect(JSON.parse(s.get("doves-cursor:SOL")!).sig).toBe("missing"); }
  expect(s.db.prepare("SELECT * FROM gaps WHERE reason='listing' AND b IS NULL").all()).toHaveLength(3);
  await d.poll(); expect(s.get("doves-cursor:SOL")).toBeUndefined();
  expect(s.db.prepare("SELECT * FROM gaps WHERE reason='process-start' AND b IS NULL").all()).toHaveLength(3);
  s.close();
});
it("a cursor older than six hours opens process-start gaps", () => {
  const { s, rpc } = setup();
  for (const market of MARKETS) s.set(`doves-cursor:${market}`, JSON.stringify({ sig: "old", slot: 1, at: t0 - 21600001, end: t0 - 21600001 }));
  new DovesRecorder(s, rpc);
  expect(s.db.prepare("SELECT * FROM gaps WHERE reason='process-start'").all()).toHaveLength(3); s.close();
});
it("confirmed transaction records restore the first ETH line at 65 despite omitted websocket notifications", async () => {
  const { s } = setup(), start = 1792604373;
  let n = 0;
  const rpc: any = { call: async (method: string, params: any[]) => {
    if (method === "getSignaturesForAddress") return [{ signature: `s${n}`, slot: n + 100, blockTime: start + n, err: null }];
    const tx = structuredClone(fixtures[0].tx); tx.slot = n + 100; tx.blockTime = start + n;
    const price = n === 65 ? "251726539820" : n === 66 ? "251722177322" : n >= 69 ? "251733015967" : "251474120396";
    const keys = [...tx.transaction.message.accountKeys, ...tx.meta.loadedAddresses.writable, ...tx.meta.loadedAddresses.readonly];
    const instructions = tx.transaction.message.instructions.filter((ix: any) => ix.data === "BFFRQh5PNJx");
    let block = -1;
    tx.meta.logMessages = tx.meta.logMessages.map((line: string) => {
      if (line === "Program log: Instruction: UpdateAgPrice2") block++;
      if (/ price: \d+, timestamp: \d+/.test(line)) return line.replace(/price: \d+, timestamp: \d+/, `price: ${keys[instructions[block]?.accounts[1]] === FEEDS[2] ? price : "10000000000"}, timestamp: ${start + n}`);
      return line;
    });
    return tx;
  } };
  vi.setSystemTime((start - 10) * 1000);
  const d = new DovesRecorder(s, rpc);
  for (n = 0; n <= 76; n++) { vi.setSystemTime((start + n + 5) * 1000); await d.poll(); }
  const trade = (id: string, kind: Trade["kind"], at: number, heldFor: number | null = null): Trade => ({ id, signature: id, kind, executedAt: String(at), heldFor, market: "ETH", side: "short", owner: "owner", margin: "10000000", notional: "10000000000", leverage: 1000, price: "2514737519730000", amount: "0", queued: "0" });
  const p = new Publisher(s, "", null as any, null as any, null as any);
  const result = calculate(trade("e", "liquidate", start + 63, 63), trade("o", "open", start), s.db.prepare("SELECT * FROM doves WHERE market='ETH' ORDER BY publish_ts,slot,id").all() as Sample[], (a, b) => p.covered("ETH", a, b), start + 77);
  expect(result).toMatchObject({ status: "rows", row: { c: -1, d: 65 } }); s.close();
});
it('independent address listings retain a confirmed update discovered after a newer value',async()=>{
 const rows=[825,830,832].map(n=>JSON.parse(readFileSync(new URL(`./fixtures/doves-460270${n}.json`,import.meta.url),'utf8')));
 vi.useFakeTimers({now:rows[2].tx.blockTime*1000+4000,toFake:['Date']});
 const s=new Store(':memory:');let round=0;
 const rpc:any={call:async(method:string,params:any[])=>{
  if(method==='getSignaturesForAddress')return(round===0?(params[0]===FEEDS[0]?[0]:[2]):params[0]===FEEDS[0]?[2,1]:[]).map(i=>({signature:String(i),slot:rows[i].tx.slot,blockTime:rows[i].tx.blockTime,err:null}));
  return rows[Number(params[0])].tx;
 }};
 const d=new DovesRecorder(s,rpc);await d.poll();round++;await d.poll();
 expect((s.db.prepare("SELECT publish_ts,price FROM doves WHERE market='SOL' ORDER BY publish_ts,slot,id").all() as any[]).map(r=>[r.publish_ts,r.price])).toEqual([[1792722058,'10407440355'],[1792722059,'10407440355'],[1792722060,'10407418871']]);
 expect((d as any).latest.get('SOL').publish_ts).toBe(1792722060);
 expect(s.db.prepare('SELECT * FROM gaps').all()).toHaveLength(0);s.close();
});

function delayedListings() {
 const rows=[825,830,832].map(n=>structuredClone(JSON.parse(readFileSync(new URL(`./fixtures/doves-460270${n}.json`,import.meta.url),'utf8')).tx)),start=1792722058;
 rows[1].meta.logMessages=rows[1].meta.logMessages.map((l:string)=>l.replace(/price: \d+, timestamp:/,'price: 10390000000, timestamp:'));
 vi.useFakeTimers({now:(start-1)*1000,toFake:['Date']});const s=new Store(':memory:'),calls:any[]=[];
 const control={round:0,bad:'' as ''|'decode'|'null',missing:false};
 const rpc:any={call:async(method:string,params:any[])=>{
  calls.push({method,params});if(method==='getSignaturesForAddress'){
   const selected=control.round===0?[0]:params[0]===FEEDS[0]?control.missing?[]:[2,1]:params[1].until==='832'?[]:[2];
   return selected.map(i=>({signature:String([825,830,832][i]),slot:rows[i].slot,blockTime:rows[i].blockTime,err:null}));
  }
  const i=[825,830,832].indexOf(Number(params[0]));if(i===1&&control.bad==='null')return null;
  const tx=structuredClone(rows[i]);if(i===1&&control.bad==='decode')tx.meta.logMessages=[];return tx;
 }};
 const recorder=new DovesRecorder(s,rpc),poll=async()=>{vi.setSystemTime((start+5+control.round*3)*1000);await recorder.poll()};
 const pub=new Publisher(s,'',null as any,null as any,null as any),prices=()=>s.db.prepare("SELECT * FROM doves WHERE market='SOL' ORDER BY publish_ts,slot,id").all() as Sample[];
 const trade=(kind:Trade['kind'],at:number):Trade=>({id:kind,signature:kind,kind,executedAt:String(at),heldFor:kind==='open'?null:2,market:'SOL',side:'long',owner:'owner',margin:'1000000',notional:'1000000000',leverage:1000,price:'104074403550000',amount:'0',queued:'0'});
 const result=()=>calculate(trade('close',start+2),trade('open',start),prices(),(a,end)=>pub.covered('SOL',a,end));
 return{s,calls,control,recorder,poll,pub,prices,result,rows,start,open:trade('open',start),exit:trade('close',start+2)};
}
it('records each market only from its own listing and keeps the missing middle line pending until its transaction arrives',async()=>{
 const f=delayedListings();await f.poll();expect(f.calls.filter(c=>c.method==='getTransaction')).toHaveLength(1);expect(f.s.db.prepare('SELECT DISTINCT market FROM doves').all()).toHaveLength(3);
 f.control.round=1;f.control.missing=true;await f.poll();expect(f.prices().map(v=>v.publish_ts)).toEqual([1792722058]);expect(f.pub.covered('SOL',f.prices()[0],1792722060)).toBe('pending');expect(f.result().status).toBe('pending');
 f.control.round=2;f.control.missing=false;await f.poll();expect(f.prices().map(v=>v.publish_ts)).toEqual([1792722058,1792722059,1792722060]);expect(f.result()).toMatchObject({status:'rows',row:{c:-1,d:1}});
 expect(f.calls.filter(c=>c.method==='getTransaction').map(c=>c.params[0])).toEqual(['825','832','830']);f.s.close();
});
it('keeps twelve-second-old coverage pending, rejects an overlapping gap, and calculates after coverage catches up',async()=>{
 const f=delayedListings();await f.poll();f.control.round=1;await f.poll();const end=1792722060;
 f.s.db.prepare('UPDATE coverage SET end_ms=?').run((end-2)*1000);vi.setSystemTime((end+12)*1000);expect(f.pub.covered('SOL',f.prices()[0],end)).toBe('pending');expect(f.result().status).toBe('pending');
 for(const [n,t] of [f.open,f.exit].entries())f.s.db.prepare('INSERT INTO trades VALUES(?,?,?,?,?)').run(t.id,n+1,Number(t.executedAt),t.kind,JSON.stringify(t));f.s.set('yolo-cursor','2');f.pub.calculate();expect(f.s.db.prepare("SELECT status FROM results WHERE id='close'").get()).toMatchObject({status:'pending'});
 f.s.db.prepare("INSERT INTO gaps(market,a,b,reason,start_ms,end_ms) VALUES('SOL',?,?,'listing',?,?)").run(end-2,end,(end-2)*1000,end*1000);expect(f.pub.covered('SOL',f.prices()[0],end)).toBe(false);
 f.s.db.exec('DELETE FROM gaps');f.s.db.prepare('UPDATE coverage SET end_ms=?').run(end*1000);expect(f.result()).toMatchObject({status:'rows',row:{c:-1,d:1}});f.pub.calculate();const saved=f.s.db.prepare("SELECT status,row FROM results WHERE id='close'").get() as any;expect(saved.status).toBe('rows');expect(JSON.parse(saved.row)).toMatchObject({c:-1,d:1});f.s.close();
});
it('skips a deterministic decode failure on the second consecutive poll and closes its gap with a later slot',async()=>{
 const f=delayedListings();await f.poll();const before=JSON.parse(f.s.get('doves-cursor:SOL')!);f.control.round=1;f.control.bad='decode';await f.poll();
 expect(JSON.parse(f.s.get('doves-cursor:SOL')!).sig).toBe('825');expect(f.s.db.prepare("SELECT b FROM gaps WHERE market='SOL' AND reason='decode'").get()).toMatchObject({b:null});
 f.control.round=2;await f.poll();expect(JSON.parse(f.s.get('doves-cursor:SOL')!).sig).toBe('832');expect(f.s.db.prepare("SELECT a,b FROM gaps WHERE market='SOL' AND reason='decode'").get()).toMatchObject({a:1792722058,b:1792722060});
 expect((f.s.db.prepare('SELECT MAX(end_ms) b FROM coverage').get() as any).b).toBeGreaterThan(before.end);expect(f.calls.filter(c=>c.method==='getTransaction'&&c.params[0]==='830')).toHaveLength(2);f.s.close();
});
it('does not skip two null transaction responses and recovers the listing gap when the body becomes readable',async()=>{
 const f=delayedListings();await f.poll();f.control.bad='null';for(const round of [1,2]){f.control.round=round;await f.poll();expect(JSON.parse(f.s.get('doves-cursor:SOL')!).sig).toBe('825')}
 expect(f.s.db.prepare("SELECT * FROM gaps WHERE market='SOL' AND reason='listing' AND b IS NULL").all()).toHaveLength(1);f.control.round=3;f.control.bad='';await f.poll();
 expect(f.prices().map(v=>v.publish_ts)).toEqual([1792722058,1792722059,1792722060]);expect(JSON.parse(f.s.get('doves-cursor:SOL')!).sig).toBe('832');expect(f.s.db.prepare("SELECT b FROM gaps WHERE market='SOL' AND reason='listing'").get()).toMatchObject({b:1792722060});f.s.close();
});
it('abandons a retained cursor after ten consecutive listing failures and resumes from a fresh baseline',async()=>{
 const f=delayedListings();await f.poll();let failed=0,baseline=false;const fresh=structuredClone(f.rows[2]);fresh.slot+=1000;fresh.blockTime=f.start+36;fresh.meta.logMessages=fresh.meta.logMessages.map((l:string)=>l.replace(/timestamp: \d+/,`timestamp: ${f.start+36}`));
 const rpc:any={call:async(method:string,params:any[])=>{
  if(method==='getSignaturesForAddress'){if(params[0]===FEEDS[0]&&!baseline){failed++;return[{signature:'behind',slot:f.rows[0].slot-1,blockTime:f.start,err:null}]}
   if(params[0]===FEEDS[0])expect(params[1].until).toBeUndefined();return[{signature:'fresh',slot:fresh.slot,blockTime:fresh.blockTime,err:null}];
  }return fresh;
 }};const d=new DovesRecorder(f.s,rpc);
 for(let n=0;n<10;n++){vi.setSystemTime((f.start+6+n*3)*1000);await d.poll();if(n<9)expect(f.s.get('doves-cursor:SOL')).toBeDefined()}
 expect(failed).toBe(10);expect(f.s.get('doves-cursor:SOL')).toBeUndefined();expect(f.s.db.prepare("SELECT * FROM gaps WHERE market='SOL' AND reason='process-start' AND b IS NULL").all()).toHaveLength(1);
 baseline=true;vi.setSystemTime((f.start+41)*1000);await d.poll();expect(JSON.parse(f.s.get('doves-cursor:SOL')!).sig).toBe('fresh');expect(f.s.db.prepare("SELECT b FROM gaps WHERE market='SOL' AND reason='process-start'").get()).toMatchObject({b:f.start+36});
 expect((f.s.db.prepare('SELECT MAX(end_ms) b FROM coverage').get() as any).b).toBe((f.start+36)*1000);f.s.close();
});
it('persists a skipped decode gap across restart until that market records a later slot',async()=>{
 const f=delayedListings();await f.poll();let stage=0;
 const rpc:any={call:async(method:string,params:any[])=>{
  if(method==='getSignaturesForAddress')return params[0]!==FEEDS[0]||stage===1?[]:[{signature:stage===0?'830':'832',slot:f.rows[stage===0?1:2].slot,blockTime:f.rows[stage===0?1:2].blockTime,err:null}];
  const tx=structuredClone(f.rows[params[0]==='830'?1:2]);if(params[0]==='830')tx.meta.logMessages=[];return tx;
 }};
 const d=new DovesRecorder(f.s,rpc);for(let n=0;n<2;n++){vi.setSystemTime((f.start+8+n*3)*1000);await d.poll()}
 expect(JSON.parse(f.s.get('doves-cursor:SOL')!).sig).toBe('830');expect(f.s.db.prepare("SELECT b FROM gaps WHERE market='SOL' AND reason='decode'").get()).toMatchObject({b:null});
 const restarted=new DovesRecorder(f.s,rpc);stage=1;await restarted.poll();expect(f.s.db.prepare("SELECT b FROM gaps WHERE market='SOL' AND reason='decode'").get()).toMatchObject({b:null});
 stage=2;await restarted.poll();expect(f.s.db.prepare("SELECT b FROM gaps WHERE market='SOL' AND reason='decode'").get()).toMatchObject({b:f.start+2});f.s.close();
});
it('rebases a first-failure decode gap when restarting beyond the retained cursor lifetime',async()=>{
 const f=delayedListings();await f.poll();f.control.round=1;f.control.bad='decode';await f.poll();
 const at=f.start+21610;vi.setSystemTime(at*1000);const fresh=structuredClone(f.rows[2]);fresh.slot+=100000;fresh.blockTime=at-1;fresh.meta.logMessages=fresh.meta.logMessages.map((l:string)=>l.replace(/timestamp: \d+/,`timestamp: ${at-1}`));
 const rpc:any={call:async(method:string,params:any[])=>method==='getSignaturesForAddress'?[{signature:'fresh',slot:fresh.slot,blockTime:fresh.blockTime,err:null}]:fresh};
 const restarted=new DovesRecorder(f.s,rpc);await restarted.poll();
 expect(f.s.db.prepare("SELECT b FROM gaps WHERE market='SOL' AND reason='decode'").get()).toMatchObject({b:at-1});
 expect(f.s.db.prepare("SELECT b FROM gaps WHERE market='SOL' AND reason='process-start'").get()).toMatchObject({b:at-1});
 expect(JSON.parse(f.s.get('doves-cursor:SOL')!).sig).toBe('fresh');f.s.close();
});
