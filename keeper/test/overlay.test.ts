import { it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { address, createNoopSigner, getAddressEncoder } from '@solana/kit';
import * as r from '../../program/client/index.js';
import { ASSETS, DOVES, FEEDS } from '../../program/client/constants.js';
import { RpcPool } from '../src/common/rpc.js';
import { Overlay } from '../src/keeper/overlay.js';
import { Keeper, chooseAction, type Entry } from '../src/keeper/engine.js';
class Socket extends EventEmitter {
 ready = true; subscriptions: {method:string; callback:(v:any)=>void}[]=[];
 subscribe(method:string,_params:unknown[],callback:(v:any)=>void){const entry={method,callback};this.subscriptions.push(entry);return()=>{this.subscriptions=this.subscriptions.filter(x=>x!==entry)}}
 close(){} start(){}
}
const quiet=()=>{};
afterEach(()=>vi.useRealTimers());
it('real pool, all background reads, independent lanes, windows and notification loss',async()=>{
 vi.useFakeTimers();
 const calls:{method:string;at:number}[]=[], feeds:number[]=[], slots:number[]=[], tables:number[]=[];
 const transport=(async(_url:any,init:any)=>{const b=JSON.parse(init.body);calls.push({method:b.method,at:Date.now()});
  let result:any={};if(b.method==='getProgramAccounts')result={context:{slot:1007},value:[{pubkey:'new',account:{data:['AA==','base64']}}]};
  if(b.method==='getMultipleAccounts')result={context:{slot:1007},value:FEEDS.map(()=>({data:['AA==','base64']}))};
  if(b.method==='getSlot')result=1007;
  return Response.json({result});})as typeof fetch;
 const rpc=new RpcPool('mainnet',[{name:'public',url:'https://rpc.invalid',ws:'wss://rpc.invalid',verified:true}],transport,quiet),ws=new Socket();
 let active=true,open=true,seen=0;
 const overlay:Overlay=new Overlay(rpc,ws as any,r.RUIN_PROGRAM_ADDRESS,FEEDS,{onSlot:()=>{},onPrice:i=>{if(i===0)feeds.push(Date.now())},onTable:()=>{tables.push(Date.now());seen++},windows:()=>active?[{target:1007n,end:1011n}]:[],openCount:()=>open?1:0,signatures:()=>[],onStatuses:()=>{}},quiet);
 overlay.slot=1007n;
 const call=rpc.call.bind(rpc); rpc.call=async(method,params=[],mode='normal',lane)=>{const result=await call(method,params,mode,lane);if(method==='getSlot')slots.push(Date.now());return result};
 overlay.start();
 const background=[setInterval(()=>{void rpc.call('getLatestBlockhash');void rpc.call('getBlockHeight')},2000),setInterval(()=>void rpc.call('getAccountInfo'),10000),setInterval(()=>{void rpc.call('getAccountInfo');void rpc.call('getProgramAccounts');void rpc.call('getMultipleAccounts')},15000)];
 try{
  await vi.advanceTimersByTimeAsync(16000);
  const maxGap=(rows:number[])=>Math.max(...rows.slice(1).map((n,i)=>n-rows[i]!));
  expect(maxGap(feeds)).toBeLessThanOrEqual(600);expect(maxGap(slots)).toBeLessThanOrEqual(600);expect(seen).toBeGreaterThanOrEqual(8);expect(tables[0]!-calls[0]!.at).toBeLessThanOrEqual(2000);expect(overlay.wsLoss).toBeGreaterThan(0);
  const slotCount=slots.length,feedCount=feeds.length;active=false;open=false;
  await vi.advanceTimersByTimeAsync(3000);expect(slots.length).toBe(slotCount);expect(feeds.length-feedCount).toBe(3);
  expect(rpc.metrics.snapshot().endpoints.public?.failovers??0).toBe(0);
 }finally{background.forEach(clearInterval);overlay.close();rpc.close()}
});
function feed(price:bigint,ts:bigint){const d=Buffer.alloc(394);Buffer.from('70f98bd9d7d0f936','hex').copy(d);Buffer.from(getAddressEncoder().encode(ASSETS[0])).copy(d,8);d.writeBigUInt64LE(price,168);d[176]=248;d.writeBigInt64LE(ts,177);return{owner:DOVES,data:[d.toString('base64'),'base64']}}
const table=():r.Table=>({discriminator:r.TABLE_DISCRIMINATOR,house:address('11111111111111111111111111111111'),trader:address('11111111111111111111111111111111'),seq:1n,market:0,side:r.Side.Long,lev:919,m:1000000n,k:10,eBps:700,delayMin:10,delayMax:23,fillWindow:4,closeWindow:4,staleSecs:30,expirySecs:86400,state:r.TableState.CloseRequested,requestSlot:980n,requestPublishTs:900n,p0:10454457828n,fillSlot:990n,fillPublishTs:901n,fillTs:1000n,closeRequestSlot:997n,closePublishTs:902n,bump:255});
it('close target 1007 through 1011 chooses stop only inside its window with a newer publication',()=>{
 const t={...table(),p0:10443380457n};
 expect(chooseAction(t,{price:t.p0,publishTs:903n,slot:0,recvMs:0},1006n,1001n,undefined,1007n)).toBeUndefined();
 for(const slot of[1007n,1011n])expect(chooseAction(t,{price:t.p0,publishTs:903n,slot:0,recvMs:0},slot,1001n,undefined,1007n)?.kind).toBe('settle-stop');
 expect(chooseAction(t,{price:t.p0,publishTs:902n,slot:0,recvMs:0},1007n,1001n,undefined,1007n)).toBeUndefined();
});
it('the actual keeper price path sends the five-slot middle line crossing and ignores stale observations',async()=>{
 const ws=new Socket(),rpc:any={cluster:'mainnet',close(){},metrics:{snapshot:()=>({})}},keeper=new Keeper(rpc,ws as any,createNoopSigner(address('11111111111111111111111111111111')),quiet);
 const t={...table(),state:r.TableState.Open},key=address('11111111111111111111111111111112'),job:any={kind:'settle-line',wire:'wire',signature:'sig'};
 const entry:Entry={address:key,table:t,fingerprint:'x',slot:1000,ready:true,jobs:new Map([['settle-line',job]]),nonce:0n,failedSignatures:new Set()};
 keeper.tables.set(key,entry);keeper.slot=1000n;
 (keeper as any).build=async()=>{};const sent:string[]=[];keeper.sender.send=async(_key,_house,_seq,p)=>{sent.push(p.kind)};
 await keeper.onPrice(0,FEEDS[0],feed(10443380457n,1000n),1000);expect(sent).toEqual([]);
 keeper.onSlot(1001n);await keeper.onPrice(0,FEEDS[0],feed(10443078129n,1001n),1001);expect(sent).toEqual(['settle-line']);
 await keeper.onPrice(0,FEEDS[0],feed(10443220532n,1002n),1006);keeper.onSlot(1006n);expect(sent).toEqual(['settle-line']);
 await keeper.onPrice(0,FEEDS[0],feed(10443078129n,1001n),1001);expect(sent).toEqual(['settle-line']);
 keeper.close();
});
