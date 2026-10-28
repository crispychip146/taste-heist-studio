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
import { fakeQloo, id, entity } from './fixtures.mjs';

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
  for (const cookie of cookies) await action(app, cookie, { type: 'solve', answer: id(100) });
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
test('upstream errors preserve a crew; empty evidence offers retaste without invented discoveries', async () => {
  for (const empty of [false, true]) {
    const qloo = fakeQloo({ research: empty ? async players => players.map((p, i) => ({ playerId: p.id, entities: [entity(500 + i)] })) : async () => { throw new ProviderError('QLOO_AUTH', 'Credential rejected.'); } });
    const store = new Store(':memory:'), app = createApp({ store, qloo }); const { code, cookies } = await crew(app);
    for (const cookie of cookies) { await request(app, '/api/search', { query: 'first', type: 'movie' }, cookie); await action(app, cookie, { type: 'favorites', ids: [id(1), id(3)] }); }
    await app.research(code, store.get(code).generation);
    const failed = store.get(code); assert.equal(failed.research.status, empty ? 'empty' : 'error'); assert.equal(failed.candidates.length, 0);
    await action(app, cookies[0], { type: 'retaste' }); assert.equal(store.get(code).phase, 'intake'); assert.equal(store.get(code).players.length, 2); await app.close();
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
