import { SYMBOLS, EXIT_TOKENS } from '../shared/catalog.mjs';
import { imagePathFor } from './artwork.mjs';
import { shortlist } from './shortlist.mjs';

export class GameError extends Error {}
const requireThat = (condition, message) => { if (!condition) throw new GameError(message); };
const clean = (value, max = 180) => String(value ?? '').trim().slice(0, max);
const shuffle = (array, random) => array.reduce((out, item) => {
  out.splice(Math.floor(random() * (out.length + 1)), 0, item); return out;
}, []);
export function createRoom({ code, id, name, avatar = 0, practice = false, mode = 'live', now = Date.now() }) {
  requireThat(mode === 'live' && !practice, 'This version uses live Qloo research and human crews.');
  const room = {
    code, schemaVersion: 2, host: id, mode: 'live', phase: 'lobby', players: [], version: 0,
    createdAt: now, updatedAt: now, messages: [], board: [], hints: 0, attempts: 0,
    research: null, generation: 0, candidates: [], stage: 0, route: null, discovery: null,
  };
  addPlayer(room, { id, name, avatar });
  return room;
}
export function addPlayer(room, { id, name, avatar = 0 }) {
  requireThat(room.phase === 'lobby', 'This crew has already started. Ask the host to make a new crew.');
  requireThat(room.players.length < 4, 'This crew is full (four players).');
  requireThat(!room.players.some(p => p.id === id), 'Already in this crew.');
  requireThat(clean(name, 24).length > 0, 'Give your agent a name.');
  room.players.push({ id, name: clean(name, 24), avatar: Math.max(0, Math.min(3, Number(avatar) || 0)), favorites: [], resolved: [], draft: [], familiarity: {}, confirmed: false, support: [], researchResults: [], routeChoice: null, solvedStage: null, readyStage: null, hints: 0, discoveryId: null });
}
export function installResearch(room, results, now = Date.now()) {
  requireThat(room.phase === 'researching', 'Research is no longer needed.');
  for (const player of room.players) {
    const entities = results.find(r => r.playerId === player.id)?.entities || [];
    player.support = entities.map(e => e.id);
    player.researchResults = entities;
  }
  const seeds = new Set(room.players.flatMap(p => p.favorites.map(f => f.id)));
  // Present candidates supported by everyone first; membership stays private until shared.
  room.candidates = shortlist(results, seeds);
  requireThat(room.candidates.length >= 1, 'Too few discoveries returned. Try different favourites.');
  for (const player of room.players) {
    player.confirmed = false;
    player.routeChoice = null;
    player.familiarity = Object.fromEntries(room.candidates.map(e => [e.id, 'unknown']));
  }
  room.phase = 'familiarity'; room.updatedAt = now; room.research = { status: 'complete', count: results.length, at: now, metadataWarning: results.find(result => result.metadataWarning)?.metadataWarning || null };
}
export function eligible(room, route = room.route) {
  return room.candidates.filter(entity => {
    if (!room.players.every(p => p.support.includes(entity.id))) return false;
    const marks = room.players.map(p => p.familiarity[entity.id]);
    if (route === 'shared') return marks.every(m => m === 'new');
    if (route === 'mentor') return marks.includes('known') && marks.includes('new') && marks.every(m => ['known', 'new'].includes(m));
    return false;
  });
}
export function startPuzzle(room, random = Math.random, now = Date.now()) {
  const order = shuffle(SYMBOLS, random).slice(0, 3);
  const digits = shuffle(['2', '4', '6', '8'], random);
  const mapping = Object.fromEntries(SYMBOLS.map((s, i) => [s, digits[i]]));
  const exit = shuffle(EXIT_TOKENS, random);
  room.secrets = { order, mapping, code: order.map(s => mapping[s]).join(''), exit };
  room.phase = 'playing'; room.stage = 0; room.startedAt = now; room.elapsed = 0; room.pausedAt = null;
  room.board = []; room.hints = 0; room.attempts = 0;
  room.players.forEach(player => { player.solvedStage = null; player.readyStage = null; player.hints = 0; player.discoveryId = null; });
}
export function clueFor(room, playerId, stage = room.stage) {
  const index = room.players.findIndex(p => p.id === playerId);
  if (index < 0 || !room.secrets) return null;
  const count = room.players.length;
  if (stage === 0) {
    if (index === 0) return { kind: 'order', symbols: room.secrets.order, text: 'Read these three symbols from left to right. Your crew has the numbers.' };
    const pairs = Object.entries(room.secrets.mapping).filter((_, i) => i % (count - 1) === index - 1);
    return { kind: 'mapping', pairs, text: 'These are your decoder pieces. Another agent has the symbol order.' };
  }
  if (stage === 1) {
    const player = room.players[index];
    return { kind: 'connections', entities: room.candidates.filter(e => player.support.includes(e.id)).map(e => ({ id: e.id, name: e.name, familiarity: player.familiarity[e.id] })), text: 'Only these discoveries appeared in your research. Combine everybody’s list.' };
  }
  return { kind: 'sequence', first: count === 4 && index === 3 ? room.secrets.exit[0] : null, pairs: room.secrets.exit.slice(0, 3).map((item, i) => [item, room.secrets.exit[i + 1]])
    .filter((_, i) => i % count === index), text: 'Put the souvenirs in order. Each arrow means “immediately before”.' };
}
function share(room, playerId) {
  if (room.board.some(b => b.playerId === playerId && b.stage === room.stage)) return;
  room.board.push({ playerId, stage: room.stage, clue: clueFor(room, playerId), at: room.updatedAt });
}
export function command(room, playerId, action, now = Date.now(), random = Math.random) {
  const player = room.players.find(p => p.id === playerId);
  requireThat(player, 'Your session has expired. Rejoin your crew.');
  requireThat(action && typeof action.type === 'string', 'Invalid action.');
  room.updatedAt = now;
  const host = () => requireThat(room.host === playerId, 'Only the host can do that.');
  const phase = value => requireThat(room.phase === value, 'That action belongs to a different step.');
  switch (action.type) {
    case 'begin':
      host(); phase('lobby'); requireThat(room.players.length >= 2, 'Invite at least one friend to start the heist.');
      room.phase = 'intake'; break;
    case 'selection': {
      phase('intake');
      requireThat(Array.isArray(action.ids) && action.ids.length <= 4, 'Choose up to four favourites.');
      const ids = [...new Set(action.ids)];
      requireThat(ids.every(id => player.resolved.some(entity => entity.id === id)), 'Choose confirmed search results.');
      player.draft = ids; player.favorites = []; break;
    }
    case 'favorites': {
      phase('intake');
      requireThat(Array.isArray(action.ids) && action.ids.length >= 2 && action.ids.length <= 4, 'Choose two to four favourites.');
      const catalog = player.resolved || [];
      const favorites = [...new Set(action.ids)].map(id => catalog.find(f => f.id === id));
      requireThat(favorites.length >= 2 && favorites.every(Boolean), 'Choose confirmed search matches.');
      player.favorites = favorites;
      player.draft = favorites.map(entity => entity.id);
      if (room.players.every(p => p.favorites.length >= 2)) {
        room.phase = 'researching'; room.generation++;
        room.research = { status: 'working', at: now };
      }
      break;
    }
    case 'retry':
      host(); phase('researching'); requireThat(room.research?.status === 'error', 'Research is still working.');
      room.generation++; room.research = { status: 'working', at: now }; break;
    case 'familiarity': {
      phase('familiarity'); requireThat(room.candidates.some(e => e.id === action.id), 'Unknown discovery.');
      requireThat(['known', 'new', 'skip'].includes(action.value), 'Choose a familiarity option.');
      player.familiarity[action.id] = action.value; player.confirmed = false; break;
    }
    case 'confirm':
      phase('familiarity'); requireThat(room.candidates.every(e => ['known', 'new', 'skip'].includes(player.familiarity[e.id])), 'Mark every discovery first.');
      player.confirmed = true;
      if (room.players.every(p => p.confirmed)) {
        room.phase = 'briefing';
        room.players.forEach(p => { if (p.routeChoice && !eligible(room, p.routeChoice).length) p.routeChoice = null; });
      }
      break;
    case 'revise':
      requireThat(['briefing', 'familiarity'].includes(room.phase), 'Cards cannot be changed during a heist.');
      room.phase = 'familiarity'; player.confirmed = false; player.routeChoice = null; break;
    case 'retaste':
      requireThat(['briefing', 'familiarity'].includes(room.phase) || (room.phase === 'researching' && ['error', 'empty'].includes(room.research?.status)), 'Research must finish before changing favourites.'); room.generation++; room.phase = 'intake'; room.candidates = []; room.research = null;
      player.favorites = []; player.draft = [];
      room.players.forEach(p => { p.familiarity = {}; p.support = []; p.confirmed = false; p.routeChoice = null; }); break;
    case 'route':
      phase('briefing'); requireThat(room.players.every(p => p.confirmed), 'Wait for everyone to finish their cards.');
      requireThat(['shared', 'mentor'].includes(action.route), 'Choose a route.');
      requireThat(eligible(room, action.route).length > 0, 'No verified matches for that route. Revisit the cards or start with other favourites.');
      player.routeChoice = action.route;
      if (room.players.every(p => p.routeChoice === action.route)) { room.route = action.route; startPuzzle(room, random, now); }
      break;
    case 'share':
      phase('playing'); share(room, playerId); break;
    case 'chat': {
      const text = clean(action.text); requireThat(text, 'Write a message first.');
      room.messages.push({ id: `${now}-${room.version}`, playerId, text, at: now });
      room.messages = room.messages.slice(-60); break;
    }
    case 'pause':
      host(); phase('playing');
      if (room.pausedAt) { room.startedAt += now - room.pausedAt; room.pausedAt = null; } else room.pausedAt = now;
      break;
    case 'hint':
      phase('playing'); player.hints = Math.min(3, (player.hints || 0) + 1); break;
    case 'solve': {
      phase('playing'); requireThat(!room.pausedAt, 'Resume the heist first.'); room.attempts++;
      requireThat(player.solvedStage !== room.stage, 'You have cleared this room. Ready up when you want to continue.');
      let correct = false;
      if (room.stage === 0) correct = clean(action.answer, 8) === room.secrets.code;
      if (room.stage === 1) correct = eligible(room).some(e => e.id === action.answer);
      if (room.stage === 2) correct = Array.isArray(action.answer) && JSON.stringify(action.answer) === JSON.stringify(room.secrets.exit);
      requireThat(correct, room.stage === 1 ? 'That discovery does not meet the crew’s route. Compare every private list and familiarity mark.' : 'The lock is still closed. Compare your crew’s clues and try again.');
      if (room.stage === 1) player.discoveryId = action.answer;
      player.solvedStage = room.stage; player.readyStage = null;
      break;
    }
    case 'continue':
      phase('playing'); requireThat(!room.pausedAt, 'Resume the heist first.');
      requireThat(player.solvedStage === room.stage, 'Check your own answer before continuing.');
      player.readyStage = room.stage;
      if (room.players.every(p => p.solvedStage === room.stage && p.readyStage === room.stage)) {
        if (room.stage < 2) { room.stage++; room.players.forEach(p => { p.hints = 0; }); }
        else { room.phase = 'debrief'; room.finishedAt = now; room.elapsed = now - room.startedAt; }
      }
      break;
    default: throw new GameError('Unknown action.');
  }
  room.version++;
  return room;
}
const HINTS = [
  ['One agent has the order. The others have the decoder.', 'Share every clue on the crew board.', 'Replace each of the three ordered symbols with its digit.'],
  ['Compare the actual lists; the biggest list is not the answer.', 'A valid discovery must appear in every player’s research.', 'Shared route: everyone marked it new. Pass-it-on route: at least one knows it and at least one is new. Nobody skipped it.'],
  ['Read each arrow as “immediately before”.', 'Connect matching souvenirs into one chain.', 'Find the souvenir that never appears at the end of an arrow. It goes first.'],
];
export function project(room, playerId, now = Date.now()) {
  const self = room.players.find(p => p.id === playerId);
  requireThat(self, 'This session cannot view that crew.');
  const personalPhase = room.phase === 'familiarity' && self.confirmed ? 'briefing' : room.phase;
  const discovery = room.phase === 'debrief' ? room.candidates.find(entity => entity.id === self.discoveryId) || room.discovery : null;
  const view = {
    code: room.code, mode: 'live', phase: personalPhase, version: room.version,
    host: room.host, stage: room.stage, route: room.route, createdAt: room.createdAt,
    players: room.players.map(p => ({ id: p.id, name: p.name, avatar: p.avatar, ready: p.favorites.length >= 2, confirmed: p.confirmed, routeReady: !!p.routeChoice, cleared: room.phase === 'playing' && p.solvedStage === room.stage, readyForNext: room.phase === 'playing' && p.readyStage === room.stage })),
    self: { id: self.id, favorites: self.favorites.map(publicEntity), resolved: (self.resolved || []).map(publicEntity), draft: self.draft || [], familiarity: self.familiarity, confirmed: self.confirmed, routeChoice: self.routeChoice || null, solved: room.phase === 'playing' && self.solvedStage === room.stage, readyForNext: room.phase === 'playing' && self.readyStage === room.stage, clue: room.phase === 'playing' ? clueFor(room, playerId) : null },
    candidates: ['familiarity', 'briefing', 'playing', 'debrief'].includes(room.phase) ? room.candidates.map(publicEntity) : [],
    research: room.research, messages: room.messages, board: room.board,
    allCardsConfirmed: room.players.every(p => p.confirmed),
    routeConflict: room.phase === 'briefing' && room.players.every(p => p.routeChoice) && new Set(room.players.map(p => p.routeChoice)).size > 1,
    availableRoutes: personalPhase === 'briefing' ? ['shared', 'mentor'].map(route => ({ route, available: room.players.every(p => p.confirmed) && eligible(room, route).length > 0 })) : [],
    paused: !!room.pausedAt, elapsed: room.phase === 'debrief' ? room.elapsed : room.startedAt ? (room.pausedAt || now) - room.startedAt : 0,
    hints: self.hints || 0, hint: room.phase === 'playing' ? HINTS[room.stage][(self.hints || 0) - 1] : null,
    discovery: discovery ? publicEntity(discovery) : null,
  };
  if (discovery) view.evidence = room.players.map(p => ({ name: p.name, favorites: p.favorites.map(f => f.name), returned: p.support.includes(discovery.id), familiarity: p.familiarity[discovery.id] }));
  return view;
}
export function publicEntity(entity) {
  const { id, name, type, detail, description, year, creators, tags, color, provider, imageAttribution } = entity;
  return { id, name, type, detail, description, year, creators, tags, color, provider, imageAttribution, imageUrl: imagePathFor(entity) };
}
