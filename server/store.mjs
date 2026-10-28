import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ProviderError } from './errors.mjs';
import { setting } from './limits.mjs';
import { upgradeOutcome } from './game.mjs';

const hash = token => createHash('sha256').update(token).digest('hex');
export class Store {
  constructor(path = process.env.DB_PATH || './data/heist.sqlite', { now = Date.now, recoverResearch = true, cleanupIntervalMs = 300000, every = setInterval, cancel = clearInterval } = {}) {
    this.now = now; this.cancel = cancel;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS rooms(code TEXT PRIMARY KEY, body TEXT NOT NULL, updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, code TEXT NOT NULL, player TEXT NOT NULL, expires INTEGER NOT NULL);`);
    this.db.exec('CREATE TABLE IF NOT EXISTS commands(player TEXT, id TEXT, fingerprint TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(player,id));');
    this.db.exec('CREATE TABLE IF NOT EXISTS entries(id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, code TEXT NOT NULL, player TEXT NOT NULL, expires INTEGER NOT NULL);');
    this.db.exec(`CREATE TABLE IF NOT EXISTS guesses(player TEXT, code TEXT, stage INTEGER, misses INTEGER NOT NULL, lastAt INTEGER NOT NULL, retryAt INTEGER NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY(player,code,stage));
      CREATE TABLE IF NOT EXISTS rejections(player TEXT, id TEXT, fingerprint TEXT NOT NULL, message TEXT NOT NULL, retryAt INTEGER NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY(player,id));
      CREATE TABLE IF NOT EXISTS usage(bucket TEXT, period INTEGER, units INTEGER NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY(bucket,period));
      CREATE TABLE IF NOT EXISTS provider_state(id INTEGER PRIMARY KEY, failures INTEGER NOT NULL, retryAt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS rooms_updated ON rooms(updated);
      CREATE INDEX IF NOT EXISTS sessions_expires ON sessions(expires);
      CREATE INDEX IF NOT EXISTS sessions_code ON sessions(code);
      CREATE INDEX IF NOT EXISTS commands_created ON commands(created);
      CREATE INDEX IF NOT EXISTS entries_expires ON entries(expires);
      CREATE INDEX IF NOT EXISTS guesses_expires ON guesses(expires);
      CREATE INDEX IF NOT EXISTS rejections_expires ON rejections(expires);
      CREATE INDEX IF NOT EXISTS usage_expires ON usage(expires);`);
    this.cleanup();
    // Remove unsupported room modes while preserving live rooms.
    this.transaction(() => {
      for (const row of this.db.prepare('SELECT code, body FROM rooms').all()) {
        const old = JSON.parse(row.body);
        if (old.mode === 'sample' || old.practice === true) {
          this.db.prepare('DELETE FROM sessions WHERE code=?').run(row.code);
          this.db.prepare('DELETE FROM rooms WHERE code=?').run(row.code);
        }
      }
    });
    // A restart makes in-flight upstream jobs retryable instead of leaving crews waiting forever.
    for (const row of this.db.prepare('SELECT code, body FROM rooms').all()) {
      const room = JSON.parse(row.body);
      const upgraded = room.schemaVersion === 2 && room.mode === 'live' && upgradeOutcome(room);
      if (recoverResearch && room.phase === 'researching' && room.research?.status === 'working') {
        room.research = { status: 'error', expanded: room.research.expanded === true, message: 'The server restarted during research. The host can retry.' };
        room.version++;
        this.save(room);
      } else if (upgraded) this.save(room);
    }
    this.cleanupTimer = every(() => {
      try { this.cleanup(); }
      catch { console.warn('Expired-record cleanup was deferred and will retry at the next interval.'); }
    }, cleanupIntervalMs);
    this.cleanupTimer?.unref?.();
  }
  save(room) {
    this.db.prepare('INSERT INTO rooms VALUES(?,?,?) ON CONFLICT(code) DO UPDATE SET body=excluded.body,updated=excluded.updated')
      .run(room.code, JSON.stringify(room), room.updatedAt);
  }
  get(code) {
    const row = this.db.prepare('SELECT body FROM rooms WHERE code=? AND updated > ?').get(code, this.now() - 86400000);
    const room = row ? JSON.parse(row.body) : null;
    return room?.schemaVersion === 2 && room.mode === 'live' ? room : null;
  }
  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  mutate(code, work) {
    return this.transaction(() => {
      const room = this.get(code); if (!room) return null;
      work(room); this.save(room); return room;
    });
  }
  receipt(player, id) { return this.db.prepare('SELECT fingerprint FROM commands WHERE player=? AND id=?').get(player, id); }
  recordCommand(player, id, fingerprint) { this.db.prepare('INSERT INTO commands VALUES(?,?,?,?)').run(player, id, fingerprint, this.now()); }
  entry(id) { return this.db.prepare('SELECT fingerprint,code,player FROM entries WHERE id=? AND expires>?').get(hash(id), this.now()); }
  recordEntry(id, fingerprint, code, player) { this.db.prepare('INSERT INTO entries VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET fingerprint=excluded.fingerprint,code=excluded.code,player=excluded.player,expires=excluded.expires').run(hash(id), fingerprint, code, player, this.now() + 600000); }
  session(token) {
    if (!token) return null;
    return this.db.prepare('SELECT code,player,expires FROM sessions WHERE token=? AND expires > ?').get(hash(token), this.now()) || null;
  }
  putSession(token, code, player) {
    this.db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(hash(token), code, player, this.now() + 86400000);
  }
  cleanup() {
    if (this.closed) return;
    const now = this.now(), cutoff = now - 86400000;
    this.transaction(() => {
      for (const row of this.db.prepare('SELECT code,body FROM rooms WHERE updated<=?').all(cutoff)) {
        for (const player of JSON.parse(row.body).players || []) {
          this.db.prepare('DELETE FROM commands WHERE player=?').run(player.id);
          this.db.prepare('DELETE FROM rejections WHERE player=?').run(player.id);
          this.db.prepare('DELETE FROM guesses WHERE player=?').run(player.id);
        }
        this.db.prepare('DELETE FROM sessions WHERE code=?').run(row.code);
        this.db.prepare('DELETE FROM entries WHERE code=?').run(row.code);
      }
      this.db.prepare('DELETE FROM rooms WHERE updated<=?').run(cutoff);
      this.db.prepare('DELETE FROM commands WHERE created<=?').run(cutoff);
      for (const table of ['sessions', 'entries']) this.db.prepare(`DELETE FROM ${table} WHERE expires<=? OR NOT EXISTS(SELECT 1 FROM rooms WHERE rooms.code=${table}.code)`).run(now);
      for (const table of ['guesses', 'rejections', 'usage']) this.db.prepare(`DELETE FROM ${table} WHERE expires<=?`).run(now);
    });
  }
  cooldown(player, code, stage) { return this.db.prepare('SELECT retryAt FROM guesses WHERE player=? AND code=? AND stage=? AND expires>?').get(player, code, stage, this.now())?.retryAt || 0; }
  rejection(player, id) { return this.db.prepare('SELECT fingerprint,message,retryAt FROM rejections WHERE player=? AND id=? AND expires>?').get(player, id, this.now()); }
  wrongGuess(player, code, stage, id, fingerprint, message) {
    const now = this.now();
    const previous = this.db.prepare('SELECT misses,lastAt FROM guesses WHERE player=? AND code=? AND stage=?').get(player, code, stage);
    const misses = Math.min(5, (previous?.lastAt > now - 60000 ? previous.misses : 0) + 1), retryAt = now + Math.min(15000, 1000 * 2 ** (misses - 1));
    this.db.prepare('INSERT INTO guesses VALUES(?,?,?,?,?,?,?) ON CONFLICT(player,code,stage) DO UPDATE SET misses=excluded.misses,lastAt=excluded.lastAt,retryAt=excluded.retryAt,expires=excluded.expires').run(player, code, stage, misses, now, retryAt, now + 86400000);
    this.db.prepare('INSERT INTO rejections VALUES(?,?,?,?,?,?)').run(player, id, fingerprint, message, retryAt, now + 86400000);
    return retryAt;
  }
  reserveProvider(scope = {}) {
    const now = this.now(), day = Math.floor(now / 86400000), minute = Math.floor(now / 60000);
    const limits = [
      ['global-day', day, setting('QLOO_DAILY_BUDGET', 1000), (day + 1) * 86400000],
      ['global-minute', minute, setting('QLOO_REQUESTS_PER_MINUTE', 30), (minute + 1) * 60000],
    ];
    if (scope.room) limits.push([`room:${hash(scope.room)}`, day, setting('QLOO_ROOM_DAILY_BUDGET', 120), (day + 1) * 86400000]);
    for (const player of new Set(scope.players || [])) limits.push([`player:${hash(player)}`, day, setting('QLOO_PLAYER_DAILY_BUDGET', 120), (day + 1) * 86400000]);
    this.transaction(() => {
      const breaker = this.db.prepare('SELECT failures,retryAt FROM provider_state WHERE id=1').get();
      if (breaker?.retryAt > now) throw new ProviderError('QLOO_CIRCUIT_OPEN', 'Research is taking a short recovery break. Your crew is saved; retry shortly.', { status: 503, retryable: true, retryAfter: Math.ceil((breaker.retryAt - now) / 1000) });
      if (breaker?.retryAt && breaker.retryAt <= now) this.db.prepare('UPDATE provider_state SET failures=0,retryAt=0 WHERE id=1').run();
      for (const [bucket, period, max, expires] of limits) {
        if ((this.db.prepare('SELECT units FROM usage WHERE bucket=? AND period=?').get(bucket, period)?.units || 0) >= max) throw new ProviderError('QLOO_ALLOWANCE', 'Research has reached its server allowance. Your crew is saved; try again later.', { status: 429, retryable: true, retryAfter: Math.max(1, Math.ceil((expires - now) / 1000)) });
      }
      for (const [bucket, period, , expires] of limits) this.db.prepare('INSERT INTO usage VALUES(?,?,1,?) ON CONFLICT(bucket,period) DO UPDATE SET units=units+1').run(bucket, period, expires);
    });
  }
  providerOutcome(success) {
    this.transaction(() => {
      if (success) { this.db.prepare('DELETE FROM provider_state WHERE id=1').run(); return; }
      const failures = Math.min(3, (this.db.prepare('SELECT failures FROM provider_state WHERE id=1').get()?.failures || 0) + 1);
      this.db.prepare('INSERT INTO provider_state VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET failures=excluded.failures,retryAt=excluded.retryAt').run(failures, failures >= 3 ? this.now() + 30000 : 0);
    });
  }
  close() { if (this.closed) return; this.closed = true; this.cancel(this.cleanupTimer); this.db.close(); }
}
