import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const hash = token => createHash('sha256').update(token).digest('hex');
export class Store {
  constructor(path = process.env.DB_PATH || './data/heist.sqlite') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS rooms(code TEXT PRIMARY KEY, body TEXT NOT NULL, updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, code TEXT NOT NULL, player TEXT NOT NULL, expires INTEGER NOT NULL);`);
    this.db.exec('CREATE TABLE IF NOT EXISTS commands(player TEXT, id TEXT, fingerprint TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(player,id));');
    this.db.prepare('DELETE FROM commands WHERE created < ?').run(Date.now() - 86400000);
    this.db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
    this.db.prepare('DELETE FROM rooms WHERE updated < ?').run(Date.now() - 86400000);
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
      if (room.phase === 'researching' && room.research?.status === 'working') {
        room.research = { status: 'error', message: 'The server restarted during research. The host can retry.' };
        this.save(room);
      }
    }
  }
  save(room) {
    this.db.prepare('INSERT INTO rooms VALUES(?,?,?) ON CONFLICT(code) DO UPDATE SET body=excluded.body,updated=excluded.updated')
      .run(room.code, JSON.stringify(room), room.updatedAt);
  }
  get(code) {
    const row = this.db.prepare('SELECT body FROM rooms WHERE code=? AND updated > ?').get(code, Date.now() - 86400000);
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
  recordCommand(player, id, fingerprint) { this.db.prepare('INSERT INTO commands VALUES(?,?,?,?)').run(player, id, fingerprint, Date.now()); }
  session(token) {
    if (!token) return null;
    return this.db.prepare('SELECT code,player,expires FROM sessions WHERE token=? AND expires > ?').get(hash(token), Date.now()) || null;
  }
  putSession(token, code, player) {
    this.db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(hash(token), code, player, Date.now() + 86400000);
  }
  close() { this.db.close(); }
}
