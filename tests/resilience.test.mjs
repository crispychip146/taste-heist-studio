import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/store.mjs';
import { createApp } from '../server/app.mjs';
import { createRoom, startPuzzle, project, installResearch } from '../server/game.mjs';
import { createRealtime } from '../server/realtime.mjs';
import { Artwork } from '../server/artwork.mjs';
import { Qloo } from '../server/qloo.mjs';
import { positiveInteger, publicOrigin } from '../server/limits.mjs';
import { fakeQloo, entity, confirmed, recommendationTool, record, prepared } from './fixtures.mjs';

async function api(app,path,data,cookie){
  const req=Readable.from(data?[JSON.stringify(data)]:[]);req.url=path;req.method=data?'POST':'GET';req.headers={host:'localhost','content-type':'application/json',cookie:cookie||''};req.socket={remoteAddress:'resilience-test'};
  const out={headers:{}};const res={setHeader(k,v){out.headers[k.toLowerCase()]=v;},writeHead(status,headers){out.status=status;Object.assign(out.headers,headers);},end(body){out.body=JSON.parse(body);}};await app.handler(req,res);return out;
}
const cookieOf=result=>result.headers['set-cookie']?.split(';')[0];

test('wrong-answer cooldowns survive rollback and restart, are per-seat, and replay failures once',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'heist-cooldown-'));let now=Date.now(),store=new Store(join(dir,'db'),{now:()=>now});
  let app=createApp({store,qloo:fakeQloo(),now:()=>now});try{
    const host=await api(app,'/api/rooms',{name:'Host'}),guest=await api(app,'/api/join',{name:'Guest',code:host.body.room.code});
    const room=store.get(host.body.room.code);startPuzzle(room,undefined,now);store.save(room);
    const wrong={type:'solve',answer:'0000',commandId:randomUUID()};
    const failure=await api(app,'/api/command',wrong,cookieOf(host));assert.equal(failure.status,400);assert.equal(failure.body.code,'WRONG_ANSWER');assert.equal(failure.body.retryAfter,1);
    await api(app,'/api/command',wrong,cookieOf(host));assert.equal(store.db.prepare('SELECT misses FROM guesses').get().misses,1);
    const next={type:'solve',answer:room.secrets.code,commandId:randomUUID()};
    assert.equal((await api(app,'/api/command',next,cookieOf(host))).status,429);
    assert.equal((await api(app,'/api/command',{...next,commandId:randomUUID()},cookieOf(guest))).status,200);
    await app.close();store=new Store(join(dir,'db'),{now:()=>now});app=createApp({store,qloo:fakeQloo(),now:()=>now});
    const blocked=await api(app,'/api/command',next,cookieOf(host));assert.equal(blocked.status,429);assert.equal(blocked.headers['retry-after'],'1');
    now+=1001;const solved=await api(app,'/api/command',next,cookieOf(host));assert.equal(solved.status,200);assert(solved.body.room.self.solved);
  }finally{await app.close();rmSync(dir,{recursive:true});}
});

test('scheduled cleanup deletes expired records without restarting and retains active rooms',()=>{
  let now=Date.now(),sweep,cancelled=false;
  const store=new Store(':memory:',{now:()=>now,every:fn=>{sweep=fn;return 1;},cancel:()=>{cancelled=true;}});try{
    const old=createRoom({code:'OLDER',id:'old-player',name:'Old',now});store.save(old);store.putSession('old-token','OLDER','old-player');store.recordCommand('old-player','test-command','hash');
    store.recordEntry('test-entry','hash','OLDER','old-player');store.transaction(()=>store.wrongGuess('old-player','OLDER',0,'wrong-command','hash','Wrong answer'));
    now+=86400001;const active=createRoom({code:'NEWER',id:'new-player',name:'New',now});store.save(active);store.putSession('new-token','NEWER','new-player');
    assert.equal(store.get('OLDER'),null);assert.equal(store.db.prepare('SELECT count(*) AS n FROM rooms').get().n,2);
    sweep();assert.equal(store.db.prepare('SELECT count(*) AS n FROM rooms').get().n,1);assert(store.session('new-token'));
    for(const table of ['commands','entries','guesses','rejections'])assert.equal(store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n,0);
  }finally{store.close();assert(cancelled);}
});

