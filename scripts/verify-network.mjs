// Verifies the actual HTTP and WebSocket transport without requesting cultural data from Qloo.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.mjs';
import { createRealtime } from '../server/realtime.mjs';
import { Store } from '../server/store.mjs';
import { startPuzzle } from '../server/game.mjs';
import { WebSocket } from '../vendor/ws/wrapper.mjs';

const oldOrigin = process.env.PUBLIC_ORIGIN, oldMode = process.env.NODE_ENV; delete process.env.PUBLIC_ORIGIN; process.env.NODE_ENV = 'test';
// This isolated transport check supplies readiness only. Every cultural operation fails
// immediately, so CI needs no Qloo credential and cannot accidentally spend provider quota.
const noProvider = () => { throw new Error('Cultural requests are forbidden in the transport check.'); };
const transportOnlyProvider = {
  status: () => ({ configured: true, harnessReady: false, verifiedAt: null }),
  search: noProvider, research: noProvider,
};
const realtime = createRealtime(), app = createApp({ store: new Store(':memory:'), qloo: transportOnlyProvider, broadcast: realtime.broadcast });
const server = createServer(app.handler); realtime.attach(server, app);
const sockets = []; let origin;
async function api(path, data, cookie) {
  const response = await fetch(`${origin}/api/${path}`, { method: data ? 'POST' : 'GET', headers: { ...(data ? {'content-type':'application/json', origin} : {}), ...(cookie ? {cookie} : {}) }, body: data ? JSON.stringify(data) : undefined, signal: AbortSignal.timeout(5000) });
  const result = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${result.code || 'request failed'}`);
  return { ...result, cookie: response.headers.get('set-cookie')?.split(';')[0] };
}
async function socketFor(cookie) {
  const socket = new WebSocket(origin.replace('http:', 'ws:')+'/live', {headers:{cookie,origin}}); sockets.push(socket);
  socket.views = []; socket.on('message', data => { socket.views.push(JSON.parse(data)); });
  await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('WebSocket connection timeout')),5000);socket.once('open',()=>{clearTimeout(timeout);resolve();});socket.once('error',error=>{clearTimeout(timeout);reject(error);});});
  return socket;
}
async function waitFor(socket, predicate) {
  const deadline = Date.now()+5000;
  while(Date.now()<deadline){const found=socket.views.find(view=>predicate(view.room));if(found)return found.room;await new Promise(resolve=>setTimeout(resolve,20));}
  throw new Error('A personalized WebSocket update did not arrive.');
}
try {
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});origin=`http://127.0.0.1:${server.address().port}`;
  const host=await api('rooms',{name:'Transport check A'}),hostSocket=await socketFor(host.cookie);
  const guest=await api('join',{name:'Transport check B',code:host.room.code}),guestSocket=await socketFor(guest.cookie);
  await waitFor(hostSocket,room=>room.players.length===2);console.log('HTTP cookies, invite and lobby WebSocket update: passed');
  const move=(cookie,values)=>api('command',{...values,commandId:randomUUID()},cookie);
  await move(host.cookie,{type:'begin'});await waitFor(guestSocket,room=>room.phase==='intake');
  await move(guest.cookie,{type:'chat',text:'Transport verified'});await waitFor(hostSocket,room=>room.messages.some(message=>message.text==='Transport verified'));console.log('Cross-client action delivery: passed');
  // Generate only the mechanical lock in this isolated in-memory room to test private projections.
  // This is transport QA, not a cultural recommendation or an alternate product mode.
  const room=app.store.mutate(host.room.code,room=>{startPuzzle(room);room.version++;});realtime.broadcast(room);
  const hostView=await waitFor(hostSocket,room=>room.phase==='playing'),guestView=await waitFor(guestSocket,room=>room.phase==='playing');
  if(hostView.self.clue.kind!=='order'||guestView.self.clue.kind!=='mapping'||hostView.secrets||guestView.secrets||hostView.players.some(player=>player.support||player.favorites))throw new Error('Private projection check failed');
  const sameCommand={type:'share',commandId:randomUUID()};await api('command',sameCommand,host.cookie);await api('command',sameCommand,host.cookie);
  const shared=await waitFor(guestSocket,room=>room.board.length===1);if(shared.board.length!==1)throw new Error('Duplicate command was replayed');
  console.log('Private clues, deliberate sharing and idempotent moves: passed');
  hostSocket.close();const reconnected=await socketFor(host.cookie);const restored=await waitFor(reconnected,room=>room.phase==='playing');
  if(restored.self.id!==hostView.self.id)throw new Error('Reconnect changed identity');console.log('WebSocket reconnect and restored identity: passed');
  const unauthorized=new WebSocket(origin.replace('http:','ws:')+'/live',{headers:{origin}});sockets.push(unauthorized);
  await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Unauthorized socket was not rejected')),5000);unauthorized.once('unexpected-response',(request,response)=>{clearTimeout(timeout);response.resume();unauthorized.terminate();response.statusCode===401?resolve():reject(new Error('Unexpected rejection status'));});unauthorized.once('open',()=>{clearTimeout(timeout);reject(new Error('An unauthenticated socket opened'));});unauthorized.on('error',()=>{});});
  console.log('Unauthenticated WebSocket rejection: passed');
  console.log('Actual HTTP/WebSocket network verification passed. No Qloo requests were made. Browser visual QA remains separate.');
} catch(error) {console.error(`NETWORK_CHECK: ${error.message}`);process.exitCode=1;}
finally{for(const socket of sockets)try{socket.terminate();}catch{}realtime.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await app.close();if(oldOrigin!==undefined)process.env.PUBLIC_ORIGIN=oldOrigin;if(oldMode===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=oldMode;}
