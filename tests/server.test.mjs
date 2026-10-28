import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.mjs';
import { Store } from '../server/store.mjs';
import { ProviderError } from '../server/errors.mjs';
import { Artwork } from '../server/artwork.mjs';
import { fakeQloo, id, entity, confirmed, launch, clearRoom } from './fixtures.mjs';

export async function request(app, path, data, cookie, origin) {
  const req = Readable.from(data ? [JSON.stringify(data)] : []); req.url = path; req.method = data ? 'POST' : 'GET';
  req.headers = { host: 'localhost:3100', 'content-type': 'application/json', cookie: cookie || '', ...(origin ? { origin } : {}) }; req.socket = { remoteAddress: 'test' };
  const result = { headers: {} };
  const res = { setHeader(k, v) { result.headers[k.toLowerCase()] = v; }, writeHead(status, headers) { result.status = status; Object.assign(result.headers, headers); }, end(body) { try { result.body = JSON.parse(body); } catch { result.body = body; } } };
  await app.handler(req, res); return result;
}
const cookieOf = result => result.headers['set-cookie'].split(';')[0];
const action = (app, cookie, values) => request(app, '/api/command', { commandId: randomUUID(), ...values }, cookie);
async function crew(app) {
  const host = await request(app, '/api/rooms', { name: 'Roux' }); assert.equal(host.status, 201);
  const guest = await request(app, '/api/join', { name: 'Friend', code: host.body.room.code }); assert.equal(guest.status, 200);
  const cookies = [cookieOf(host), cookieOf(guest)]; await action(app, cookies[0], { type: 'begin' });
  return { code: host.body.room.code, cookies, host, guest };
}
test('HTTP journey with controlled provider: identities, private clues, concurrent familiarity and completion', async () => {
  const store = new Store(':memory:'), app = createApp({ store, qloo: fakeQloo() });
  const { code, cookies } = await crew(app);
  for (const cookie of cookies) {
    const matches = await request(app, '/api/search', { query: 'first', type: 'movie' }, cookie);
    assert.equal(matches.body.matches[0].imageUrl, `/api/artwork/${id(1)}`);
    assert.equal(matches.body.matches[0].imageSource, undefined); assert.equal(matches.body.matches[0].evidence, undefined);
    await action(app, cookie, { type: 'favorites', ids: [id(1), id(3)] });
  }
  await app.research(code, store.get(code).generation);
  let room = store.get(code); assert.equal(room.phase, 'familiarity');
  await Promise.all(cookies.flatMap(cookie => room.candidates.map(candidate => action(app, cookie, { type: 'familiarity', id: candidate.id, value: 'new' }))));
  room = store.get(code); assert(room.players.every(p => Object.values(p.familiarity).every(mark => mark === 'new')));
  await Promise.all(cookies.map(cookie => action(app, cookie, { type: 'confirm' })));
  assert.equal(store.get(code).phase, 'briefing');
  assert.equal((await action(app, cookies[1], { type: 'route', route: 'shared' })).status, 200);
  assert.equal(store.get(code).phase, 'briefing');
  await action(app, cookies[0], { type: 'route', route: 'shared' });
  const views = await Promise.all(cookies.map(cookie => request(app, '/api/session', undefined, cookie)));
  assert(views.every(view => !view.body.room.secrets && view.body.room.players.every(p => !p.favorites && !p.support)));
  const order = views[0].body.room.self.clue.symbols, map = Object.fromEntries(views[1].body.room.self.clue.pairs);
  for (const cookie of cookies) await action(app, cookie, { type: 'solve', answer: order.map(symbol => map[symbol]).join('') });
  for (const cookie of cookies) await action(app, cookie, { type: 'continue' });
  // A cooldown saved by the old guessing flow must never block a valid recommendation proposal.
  for (const player of store.get(code).players) store.wrongGuess(player.id, code, 1, `old-discovery-${player.id}`, 'old-fingerprint', 'Old discovery guess');
  for (const cookie of cookies) assert.equal((await action(app, cookie, { type: 'solve', answer: id(100) })).status, 200);
  for (const cookie of cookies) await action(app, cookie, { type: 'continue' });
  const exits = await Promise.all(cookies.map(cookie => request(app, '/api/session', undefined, cookie)));
  const pairs = exits.flatMap(view => view.body.room.self.clue.pairs), chain = [pairs.find(([a]) => !pairs.some(([, b]) => a === b))[0]];
  while (chain.length < 4) chain.push(pairs.find(([a]) => a === chain.at(-1))[1]);
  for (const cookie of cookies) await action(app, cookie, { type: 'solve', answer: chain });
  for (const cookie of cookies) await action(app, cookie, { type: 'continue' });
  const completed = (await request(app, '/api/session', undefined, cookies[1])).body.room;
  assert.equal(completed.phase, 'debrief'); assert(completed.evidence.every(person => person.returned)); await app.close();
});
test('commands reload after body parsing, are idempotent and reject changed payloads or stale stages', async () => {
  const store = new Store(':memory:'), app = createApp({ store, qloo: fakeQloo() }); const { cookies, code } = await crew(app);
  const command = { type: 'chat', text: 'A shared thought', commandId: randomUUID() };
  const results = await Promise.all([request(app, '/api/command', command, cookies[0]), request(app, '/api/command', command, cookies[0])]);
  assert(results.every(result => result.status === 200)); assert.equal(store.get(code).messages.length, 1);
  assert.equal((await request(app, '/api/command', { ...command, text: 'Changed' }, cookies[0])).status, 400);
  const before = JSON.stringify(store.get(code));
  assert.equal((await action(app, cookies[0], { type: 'favorites', ids: [id(999), id(998)] })).status, 400);
  assert.equal(JSON.stringify(store.get(code)), before);
  assert.equal((await action(app, cookies[0], { type: 'selection', ids: [], expectedPhase: 'playing' })).status, 409);
  assert.equal((await request(app, '/api/command', { type: 'chat', text: 'No ID' }, cookies[0])).status, 400);
  await app.close();
});
test('origin and identity boundaries, unsupported room modes and protected server code', async () => {
  const app = createApp({ store: new Store(':memory:'), qloo: fakeQloo() }); const { cookies } = await crew(app);
  assert.equal((await request(app, '/api/command', { type: 'chat', text: 'Bad origin', commandId: randomUUID() }, cookies[0], 'https://evil.example')).status, 403);
  assert.equal((await action(app, undefined, { type: 'chat', text: 'No cookie' })).status, 400);
  assert.equal((await request(app, '/api/rooms', { name: 'Fake', practice: true })).status, 400);
  assert.equal((await request(app, '/api/rooms', { name: 'Fake', mode: 'sample' })).status, 400);
  assert.equal((await request(app, '/server/game.mjs')).status, 404);
  assert.equal((await request(app, '/shared/game.mjs')).status, 404);
  assert.equal((await request(app, '/.env')).status, 404); await app.close();
});
test('SQLite survives restart, preserves hashed sessions and makes interrupted research recoverable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'heist-test-')), file = join(dir, 'db.sqlite'); let store = new Store(file);
  let app = createApp({ store, qloo: fakeQloo() }); const { cookies, code } = await crew(app);
  const room = store.get(code); room.phase = 'researching'; room.research = { status: 'working' }; store.save(room);
  store.save({ ...structuredClone(room), code: 'OLD12', mode: 'sample', schemaVersion: 1 });
  store.putSession('legacy-test-only-token', 'OLD12', room.host);
  const token = cookies[0].split('=')[1]; assert(!store.db.prepare('SELECT token FROM sessions').all().some(row => row.token === token));
  await app.close(); store = new Store(file); app = createApp({ store, qloo: fakeQloo() });
  const resumed = await request(app, '/api/session', undefined, cookies[0]); assert.equal(resumed.body.room.research.status, 'error');
  assert.equal(store.get('OLD12'), null); assert.equal(store.session('legacy-test-only-token'), null);
  assert.equal(store.db.prepare('SELECT count(*) AS total FROM rooms WHERE code=?').get('OLD12').total, 0);
  assert.equal(resumed.body.room.self.id, room.host); await app.close(); rmSync(dir, { recursive: true });
});
test('upstream errors and disjoint or empty results keep pass-it-on available without inventing Qloo support', async () => {
  for (const kind of ['error', 'empty', 'disjoint']) {
    const qloo = fakeQloo({ research: kind !== 'error' ? async players => players.map((p, i) => ({ playerId: p.id, entities: kind === 'empty' ? [] : [entity(500 + i)] })) : async () => { throw new ProviderError('QLOO_AUTH', 'Credential rejected.'); } });
    const store = new Store(':memory:'), app = createApp({ store, qloo });
    try {
      const { code, cookies } = await crew(app);
      for (const cookie of cookies) { await request(app, '/api/search', { query: 'first', type: 'movie' }, cookie); await action(app, cookie, { type: 'favorites', ids: [id(1), id(3)] }); }
      await app.research(code, store.get(code).generation);
      const room = store.get(code);
      assert.equal(room.research.status, kind === 'error' ? 'error' : 'complete');
      if (kind === 'disjoint') for (const cookie of cookies) {
        for (const candidate of room.candidates) await action(app, cookie, { type: 'familiarity', id: candidate.id, value: 'new' });
        await action(app, cookie, { type: 'confirm' });
      }
      const view = (await request(app, '/api/session', undefined, cookies[0])).body.room;
      assert.equal(view.phase, kind === 'error' ? 'researching' : 'briefing');
      if (kind === 'error') assert.equal((await action(app, cookies[1], { type: 'use-favorites' })).status, 200);
      const ready = (await request(app, '/api/session', undefined, cookies[0])).body.room;
      assert(ready.availableRoutes.find(route => route.route === 'mentor').available);
      assert(!ready.availableRoutes.find(route => route.route === 'shared').available);
      assert.equal((await action(app, cookies[0], { type: 'route', route: 'mentor' })).status, 200);
      await action(app, cookies[0], { type: 'retaste' });
      assert.equal(store.get(code).phase, 'intake');
      assert.equal(store.get(code).players.length, 2);
      assert.equal(store.get(code).players[1].favorites.length, 2);
    } finally { await app.close(); }
  }
});
test('draft selections and resolved metadata survive refresh; configuration is not mistaken for live verification', async () => {
  const store = new Store(':memory:'), app = createApp({ store, qloo: fakeQloo({ status: () => ({ configured: true, harnessReady: false, verifiedAt: null }) }) });
  const { cookies } = await crew(app); await request(app, '/api/search', { query: 'first', type: 'book' }, cookies[0]);
  await action(app, cookies[0], { type: 'selection', ids: [id(1)] });
  const room = (await request(app, '/api/session', undefined, cookies[0])).body.room;
  assert.deepEqual(room.self.draft, [id(1)]); assert.equal(room.self.resolved.length, 2);
  const health = (await request(app, '/api/health')).body; assert.equal(health.research.configured, true); assert.equal(health.research.verifiedAt, null); await app.close();
});
test('artwork HTTP route returns private image bytes only for an authenticated permitted entity', async () => {
  const bytes = Buffer.from([255,216,255,217]);
  const artwork = new Artwork({ fetcher: async () => new Response(bytes, { headers: { 'content-type': 'image/jpeg' } }) });
  const app = createApp({ store: new Store(':memory:'), qloo: fakeQloo(), artwork });
  const { cookies } = await crew(app);
  await request(app, '/api/search', { query: 'first', type: 'movie' }, cookies[0]);
  const image = await request(app, `/api/artwork/${id(1)}`, undefined, cookies[0]);
  assert.equal(image.status, 200); assert.equal(image.headers['content-type'], 'image/jpeg');
  assert.match(image.headers['cache-control'], /^private/); assert.deepEqual(image.body, bytes);
  assert.equal((await request(app, `/api/artwork/${id(1)}`, undefined, cookies[1])).status, 404);
  assert.equal((await request(app, `/api/artwork/${id(1)}`)).status, 400);
  await app.close();
});

