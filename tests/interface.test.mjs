// Real browser modules + actual HTTP handlers in a DOM harness. This is not a browser paint test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { SourceTextModule, createContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { Readable } from 'node:stream';
import { createApp } from '../server/app.mjs';
import { Store } from '../server/store.mjs';
import { fakeQloo } from './fixtures.mjs';

function environment() {
  const listeners = new Set(); let app;
  app = createApp({ store: new Store(':memory:'), qloo: fakeQloo(), broadcast: room => { for (const listener of listeners) listener(room); } });
  return { app, listeners };
}
async function browser(env, { reducedMotion = false, cookie = '', offline = false, saved = [], systemDark = false, storageBlocked = false, href = 'http://localhost:3100/' } = {}) {
  const root = resolve(import.meta.dirname, '..'), events = new Map(), storage = new Map(saved), nodes = new Map(); let animations = 0;
  const classList = { add() {}, remove() {}, toggle() {} };
  const document = { activeElement: null, hidden: false, documentElement: { dataset: {}, classList }, querySelectorAll: () => [],
    querySelector: selector => nodes.get(selector) || null, getElementById: id => nodes.get(`#${id}`) || null,
    addEventListener: (name, fn) => { if (!events.has(name)) events.set(name, []); events.get(name).push(fn); }, createElement: () => ({ click() {} }),
  };
  for (const id of ['main','#header','#footer','#announcer','#toast','#vault-code','#chat-input','#search-query','#search-type']) nodes.set(id, { innerHTML: '', textContent: '', value: '', dataset: {}, classList, hidden: false, focus() { document.activeElement = this; }, animate() { animations++; } });
  async function fetcher(url, options = {}) {
    if (offline) throw new Error('Offline');
    const request = Readable.from(options.body ? [options.body] : []); request.url = url; request.method = options.method || 'GET';
    request.headers = { host: 'localhost:3100', cookie, ...(options.headers || {}) }; request.socket = { remoteAddress: 'interface-check' };
    let status, body;
    const response = { setHeader() {}, writeHead(code, headers) { status = code; if (headers['set-cookie']) cookie = headers['set-cookie'].split(';')[0]; }, end(value) { body = value; } };
    await env.app.handler(request, response);
    return { ok: status < 400, status, json: async () => JSON.parse(body) };
  }
  class WebSocket {
    static OPEN = 1;
    constructor() {
      this.readyState = 1;
      this.listener = room => { try { const { session } = env.app.authenticate({ headers: { cookie } }); if (session.code === room.code) this.onmessage?.({ data: JSON.stringify({ room: env.app.project(room, session.player) }) }); } catch {} };
      env.listeners.add(this.listener);
      queueMicrotask(() => { this.onopen?.(); try { const { room } = env.app.authenticate({ headers: { cookie } }); this.listener(room); } catch {} });
    }
    close() { this.readyState = 3; env.listeners.delete(this.listener); this.onclose?.(); }
  }
  const context = createContext({ console, document, window: { scrollTo() {} }, location: new URL(href), navigator: {}, URL, URLSearchParams, AbortSignal, crypto: webcrypto, structuredClone, Blob, WebSocket,
    FormData: class { constructor(form) { this.fields = form.fields; } get(name) { return this.fields[name]; } },
    localStorage: { getItem: key => { if(storageBlocked)throw new Error('Blocked storage');return storage.get(key) || null; }, setItem: (key, value) => { if(storageBlocked)throw new Error('Blocked storage');storage.set(key, value); }, removeItem: key => { if(storageBlocked)throw new Error('Blocked storage');storage.delete(key); } },
    fetch: fetcher, matchMedia: query => ({ matches: query.includes('color-scheme') ? systemDark : reducedMotion }), setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
  });
  const modules = new Map();
  async function load(file) {
    if (modules.has(file)) return modules.get(file);
    const module = new SourceTextModule(await readFile(file, 'utf8'), { context, identifier: file }); modules.set(file, module);
    await module.link((specifier, parent) => load(specifier.startsWith('/shared/') ? resolve(root, '.' + specifier) : resolve(dirname(parent.identifier), specifier))); return module;
  }
  const module = await load(resolve(root, 'public/app.mjs')); await module.evaluate();
  async function click(action, value, extra = {}) {
    const target = { disabled: false, tagName: 'BUTTON', dataset: { action, ...(value !== undefined ? { value: String(value) } : {}), ...extra }, closest() { return this; } };
    for (const fn of events.get('click') || []) await fn({ target, preventDefault() {} });
  }
  async function submit(id, fields = {}) { for (const fn of events.get('submit') || []) await fn({ target: { id, fields }, preventDefault() {} }); }
  return { click, submit, storage, nodes, document, events, cookie: () => cookie, view: () => { const { room, session } = env.app.authenticate({ headers: { cookie } }); return env.app.project(room, session.player); }, markup: () => nodes.get('main').innerHTML, animations: () => animations };
}
test('live-only interface completes a two-person heist with controlled provider responses', async () => {
  const env = environment(), host = await browser(env), guest = await browser(env);
  assert.match(host.markup(), /Good taste/); assert(!host.markup().includes('Try a solo heist'));
  await host.click('character',2); await host.click('create'); await host.submit('crew-form',{ name: 'Roux' });
  const code = host.view().code;
  await guest.click('join'); await guest.submit('crew-form',{ name: 'Friend', code });
  await host.click('begin'); assert.match(guest.markup(), /Your taste/);
  for (const ui of [host, guest]) {
    ui.nodes.get('#search-query').value = 'first'; ui.nodes.get('#search-type').value = 'movie'; await ui.submit('search-form');
    assert.match(ui.markup(), /data-artwork/); const favorites = ui.view().self.resolved;
    await ui.click('taste',favorites[0].id); await ui.click('taste',favorites[1].id); await ui.click('submit-tastes');
  }
  const room = env.app.store.get(code); await env.app.research(code,room.generation);
  assert.match(host.markup(), /Seen it/);
  for (const ui of [host, guest]) {
    for (const entity of ui.view().candidates) await ui.click('familiar','new',{ id: entity.id });
    await ui.click('confirm');
  }
  await host.click('route','shared'); assert.equal(guest.view().phase,'briefing'); await guest.click('route','shared'); await guest.click('share'); await host.click('share');
  const order = host.view().self.clue.symbols, mapping = Object.fromEntries(guest.view().self.clue.pairs);
  host.nodes.get('#vault-code').value = order.map(symbol => mapping[symbol]).join(''); await host.submit('code-form');
  assert.equal(guest.view().stage,0); assert.match(guest.markup(),/code-form/); assert.match(host.markup(),/You cracked it/);
  guest.nodes.get('#vault-code').value=order.map(symbol=>mapping[symbol]).join(''); await guest.submit('code-form');
  await host.click('continue'); assert.equal(guest.view().stage,0); await guest.click('continue');
  const intersection = host.view().self.clue.entities.find(entity => guest.view().self.clue.entities.some(other => other.id === entity.id));
  for(const ui of [host,guest]){await ui.click('pick-discovery',intersection.id); assert.equal(ui.view().stage,1); await ui.click('solve-discovery');}
  await host.click('continue');await guest.click('continue');assert.match(host.markup(), /Find the way out/);
  const pairs = [...host.view().self.clue.pairs,...guest.view().self.clue.pairs], chain = [pairs.find(([a]) => !pairs.some(([,b]) => a===b))[0]];
  while(chain.length<4)chain.push(pairs.find(([a])=>a===chain.at(-1))[1]);
  const current=['record','book','ticket','key'];
  for(let i=0;i<4;i++)if(current[i]!==chain[i]){const j=current.indexOf(chain[i]);for(const ui of [host,guest]){await ui.click('swap',i);await ui.click('swap',j);}[current[i],current[j]]=[current[j],current[i]];}
  await host.click('solve-exit'); assert.equal(guest.view().self.solved,false); await guest.click('solve-exit');
  await host.click('continue');await guest.click('continue'); assert.match(guest.markup(), /You found a connection/); assert.match(guest.markup(), /Live Qloo research/);
  assert(!guest.markup().includes('illustrative'));
  const resumed=await browser(env,{cookie:host.cookie()});
  assert.match(resumed.markup(), /Good taste/); assert(!resumed.markup().includes('You found a connection'));
  assert.match(resumed.nodes.get('#header').innerHTML, /View last dossier/);
  await resumed.click('resume'); assert.match(resumed.markup(), /You found a connection/);
  assert.equal(resumed.view().discovery.id, host.view().discovery.id);
  await resumed.click('home'); await resumed.click('create'); await resumed.submit('crew-form',{name:'Fresh Agent'});
  assert.equal(resumed.view().phase,'lobby'); assert.notEqual(resumed.view().code,code);
  assert.equal(resumed.view().players.length,1); assert.equal(resumed.view().self.favorites.length,0);
  assert.equal(guest.view().phase,'debrief');
  const invited=await browser(env,{cookie:host.cookie(),href:`http://localhost:3100/?join=${resumed.view().code}`});
  assert.match(invited.markup(), /id="crew-form"/);
  assert(invited.markup().includes(`value="${resumed.view().code}"`));
  await invited.submit('crew-form',{name:'Returning Friend',code:resumed.view().code});
  assert.equal(invited.view().code,resumed.view().code);assert.equal(invited.view().phase,'lobby');
  assert.notEqual(invited.view().self.id,host.view().self.id);await env.app.close();
});
test('offline never becomes a fabricated game and reduced motion disables JS spatial animation',async()=>{
  const env=environment(), ui=await browser(env,{offline:true,reducedMotion:true});
  await ui.click('character',1); await ui.click('create'); await ui.submit('crew-form',{name:'Test'});
  assert.match(ui.markup(), /temporarily unavailable/); assert.equal(ui.storage.get('taste-heist:practice:v1'),undefined); assert.equal(ui.animations(),0); await env.app.close();
});
test('player-controlled labels remain escaped in the live interface',async()=>{
  const env=environment(), host=await browser(env), guest=await browser(env);
  await host.click('create'); await host.submit('crew-form',{name:'<script>bad()</script>'});
  await guest.click('join'); await guest.submit('crew-form',{name:'Friend',code:host.view().code});
  assert.match(guest.markup(),/&lt;script&gt;/); assert(!guest.markup().includes('<script>bad()')); await env.app.close();
});