test('provider allowance is atomic across rooms, persists on restart and resets at its period boundary',()=>{
  const old=process.env.QLOO_DAILY_BUDGET;process.env.QLOO_DAILY_BUDGET='2';
  const dir=mkdtempSync(join(tmpdir(),'heist-budget-'));let now=Date.now(),store=new Store(join(dir,'db'),{now:()=>now});try{
    store.reserveProvider({room:'A',players:['p1']});store.reserveProvider({room:'B',players:['p2']});
    assert.throws(()=>store.reserveProvider({room:'C',players:['p3']}),error=>error.code==='QLOO_ALLOWANCE');
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM usage WHERE bucket LIKE 'room:%'").get().n,2);
    store.close();store=new Store(join(dir,'db'),{now:()=>now});assert.throws(()=>store.reserveProvider(),error=>error.code==='QLOO_ALLOWANCE');
    now=(Math.floor(now/86400000)+1)*86400000;assert.doesNotThrow(()=>store.reserveProvider());
  }finally{store.close();rmSync(dir,{recursive:true});if(old===undefined)delete process.env.QLOO_DAILY_BUDGET;else process.env.QLOO_DAILY_BUDGET=old;}
});

test('artwork pool bounds distinct downloads, coalesces identical images and recovers after saturation',async()=>{
  const pending=[];let active=0,max=0;
  const art=new Artwork({concurrency:2,queueLimit:1,fetcher:()=>{active++;max=Math.max(max,active);return new Promise(resolve=>pending.push(()=>{active--;resolve(new Response(Buffer.from([255,216,255,217]),{headers:{'content-type':'image/jpeg'}}));}));}});
  const a=art.get('https://images.qloo.com/a'),same=art.get('https://images.qloo.com/a'),b=art.get('https://images.qloo.com/b'),c=art.get('https://images.qloo.com/c');
  await assert.rejects(art.get('https://images.qloo.com/d'),error=>error.code==='ARTWORK_BUSY');assert.equal(active,2);
  pending.shift()();await a;await same;await new Promise(resolve=>setImmediate(resolve));assert.equal(active,2);
  pending.shift()();pending.shift()();await Promise.all([b,c]);assert.equal(max,2);assert.equal(art.active,0);assert.equal(art.waiters.length,0);
});

test('provider queue rejects excess work and does not charge cached requests twice',async()=>{
  const pending=[],charges=[];const h={env:{},close:async()=>{},search:()=>new Promise(resolve=>pending.push(()=>resolve([record(1)])))};
  const qloo=new Qloo({harness:h,queueLimit:1,reserve:scope=>charges.push(scope)});try{
    const a=qloo.search('Alpha','movie',{room:'A'}),same=qloo.search('Alpha','movie',{room:'A'}),b=qloo.search('Beta','movie',{room:'B'}),c=qloo.search('Gamma','movie',{room:'C'});
    await assert.rejects(qloo.search('Delta','movie'),error=>error.code==='QLOO_BUSY');assert.equal(qloo.active,2);
    pending.shift()();await a;await same;await new Promise(resolve=>setImmediate(resolve));
    pending.shift()();pending.shift()();await Promise.all([b,c]);await qloo.search('Alpha','movie');assert.equal(charges.length,3);assert.equal(qloo.active,0);
  }finally{await qloo.close();}
});

