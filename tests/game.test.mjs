import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoom, addPlayer, command, project, eligible, clueFor, installResearch } from '../server/game.mjs';
import { confirmed, prepared, launch, clearRoom, permutations, exitMatches, entity } from './fixtures.mjs';

for (const count of [2, 3, 4]) test(`${count}-person heist is solvable with distributed clues and accepts every valid discovery`, () => {
  const room = launch(confirmed(count));
  const clues = room.players.map(p => clueFor(room, p.id));
  const mapping = Object.fromEntries(clues.filter(c => c.kind === 'mapping').flatMap(c => c.pairs));
  const answer = clues.find(c => c.kind === 'order').symbols.map(s => mapping[s]).join('');
  assert.equal(answer.length, 4); assert.equal(new Set(answer).size, 4);
  assert.throws(() => command(room, 'p0', { type: 'solve', answer: '000' }), /still closed/);
  clearRoom(room, answer);
  for (const candidate of eligible(room)) {
    const branch = structuredClone(room); clearRoom(branch, candidate.id); assert.equal(branch.stage, 2);
  }
  clearRoom(room, eligible(room).at(-1).id);
  const exitClues = room.players.map(p => clueFor(room,p.id));
  const matches = permutations(room.secrets.exit).filter(order => exitMatches(order,exitClues));
  assert.equal(matches.length,1);const exit=matches[0];
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
for (const count of [2, 3, 4]) test(`${count}-person crew cannot finish with different discoveries; every dossier uses the unanimous result`, () => {
  const room = launch(confirmed(count)); clearRoom(room, room.secrets.code);
  const candidates = eligible(room); assert(candidates.length >= 2);
  for (const [i, player] of room.players.entries()) command(room, player.id, { type: 'solve', answer: candidates[i % 2].id });
  for (const player of room.players) command(room, player.id, { type: 'continue' });
  assert.equal(room.stage, 1); assert.equal(room.discovery, null);
  assert(project(room, 'p0').discoveryConflict);
  for (const player of room.players.filter((_, i) => i % 2)) {
    command(room, player.id, { type: 'reconsider' });
    assert.equal(player.readyStage, null);
    command(room, player.id, { type: 'solve', answer: candidates[0].id });
    command(room, player.id, { type: 'continue' });
  }
  assert.equal(room.stage, 2); assert.equal(room.discovery.id, candidates[0].id);
  assert.throws(() => command(room, 'p0', { type: 'reconsider' }), /common-ground/);
  clearRoom(room, room.secrets.exit);
  const views = room.players.map(player => project(room, player.id));
  assert(views.every(view => view.discovery.id === candidates[0].id));
  assert(views.every(view => JSON.stringify(view.evidence) === JSON.stringify(views[0].evidence)));
});

test('all generated puzzles require every seat and have exactly one complete exit', () => {
  for(const count of [2,3,4])for(let seed=1;seed<=300;seed++) {
    let value=seed;const random=()=>{value=(Math.imul(value,1664525)+1013904223)>>>0;return value/2**32;};
    const room=confirmed(count);for(const player of room.players)command(room,player.id,{type:'route',route:'shared'},1000,random);
    assert.equal(room.secrets.order.length,4);assert.equal(new Set(Object.values(room.secrets.mapping)).size,4);
    const decoders=room.players.slice(1).map(p=>clueFor(room,p.id));
    for(const clue of decoders)assert(clue.pairs.some(([symbol])=>room.secrets.order.includes(symbol)));
    // Decoder allocation follows a fixed symbol order; it must not disclose the private order.
    assert.deepEqual(decoders.flatMap(c=>c.pairs).map(([symbol])=>symbol).sort(), [...room.secrets.order].sort());
    room.stage=2;const clues=room.players.map(p=>clueFor(room,p.id)),orders=permutations(room.secrets.exit);
    assert.equal(orders.filter(order=>exitMatches(order,clues)).length,1);
    for(let withheld=0;withheld<count;withheld++)assert(orders.filter(order=>exitMatches(order,clues.filter((_,i)=>i!==withheld))).length>=2);
  }
});

test('saved three-symbol locks and arrow-chain exits remain playable',()=>{
  const room=launch(confirmed(4));
  delete room.secrets.exitClues;room.secrets.order=room.secrets.order.slice(0,3);room.secrets.code=room.secrets.order.map(symbol=>room.secrets.mapping[symbol]).join('');
  assert.equal(project(room,'p0').signalLength,3);clearRoom(room,room.secrets.code);
  clearRoom(room,eligible(room)[0].id);assert(room.players.every(p=>Array.isArray(clueFor(room,p.id).pairs)));
  clearRoom(room,room.secrets.exit);assert.equal(room.phase,'debrief');
});

test('source receipts remain private until the debrief and expose only the selected discovery context',()=>{
  const room=launch(confirmed());
  for(const player of room.players)player.researchRequests=[{requestId:'source-receipt',category:'movie',inputIds:player.favorites.map(item=>item.id),limit:12,completedAt:123456,status:'ok',returnedIds:[room.candidates[0].id],privateHeaders:'never-expose'}];
  assert(!JSON.stringify(project(room,'p0')).includes('source-receipt'));
  clearRoom(room,room.secrets.code);clearRoom(room,room.candidates[0].id);clearRoom(room,room.secrets.exit);
  const view=project(room,'p0');assert.equal(view.evidence[0].receipts[0].basis,'combined favourites');
  assert.equal(view.evidence[0].receipts[0].entityId,room.candidates[0].id);assert(!JSON.stringify(view).includes('privateHeaders'));assert(!JSON.stringify(view).includes('never-expose'));
});

for (const mark of ['known', 'skip']) test(`all-${mark} recommendations cannot masquerade as either discovery route`, () => {
  const room = prepared();
  for (const player of room.players) {
    for (const item of room.candidates) command(room, player.id, { type: 'familiarity', id: item.id, value: mark });
    command(room, player.id, { type: 'confirm' });
  }
  assert(project(room, 'p0').availableRoutes.every(route => !route.available));
  assert(project(room, 'p0').canRefine);
  assert.throws(() => command(room, 'p0', { type: 'route', route: 'mentor' }), /another discovery/);
  const favorites = structuredClone(room.players.map(player => player.favorites));
  command(room, 'p0', { type: 'refine' });
  assert.equal(room.phase, 'researching');
  assert.deepEqual(room.players.map(player => player.favorites), favorites);
});

for (const count of [2, 3, 4]) test(`${count}-person pass-it-on can introduce one selected favourite only when Qloo supports every other profile`, () => {
  const room = prepared(count), favorite = room.players[0].favorites[0];
  room.phase = 'researching'; room.research = { status: 'working' };
  installResearch(room, room.players.map((player, i) => ({ playerId: player.id, entities: i ? [favorite] : [] })));
  assert(room.candidates.some(item => item.id === favorite.id));
  assert.throws(() => command(room, 'p0', { type: 'familiarity', id: favorite.id, value: 'new' }), /selected this as a favourite/);
  for (const [i, player] of room.players.entries()) {
    command(room, player.id, { type: 'familiarity', id: favorite.id, value: i ? 'new' : 'known' });
    command(room, player.id, { type: 'confirm' });
  }
  assert(project(room, 'p0').availableRoutes.find(route => route.route === 'mentor').available);
  assert(!project(room, 'p0').availableRoutes.find(route => route.route === 'shared').available);
  launch(room, 'mentor'); clearRoom(room, room.secrets.code); clearRoom(room, favorite.id); clearRoom(room, room.secrets.exit);
  for (const player of room.players) {
    const view = project(room, player.id);
    assert.equal(view.discovery.id, favorite.id);
    assert.equal(view.evidence[0].selectedFavorite, true);
    assert.equal(view.evidence[0].returned, false, 'own favourite must not be presented as a provider return');
    assert(view.evidence.slice(1).every(person => person.returned && person.familiarity === 'new'));
  }
});

test('a friend’s favourite is not a fit for an unsupported profile or an all-familiar crew', () => {
  const room = prepared(3), favorite = room.players[0].favorites[0];
  room.phase = 'researching'; room.research = {};
  installResearch(room, room.players.map((player, i) => ({ playerId: player.id, entities: i === 1 ? [favorite] : [] })));
  assert(!room.candidates.some(item => item.id === favorite.id));
  assert(project(room, 'p0').availableRoutes.every(route => !route.available));
});

test('wider research preserves reviews, favourites, actual earlier memberships and source receipts', () => {
  const room = confirmed(); const before = structuredClone(room);
  command(room, 'p0', { type: 'route', route: 'shared' });
  command(room, 'p1', { type: 'refine' });
  assert.equal(room.phase, 'researching'); assert(room.research.expanded);
  assert(room.players.every(player => !player.routeChoice));
  const fresh = entity(900);
  installResearch(room, room.players.map(player => ({ playerId: player.id, entities: [fresh] })));
  assert.equal(room.phase, 'familiarity');
  assert(room.candidates.some(item => item.id === fresh.id));
  for (const [i, player] of room.players.entries()) {
    assert.deepEqual(player.favorites, before.players[i].favorites);
    for (const item of before.candidates) assert.equal(player.familiarity[item.id], 'new');
    assert(player.support.includes(before.candidates[0].id));
    command(room, player.id, { type: 'familiarity', id: fresh.id, value: 'new' });
    command(room, player.id, { type: 'confirm' });
  }
  assert.equal(room.phase, 'briefing');
  assert.throws(() => command(room, 'p0', { type: 'refine' }), /reviewed this trail/);
});

test('widening with no additional candidates auto-completes saved reviews without stranding the crew', () => {
  const room = confirmed();
  command(room, 'p0', { type: 'refine' });
  installResearch(room, room.players.map(player => ({ playerId: player.id, entities: [] })));
  assert.equal(room.phase, 'briefing');
  assert(project(room, 'p0').availableRoutes.find(route => route.route === 'shared').available);
});

test('replacing a full shortlist retains earlier reviews and receipts outside the displayed cards', () => {
  const room = prepared(); room.phase = 'researching';
  const oldCards = Array.from({ length: 9 }, (_, i) => entity(600 + i));
  const newerCards = Array.from({ length: 9 }, (_, i) => entity(700 + i));
  installResearch(room, room.players.map(player => ({ playerId: player.id, entities: oldCards, requests: [{ requestId: 'old-query', returnedIds: oldCards.map(item => item.id) }] })));
  for (const player of room.players) {
    for (const card of room.candidates) command(room, player.id, { type: 'familiarity', id: card.id, value: 'known' });
    command(room, player.id, { type: 'confirm' });
  }
  command(room, 'p0', { type: 'refine' });
  installResearch(room, room.players.map(player => ({ playerId: player.id, entities: newerCards, requests: [{ requestId: 'new-query', returnedIds: newerCards.map(item => item.id) }] })));
  assert(room.candidates.every(item => newerCards.some(card => card.id === item.id)));
  for (const player of room.players) {
    assert(oldCards.every(card => player.familiarity[card.id] === 'known'));
    assert(newerCards.every(card => player.familiarity[card.id] === 'unknown'));
    assert.deepEqual(player.researchRequests.map(request => request.requestId), ['old-query', 'new-query']);
    assert.equal(player.support.length, 18);
  }
});

for (const count of [2, 3, 4]) for (const route of ['shared', 'mentor']) test(`${count}-person ${route} Common Ground offers only matching discoveries and accepts every displayed card`, () => {
  const room = prepared(count);
  const records = [950, 951, 952, 953, 954, 955, 956].map(number => entity(number));
  room.phase = 'researching'; room.research = { status: 'working' };
  installResearch(room, room.players.map((player, i) => ({ playerId: player.id, entities: records.filter(item => i !== count - 1 || item.id !== entity(955).id) })));
  for (const [i, player] of room.players.entries()) {
    for (const item of room.candidates) {
      const value = item.id === entity(954).id || (i === 0 && item.id === entity(952).id) || (i === 1 && item.id === entity(956).id) ? 'known' : i === 0 && item.id === entity(953).id ? 'skip' : 'new';
      command(room, player.id, { type: 'familiarity', id: item.id, value });
    }
    command(room, player.id, { type: 'confirm' });
  }
  assert.equal(project(room, 'p0').candidates.length, 7, 'familiarity review keeps the broader research shortlist');
  launch(room, route); clearRoom(room, room.secrets.code);
  const expected = (route === 'shared' ? [950, 951] : [952, 956]).map(number => entity(number).id);
  for (const player of room.players) {
    const view = project(room, player.id);
    assert.deepEqual(view.candidates.map(item => item.id).sort(), [...expected].sort());
    assert.deepEqual(view.self.clue.entities.map(item => item.id).sort(), [...expected].sort());
    assert(view.candidates.every(item => item.connection.total === count && item.connection.known === (route === 'shared' ? 0 : 1) && item.connection.new === (route === 'shared' ? count : count - 1)));
    assert.throws(() => command(structuredClone(room), player.id, { type: 'solve', answer: entity(955).id }), error => error.code !== 'WRONG_ANSWER' && /recommendations shown/.test(error.message));
  }
  command(room, 'p0', { type: 'share' });
  assert.deepEqual(project(room, 'p1').board[0].clue.entities.map(item => item.id).sort(), [...expected].sort());
  // A connection pinned before this fix may still contain the broader shortlist in its saved snapshot.
  room.board.push({ playerId: 'p1', stage: 1, clue: { kind: 'connections', entities: records.map(item => ({ id: item.id, name: item.name })) } });
  assert.deepEqual(project(room, 'p0').board[1].clue.entities.map(item => item.id).sort(), [...expected].sort());
  for (const choice of project(room, 'p0').candidates) {
    const branch = structuredClone(room);
    clearRoom(branch, choice.id);
    assert.equal(branch.stage, 2);
    assert.equal(branch.discovery.id, choice.id);
  }
});