test('every character is named, theme follows system and explicit choices survive reload', async () => {
  const env=environment(), ui=await browser(env,{systemDark:true});
  assert.equal(ui.document.documentElement.dataset.theme,'dark');
  for(const name of ['Roux','Pip','Bram','Byte']) assert.match(ui.markup(),new RegExp('toy-name[^>]*>'+name));
  await ui.click('theme'); assert.equal(ui.document.documentElement.dataset.theme,'light');
  assert.equal(ui.storage.get('heist:theme'),'light');
  const reloaded=await browser(env,{saved:ui.storage,systemDark:true}); assert.equal(reloaded.document.documentElement.dataset.theme,'light'); await env.app.close();
});
test('private updates leave another player’s current card and form drafts untouched', async () => {
  const env=environment(), host=await browser(env), guest=await browser(env);
  await host.click('create');await host.submit('crew-form',{name:'Host'});await guest.click('join');await guest.submit('crew-form',{name:'Friend',code:host.view().code});await host.click('begin');
  for(const ui of [host,guest]){ui.nodes.get('#search-query').value='first';ui.nodes.get('#search-type').value='movie';await ui.submit('search-form');for(const item of ui.view().self.resolved)await ui.click('taste',item.id);await ui.click('submit-tastes');}
  await env.app.research(host.view().code,env.app.store.get(host.view().code).generation);
  await guest.click('card',1);const before=guest.markup();
  await host.click('familiar','new',{id:host.view().candidates[0].id});
  assert.equal(guest.markup(),before); await env.app.close();
});