test('WebSocket limits reject excess seats and terminate slow consumers',()=>{
  const accepted=[],server=new EventEmitter(),room=confirmed(2);
  class Socket extends EventEmitter {constructor(){super();this.readyState=1;this.bufferedAmount=0;this.sent=[];}send(value){this.sent.push(value);}ping(){}terminate(){this.readyState=3;this.emit('close');}}
  const realtime=createRealtime({maxPerSeat:1,maxPerRoom:2,maxConnections:2,maxBufferedBytes:100000,makeServer:()=>({handleUpgrade(req,socket,head,callback){const ws=new Socket();accepted.push(ws);callback(ws);},close(){}})});
  const app={authenticate:req=>({room,session:{code:room.code,player:req.player,expires:Date.now()+60000}}),project,store:{get:()=>room}};
  realtime.attach(server,app);
  const upgrade=player=>{const raw={response:'',write(value){this.response+=value;},destroy(){this.destroyed=true;}};server.emit('upgrade',{url:'/live',headers:{host:'localhost',origin:'http://localhost'},player},raw,Buffer.alloc(0));return raw;};
  try{
    assert(!upgrade('p0').destroyed);assert.match(upgrade('p0').response,/429/);assert(!upgrade('p1').destroyed);assert.match(upgrade('p2').response,/429/);
    accepted[0].bufferedAmount=100001;realtime.broadcast(room);assert.equal(accepted[0].readyState,3);assert.equal(accepted[1].sent.length,2);
    assert(!upgrade('p0').destroyed);
  }finally{realtime.close();}
});

test('invalid limits and production origins fail clearly before serving requests',()=>{
  for(const value of [0,-1,1.5,NaN,Infinity,'broken',''])assert.throws(()=>positiveInteger(value,'limit'));
  const mode=process.env.NODE_ENV,origin=process.env.PUBLIC_ORIGIN;
  try{process.env.NODE_ENV='production';delete process.env.PUBLIC_ORIGIN;assert.throws(()=>publicOrigin());
    for(const value of ['http://example.com','https://example.com/path','https://user:pass@example.com']){process.env.PUBLIC_ORIGIN=value;assert.throws(()=>publicOrigin());}
    process.env.PUBLIC_ORIGIN='https://example.com';assert.equal(publicOrigin(),'https://example.com');
  }finally{if(mode===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=mode;if(origin===undefined)delete process.env.PUBLIC_ORIGIN;else process.env.PUBLIC_ORIGIN=origin;}
});

test('provider failure circuit persists, blocks dispatch and recovers without losing allowance history',()=>{
  const dir=mkdtempSync(join(tmpdir(),'heist-circuit-'));let now=Date.now(),store=new Store(join(dir,'db'),{now:()=>now});try{
    for(let i=0;i<3;i++){store.reserveProvider();store.providerOutcome(false);}
    assert.throws(()=>store.reserveProvider(),error=>error.code==='QLOO_CIRCUIT_OPEN'&&error.retryAfter===30);
    store.close();store=new Store(join(dir,'db'),{now:()=>now});assert.throws(()=>store.reserveProvider(),error=>error.code==='QLOO_CIRCUIT_OPEN');
    now+=30001;store.reserveProvider();store.providerOutcome(true);assert.equal(store.db.prepare('SELECT count(*) AS n FROM provider_state').get().n,0);
    assert.equal(store.db.prepare("SELECT units FROM usage WHERE bucket='global-day'").get().units,4);
  }finally{store.close();rmSync(dir,{recursive:true});}
});

test('process-minute reservation stays bounded while an asynchronous quota callback yields',async()=>{
  const old=process.env.QLOO_REQUESTS_PER_MINUTE;process.env.QLOO_REQUESTS_PER_MINUTE='1';let sent=0;
  const qloo=new Qloo({harness:{close:async()=>{}},reserve:async()=>Promise.resolve()});
  try{
    const first=qloo.limited(async()=>{sent++;return 1;});
    await assert.rejects(qloo.limited(async()=>{sent++;}),error=>error.code==='QLOO_LOCAL_RATE');
    assert.equal(await first,1);assert.equal(sent,1);
  }finally{await qloo.close();if(old===undefined)delete process.env.QLOO_REQUESTS_PER_MINUTE;else process.env.QLOO_REQUESTS_PER_MINUTE=old;}
});
