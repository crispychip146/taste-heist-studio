import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SourceTextModule, createContext } from 'node:vm';
import { Readable } from 'node:stream';
import { randomUUID, webcrypto } from 'node:crypto';
import { createApp } from '../server/app.mjs';
import { Store } from '../server/store.mjs';
import { fakeQloo } from './fixtures.mjs';

function clock() {
  let now=0,id=0; const jobs=new Map();
  return { setTimeout(fn,delay=0){const key=++id;jobs.set(key,{fn,at:now+delay,period:0});return key;},
    setInterval(fn,delay){const key=++id;jobs.set(key,{fn,at:now+delay,period:delay});return key;}, clear(key){jobs.delete(key);},
    async tick(ms){const end=now+ms;for(let n=0;n<1000;n++){const next=[...jobs].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;const[key,job]=next;now=job.at;if(job.period)job.at+=job.period;else jobs.delete(key);await job.fn();await Promise.resolve();}now=end;}, size:()=>jobs.size };
}
test('polling survives repeated upgrade failures, socket recovery and disconnect',async()=>{
  const timers=clock();let polls=0,blocked=true;const sockets=[],states=[],updates=[];
  class Socket { static OPEN=1;constructor(){this.readyState=blocked?0:1;sockets.push(this);timers.setTimeout(()=>{if(this.readyState===3)return;if(blocked){this.readyState=3;this.onclose?.();}else this.onopen?.();},0);}close(){this.readyState=3;this.onclose?.();} }
  const context=createContext({WebSocket:Socket,location:{protocol:'http:',host:'localhost'},AbortSignal,
    setTimeout:timers.setTimeout,setInterval:timers.setInterval,clearTimeout:timers.clear,clearInterval:timers.clear,
    fetch:async()=>{polls++;return{ok:true,json:async()=>({room:{code:'ABCDE',createdAt:1,version:polls}})};}});
  const mod=new SourceTextModule(await readFile(new URL('../public/transport.mjs',import.meta.url),'utf8'),{context});await mod.link(()=>{});await mod.evaluate();
  const transport=new mod.namespace.Transport(room=>updates.push(room),state=>states.push(state));transport.connect();
  await timers.tick(16000);assert.equal(polls,3);assert.equal(updates.length,3);assert(states.includes('polling'));
  blocked=false;await timers.tick(20000);assert(states.includes('connected'));assert.equal(polls,7);
  const stale=sockets[0];transport.disconnect();stale.onmessage?.({data:JSON.stringify({room:{code:'STALE',version:999}})});
  await timers.tick(30000);assert.equal(polls,7);assert.equal(timers.size(),0);assert(!updates.some(room=>room.code==='STALE'));
});
async function api(app,path,data,cookie) {
  const req=Readable.from(data?[JSON.stringify(data)]:[]);req.url=path;req.method=data?'POST':'GET';req.headers={host:'localhost','content-type':'application/json',cookie:cookie||''};req.socket={remoteAddress:'seat-test'};
  const out={headers:{}};const res={setHeader(k,v){out.headers[k.toLowerCase()]=v;},writeHead(status,headers){out.status=status;Object.assign(out.headers,headers);},end(body){out.body=JSON.parse(body);}};await app.handler(req,res);return out;
}
const cookieOf=result=>result.headers['set-cookie']?.split(';')[0];
test('same-room joins preserve host ownership, including after the lobby',async()=>{
  const app=createApp({store:new Store(':memory:'),qloo:fakeQloo()});try{
    const host=await api(app,'/api/rooms',{name:'Host'}),cookie=cookieOf(host),code=host.body.room.code;
    for(let n=0;n<3;n++){const resumed=await api(app,'/api/join',{name:'Host',code},cookie);assert.equal(resumed.body.room.self.id,host.body.room.host);assert.equal(resumed.body.room.players.length,1);assert.equal(cookieOf(resumed),undefined);}
    await api(app,'/api/join',{name:'Guest',code});await api(app,'/api/command',{type:'begin',commandId:randomUUID()},cookie);
    const resumed=await api(app,'/api/join',{name:'Host',code},cookie);assert.equal(resumed.body.room.phase,'intake');assert.equal(resumed.body.room.self.id,host.body.room.host);assert.equal(resumed.body.room.players.length,2);
  }finally{await app.close();}
});
test('create and join retry identifiers replay the same seat after a lost response',async()=>{
  const app=createApp({store:new Store(':memory:'),qloo:fakeQloo()});try{
    const creation={name:'Host',requestId:randomUUID()},first=await api(app,'/api/rooms',creation);
    const retry=await api(app,'/api/rooms',creation);assert.equal(retry.body.room.code,first.body.room.code);assert.equal(retry.body.room.self.id,first.body.room.self.id);
    assert.equal((await api(app,'/api/session',undefined,cookieOf(retry))).body.room.self.id,first.body.room.self.id);
    const joining={name:'Guest',code:first.body.room.code,requestId:randomUUID()};
    const [a,b]=await Promise.all([api(app,'/api/join',joining),api(app,'/api/join',joining)]);
    assert.equal(a.body.room.self.id,b.body.room.self.id);assert.equal(b.body.room.players.length,2);
    assert.equal((await api(app,'/api/join',{...joining,name:'Changed'})).status,400);
  }finally{await app.close();}
});

test('entry retries retain their identifier when randomUUID is unavailable on a LAN origin',async()=>{
  const calls=[];let attempts=0;
  class Socket{static OPEN=1;constructor(){this.readyState=1;}close(){this.readyState=3;}}
  const context=createContext({WebSocket:Socket,location:{protocol:'http:',host:'192.168.1.2:3100'},AbortSignal,
    crypto:{getRandomValues:array=>webcrypto.getRandomValues(array)},setTimeout:()=>0,clearTimeout(){},setInterval:()=>0,clearInterval(){},
    fetch:async(url,options)=>{calls.push(JSON.parse(options.body));if(!attempts++)throw new Error('Lost response');return{ok:true,json:async()=>({room:{code:'ABCDE',version:1,createdAt:1}})};}});
  const mod=new SourceTextModule(await readFile(new URL('../public/transport.mjs',import.meta.url),'utf8'),{context});await mod.link(()=>{});await mod.evaluate();
  const transport=new mod.namespace.Transport(()=>{},()=>{});transport.online=true;
  await assert.rejects(transport.create({name:'Host'}),error=>error.code==='NETWORK');await transport.create({name:'Host'});
  assert.equal(calls.length,2);assert.equal(calls[0].requestId,calls[1].requestId);assert.match(calls[0].requestId,/^[a-f0-9]{32}$/);transport.disconnect();
});
