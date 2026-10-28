import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoom, addPlayer, command, project, eligible, clueFor } from '../server/game.mjs';
import { confirmed, prepared, launch, clearRoom } from './fixtures.mjs';

for (const count of [2, 3, 4]) test(`${count}-person heist is solvable with distributed clues and accepts every valid discovery`, () => {
  const room = launch(confirmed(count));
  const clues = room.players.map(p => clueFor(room, p.id));
  const mapping = Object.fromEntries(clues.filter(c => c.kind === 'mapping').flatMap(c => c.pairs));
  const answer = clues.find(c => c.kind === 'order').symbols.map(s => mapping[s]).join('');
  assert.equal(answer.length, 3); assert.equal(new Set(answer).size, 3);
  assert.throws(() => command(room, 'p0', { type: 'solve', answer: '000' }), /still closed/);
  clearRoom(room, answer);
  for (const candidate of eligible(room)) {
    const branch = structuredClone(room); clearRoom(branch, candidate.id); assert.equal(branch.stage, 2);
  }
  clearRoom(room, eligible(room).at(-1).id);
  const pairs = room.players.flatMap(p => clueFor(room, p.id).pairs);
  assert.equal(pairs.length, 3); assert.equal(new Set(pairs.flat()).size, 4);
  const start = pairs.find(([a]) => !pairs.some(([, b]) => b === a))[0];
  const exit = [start]; while (exit.length < 4) exit.push(pairs.find(([a]) => a === exit.at(-1))[1]);
  clearRoom(room, exit);
  assert.equal(room.phase, 'debrief'); assert.equal(project(room, 'p1').evidence.length, count);
});
test('unknown, skipped and unsupported candidates cannot masquerade as new shared discoveries', () => {
  const room = prepared(); assert.equal(eligible(room, 'shared').length, 0);
  const id = room.candidates[0].id;
  room.players.forEach(p => { p.familiarity[id] = 'new'; }); assert(eligible(room, 'shared').some(e => e.id === id));
  room.players[0].familiarity[id] = 'skip'; assert(!eligible(room, 'shared').some(e => e.id === id));
  room.players[0].familiarity[id] = 'known'; assert(eligible(room, 'mentor').some(e => e.id === id));
  room.players[1].support = []; assert.equal(eligible(room, 'mentor').length, 0);
});
test('projection does not leak private lists, familiarity, decoder, order or solution', () => {
  const room = launch(confirmed(4));
  const view = project(room, 'p2');
  assert.equal(view.secrets, undefined); assert.equal(view.self.clue.kind, 'mapping');
  for (const player of view.players) { assert.equal(player.favorites, undefined); assert.equal(player.support, undefined); assert.equal(player.familiarity, undefined); }
  assert(!JSON.stringify(view).includes('"code":"' + room.secrets.code + '"'));
  command(room, 'p1', { type: 'share' });
  assert.equal(project(room, 'p2').board.length, 1);
  command(room, 'p1', { type: 'share' }); assert.equal(room.board.length, 1);
  assert.throws(() => project(room, 'intruder'), /cannot view/);
  room.candidates[0].explainability = { privateSeed: 'do-not-publish' };
  assert(!JSON.stringify(project(room, 'p2')).includes('do-not-publish'));
});
test('host boundaries, capacity, phase rules and rejection of synthetic crews', () => {
  const room = createRoom({ code: 'TEST', id: 'p0', name: 'A' });
  assert.throws(() => command(room, 'p0', { type: 'begin' }), /Invite/);
  for (let i = 1; i < 4; i++) addPlayer(room, { id: `p${i}`, name: 'Friend' });
  assert.throws(() => addPlayer(room, { id: 'p4', name: 'Extra' }), /full/);
  assert.throws(() => command(room, 'p1', { type: 'begin' }), /host/);
  command(room, 'p0', { type: 'begin' });
  assert.throws(() => command(room, 'p0', { type: 'confirm' }), /different step/);
  assert.throws(() => createRoom({ code: 'SOLO', id: 'you', name: 'You', practice: true }), /human crews/);
});
test('pause excludes time from completion and blocks solving until resumed', () => {
  const room = launch(confirmed(), 'shared', 1000);
  command(room, 'p0', { type: 'pause' }, 2000);
  assert.equal(project(room, 'p0', 9000).elapsed, 1000);
  assert.throws(() => command(room, 'p0', { type: 'solve', answer: room.secrets.code }), /Resume/);
  command(room, 'p0', { type: 'pause' }, 12000);
  assert.equal(project(room, 'p0', 14000).elapsed, 3000);
});
test('a crew can change favourites without losing its people when no route fits', () => {
  const room = confirmed(4);
  command(room, 'p0', { type: 'retaste' });
  assert.equal(room.phase, 'intake'); assert.equal(room.players.length, 4);
  assert.equal(room.players[0].favorites.length, 0); assert(room.players.slice(1).every(p => p.favorites.length >= 2)); assert.equal(room.candidates.length, 0);
});

