// Explicit bounded credentialed check; no keys, player data or raw response payloads in output/report.
import { lookup } from 'node:dns/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { Qloo } from '../server/qloo.mjs';
import { Artwork, imagePathFor } from '../server/artwork.mjs';
import { ProviderError } from '../server/errors.mjs';
import { createApp } from '../server/app.mjs';
import { Store } from '../server/store.mjs';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';

const report = { checkedAt: new Date().toISOString(), host: 'https://hackathon.api.qloo.com', source: 'official-qloo-harness', status: 'running', checks: [], browserVerified: false };
const qloo = new Qloo(); let app;
const pass = (name, detail) => { report.checks.push({ name, status: 'passed', ...(detail ? { detail } : {}) }); console.log(`${name}: passed`); };
async function api(path, data, cookie) {
  const request = Readable.from(data ? [JSON.stringify(data)] : []); request.url = path; request.method = data ? 'POST' : 'GET';
  request.headers = { host: 'localhost:3100', 'content-type': 'application/json', cookie: cookie || '' }; request.socket = { remoteAddress: 'live-check' };
  let result; const headers = {};
  const response = { setHeader(key, value) { headers[key.toLowerCase()] = value; }, writeHead(status, values) { this.status = status; Object.assign(headers, values); }, end(body) { result = { status: this.status, body: JSON.parse(body), cookie: headers['set-cookie']?.split(';')[0] }; } };
  await app.handler(request, response);
  if (result.status >= 400) throw new ProviderError(result.body.code || 'HTTP_CHECK', result.body.error); return result;
}
try {
  if (!process.env.QLOO_API_KEY) throw new ProviderError('QLOO_CONFIG', 'The server credential is missing.');
  try { await lookup('hackathon.api.qloo.com'); } catch { throw new ProviderError('NETWORK_DNS', 'The environment cannot resolve the hackathon API host. No live request was made.'); }
  const require = createRequire(import.meta.url);
  try { require.resolve('@modelcontextprotocol/sdk/client/index.js'); } catch { throw new ProviderError('HARNESS_MISSING', 'Run npm install to install the official harness and SDK.'); }
  await qloo.harness.connect(); pass('Official harness capabilities');
  // Public cultural signals for a reproducible check, not a runtime starter catalogue.
  const configured = process.env.QLOO_VERIFY_SIGNALS ? JSON.parse(process.env.QLOO_VERIFY_SIGNALS) : [
    [{ query: 'Spirited Away', type: 'movie' }, { query: 'Nujabes', type: 'artist' }],
    [{ query: 'My Neighbor Totoro', type: 'movie' }, { query: 'Khruangbin', type: 'artist' }],
  ];
  if (!Array.isArray(configured) || configured.length !== 2 || configured.some(profile => !Array.isArray(profile) || profile.length !== 2)) throw new ProviderError('CHECK_INPUT', 'QLOO_VERIFY_SIGNALS must contain two profiles, each with two query/type objects.');
  const profiles = [];
  for (let i = 0; i < configured.length; i++) {
    const favorites = [];
    for (const signal of configured[i]) {
      const matches = await qloo.search(signal.query, signal.type);
      const match = matches.find(entity => entity.name.toLowerCase() === signal.query.toLowerCase());
      if (!match) throw new ProviderError('CHECK_AMBIGUOUS', 'A live-check signal did not resolve exactly. Set QLOO_VERIFY_SIGNALS to confirmed public titles.');
      favorites.push(match);
    }
    profiles.push({ id: `check-${i}`, favorites });
  }
  pass('Four exact live entity resolutions');
  const research = await qloo.research(profiles);
  if (!research.every(result => result.entities.length)) throw new ProviderError('CHECK_EMPTY', 'A profile returned no usable recommendations.');
  const common = research[0].entities.filter(entity => research.every(result => result.entities.some(item => item.id === entity.id)));
  if (!common.length) throw new ProviderError('CHECK_NO_OVERLAP', 'These public check profiles produced no shared discovery. Change QLOO_VERIFY_SIGNALS before accepting the integration.');
  pass('Independent per-profile recommendations and genuine overlap', { sharedCount: common.length });
  const pictured = [...profiles.flatMap(p => p.favorites), ...research.flatMap(r => r.entities)].find(entity => imagePathFor(entity));
  if (!pictured) throw new ProviderError('CHECK_NO_ART', 'No supported artwork URL was returned. Verify the live image metadata before accepting the card integration.');
  await new Artwork().get(pictured.imageSource); pass('Live artwork retrieval and image validation');
  // Exercise the actual room HTTP handlers with live-resolved data; transport stays in memory.
  app = createApp({ qloo, store: new Store(':memory:') });
  const host = await api('/api/rooms', { name: 'Check A' }), guest = await api('/api/join', { name: 'Check B', code: host.body.room.code });
  const cookies = [host.cookie, guest.cookie];
  const move = (cookie, action) => api('/api/command', { ...action, commandId: randomUUID() }, cookie);
  await move(host.cookie, { type: 'begin' });
  for (let i = 0; i < profiles.length; i++) {
    for (const signal of configured[i]) await api('/api/search', signal, cookies[i]);
    await move(cookies[i], { type: 'favorites', ids: profiles[i].favorites.map(entity => entity.id) });
  }
  const roomCode = host.body.room.code; let room = app.store.get(roomCode);
  await app.research(roomCode, room.generation); room = app.store.get(roomCode);
  if (room.phase !== 'familiarity') throw new ProviderError('CHECK_ROOM', 'Live research did not produce a playable room.');
  // Explicit automation marks are test inputs, never represented as human familiarity evidence.
  for (let i = 0; i < cookies.length; i++) {
    for (const entity of room.candidates) await move(cookies[i], { type: 'familiarity', id: entity.id, value: 'new' });
    await move(cookies[i], { type: 'confirm' });
  }
  for (const cookie of cookies) await move(cookie, { type: 'route', route: 'shared' });
  const views = await Promise.all(cookies.map(cookie => api('/api/session', null, cookie)));
  if (views.some(view => view.body.room.secrets || view.body.room.players.some(player => player.support || player.favorites))) throw new ProviderError('CHECK_PRIVACY', 'A public room projection exposed private research.');
  const order = views[0].body.room.self.clue.symbols, mapping = Object.fromEntries(views[1].body.room.self.clue.pairs);
  const clear = async answer => {
    for (const cookie of cookies) await move(cookie, { type: 'solve', answer });
    for (const cookie of cookies) await move(cookie, { type: 'continue' });
  };
  await clear(order.map(symbol => mapping[symbol]).join(''));
  const match = room.candidates.find(entity => common.some(item => item.id === entity.id));
  await clear(match.id);
  const exits = await Promise.all(cookies.map(cookie => api('/api/session', null, cookie)));
  const pairs = exits.flatMap(view => view.body.room.self.clue.pairs), chain = [pairs.find(([a]) => !pairs.some(([, b]) => a === b))[0]];
  while (chain.length < 4) chain.push(pairs.find(([a]) => a === chain.at(-1))[1]);
  await clear(chain);
  if ((await api('/api/session', null, guest.cookie)).body.room.phase !== 'debrief') throw new ProviderError('CHECK_COMPLETION', 'The guest did not receive the completed heist.');
  pass('Two independent sessions, private clues, all three rooms and restored debrief');
  report.status = 'passed'; console.log('Live provider and in-memory server journey passed. Browser/WebSocket network verification is still separate.');
} catch (error) {
  report.status = 'blocked'; report.error = { code: error instanceof ProviderError ? error.code : 'CHECK_ERROR', message: error instanceof ProviderError ? error.message : 'The check stopped unexpectedly. No raw error or credential was logged.' };
  console.error(`${report.error.code}: ${report.error.message}`); process.exitCode = 1;
} finally {
  if (app) await app.close(); else await qloo.close();
  await mkdir('data', { recursive: true }); await writeFile('data/live-verification.json', JSON.stringify(report, null, 2), { mode: 0o600 });
}
