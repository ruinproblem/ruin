import {afterEach,it,expect,vi} from 'vitest';
import {Store} from '../src/common/sqlite.js';
import {YoloReader,type Trade} from '../src/tape/yolo.js';
const trade=(id:string,market='SOL',at=1792800000):Trade=>({id,signature:id,kind:'open',executedAt:String(at),heldFor:null,market,side:'long',owner:'owner',margin:'1000000',notional:'1000000000',leverage:1000,price:'1000000000000',amount:'0',queued:'0'});
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers()});
it('accepts a mixed-market API page and preserves raw cursor offsets while storing only tracked markets',async()=>{
 const s=new Store(':memory:'),reader=new YoloReader(s);
 vi.stubGlobal('fetch',async()=>Response.json({cursor:'1003',trades:[trade('a'),trade('z','ZEC'),trade('b','ETH')]}));
 const page=await reader.page();expect(page.trades).toHaveLength(3);(reader as any).save(page);
 expect(s.db.prepare('SELECT id,cursor FROM trades ORDER BY cursor').all()).toEqual([{id:'a',cursor:1000},{id:'b',cursor:1002}]);s.close();
});
it('still rejects malformed records from tracked and untracked markets',async()=>{
 const s=new Store(':memory:'),reader=new YoloReader(s);
 for(const market of ['SOL','ZEC']){vi.stubGlobal('fetch',async()=>Response.json({cursor:1,trades:[{...trade('bad',market),price:'invalid'}]}));await expect(reader.page()).rejects.toThrow('schema changed')}
 s.close();
});
it('continues bootstrap and full-page polling using the original API lengths even when almost all records are untracked',async()=>{
 vi.useFakeTimers({now:1792800000000});const s=new Store(':memory:'),reader=new YoloReader(s),calls:(number|null)[]=[];
 vi.stubGlobal('fetch',async(url:string)=>{
  const param=new URL(url).searchParams.get('after'),after=param===null?null:Number(param);calls.push(after);
  if(after===3000){reader.stopped=true;return Response.json({cursor:3001,trades:[trade('last','ZEC')]})}
  const first=after===null?1000:after,rows=Array.from({length:1000},(_,i)=>trade(String(first+i),'ZEC',after===0?1792800000-81*3600:1792800000));
  if(after===null)rows[5]=trade('tracked-latest');if(after===2000)rows[9]=trade('tracked-new','BTC');
  return Response.json({cursor:first+1000,trades:rows});
 });
 const running=reader.run();await vi.advanceTimersByTimeAsync(8000);await running;
 expect(calls).toEqual([null,0,2000,3000]);expect(s.get('yolo-cursor')).toBe('3001');
 expect(s.db.prepare('SELECT id,cursor FROM trades ORDER BY cursor').all()).toEqual([{id:'tracked-latest',cursor:1005},{id:'tracked-new',cursor:2009}]);s.close();
});