test('one canonical discovery and all evidence survive a database restart for every member', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'heist-outcome-')), file = join(dir, 'crew.sqlite');
  let store = new Store(file);
  try {
    const room = launch(confirmed(4));
    clearRoom(room, room.secrets.code); const choice = room.candidates[0].id;
    clearRoom(room, choice); clearRoom(room, room.secrets.exit);
    store.save(room);
    const tokens = room.players.map((player, i) => { const token = String(i + 1).repeat(64); store.putSession(token, room.code, player.id); return token; });
    store.close(); store = new Store(file);
    const app = createApp({ store, qloo: fakeQloo() });
    try {
      const views = await Promise.all(tokens.map(token => request(app, '/api/session', undefined, `th_session=${token}`)));
      assert(views.every(result => result.body.room.phase === 'debrief' && result.body.room.discovery.id === choice));
      assert(views.every(result => JSON.stringify(result.body.room.evidence) === JSON.stringify(views[0].body.room.evidence)));
    } finally { await app.close(); }
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('old divergent or exchange outcomes return to shared agreement while preserving profiles and sessions', () => {
  for (const phase of ['playing', 'debrief']) {
    const dir = mkdtempSync(join(tmpdir(), 'heist-upgrade-')), file = join(dir, 'crew.sqlite');
    let store = new Store(file);
    try {
      const room = launch(confirmed()); clearRoom(room, room.secrets.code);
      const favorites = structuredClone(room.players.map(player => player.favorites));
      room.phase = phase; room.stage = 2; room.discovery = null;
      room.players.forEach((player, i) => { player.discoveryId = room.candidates[i].id; player.solvedStage = 2; player.readyStage = 2; });
      room.exchangeVersion = 1; delete room.outcomeVersion;
      store.save(room); store.putSession('legacy-session', room.code, room.host);
      store.close(); store = new Store(file);
      const recovered = store.get(room.code);
      assert(['briefing', 'familiarity'].includes(recovered.phase));
      assert.equal(recovered.discovery, null);
      assert.equal(recovered.outcomeVersion, 1);
      assert.equal(recovered.exchangeVersion, undefined);
      assert.deepEqual(recovered.players.map(player => player.favorites), favorites);
      assert.equal(store.session('legacy-session').player, room.host);
      assert(recovered.players.every(player => !player.discoveryId && player.readyStage === null));
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  }
});

test('fallback artwork, one-tap idempotence and canonical result survive an actual SQLite/app restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'heist-handoff-')), file = join(dir, 'crew.sqlite');
  const qloo = () => fakeQloo({ research: async players => players.map(player => ({ playerId: player.id, entities: [] })) });
  const artwork = () => new Artwork({ fetcher: async () => new Response(Buffer.from([255, 216, 255, 217]), { headers: { 'content-type': 'image/jpeg' } }) });
  let app = createApp({ store: new Store(file), qloo: qloo(), artwork: artwork() });
  try {
    const { cookies, code } = await crew(app);
    for (const [i, cookie] of cookies.entries()) {
      const matches = await request(app, '/api/search', { query: i ? 'second' : 'first', type: 'movie' }, cookie);
      await action(app, cookie, { type: 'favorites', ids: matches.body.matches.map(item => item.id) });
    }
    await app.research(code, app.store.get(code).generation);
    assert.equal((await request(app, `/api/artwork/${id(1)}`, undefined, cookies[1])).status, 404, 'a friend’s private favourites are not available before route consent');
    for (const cookie of cookies) await action(app, cookie, { type: 'route', route: 'mentor' });
    assert.equal((await request(app, `/api/artwork/${id(1)}`, undefined, cookies[1])).status, 200, 'fallback cards have usable authenticated artwork');
    const secret = app.store.get(code).secrets;
    for (const cookie of cookies) await action(app, cookie, { type: 'solve', answer: secret.code });
    for (const cookie of cookies) await action(app, cookie, { type: 'continue' });
    const proposal = { type: 'choose-discovery', answer: id(1), commandId: randomUUID(), expectedPhase: 'playing', expectedStage: 1 };
    assert.equal((await request(app, '/api/command', proposal, cookies[0])).status, 200);
    await action(app, cookies[1], { type: 'choose-discovery', answer: id(2) });
    assert.equal(app.store.get(code).stage, 1);
    await app.close(); app = createApp({ store: new Store(file), qloo: qloo(), artwork: artwork() });
    const restored = (await request(app, '/api/session', undefined, cookies[1])).body.room;
    assert(restored.discoveryConflict); assert.equal(restored.self.readyForNext, true);
    await action(app, cookies[1], { type: 'choose-discovery', answer: id(1), expectedStage: 1 });
    assert.equal(app.store.get(code).stage, 2);
    assert.equal((await request(app, '/api/command', proposal, cookies[0])).status, 200, 'a retried stage-one request replays without touching stage two');
    assert.equal(app.store.get(code).stage, 2);
    assert.equal((await action(app, cookies[1], { type: 'choose-discovery', answer: id(2), expectedStage: 1 })).status, 409);
    for (const cookie of cookies) await action(app, cookie, { type: 'solve', answer: secret.exit });
    for (const cookie of cookies) await action(app, cookie, { type: 'continue' });
    await app.close(); app = createApp({ store: new Store(file), qloo: qloo(), artwork: artwork() });
    const views = await Promise.all(cookies.map(cookie => request(app, '/api/session', undefined, cookie)));
    assert(views.every(result => result.body.room.phase === 'debrief' && result.body.room.discovery.id === id(1)));
    assert.deepEqual(views[0].body.room.evidence, views[1].body.room.evidence);
    assert(views[0].body.room.evidence.every(person => !person.returned && !person.receipts.length));
    assert.equal(views[0].body.room.discoveryConnection.basis, 'crew-favourite');
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
