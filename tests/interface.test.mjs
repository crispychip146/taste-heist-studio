// Real browser modules + actual HTTP handlers in a DOM harness. This is not a browser paint test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { SourceTextModule, createContext, Script } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { Readable } from 'node:stream';
import { createApp } from '../server/app.mjs';
import { Store } from '../server/store.mjs';
import { startPuzzle, clueFor } from '../server/game.mjs';
import { permutations, exitMatches } from './fixtures.mjs';
import { fakeQloo, entity } from './fixtures.mjs';
import { ProviderError } from '../server/errors.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

function environment(qloo = fakeQloo(), store = new Store(':memory:')) {
  const listeners = new Set(); let app;
  app = createApp({ store, qloo, broadcast: room => { for (const listener of listeners) listener(room); } });
  return { app, listeners };
}
async function browser(env, { reducedMotion = false, cookie = '', offline = false, saved = [], systemDark = false, storageBlocked = false, controlledClock = false, href = 'http://localhost:3100/' } = {}) {
  const root = resolve(import.meta.dirname, '..'), events = new Map(), storage = new Map(saved), nodes = new Map(); let animations = 0;
  const classList = { add() {}, remove() {}, toggle() {} };
  const document = { activeElement: null, hidden: false, documentElement: { dataset: {}, classList }, querySelectorAll: () => [],
    querySelector: selector => nodes.get(selector) || null, getElementById: id => nodes.get(`#${id}`) || null,
    addEventListener: (name, fn) => { if (!events.has(name)) events.set(name, []); events.get(name).push(fn); }, createElement: () => ({ click() {} }),
  };
  for (const id of ['main','#header','#footer','#announcer','#toast','#vault-code','#chat-input','#search-query','#search-type','#puzzle-error','#search-error','#action-error','#discovery-title','#timer']) nodes.set(id, { innerHTML: '', textContent: '', value: '', dataset: {}, classList, hidden: false, focus() { document.activeElement = this; }, animate() { animations++; } });
  nodes.set('meta[name="theme-color"]', { attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } });
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
  let clientNow = Date.now(), clockTick;
  const ClientDate = class extends Date { static now() { return clientNow; } };
  const context = createContext({ Date: controlledClock ? ClientDate : Date, console, document, window: { scrollTo() {} }, location: new URL(href), navigator: {}, URL, URLSearchParams, AbortSignal, crypto: webcrypto, structuredClone, Blob, WebSocket,
    FormData: class { constructor(form) { this.fields = form.fields; } get(name) { return this.fields[name]; } },
    localStorage: { getItem: key => { if(storageBlocked)throw new Error('Blocked storage');return storage.get(key) || null; }, setItem: (key, value) => { if(storageBlocked)throw new Error('Blocked storage');storage.set(key, value); }, removeItem: key => { if(storageBlocked)throw new Error('Blocked storage');storage.delete(key); } },
    fetch: fetcher, matchMedia: query => ({ matches: query.includes('color-scheme') ? systemDark : reducedMotion }), setInterval: (fn, delay) => { if (delay === 1000) clockTick = fn; return 0; }, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
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
  return { advance: milliseconds => { clientNow += milliseconds; clockTick?.(); }, click, submit, storage, nodes, document, events, cookie: () => cookie, view: () => { const { room, session } = env.app.authenticate({ headers: { cookie } }); return env.app.project(room, session.player); }, markup: () => nodes.get('main').innerHTML, animations: () => animations };
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
  assert.equal(ui.nodes.get('meta[name="theme-color"]').attributes.content,'#000000');
  for(const name of ['Roux','Pip','Bram','Byte']) assert.match(ui.markup(),new RegExp('toy-name[^>]*>'+name));
  await ui.click('theme'); assert.equal(ui.document.documentElement.dataset.theme,'light');
  assert.equal(ui.nodes.get('meta[name="theme-color"]').attributes.content,'#fff6ce');
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

test('unfinished heists open at home and require explicit resume without losing player identity', async () => {
  const env=environment(), host=await browser(env), guest=await browser(env);
  await host.click('create');await host.submit('crew-form',{name:'Host'});
  await guest.click('join');await guest.submit('crew-form',{name:'Friend',code:host.view().code});
  await host.click('begin');
  const resumed=await browser(env,{cookie:guest.cookie()});
  assert.match(resumed.markup(), /Good taste/);assert.match(resumed.nodes.get('#header').innerHTML,/Resume saved heist/);
  await resumed.click('resume');assert.match(resumed.markup(), /Your taste/);assert.equal(resumed.view().self.id,guest.view().self.id);
  assert.equal(resumed.view().code,host.view().code);await env.app.close();
});

test('invalid puzzle answers remain visible, keep the entered code, and clear on correction',async()=>{
  const env=environment(),host=await browser(env),guest=await browser(env);
  await host.click('create');await host.submit('crew-form',{name:'Host'});await guest.click('join');await guest.submit('crew-form',{name:'Guest',code:host.view().code});
  const room=env.app.store.mutate(host.view().code,room=>{startPuzzle(room);room.version++;});for(const listener of env.listeners)listener(room);
  for(const fn of host.events.get('input')||[])fn({target:{id:'vault-code',value:'0000'}});
  host.nodes.get('#vault-code').value='0000';await host.submit('code-form');
  assert.match(host.nodes.get('#puzzle-error').textContent,/still closed/);assert.equal(host.nodes.get('#puzzle-error').hidden,false);
  assert.equal(host.nodes.get('#vault-code').value,'0000');
  guest.nodes.get('#chat-input').value='Compare the symbols';await guest.submit('chat-form');
  assert.match(host.markup(),/still closed/);assert.match(host.markup(),/value="0000"/);
  for(const fn of host.events.get('input')||[])fn({target:{id:'vault-code',value:room.secrets.code}});
  assert.equal(host.nodes.get('#puzzle-error').hidden,true);await env.app.close();
});

test('four individual interfaces complete the revised rules and announce familiarity progress',async()=>{
  const env=environment(),players=await Promise.all([browser(env),browser(env),browser(env),browser(env)]);
  const [host]=players;await host.click('create');await host.submit('crew-form',{name:'Host'});
  for(const [i,ui]of players.slice(1).entries()){await ui.click('join');await ui.submit('crew-form',{name:'Guest '+i,code:host.view().code});}
  await host.click('begin');assert.match(host.markup(),/Your crew sees your name and favourites/);
  for(const ui of players){ui.nodes.get('#search-query').value='first';ui.nodes.get('#search-type').value='movie';await ui.submit('search-form');for(const entity of ui.view().self.resolved)await ui.click('taste',entity.id);await ui.click('submit-tastes');}
  await env.app.research(host.view().code,env.app.store.get(host.view().code).generation);
  const updated=env.app.store.mutate(host.view().code,room=>{room.candidates[0].imageAttribution='Provider & artist';room.version++;});for(const listener of env.listeners)listener(updated);
  assert.match(host.markup(),/Artwork: Provider &amp; artist/);
  for(const ui of players){for(const entity of ui.view().candidates)await ui.click('familiar','new',{id:entity.id});assert.match(ui.nodes.get('#announcer').textContent,/Discovery .* of/);assert.equal(ui.document.activeElement,ui.nodes.get('#discovery-title'));await ui.click('confirm');}
  for(const ui of players)await ui.click('route','shared');
  const order=host.view().self.clue.symbols,mapping=Object.fromEntries(players.slice(1).flatMap(ui=>ui.view().self.clue.pairs));
  assert.equal(order.length,4);for(const ui of players){ui.nodes.get('#vault-code').value=order.map(symbol=>mapping[symbol]).join('');await ui.submit('code-form');}
  for(const ui of players)await ui.click('continue');
  const match=players[0].view().self.clue.entities.find(entity=>players.every(ui=>ui.view().self.clue.entities.some(item=>item.id===entity.id)));
  for(const ui of players){await ui.click('pick-discovery',match.id);await ui.click('solve-discovery');}for(const ui of players)await ui.click('continue');
  assert(players.every(ui=>ui.markup().includes('before · a gap is allowed')||ui.markup().includes('beside · either order')));
  const clues=players.map(ui=>ui.view().self.clue),chain=permutations(['record','book','ticket','key']).find(order=>exitMatches(order,clues));
  const current=['record','book','ticket','key'];for(let i=0;i<4;i++)if(current[i]!==chain[i]){const j=current.indexOf(chain[i]);for(const ui of players){await ui.click('swap',i);await ui.click('swap',j);}[current[i],current[j]]=[current[j],current[i]];}
  for(const ui of players)await ui.click('solve-exit');for(const ui of players)await ui.click('continue');
  assert(players.every(ui=>ui.view().phase==='debrief'));await env.app.close();
});

for (const route of ['shared', 'mentor']) test(`${route} interface resolves conflicting proposals into one result on both clients and restored dossiers`, async () => {
  const env = environment();
  try {
    const host = await browser(env), guest = await browser(env);
    await host.click('create'); await host.submit('crew-form', { name: 'Host' });
    await guest.click('join'); await guest.submit('crew-form', { name: 'Guest', code: host.view().code });
    await host.click('begin');
    for (const ui of [host, guest]) {
      ui.nodes.get('#search-query').value = 'first'; ui.nodes.get('#search-type').value = 'movie'; await ui.submit('search-form');
      for (const item of ui.view().self.resolved) await ui.click('taste', item.id);
      await ui.click('submit-tastes');
    }
    const code = host.view().code;
    await env.app.research(code, env.app.store.get(code).generation);
    for (const ui of [host, guest]) {
      for (const item of ui.view().candidates) await ui.click('familiar', ui === guest && item.id === entity(102, 'artist').id ? 'skip' : route === 'mentor' && ui === host ? 'known' : 'new', { id: item.id });
      await ui.click('confirm');
    }
    await host.click('route', route); await guest.click('route', route);
    const room = env.app.store.get(code);
    for (const ui of [host, guest]) { ui.nodes.get('#vault-code').value = room.secrets.code; await ui.submit('code-form'); }
    for (const ui of [host, guest]) await ui.click('continue');
    for (const ui of [host, guest]) {
      assert.equal(ui.view().candidates.length, 2, 'only the two qualifying cards should be available');
      assert.match(ui.markup(), /Fits all 2 tastes/);
      assert.match(ui.markup(), route === 'shared' ? /New to everyone/ : /Known to 1 · New to 1/);
      assert.match(ui.markup(), /How to choose/);
      assert(!ui.markup().includes(entity(102, 'artist').name), 'a skipped common item must not appear in cards or personal connections');
      assert(!ui.markup().includes(entity(200).name), 'a recommendation for only one profile must not appear');
      assert(!ui.markup().includes(entity(201).name));
      assert(!ui.markup().includes('Compare everybody’s list'));
    }
    const [pick, other] = host.view().candidates;
    await host.click('pick-discovery', pick.id); await host.click('solve-discovery');
    await guest.click('pick-discovery', other.id); await guest.click('solve-discovery');
    for (const ui of [host, guest]) await ui.click('continue');
    assert.equal(host.view().stage, 1); assert.equal(guest.view().stage, 1);
    assert.match(host.markup(), /Different discoveries on the table/);
    assert.match(guest.markup(), /Change my proposal/);
    await guest.click('reconsider'); await guest.click('pick-discovery', pick.id); await guest.click('solve-discovery');
    assert.equal(host.view().stage, 1, 'changing a proposal does not advance anyone automatically');
    await guest.click('continue');
    assert.equal(host.view().stage, 2);
    const clues = [host.view().self.clue, guest.view().self.clue];
    const chain = permutations(['record', 'book', 'ticket', 'key']).find(order => exitMatches(order, clues));
    for (const ui of [host, guest]) {
      const current = ['record', 'book', 'ticket', 'key'];
      for (let i = 0; i < 4; i++) if (current[i] !== chain[i]) {
        const j = current.indexOf(chain[i]); await ui.click('swap', i); await ui.click('swap', j); [current[i], current[j]] = [current[j], current[i]];
      }
      await ui.click('solve-exit');
    }
    for (const ui of [host, guest]) await ui.click('continue');
    assert.equal(host.view().phase, 'debrief');
    assert.equal(host.view().discovery.id, pick.id); assert.equal(guest.view().discovery.id, pick.id);
    assert.deepEqual(host.view().evidence, guest.view().evidence);
    assert.match(host.markup(), /YOUR CREW’S DISCOVERY/);
    if (route === 'mentor') assert.match(guest.markup(), /Known to some. New to others/);
    const restored = await browser(env, { cookie: guest.cookie() });
    assert.match(restored.markup(), /Good taste/); await restored.click('resume');
    assert.equal(restored.view().discovery.id, pick.id);
    assert.match(restored.markup(), /YOUR CREW’S DISCOVERY/);
  } finally { await env.app.close(); }
});

test('provider failures and skipped recommendations retain recovery actions without substituting an unrelated result', async () => {
  for (const failed of [false, true]) {
    const env = environment(failed ? fakeQloo({ research: async () => { throw new ProviderError('QLOO_TIMEOUT', 'Research timed out. Your crew is saved.', { retryable: true }); } }) : fakeQloo());
    try {
      const host = await browser(env), guest = await browser(env);
      await host.click('create'); await host.submit('crew-form', { name: 'Host' });
      await guest.click('join'); await guest.submit('crew-form', { name: 'Guest', code: host.view().code });
      await host.click('begin');
      for (const ui of [host, guest]) {
        ui.nodes.get('#search-query').value = 'first'; ui.nodes.get('#search-type').value = 'movie'; await ui.submit('search-form');
        for (const item of ui.view().self.resolved) await ui.click('taste', item.id);
        await ui.click('submit-tastes');
      }
      await env.app.research(host.view().code, env.app.store.get(host.view().code).generation);
      if (!failed) for (const ui of [host, guest]) {
        for (const item of ui.view().candidates) await ui.click('familiar', 'skip', { id: item.id });
        await ui.click('confirm');
      }
      assert.match(host.markup(), failed ? /Check research again/ : /Find more discoveries/);
      assert.match(host.markup(), /Change my favourites/);
      assert(!host.view().availableRoutes.some(route => route.available));
      await host.click('retaste'); assert.equal(host.view().phase, 'intake');
      assert.equal(guest.view().self.favorites.length, 2);
    } finally { await env.app.close(); }
  }
});

test('wider search keeps reviews and favourites in the actual interface and returns an actionable route', async () => {
  const calls = [];
  const base = fakeQloo();
  const env = environment(fakeQloo({ research: async (players, progress, scope) => {
    calls.push(scope);
    const results = await base.research(players, progress);
    if (scope.expanded) for (const result of results) result.entities.push(entity(987));
    return results;
  } }));
  try {
    const host = await browser(env), guest = await browser(env);
    await host.click('create'); await host.submit('crew-form', { name: 'Host' });
    await guest.click('join'); await guest.submit('crew-form', { name: 'Guest', code: host.view().code });
    await host.click('begin');
    for (const ui of [host, guest]) {
      ui.nodes.get('#search-query').value = 'first'; ui.nodes.get('#search-type').value = 'movie'; await ui.submit('search-form');
      for (const item of ui.view().self.resolved) await ui.click('taste', item.id);
      await ui.click('submit-tastes');
    }
    const code = host.view().code;
    await env.app.research(code, env.app.store.get(code).generation);
    for (const ui of [host, guest]) { for (const item of ui.view().candidates) await ui.click('familiar', 'known', { id: item.id }); await ui.click('confirm'); }
    const previous = host.view(), favorites = previous.self.favorites;
    assert.match(host.markup(), /Find more discoveries/);
    await host.click('refine'); await env.app.research(code, env.app.store.get(code).generation);
    assert(calls.at(-1).expanded);
    assert.deepEqual(host.view().self.favorites, favorites);
    for (const item of previous.candidates) assert.equal(host.view().self.familiarity[item.id], 'known');
    for (const ui of [host, guest]) { await ui.click('familiar', 'new', { id: entity(987).id }); await ui.click('confirm'); }
    assert.equal(host.view().phase, 'briefing');
    assert(host.view().availableRoutes.find(route => route.route === 'shared').available);
    assert(!host.view().availableRoutes.find(route => route.route === 'mentor').available);
  } finally { await env.app.close(); }
});

test('a real SQLite/app restart opens at home; updates cannot pull a returning user into the saved heist', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'heist-home-')), file = resolve(dir, 'crew.sqlite');
  const env = environment(fakeQloo(), new Store(file));
  try {
    const host = await browser(env), guest = await browser(env);
    await host.click('create'); await host.submit('crew-form', { name: 'Host' });
    await guest.click('join'); await guest.submit('crew-form', { name: 'Guest', code: host.view().code });
    const code = host.view().code, identity = guest.view().self.id;
    await env.app.close();
    env.app = createApp({ store: new Store(file), qloo: fakeQloo(), broadcast: room => { for (const listener of env.listeners) listener(room); } });
    const returning = await browser(env, { cookie: guest.cookie() });
    assert.match(returning.markup(), /Good taste/);
    assert.match(returning.nodes.get('#header').innerHTML, /Resume saved heist/);
    assert.equal(returning.view().self.id, identity);
    await host.click('begin');
    assert.equal(returning.view().phase, 'intake');
    assert.match(returning.markup(), /Good taste/, 'a saved-room WebSocket update must not open a heist automatically');
    await returning.click('resume'); assert.match(returning.markup(), /Your taste/);
    await returning.click('home');
    await returning.click('create'); await returning.submit('crew-form', { name: 'Fresh start' });
    assert.notEqual(returning.view().code, code);
    assert.equal(returning.view().phase, 'lobby');
    assert.equal(returning.view().self.favorites.length, 0);
    assert.equal(env.app.store.get(code).players.length, 2, 'starting fresh must not delete the other crew');
  } finally { await env.app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('explicitly joining a saved crew opens it even when the room version has not changed', async () => {
  const env = environment();
  try {
    const host = await browser(env);
    await host.click('create'); await host.submit('crew-form', { name: 'Host' });
    const code = host.view().code;
    const returning = await browser(env, { cookie: host.cookie() });
    assert.match(returning.markup(), /Good taste/);
    await returning.click('join'); await returning.submit('crew-form', { name: 'Host', code });
    assert.match(returning.markup(), /good accomplices/);
    assert.equal(returning.view().self.id, host.view().self.id);
    assert.equal(returning.view().players.length, 1);
  } finally { await env.app.close(); }
});

test('local redraws preserve the running timer and paused redraws stay frozen', async () => {
  const env = environment();
  try {
    const host = await browser(env, { controlledClock: true });
    await host.click('create'); await host.submit('crew-form', { name: 'Clock host' });
    const guest = await browser(env); await guest.click('join'); await guest.submit('crew-form', { name: 'Guest', code: host.view().code });
    const room = env.app.store.mutate(host.view().code, room => { startPuzzle(room); room.stage = 2; room.version++; });
    for (const listener of env.listeners) listener(room);
    host.advance(12000); const before = host.nodes.get('#timer').textContent;
    await host.click('swap', 0);
    assert.equal(host.markup().match(/id="timer"[^>]*>([^<]+)/)[1], before);
    await host.click('motion');
    assert.equal(host.markup().match(/id="timer"[^>]*>([^<]+)/)[1], before);
    await host.click('pause'); const paused = host.markup().match(/id="timer"[^>]*>([^<]+)/)[1];
    host.advance(20000); await host.click('motion');
    assert.equal(host.nodes.get('#timer').textContent, paused);
    assert.equal(host.markup().match(/id="timer"[^>]*>([^<]+)/)[1], paused);
    await host.click('pause'); host.advance(3000); await host.click('swap', 1);
    assert.match(host.markup(), /id="timer"[^>]*>00:03</);
  } finally { await env.app.close(); }
});

test('a failed search keeps the query and selected favourites and offers a successful retry', async () => {
  let rejectSearch = false;
  const base = fakeQloo(), env = environment(fakeQloo({ search: async (...args) => { if (rejectSearch) throw new ProviderError('QLOO_SEARCH', 'npm run doctor'); return base.search(...args); } }));
  try {
    const host = await browser(env), guest = await browser(env);
    await host.click('create'); await host.submit('crew-form', { name: 'Host' });
    await guest.click('join'); await guest.submit('crew-form', { name: 'Guest', code: host.view().code }); await host.click('begin');
    host.nodes.get('#search-query').value = 'first'; host.nodes.get('#search-type').value = 'movie'; await host.submit('search-form');
    const favorite = host.view().self.resolved[0]; await host.click('taste', favorite.id);
    rejectSearch = true; host.nodes.get('#search-query').value = 'second'; await host.submit('search-form'); await host.click('filter', 'all');
    assert.match(host.markup(), /Try search again/); assert.match(host.markup(), /value="second"/);
    assert(!host.markup().includes('npm run doctor'));
    assert(host.view().self.draft.includes(favorite.id));
    rejectSearch = false; await host.submit('search-form');
    assert(host.view().self.draft.includes(favorite.id));
    assert(!host.markup().includes('Research is unavailable'));
    assert(!host.markup().includes('Try search again'));
  } finally { await env.app.close(); }
});

test('pre-paint theme selection and browser chrome agree for saved, system and blocked-storage preferences', async () => {
  const script = new Script(await readFile(new URL('../public/theme-init.js', import.meta.url), 'utf8'));
  for (const [saved, systemDark, blocked, expectedTheme, expectedColor] of [
    ['dark', false, false, 'dark', '#000000'],
    ['light', true, false, 'light', '#fff6ce'],
    [null, true, false, 'dark', '#000000'],
    ['invalid', false, false, 'light', '#fff6ce'],
    ['light', true, true, 'dark', '#000000'],
  ]) {
    let color;
    const document = { documentElement: { dataset: {} }, querySelector: () => ({ setAttribute(name, value) { if (name === 'content') color = value; } }) };
    script.runInNewContext({ document, localStorage: { getItem() { if (blocked) throw new Error('Storage blocked'); return saved; } }, matchMedia: () => ({ matches: systemDark }) });
    assert.equal(document.documentElement.dataset.theme, expectedTheme);
    assert.equal(color, expectedColor);
  }
});
