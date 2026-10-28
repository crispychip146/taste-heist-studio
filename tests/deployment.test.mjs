import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { clientAddressResolver } from '../server/client-address.mjs';
import { createApp } from '../server/app.mjs';
import { ProviderError, providerFeedback } from '../server/errors.mjs';
import { Store } from '../server/store.mjs';
import { fakeQloo } from './fixtures.mjs';

function peer(ip, forwarded) { return { socket: { remoteAddress: ip }, headers: { 'x-forwarded-for': forwarded } }; }
async function request(app, path, data, { cookie = '', ip = '10.20.30.40', forwarded } = {}) {
  const req = Readable.from(data ? [JSON.stringify(data)] : []);
  Object.assign(req, { url: path, method: data ? 'POST' : 'GET', ...peer(ip, forwarded) });
  Object.assign(req.headers, { host: 'localhost:3100', cookie, 'content-type': 'application/json' });
  const result = { headers: {} };
  await app.handler(req, { setHeader() {}, writeHead(status, headers) { result.status = status; Object.assign(result.headers, headers); }, end(value) { result.body = JSON.parse(value); } });
  return result;
}
const cookieOf = result => result.headers['set-cookie'].split(';')[0];

test('forwarded addresses are ignored unless the socket peer is explicitly trusted', () => {
  const untrusted = clientAddressResolver('');
  assert.equal(untrusted(peer('203.0.113.8', '198.51.100.1')), '203.0.113.8');
  assert.equal(untrusted(peer('::ffff:203.0.113.8', '198.51.100.1')), '203.0.113.8');
  const trusted = clientAddressResolver('127.0.0.1/32,::1/128,10.0.0.0/8');
  assert.equal(trusted(peer('127.0.0.1', '198.51.100.1, 203.0.113.8, 10.1.2.3')), '203.0.113.8', 'ignore forged values left of the first untrusted hop');
  assert.equal(trusted(peer('::1', '2001:db8::8')), '2001:db8::8');
  assert.equal(trusted(peer('203.0.113.8', '198.51.100.1')), '203.0.113.8');
  for (const header of ['garbage, 203.0.113.8', '', Array(22).fill('203.0.113.8').join(','), ['203.0.113.8']]) assert.equal(trusted(peer('127.0.0.1', header)), '127.0.0.1');
});

test('invalid or globally trusting proxy configurations fail before serving requests', () => {
  for (const value of ['*', 'true', 'localhost', '0.0.0.0/0', '::/0', '127.0.0.1/', '127.0.0.1/33', '::1/129', '127.0.0.1/-1', '127.0.0.1/32/1']) assert.throws(() => clientAddressResolver(value), /TRUSTED_PROXY_CIDRS/);
});

test('players sharing one proxy have independent allowances; rotating a valid session does not reset a player’s allowance', async () => {
  const store = new Store(':memory:'), app = createApp({ store, qloo: fakeQloo() });
  try {
    const host = await request(app, '/api/rooms', { name: 'Host' });
    const guest = await request(app, '/api/join', { name: 'Guest', code: host.body.room.code });
    const cookies = [cookieOf(host), cookieOf(guest)];
    for (let i = 0; i < 100; i++) assert.equal((await request(app, '/api/command', { type: 'chat', text: 'Shared-proxy check', commandId: randomUUID() }, { cookie: cookies[0] })).status, 200);
    const limited = await request(app, '/api/command', { type: 'chat', text: 'Wait', commandId: randomUUID() }, { cookie: cookies[0] });
    assert.equal(limited.status, 429); assert(Number(limited.headers['retry-after']) > 0);
    assert.equal((await request(app, '/api/command', { type: 'chat', text: 'Independent guest', commandId: randomUUID() }, { cookie: cookies[1] })).status, 200);
    const replacement = 'a'.repeat(64); store.putSession(replacement, host.body.room.code, host.body.room.self.id);
    assert.equal((await request(app, '/api/command', { type: 'chat', text: 'Same player', commandId: randomUUID() }, { cookie: `th_session=${replacement}` })).status, 429);
  } finally { await app.close(); }
});

for (const trust of [false, true]) test(`anonymous entry limits ${trust ? 'separate real forwarded clients behind a trusted proxy' : 'cannot be bypassed using spoofed forwarded headers'}`, async () => {
  const app = createApp({ store: new Store(':memory:'), qloo: fakeQloo(), trustedProxyCidrs: trust ? '10.20.30.40/32' : '' });
  try {
    for (let i = 0; i < 13; i++) {
      const result = await request(app, '/api/rooms', { name: 'Anonymous client' }, { forwarded: `203.0.113.${i + 1}` });
      assert.equal(result.status, trust || i < 12 ? 201 : 429);
    }
  } finally { await app.close(); }
});

test('provider failures show player recovery text while only bounded redacted diagnostics reach the operator', async () => {
  const secret = 'test-only-credential-do-not-log';
  const diagnostics = [], store = new Store(':memory:');
  const app = createApp({ store, onDiagnostic: record => diagnostics.push(record), qloo: fakeQloo({ search: async () => { throw new ProviderError('QLOO_SEARCH', `${secret}: npm run doctor`, { retryable: true }); } }) });
  try {
    const host = await request(app, '/api/rooms', { name: 'Host' }), cookie = cookieOf(host);
    await request(app, '/api/join', { name: 'Guest', code: host.body.room.code });
    await request(app, '/api/command', { type: 'begin', commandId: randomUUID() }, { cookie });
    const failure = await request(app, '/api/search', { query: 'A favourite', type: 'movie' }, { cookie });
    assert.equal(failure.status, 503); assert.equal(failure.body.code, 'QLOO_SEARCH');
    assert.match(failure.body.error, /saved.*try again/i);
    assert(!/npm|doctor|credential|test-only/i.test(failure.body.error));
    assert.equal(diagnostics.length, 1); assert.equal(diagnostics[0].code, 'QLOO_SEARCH');
    assert.match(diagnostics[0].diagnosis, /npm run doctor/); assert(!JSON.stringify(diagnostics).includes(secret));
    const room = store.get(host.body.room.code); room.research = { status: 'error', code: 'QLOO_SEARCH', message: `npm run doctor ${secret}` }; room.phase = 'researching';
    assert(!JSON.stringify(app.project(room, room.host)).includes(secret), 'legacy persisted provider messages must also be sanitized');
    for (const code of ['HARNESS_MISSING', 'QLOO_AUTH', 'QLOO_CONTRACT', 'UNRECOGNIZED_UPSTREAM_ERROR']) {
      const feedback = providerFeedback(new ProviderError(code, secret));
      assert(!feedback.message.includes(secret)); assert(!/npm|doctor|credential/i.test(feedback.message));
    }
  } finally { await app.close(); }
});