test('form drafts survive avatar and theme changes, even when browser storage is blocked', async () => {
  const env=environment(), ui=await browser(env,{storageBlocked:true});
  await ui.click('join');
  for(const [id,value] of [['agent-name','Curious Agent'],['crew-code','ABC123']]) {
    for(const fn of ui.events.get('input')||[]) fn({target:{id,value}});
  }
  await ui.click('pick-avatar',3);
  assert.match(ui.markup(), /value="Curious Agent"/);assert.match(ui.markup(), /value="ABC123"/);
  const before=ui.markup();await ui.click('theme');assert.equal(ui.markup(),before);
  assert.equal(ui.document.documentElement.dataset.theme,'dark');await env.app.close();
});

test('unfinished heists resume after a reload without losing the player identity', async () => {
  const env=environment(), host=await browser(env), guest=await browser(env);
  await host.click('create');await host.submit('crew-form',{name:'Host'});
  await guest.click('join');await guest.submit('crew-form',{name:'Friend',code:host.view().code});
  await host.click('begin');
  const resumed=await browser(env,{cookie:guest.cookie()});
  assert.match(resumed.markup(), /Your taste/);assert.equal(resumed.view().self.id,guest.view().self.id);
  assert.equal(resumed.view().code,host.view().code);await env.app.close();
});
