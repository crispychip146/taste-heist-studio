import { SYMBOLS, EXIT_TOKENS } from '../shared/catalog.mjs';
import { imagePathFor } from './artwork.mjs';
import { shortlist } from './shortlist.mjs';
import { secureRandom, exitClues } from './puzzles.mjs';
import { providerFeedback } from './errors.mjs';

export class GameError extends Error {}
const requireThat = (condition, message) => { if (!condition) throw new GameError(message); };
const clean = (value, max = 180) => String(value ?? '').trim().slice(0, max);
const shuffle = (array, random) => array.reduce((out, item) => {
  out.splice(Math.floor(random() * (out.length + 1)), 0, item); return out;
}, []);
export function createRoom({ code, id, name, avatar = 0, practice = false, mode = 'live', now = Date.now() }) {
  requireThat(mode === 'live' && !practice, 'This version uses live Qloo research and human crews.');
  const room = {
    code, schemaVersion: 2, outcomeVersion: 1, host: id, mode: 'live', phase: 'lobby', players: [], version: 0,
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
  const expanded = room.research?.expanded === true;
  for (const player of room.players) {
    const result = results.find(r => r.playerId === player.id);
    const entities = expanded ? [...new Map([...(player.researchResults || []), ...(result?.entities || [])].map(entity => [entity.id, entity])).values()] : result?.entities || [];
    player.support = entities.map(e => e.id);
    player.researchResults = entities;
    player.researchRequests = expanded ? [...new Map([...(player.researchRequests || []), ...(result?.requests || [])].map(request => [request.requestId, request])).values()] : result?.requests || [];
  }
  // Present candidates supported by everyone first; membership stays private until shared.
  const combined = tasteResults(room);
  if (expanded) {
    const reviewed = combined.flatMap(result => result.entities).filter(entity => room.players.every(player => ['known', 'new', 'skip'].includes(player.familiarity[entity.id]))).map(entity => entity.id);
    const fresh = shortlist(combined, new Set(reviewed));
    room.candidates = [...new Map([...fresh, ...shortlist(combined)].map(entity => [entity.id, entity])).values()].slice(0, 9);
  } else room.candidates = shortlist(combined);
  for (const player of room.players) {
    const previous = expanded ? player.familiarity : {};
    player.routeChoice = null;
    player.familiarity = { ...previous, ...Object.fromEntries(room.candidates.map(e => [e.id, selectedFavorite(player, e.id) ? previous[e.id] === 'skip' ? 'skip' : 'known' : previous[e.id] || 'unknown'])) };
    player.confirmed = room.candidates.every(entity => ['known', 'new', 'skip'].includes(player.familiarity[entity.id]));
  }
  room.phase = room.players.every(player => player.confirmed) ? 'briefing' : 'familiarity';
  room.updatedAt = now; room.research = { status: 'complete', count: results.length, at: now, expanded, metadataWarning: results.find(result => result.metadataWarning)?.metadataWarning || null };
}
const selectedFavorite = (player, id) => player.favorites.some(entity => entity.id === id);
const fits = (player, id) => player.support.includes(id) || selectedFavorite(player, id);
function tasteResults(room) {
  const seeds = new Set(room.players.flatMap(player => player.favorites.map(entity => entity.id)));
  // An owner’s favourite proves their own interest, never anyone else’s.
  // Only introduce it when every other profile has independent supporting evidence.
  return room.players.map(player => ({ playerId: player.id, entities: [...new Map([...(player.researchResults || []), ...player.favorites].map(entity => [entity.id, entity])).values()]
    .filter(entity => !seeds.has(entity.id) || (room.players.every(person => fits(person, entity.id)) && !room.players.every(person => selectedFavorite(person, entity.id)))) }));
}
export function canRefine(room) {
  return !room.research?.expanded || tasteResults(room).some(result => result.entities.some(entity => room.players.some(player => !['known', 'new', 'skip'].includes(player.familiarity[entity.id]))));
}
export function eligible(room, route = room.route) {
  return room.candidates.filter(entity => {
    if (!room.players.every(p => fits(p, entity.id))) return false;
    const marks = room.players.map(p => p.familiarity[entity.id]);
    if (route === 'shared') return marks.every(m => m === 'new') && room.players.every(player => !selectedFavorite(player, entity.id));
    if (route === 'mentor') return marks.includes('known') && marks.includes('new') && marks.every(m => ['known', 'new'].includes(m));
    return false;
  });
}
// Upgrade the former individual-outcome flow without choosing a winner or losing tastes.
export function upgradeOutcome(room) {
  if (room.outcomeVersion === 1) return false;
  room.outcomeVersion = 1;
  if (['playing', 'debrief'].includes(room.phase)) {
    room.phase = 'researching'; room.research = { expanded: true };
    installResearch(room, room.players.map(player => ({ playerId: player.id, entities: player.researchResults || [], requests: player.researchRequests || [] })), room.updatedAt);
    room.route = null; room.discovery = null; room.stage = 0; room.board = [];
    delete room.secrets; room.startedAt = null; room.pausedAt = null;
    room.players.forEach(player => { player.solvedStage = null; player.readyStage = null; player.discoveryId = null; });
    room.notice = 'Your saved tastes are here. This heist now needs one discovery agreed by everyone. Choose your route together.';
  }
  delete room.exchangeVersion;
  room.version++;
  return true;
}
export function startPuzzle(room, random = secureRandom, now = Date.now()) {
  const order = shuffle(SYMBOLS, random);
  const digits = shuffle(Array.from({ length: 10 }, (_, i) => String(i)), random);
  const mapping = Object.fromEntries(SYMBOLS.map((s, i) => [s, digits[i]]));
  const exit = shuffle(EXIT_TOKENS, random);
  room.secrets = { order, mapping, code: order.map(s => mapping[s]).join(''), exit, exitClues: exitClues(exit, room.players.length, random) };
  room.phase = 'playing'; room.stage = 0; room.startedAt = now; room.elapsed = 0; room.pausedAt = null;
  room.discovery = null; room.notice = null; room.board = []; room.hints = 0; room.attempts = 0;
  room.players.forEach(player => { player.solvedStage = null; player.readyStage = null; player.hints = 0; player.discoveryId = null; });
}
export function clueFor(room, playerId, stage = room.stage) {
  const index = room.players.findIndex(p => p.id === playerId);
  if (index < 0 || !room.secrets) return null;
  const count = room.players.length;
  if (stage === 0) {
    if (index === 0) return { kind: 'order', symbols: room.secrets.order, text: 'Read these symbols from left to right. Your crew has the numbers.' };
    const pairs = Object.entries(room.secrets.mapping).filter((_, i) => i % (count - 1) === index - 1);
    return { kind: 'mapping', pairs, text: 'These are your decoder pieces. Another agent has the symbol order.' };
  }
  if (stage === 1) {
    const player = room.players[index];
    return { kind: 'connections', entities: eligible(room).map(e => ({ id: e.id, name: e.name, familiarity: player.familiarity[e.id] })), text: 'Every discovery here already fits your whole crew and chosen route. Your own familiarity is shown here. Choose what you want to experience together.' };
  }
  if (room.secrets.exitClues) return structuredClone(room.secrets.exitClues[index]);
  return { kind: 'sequence', first: count === 4 && index === 3 ? room.secrets.exit[0] : null, pairs: room.secrets.exit.slice(0, 3).map((item, i) => [item, room.secrets.exit[i + 1]])
    .filter((_, i) => i % count === index), text: 'Put the souvenirs in order. Each arrow means “immediately before”.' };
}
function share(room, playerId) {
  if (room.board.some(b => b.playerId === playerId && b.stage === room.stage)) return;
  room.board.push({ playerId, stage: room.stage, clue: clueFor(room, playerId), at: room.updatedAt });
}
export function command(room, playerId, action, now = Date.now(), random = secureRandom) {
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
      room.generation++; room.players.forEach(person => { person.routeChoice = null; }); room.research = { status: 'working', expanded: room.research.expanded === true, at: now }; break;
    case 'refine':
      phase('briefing'); requireThat(room.players.every(person => person.confirmed), 'Wait for everyone to finish their cards.');
      requireThat(canRefine(room), 'You have reviewed this trail. Revisit your cards or adjust your favourites to search a different direction.');
      room.phase = 'researching'; room.generation++; room.players.forEach(person => { person.routeChoice = null; });
      room.research = { status: 'working', expanded: true, stage: 'widening', at: now }; break;
    case 'familiarity': {
      phase('familiarity'); requireThat(room.candidates.some(e => e.id === action.id), 'Unknown discovery.');
      requireThat(['known', 'new', 'skip'].includes(action.value), 'Choose a familiarity option.');
      requireThat(action.value !== 'new' || !selectedFavorite(player, action.id), 'You selected this as a favourite. Mark it known, or skip it for this heist.');
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
      requireThat(room.candidates.length > 0, 'There are no research cards to revisit. Widen the search or adjust your favourites.');
      room.phase = 'familiarity'; player.confirmed = false; player.routeChoice = null; break;
    case 'retaste':
      requireThat(['briefing', 'familiarity'].includes(room.phase) || (room.phase === 'researching' && ['error', 'empty'].includes(room.research?.status)), 'Research must finish before changing favourites.'); room.generation++; room.phase = 'intake'; room.candidates = []; room.research = null;
      player.favorites = []; player.draft = [];
      room.players.forEach(p => { p.familiarity = {}; p.support = []; p.researchResults = []; p.researchRequests = []; p.confirmed = false; p.routeChoice = null; }); break;
    case 'route':
      phase('briefing');
      requireThat(room.players.every(p => p.confirmed), 'Wait for everyone to finish their cards.');
      requireThat(['shared', 'mentor'].includes(action.route), 'Choose a route.');
      requireThat(eligible(room, action.route).length > 0, 'This route needs another discovery. Widen the search, revisit your cards or adjust your favourites.');
      player.routeChoice = action.route;
      if (room.players.every(p => p.routeChoice === action.route)) {
        room.route = action.route; startPuzzle(room, random, now);
      }
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
    case 'reconsider':
      phase('playing'); requireThat(room.stage === 1 && !room.pausedAt, 'Discovery proposals can only change in the common-ground room.');
      player.solvedStage = null; player.readyStage = null; player.discoveryId = null; break;
    case 'solve': {
      phase('playing'); requireThat(!room.pausedAt, 'Resume the heist first.'); room.attempts++;
      requireThat(player.solvedStage !== room.stage, 'You have cleared this room. Ready up when you want to continue.');
      let correct = false;
      if (room.stage === 0) correct = clean(action.answer, 8) === room.secrets.code;
      if (room.stage === 1) {
        requireThat(eligible(room).some(e => e.id === action.answer), 'Choose one of the crew recommendations shown in Common Ground.');
        correct = true;
      }
      if (room.stage === 2) correct = Array.isArray(action.answer) && JSON.stringify(action.answer) === JSON.stringify(room.secrets.exit);
      if (!correct) {
        const error = new GameError('The lock is still closed. Compare your crew’s clues and try again.');
        error.code = 'WRONG_ANSWER'; throw error;
      }
      if (room.stage === 1) player.discoveryId = action.answer;
      player.solvedStage = room.stage; player.readyStage = null;
      break;
    }
    case 'continue':
      phase('playing'); requireThat(!room.pausedAt, 'Resume the heist first.');
      requireThat(player.solvedStage === room.stage, 'Check your own answer before continuing.');
      player.readyStage = room.stage;
      if (room.players.every(p => p.solvedStage === room.stage && p.readyStage === room.stage)) {
        if (room.stage === 1) {
          if (new Set(room.players.map(person => person.discoveryId)).size !== 1) break;
          room.discovery = room.candidates.find(entity => entity.id === player.discoveryId);
          requireThat(room.discovery && eligible(room).some(entity => entity.id === room.discovery.id), 'Agree on a discovery that fits your route.');
        }
        if (room.stage < 2) { room.stage++; room.players.forEach(p => { p.hints = 0; }); }
        else {
          requireThat(room.discovery && room.players.every(person => person.discoveryId === room.discovery.id), 'Your crew must agree on one discovery before the reveal.');
          room.phase = 'debrief'; room.finishedAt = now; room.elapsed = now - room.startedAt;
        }
      }
      break;
    default: throw new GameError('Unknown action.');
  }
  room.version++;
  return room;
}
const HINTS = [
  ['One agent has the order. The others have the decoder.', 'Share every clue on the crew board.', 'Replace each ordered symbol with its digit.'],
  ['Every card shown already fits your whole crew and chosen route.', 'Choose what you would like to watch, read or listen to together.', 'Everyone confirms the same discovery. If your proposals differ, talk it through and change a proposal.'],
  ['Read each arrow as “immediately before”.', 'Connect matching souvenirs into one chain.', 'Find the souvenir that never appears at the end of an arrow. It goes first.'],
];
export function project(room, playerId, now = Date.now()) {
  const self = room.players.find(p => p.id === playerId);
  requireThat(self, 'This session cannot view that crew.');
  const personalPhase = room.phase === 'familiarity' && self.confirmed ? 'briefing' : room.phase;
  const discovery = room.phase === 'debrief' ? room.discovery : null;
  const commonGround = room.phase === 'playing' && room.stage === 1;
  const candidates = commonGround ? eligible(room) : room.candidates;
  const matchedIds = new Set(candidates.map(entity => entity.id));
  let research = room.research;
  if (research?.status === 'error' && research.code) {
    const { message, code } = providerFeedback({ code: research.code });
    research = { ...research, message, code };
  }
  const hints = room.stage === 2 && room.secrets?.exitClues && room.players.length === 4
    ? ['Each agent has one rule. You need all four.', 'Before allows a gap. Beside means neighbours, in either order.', 'Check each possible sequence against all four rules.'] : HINTS[room.stage];
  const view = {
    code: room.code, mode: 'live', phase: personalPhase, version: room.version,
    host: room.host, stage: room.stage, route: room.route, createdAt: room.createdAt, signalLength: room.secrets?.order.length || 4,
    players: room.players.map(p => ({ id: p.id, name: p.name, avatar: p.avatar, ready: p.favorites.length >= 2, confirmed: p.confirmed, routeReady: !!p.routeChoice, cleared: room.phase === 'playing' && p.solvedStage === room.stage, readyForNext: room.phase === 'playing' && p.readyStage === room.stage })),
    self: { id: self.id, favorites: self.favorites.map(publicEntity), resolved: (self.resolved || []).map(publicEntity), draft: self.draft || [], familiarity: self.familiarity, confirmed: self.confirmed, routeChoice: self.routeChoice || null, solved: room.phase === 'playing' && self.solvedStage === room.stage, readyForNext: room.phase === 'playing' && self.readyStage === room.stage, clue: room.phase === 'playing' ? clueFor(room, playerId) : null },
    candidates: ['familiarity', 'briefing', 'playing', 'debrief'].includes(room.phase) ? candidates.map(entity => ({ ...publicEntity(entity), ...(commonGround ? { connection: { total: room.players.length, known: room.players.filter(player => player.familiarity[entity.id] === 'known').length, new: room.players.filter(player => player.familiarity[entity.id] === 'new').length } } : {}) })) : [],
    research,
    notice: room.notice || null, messages: room.messages,
    board: commonGround ? room.board.map(entry => entry.stage === 1 && entry.clue?.kind === 'connections' ? { ...entry, clue: { ...entry.clue, entities: entry.clue.entities.filter(entity => matchedIds.has(entity.id)) } } : entry) : room.board,
    canRefine: personalPhase === 'briefing' && canRefine(room),
    allCardsConfirmed: room.players.every(p => p.confirmed),
    routeConflict: personalPhase === 'briefing' && room.players.every(p => p.routeChoice) && new Set(room.players.map(p => p.routeChoice)).size > 1,
    availableRoutes: personalPhase === 'briefing' ? ['shared', 'mentor'].map(route => ({ route, available: room.players.every(p => p.confirmed) && eligible(room, route).length > 0 })) : [],
    proposals: room.phase === 'playing' && room.stage === 1 ? room.players.map(player => ({ playerId: player.id, entity: player.solvedStage === 1 ? publicEntity(room.candidates.find(entity => entity.id === player.discoveryId)) : null })) : [],
    discoveryConflict: room.phase === 'playing' && room.stage === 1 && room.players.every(player => player.solvedStage === 1) && new Set(room.players.map(player => player.discoveryId)).size > 1,
    paused: !!room.pausedAt, elapsed: room.phase === 'debrief' ? room.elapsed : room.startedAt ? (room.pausedAt || now) - room.startedAt : 0,
    hints: self.hints || 0, hint: room.phase === 'playing' ? hints[(self.hints || 0) - 1] : null,
    discovery: discovery ? publicEntity(discovery) : null,
  };
  if (discovery) view.evidence = room.players.map(p => ({ name: p.name, favorites: p.favorites.map(f => f.name), returned: p.support.includes(discovery.id) || (p.researchRequests || []).some(request => request.returnedIds?.includes(discovery.id)), familiarity: p.familiarity[discovery.id] || 'unknown', selectedFavorite: selectedFavorite(p, discovery.id),
    receipts: (p.researchRequests || []).filter(request => request.returnedIds?.includes(discovery.id)).map(({ requestId, category, inputIds, limit, completedAt, status }) => ({ requestId, category, inputIds, limit, completedAt, status, entityId: discovery.id, source: 'qloo', basis: 'combined favourites' })) }));
  return view;
}
export function publicEntity(entity) {
  const { id, name, type, detail, description, year, creators, tags, color, provider, imageAttribution } = entity;
  return { id, name, type, detail, description, year, creators, tags, color, provider, imageAttribution, imageUrl: imagePathFor(entity) };
}