test('a host answer and private hint cannot solve, spoil or advance another player’s room', () => {
  const room = launch(confirmed());
  command(room, 'p0', { type: 'hint' });
  assert.equal(project(room, 'p0').hints, 1); assert.equal(project(room, 'p1').hints, 0); assert.equal(project(room, 'p1').hint, undefined);
  command(room, 'p0', { type: 'solve', answer: room.secrets.code });
  assert.equal(room.stage, 0); assert.equal(project(room, 'p0').self.solved, true); assert.equal(project(room, 'p1').self.solved, false);
  command(room, 'p0', { type: 'continue' }); assert.equal(room.stage, 0);
  assert.throws(() => command(room, 'p1', { type: 'continue' }), /own answer/);
  command(room, 'p1', { type: 'solve', answer: room.secrets.code }); assert.equal(room.stage, 0);
  command(room, 'p1', { type: 'continue' }); assert.equal(room.stage, 1);
});
test('every player chooses the route and choices stay private until the crew agrees', () => {
  const room = confirmed(); command(room, 'p0', { type: 'route', route: 'shared' });
  assert.equal(room.phase, 'briefing'); assert.equal(project(room, 'p0').self.routeChoice, 'shared');
  assert.equal(project(room, 'p1').self.routeChoice, null); assert.equal(project(room, 'p1').players[0].routeChoice, undefined);
  command(room, 'p1', { type: 'route', route: 'shared' }); assert.equal(room.phase, 'playing');
});
test('finishing familiarity or revisiting cards changes only that person’s view', () => {
  const room = prepared();
  for (const item of room.candidates) command(room, 'p0', { type: 'familiarity', id: item.id, value: 'new' });
  command(room, 'p0', { type: 'confirm' });
  assert.equal(project(room, 'p0').phase, 'briefing'); assert.equal(project(room, 'p1').phase, 'familiarity');
  assert.equal(project(room, 'p1').self.confirmed, false);
  for (const item of room.candidates) command(room, 'p1', { type: 'familiarity', id: item.id, value: 'new' });
  command(room, 'p1', { type: 'confirm' }); command(room, 'p0', { type: 'revise' });
  assert.equal(project(room, 'p0').phase, 'familiarity'); assert.equal(project(room, 'p1').phase, 'briefing');
});
test('different valid discovery choices produce individual dossiers without overwriting another player', () => {
  const room = launch(confirmed()); clearRoom(room, room.secrets.code);
  const candidates = eligible(room); assert(candidates.length >= 2);
  command(room, 'p0', { type: 'solve', answer: candidates[0].id });
  command(room, 'p1', { type: 'solve', answer: candidates[1].id });
  assert.equal(project(room, 'p1').self.discoveryId, undefined);
  for (const player of room.players) command(room, player.id, { type: 'continue' });
  clearRoom(room, room.secrets.exit);
  assert.equal(project(room, 'p0').discovery.id, candidates[0].id); assert.equal(project(room, 'p1').discovery.id, candidates[1].id);
  assert(project(room, 'p1').evidence.every(person => person.returned));
});
