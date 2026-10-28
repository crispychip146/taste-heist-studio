// Synthetic records are isolated test inputs. They are never imported by application code or builds.
import { normalizeEntity } from '../server/qloo.mjs';
import { createRoom, addPlayer, command, installResearch } from '../server/game.mjs';
export const id = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
export const record = (number, type = 'movie', extra = {}) => ({ entity_id: id(number), name: `Fictional test ${type} ${number}`, subtype: `urn:entity:${type}`, properties: { release_year: 2001, description: 'An isolated test record.', image: { url: `https://images.qloo.com/i/${id(number)}.jpg` }, ...extra } });
export const entity = (number, type = 'movie') => normalizeEntity(record(number, type), type);
export const recommendationTool = { name: 'qloo_recommend', inputSchema: { type: 'object', required: ['signals', 'target_type'], properties: { signals: { type: 'array', items: { type: 'string' } }, target_type: { type: 'string', enum: ['movie', 'book', 'artist'] }, limit: { type: 'integer', maximum: 20 } } } };
export function researchResults(players) { return players.map((player, index) => ({ playerId: player.id, entities: [entity(100), entity(101, 'book'), entity(102, 'artist'), entity(200 + index)] })); }
export function fakeQloo(overrides = {}) {
  return { status: () => ({ configured: true, harnessReady: true, verifiedAt: 1 }),
    search: async (query, type) => [entity(query === 'second' ? 2 : 1, type), entity(query === 'second' ? 4 : 3, type)],
    research: async (players, progress = () => {}) => { await progress({ completed: players.length * 3, total: players.length * 3 }); return researchResults(players); },
    close: async () => {}, ...overrides,
  };
}
export function prepared(count = 2) {
  const room = createRoom({ code: 'ABCDE', id: 'p0', name: 'Roux' });
  for (let i = 1; i < count; i++) addPlayer(room, { id: `p${i}`, name: `Agent ${i}`, avatar: i });
  command(room, 'p0', { type: 'begin' });
  for (const [index, player] of room.players.entries()) {
    player.resolved = [entity(1 + index * 2), entity(2 + index * 2, 'book')];
    command(room, player.id, { type: 'favorites', ids: player.resolved.map(entity => entity.id) });
  }
  installResearch(room, researchResults(room.players)); return room;
}
export function confirmed(count = 2) {
  const room = prepared(count);
  for (const player of room.players) {
    for (const candidate of room.candidates) command(room, player.id, { type: 'familiarity', id: candidate.id, value: 'new' });
    command(room, player.id, { type: 'confirm' });
  }
  return room;
}

export function launch(room, route = 'shared', now = Date.now()) {
  for (const player of room.players) command(room, player.id, { type: 'route', route }, now);
  return room;
}
export function clearRoom(room, answer, now = Date.now()) {
  for (const player of room.players) command(room, player.id, { type: 'solve', answer }, now);
  for (const player of room.players) command(room, player.id, { type: 'continue' }, now);
}
