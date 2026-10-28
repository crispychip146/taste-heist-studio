import { randomBytes, randomInt, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { createRoom, addPlayer, command, project, installResearch, GameError, publicEntity } from './game.mjs';
import { Store } from './store.mjs';
import { Qloo, isEntityId } from './qloo.mjs';
import { ProviderError, providerFeedback } from './errors.mjs';
import { Artwork } from './artwork.mjs';
import { publicOrigin, setting } from './limits.mjs';
import { clientAddressResolver } from './client-address.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.webp': 'image/webp', '.png': 'image/png', '.svg': 'image/svg+xml', '.ttf': 'font/ttf' };
export function createApp({ store = new Store(), qloo = new Qloo(), artwork = new Artwork(), broadcast = () => {}, now = Date.now, trustedProxyCidrs, onDiagnostic = record => console.warn('Research service:', JSON.stringify(record)) } = {}) {
  const jobs = new Map(), buckets = new Map();
  const configuredOrigin = publicOrigin();
  const clientAddress = clientAddressResolver(trustedProxyCidrs);
  const maxJobs = setting('RESEARCH_CONCURRENCY', 4, 32);
  qloo.reserve = scope => store.reserveProvider(scope);
  qloo.outcome = success => store.providerOutcome(success);
  const tokenFrom = request => (request.headers.cookie || '').match(/(?:^|;\s*)th_session=([a-f0-9]+)/)?.[1];
  function authenticate(request) {
    const session = store.session(tokenFrom(request));
    if (!session) throw new GameError('Your session has expired. Join or create a crew.');
    const room = store.get(session.code);
    if (!room) throw new GameError('This crew is no longer available. Create a new live crew.');
    return { session, room };
  }
  function limit(key, maximum = 100) {
    const current = now(), recent = (buckets.get(key) || []).filter(time => time > current - 60000);
    if (recent.length >= maximum) throw new ProviderError('APP_RATE', 'A little too fast. Give the archive a moment.', { retryable: true, status: 429, retryAfter: Math.max(1, Math.ceil((recent[0] + 60000 - current) / 1000)) });
    recent.push(current); buckets.set(key, recent);
    if (buckets.size > 2000) for (const [key, times] of buckets) if (times.at(-1) < current - 60000) buckets.delete(key);
  }
  const notify = room => { if (room) broadcast(room); };
  function feedback(error) {
    const result = providerFeedback(error);
    if (result.diagnosis) {
      try { onDiagnostic({ code: result.code, diagnosis: result.diagnosis, retryable: error.retryable === true }); } catch {}
    }
    return result;
  }
  async function research(code, generation) {
    const key = `${code}:${generation}`;
    if (jobs.has(key)) return jobs.get(key);
    if (jobs.size >= maxJobs) {
      notify(store.mutate(code, room => {
        if (room.phase === 'researching' && room.generation === generation) {
          room.research = { status: 'error', expanded: room.research?.expanded === true, message: 'Research is busy. Your crew is saved; retry shortly.', retryable: true }; room.version++;
        }
      })); return;
    }
    const job = (async () => {
      try {
        const initial = store.get(code);
        if (!initial || initial.phase !== 'researching' || initial.generation !== generation || initial.research.status !== 'working') return;
        const results = await qloo.research(initial.players, progress => {
          const fresh = store.mutate(code, room => {
            if (room.phase !== 'researching' || room.generation !== generation || room.research.status !== 'working') return;
            room.research = { ...room.research, ...progress }; room.updatedAt = Date.now(); room.version++;
          }); notify(fresh);
        }, { room: code, players: initial.players.map(player => player.id), expanded: initial.research.expanded === true });
        const fresh = store.mutate(code, room => {
          if (room.phase !== 'researching' || room.generation !== generation || room.research.status !== 'working') return;
          installResearch(room, results, now());
          room.updatedAt = Date.now(); room.version++;
        }); notify(fresh);
      } catch (error) {
        const publicError = error instanceof ProviderError ? feedback(error) : null;
        const fresh = store.mutate(code, room => {
          if (room.generation !== generation || room.phase !== 'researching' || room.research.status !== 'working') return;
          room.research = {
            status: 'error', expanded: room.research?.expanded === true, code: publicError?.code || 'RESEARCH_ERROR',
            message: publicError?.message || (error instanceof GameError ? error.message : 'Research could not be completed. Your crew is saved.'),
            retryable: error instanceof ProviderError && error.retryable,
          };
          room.updatedAt = Date.now(); room.version++;
        }); notify(fresh);
      }
    })().finally(() => jobs.delete(key));
    jobs.set(key, job); return job;
  }
  async function bodyOf(request) {
    let body = ''; for await (const chunk of request) { body += chunk; if (Buffer.byteLength(body) > 16000) throw new GameError('That request is too large.'); }
    let value; try { value = JSON.parse(body || '{}'); } catch { throw new GameError('Invalid JSON request.'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GameError('Use a JSON object.'); return value;
  }
  function send(response, status, payload, headers = {}) {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }); response.end(JSON.stringify(payload));
  }
  function cookie(token) { return `th_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400${configuredOrigin?.startsWith('https:') ? '; Secure' : ''}`; }
  function entryRequest(path, data) {
    if (data.requestId !== undefined && !/^[a-zA-Z0-9_-]{20,80}$/.test(data.requestId)) throw new GameError('This request needs a valid identifier.');
    const { requestId, ...fields } = data;
    return { id: requestId, fingerprint: createHash('sha256').update(JSON.stringify({ path, fields })).digest('hex') };
  }
  function replayEntry(request, response) {
    const previous = request.id && store.entry(request.id);
    if (!previous) return false;
    if (previous.fingerprint !== request.fingerprint) throw new GameError('That request identifier was already used for another action.');
    const room = store.get(previous.code);
    if (!room || !room.players.some(player => player.id === previous.player)) throw new GameError('This crew is no longer available. Start a new request.');
    const token = randomBytes(32).toString('hex'); store.putSession(token, previous.code, previous.player);
    send(response, 200, { room: project(room, previous.player) }, { 'set-cookie': cookie(token) }); return true;
  }
  async function handler(request, response) {
    response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Referrer-Policy', 'same-origin');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const url = new URL(request.url, 'http://local');
      if (request.method === 'POST') {
        const expected = configuredOrigin || `${request.socket?.encrypted ? 'https' : 'http'}://${request.headers.host}`;
        if (request.headers.origin && request.headers.origin !== expected) return send(response, 403, { error: 'This origin is not allowed.' });
        if (!request.headers['content-type']?.includes('application/json')) return send(response, 415, { error: 'Use JSON requests.' });
        const session = store.session(tokenFrom(request));
        limit(session ? `player:${session.player}` : `anonymous:${clientAddress(request)}`);
      }
      if (url.pathname === '/api/health' && request.method === 'GET') return send(response, 200, { ok: true, research: qloo.status() });
      if (url.pathname === '/api/session' && request.method === 'GET') {
        const session = store.session(tokenFrom(request)), room = session && store.get(session.code);
        return send(response, 200, { room: room ? project(room, session.player) : null });
      }
      if (url.pathname === '/api/rooms' && request.method === 'POST') {
        const data = await bodyOf(request), entry = entryRequest('rooms', data);
        if (replayEntry(entry, response)) return;
        limit(`create:${clientAddress(request)}`, 12);
        if (data.practice || (data.mode && data.mode !== 'live')) throw new GameError('Create a live crew with two to four human players.');
        if (!qloo.status().configured) throw new ProviderError('QLOO_CONFIG', 'The server’s Qloo connection needs configuration before a crew can start.');
        let code; do { code = Array.from({ length: 5 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[randomInt(32)]).join(''); } while (store.get(code));
        const id = randomBytes(12).toString('hex'), token = randomBytes(32).toString('hex');
        const room = createRoom({ code, id, name: data.name, avatar: data.avatar, now: now() });
        store.transaction(() => { store.save(room); store.putSession(token, code, id); if (entry.id) store.recordEntry(entry.id, entry.fingerprint, code, id); }); notify(room);
        return send(response, 201, { room: project(room, id) }, { 'set-cookie': cookie(token) });
      }
      if (url.pathname === '/api/join' && request.method === 'POST') {
        const data = await bodyOf(request), entry = entryRequest('join', data);
        if (replayEntry(entry, response)) return;
        const code = String(data.code || '').trim().toUpperCase();
        const current = store.session(tokenFrom(request)), existing = current?.code === code && store.get(code);
        if (existing && existing.players.some(player => player.id === current.player)) return send(response, 200, { room: project(existing, current.player) });
        limit(`join:${clientAddress(request)}`, 15);
        const id = randomBytes(12).toString('hex'), token = randomBytes(32).toString('hex');
        const room = store.transaction(() => {
          const room = store.get(code); if (!room) throw new GameError('No open crew with that code. Check the five characters.');
          addPlayer(room, { id, name: data.name, avatar: data.avatar }); room.updatedAt = Date.now(); room.version++;
          store.save(room); store.putSession(token, code, id); if (entry.id) store.recordEntry(entry.id, entry.fingerprint, code, id); return room;
        }); notify(room);
        return send(response, 200, { room: project(room, id) }, { 'set-cookie': cookie(token) });
      }
      if (url.pathname === '/api/command' && request.method === 'POST') {
        const action = await bodyOf(request); const { session } = authenticate(request);
        if (!/^[a-zA-Z0-9_-]{12,80}$/.test(action.commandId || '')) throw new GameError('This action needs a unique command identifier. Reload the page.');
        if (action.type === 'retry') limit(`research:${session.code}`, 3);
        const fingerprint = createHash('sha256').update(JSON.stringify(action)).digest('hex'); let repeated = false, rejected;
        const wrongAnswer = previous => new ProviderError('WRONG_ANSWER', previous.message, { status: 400, retryable: true, retryAfter: Math.max(0, Math.ceil((previous.retryAt - now()) / 1000)) });
        const room = store.mutate(session.code, fresh => {
          const receipt = store.receipt(session.player, action.commandId);
          if (receipt) {
            if (receipt.fingerprint !== fingerprint) throw new GameError('That command identifier was already used for another action.');
            repeated = true; return;
          }
          const previousFailure = store.rejection(session.player, action.commandId);
          if (previousFailure) {
            if (previousFailure.fingerprint !== fingerprint) throw new GameError('That command identifier was already used for another action.');
            rejected = wrongAnswer(previousFailure); return;
          }
          if (action.type !== 'chat' && ((action.expectedPhase && project(fresh, session.player).phase !== action.expectedPhase) || (action.expectedStage !== undefined && fresh.stage !== action.expectedStage))) throw new ProviderError('STALE_ACTION', 'Your crew has moved ahead. Refresh the current room and try again.', { status: 409 });
          if (action.type === 'solve' && fresh.stage !== 1 && fresh.phase === 'playing' && !fresh.pausedAt && fresh.players.find(player => player.id === session.player).solvedStage !== fresh.stage) {
            const retryAt = store.cooldown(session.player, session.code, fresh.stage);
            if (retryAt > now()) { rejected = new ProviderError('SOLVE_COOLDOWN', 'Take a moment to compare your clues, then try again.', { status: 429, retryable: true, retryAfter: Math.ceil((retryAt - now()) / 1000) }); return; }
          }
          try { command(fresh, session.player, action, now()); }
          catch (error) {
            if (error.code !== 'WRONG_ANSWER') throw error;
            const retryAt = store.wrongGuess(session.player, session.code, fresh.stage, action.commandId, fingerprint, error.message);
            rejected = wrongAnswer({ message: error.message, retryAt }); return;
          }
          store.recordCommand(session.player, action.commandId, fingerprint);
        });
        if (!room) throw new GameError('This crew is no longer available.');
        if (rejected) throw rejected;
        if (!repeated) notify(room); send(response, 200, { room: project(room, session.player) });
        if (!repeated && room.phase === 'researching' && room.research.status === 'working') void research(room.code, room.generation);
        return;
      }
      if (url.pathname === '/api/search' && request.method === 'POST') {
        const data = await bodyOf(request); const { room, session } = authenticate(request);
        if (room.phase !== 'intake') throw new GameError('Search is available while choosing favourites.');
        limit(`search:${session.player}`, 15); const matches = await qloo.search(data.query, data.type, { room: room.code, players: [session.player] });
        const fresh = store.mutate(room.code, current => {
          const player = current.players.find(p => p.id === session.player);
          if (!player || current.phase !== 'intake') throw new GameError('The crew has moved to the next step.');
          const protectedIds = new Set([...player.draft, ...player.favorites.map(entity => entity.id)]);
          const resolved = new Map();
          for (const entity of [...matches, ...player.resolved]) if (!resolved.has(entity.id)) resolved.set(entity.id, entity);
          player.resolved = [...resolved.values()].sort((a, b) => Number(protectedIds.has(b.id)) - Number(protectedIds.has(a.id))).slice(0, 80);
          current.version++; current.updatedAt = Date.now();
        }); notify(fresh);
        return send(response, 200, { matches: matches.map(publicEntity), room: project(fresh, session.player) });
      }
      if (url.pathname.startsWith('/api/artwork/') && ['GET', 'HEAD'].includes(request.method)) {
        const id = url.pathname.slice('/api/artwork/'.length); if (!isEntityId(id)) return send(response, 404, { error: 'Artwork unavailable.' });
        const { room, session } = authenticate(request), self = room.players.find(p => p.id === session.player);
        limit(`artwork:${session.player}`, 80);
        const candidates = ['familiarity', 'briefing', 'playing', 'debrief'].includes(room.phase) ? room.candidates : [];
        const entity = [...self.resolved, ...self.favorites, ...candidates].find(entity => entity.id === id);
        if (!entity) return send(response, 404, { error: 'Artwork unavailable.' });
        const image = await artwork.get(entity.imageSource);
        response.writeHead(200, { 'content-type': image.type, 'content-length': image.body.length, 'cache-control': 'private, max-age=900' });
        response.end(request.method === 'HEAD' ? undefined : image.body); return;
      }
      if (url.pathname.startsWith('/api/')) return send(response, 404, { error: 'Unknown endpoint.' });
      if (!['GET', 'HEAD'].includes(request.method)) return send(response, 405, { error: 'Method not allowed.' });
      const base = url.pathname.startsWith('/shared/') ? resolve(ROOT, 'shared') : resolve(ROOT, 'public');
      const relative = url.pathname.startsWith('/shared/') ? url.pathname.slice(8) : url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const file = resolve(base, decodeURIComponent(relative));
      if (!file.startsWith(base + sep) || !TYPES[extname(file)]) return send(response, 404, { error: 'That page is missing.' });
      try {
        const content = await readFile(file);
        response.writeHead(200, { 'content-type': TYPES[extname(file)], 'cache-control': /^(assets|fonts)\//.test(relative) ? 'public, max-age=86400' : 'no-cache' });
        response.end(request.method === 'HEAD' ? undefined : content);
      } catch { send(response, 404, { error: 'That page is missing.' }); }
    } catch (error) {
      const publicError = error instanceof ProviderError ? feedback(error) : null;
      send(response, error instanceof ProviderError ? error.status : error instanceof GameError ? 400 : 500, {
        error: publicError?.message || (error instanceof GameError ? error.message : 'The archive hit a snag. Your crew is saved.'),
        code: publicError?.code || 'APP_ERROR', retryable: error instanceof ProviderError && error.retryable, retryAfter: error.retryAfter || 0,
      }, error.retryAfter ? { 'retry-after': String(error.retryAfter) } : {});
    }
  }
  async function close() { await Promise.allSettled([...jobs.values()]); await qloo.close?.(); store.close(); }
  return { handler, authenticate, store, research, project, close };
}
