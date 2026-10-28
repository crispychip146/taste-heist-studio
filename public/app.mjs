import { CHARACTERS, EXIT_TOKENS } from '/shared/catalog.mjs';
import { icon, avatar, tile, vault, escapeHTML as e } from './art.mjs';
import { Transport } from './transport.mjs';
import { readPreference, savePreference, preferredTheme, applyTheme } from './preferences.mjs';

const main = document.querySelector('main');
const state = { screen: 'home', following: false, room: null, avatar: 0, name: '', filter: 'all', selected: [], searchResults: [], searchQuery: '', searchType: 'movie', searching: false, searched: false, familiarIndex: 0, busy: false, connection: '', motion: readPreference('heist:motion') !== 'off', theme: preferredTheme(), sound: false, exit: [...EXIT_TOKENS], swapping: null, codeInput: '', tutorial: 0, joinCode: new URLSearchParams(location.search).get('join') || '', chatDraft: '', discoveryChoice: null, lastCardPaint: null, renderSignature: '', errors: {} };
const ROOM_NAMES = ['The listening room', 'The common ground', 'The great escape'];
let toastTimer, elapsedAt = Date.now(), formError = '';
const transport = new Transport(receive, status => { state.connection = status; updateConnection(); });
document.documentElement.dataset.motion = state.motion ? 'on' : 'off';
applyTheme(state.theme);

function receive(room, { restored = false, entered = false } = {}) {
  if (entered) { state.following = true; state.screen = 'room'; }
  const sameRoom = state.room && room.code === state.room.code && room.createdAt === state.room.createdAt;
  if (sameRoom && room.version <= state.room.version) { if (entered) render(true); return; }
  const previous = state.room;
  const changed = !sameRoom || previous.phase !== room.phase || previous.stage !== room.stage;
  const { version, elapsed, ...visible } = room;
  const signature = JSON.stringify(visible);
  state.room = room; elapsedAt = Date.now();
  if (sameRoom && signature === state.renderSignature) { if (entered) render(true); return; }
  state.renderSignature = signature;
  if (changed) {
    state.errors = {}; formError = '';
    if (state.following && !restored) state.screen = 'room';
    state.familiarIndex = 0; state.codeInput = ''; state.exit = [...EXIT_TOKENS]; state.swapping = null; state.discoveryChoice = null; state.lastCardPaint = null;
    state.selected = room.self.draft || room.self.favorites.map(f => f.id);
    if (!sameRoom || room.phase === 'intake') { state.searchResults = []; state.searchQuery = ''; state.searched = false; }
    if (restored || state.following) announce(restored ? 'Your previous heist is saved. Start fresh, or choose Resume from the header.' : room.phase === 'playing' ? ROOM_NAMES[room.stage] : `Crew ${room.code}: ${room.phase}`);
    if (state.following && previous?.phase === 'playing' && (room.stage !== previous.stage || room.phase === 'debrief')) { celebrate(); tone(); }
  }
  if (state.following && room.self.solved && !previous?.self.solved && room.phase === 'playing') { celebrate(); tone(); announce(room.stage === 1 ? 'Your proposal fits the route. Agree on the same discovery with your crew.' : 'Your answer is correct. Ready up when you want to continue.'); }
  if (state.screen === 'room') { render(changed); if (room.self.solved && !previous?.self.solved) document.querySelector('.personal-checkpoint h2')?.focus({ preventScroll: true }); }
  else renderHeader();
}
function announce(text) { document.querySelector('#announcer').textContent = text; }
function toast(text) {
  const node = document.querySelector('#toast'); node.textContent = text; node.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { node.hidden = true; }, 5500);
}
function errorRegion(scope) {
  const text = state.errors[scope] || '';
  return `<p id="${scope}-error" class="form-error action-error" role="alert" ${text ? '' : 'hidden'}>${e(text)}</p>`;
}
function clearError(scope) {
  delete state.errors[scope]; if (scope === 'form') formError = '';
  const box = document.getElementById(`${scope}-error`); if (box) { box.textContent = ''; box.hidden = true; }
}
function error(text, scope) {
  state.errors[scope] = text; if (scope === 'form') formError = text;
  const specific = document.getElementById(`${scope}-error`), box = specific || document.getElementById('action-error');
  if (!specific) state.errors.action = text;
  if (box) { box.textContent = text; box.hidden = false; } else announce(text);
  if (scope === 'search') {
    const retry = document.querySelector('#search-form button[type=submit]');
    if (retry) retry.textContent = 'Try search again';
  }
}
async function perform(task, scope = 'form') {
  if (state.busy) return false; state.busy = true; clearError(scope);
  document.documentElement.dataset.busy = 'true';
  const submit = scope === 'form' ? document.querySelector('#crew-form button[type=submit]') : null;
  const label = submit?.innerHTML;
  if (submit) { submit.disabled = true; submit.textContent = state.screen === 'join' ? 'Joining…' : 'Assembling…'; }
  try { await task(); return true; }
  catch (err) { error(err.message + (err.retryAfter ? ` Try again in ${err.retryAfter} ${err.retryAfter === 1 ? 'second' : 'seconds'}.` : ''), scope); return false; }
  finally {
    state.busy = false; document.documentElement.dataset.busy = 'false';
    if (submit?.isConnected) { submit.disabled = false; submit.innerHTML = label; }
  }
}
async function act(type, values = {}) {
  const scope = { solve: 'puzzle', reconsider: 'puzzle', route: 'route', confirm: 'familiarity', favorites: 'intake', selection: 'intake', retry: 'research', refine: 'route', retaste: state.room?.phase === 'researching' ? 'research' : 'route' }[type] || 'action';
  return perform(() => transport.act({ type, ...values }), scope);
}
function focusDiscovery() {
  if (state.room?.phase !== 'familiarity') return;
  const item = state.room.candidates[state.familiarIndex];
  if (item) announce(`${item.name}. Discovery ${state.familiarIndex + 1} of ${state.room.candidates.length}.`);
  document.getElementById('discovery-title')?.focus({ preventScroll: true });
}
function artCredit(item) { return item.imageAttribution ? `<small class="image-attribution">Artwork: ${e(item.imageAttribution)}</small>` : ''; }
function sourceReceipts(person) {
  if (!person.receipts?.length) return '';
  return `<details class="source-receipts"><summary>Qloo source record</summary><p>Recommended from the combined favourites above. This does not establish a separate affinity to each favourite.</p><ul>${person.receipts.map(receipt => `<li>${e(receipt.category)} · ${e(receipt.status)} · ${e(new Date(receipt.completedAt).toLocaleString())}</li>`).join('')}</ul></details>`;
}
function sourceBadge() { return `<span class="source-badge">${state.room?.research?.status === 'error' ? 'Qloo research paused' : 'Live Qloo research'}</span>`; }
function button(label, action, className = 'primary', extra = '') { return `<button type="button" class="button ${className}" data-action="${action}" ${extra}>${label}</button>`; }
function renderHeader() {
  const resumeLabel = state.room?.phase === 'debrief'
    ? '<span class="nav-full-label">View last dossier</span><span class="nav-short-label">Dossier</span>'
    : '<span class="nav-full-label">Resume saved heist</span><span class="nav-short-label">Crew</span>';
  document.querySelector('#header').innerHTML = `<div class="header-inner">
    <a href="#home" class="brand" data-action="home" aria-label="Taste Heist home">${vault()}<span>Taste<span class="brand-second">Heist</span><span class="brand-dot">.</span></span></a>
    <nav aria-label="Main navigation">${state.room && state.screen !== 'room' ? button(resumeLabel + ' ' + icon('arrow'), 'resume', 'quiet') : state.screen === 'home' ? '<a href="#how-it-works" class="nav-link">How to play</a>' : button(icon('back') + ' Home', 'home', 'quiet')}
      <button class="icon-button theme-toggle" type="button" data-action="theme" aria-label="Switch to ${state.theme === 'dark' ? 'light' : 'dark'} mode" aria-pressed="${state.theme === 'dark'}" title="Switch to ${state.theme === 'dark' ? 'light' : 'dark'} mode">${icon(state.theme === 'dark' ? 'sun' : 'moon')}</button>
      <button class="icon-button motion-toggle" type="button" data-action="motion" aria-label="Animations" aria-pressed="${state.motion}" title="Toggle animations">${icon('motion')}</button>
      <button class="icon-button sound-toggle" type="button" data-action="sound" aria-label="Game sounds" aria-pressed="${state.sound}" title="Toggle game sounds">${icon('sound')}</button>
      ${state.screen === 'home' && !state.room ? button('<span class="nav-full-label">Join a crew</span><span class="nav-short-label">Join</span>', 'join', 'outline compact', 'aria-label="Join a crew"') : ''}
    </nav></div>`;
}
function render(focus = false) {
  const active = document.activeElement; const focusedId = active?.id; const selection = active?.selectionStart;
  const draftValue = ['INPUT', 'SELECT'].includes(active?.tagName) ? active.value : null;
  const focusedAction = active?.dataset?.action; const focusedValue = active?.dataset?.value;
  renderHeader();
  main.innerHTML = (state.screen === 'home' ? home() : ['create', 'join'].includes(state.screen) ? setup() : roomView()) + `<div class="wrap">${errorRegion('action')}</div>`;
  document.querySelector('#footer').innerHTML = `<div><a href="#home" data-action="home">A little culture. A little trouble.</a><button type="button" class="footer-motion" data-action="motion" aria-pressed="${state.motion}">${icon('motion')} Animations ${state.motion ? 'on' : 'off'}</button><button type="button" class="footer-sound" data-action="sound" aria-pressed="${state.sound}">${icon('sound')} Game sounds ${state.sound ? 'on' : 'off'}</button><span>${state.screen === 'room' ? sourceBadge() : 'Made for curious people & their accomplices.'}</span></div>`;
  if (focus) { main.focus({ preventScroll: true }); window.scrollTo({ top: 0, behavior: 'instant' }); }
  else if (focusedId) {
    const restored = document.getElementById(focusedId); restored?.focus({ preventScroll: true });
    if (restored && draftValue !== null) restored.value = draftValue;
    if (selection !== null && restored?.setSelectionRange) try { restored.setSelectionRange(selection, selection); } catch {}
  }
  else if (focusedAction) [...document.querySelectorAll('[data-action]')].find(node => node.dataset.action === focusedAction && node.dataset.value === focusedValue)?.focus({ preventScroll: true });
  if (motionAllowed() && focus && main.animate) main.animate([{ opacity: .4, transform: 'translateY(12px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 380, easing: 'cubic-bezier(.2,.7,.2,1)' });
  updateConnection();
}
function home() {
  return `<section class="hero wrap">
    <div class="hero-copy"><h1>Good taste.<br>Great <em>accomplices.</em></h1>
      <p class="hero-description">A cooperative escape game shaped by your favourite films, books and music.</p>
      <div class="hero-actions">${button('Assemble your crew ' + icon('arrow'), 'create')}${button('Got an invite?', 'join', 'text-button')}</div>
      <div class="hero-note"><span class="crew-peek">${[0, 1, 2].map(i => avatar(i)).join('')}</span><span>2–4 friends. Three rooms.<br>One unexpected connection.</span></div>
    </div>
    <div class="hero-stage" aria-label="Explore the cultural archive and meet your crew">
      <div class="hero-decoration" aria-hidden="true"><span class="stage-orbit orbit-one"></span><span class="stage-orbit orbit-two"></span><img class="hero-archive" src="/assets/archive.webp" alt="" width="1536" height="1024" fetchpriority="high"></div>
      <span class="stage-note">Something good<br>is locked in here.</span>
      <button class="vault-peek" type="button" data-action="peek">Peek inside ${icon('arrow')}</button>
      <div class="hero-crew">${CHARACTERS.map((c, i) => `<button type="button" class="crew-toy toy-${i} ${state.avatar === i ? 'chosen' : ''}" data-action="character" data-value="${i}" aria-label="Meet ${c.name}, ${c.role}" aria-pressed="${state.avatar === i}">${avatar(i, 'toy-avatar')}<span class="toy-name">${c.name} ${icon('plus')}</span></button>`).join('')}</div>
      <div class="stage-stamp">Curiosity<br><strong>looks good on you.</strong>${icon('spark')}</div>
    </div>
  </section>
  <section class="meet-strip wrap" aria-live="polite"><span class="hand-drawn-arrow">${icon('arrow')}</span><p><strong>Meet ${CHARACTERS[state.avatar].name}.</strong> ${['A little mischief goes a long way.', 'Collects stories. Occasionally borrows vault keys.', 'Big heart. Excellent getaway instincts.', 'Runs on curiosity. And a very small battery.'][state.avatar]}</p><span class="strip-note">Pick your partner in crime.</span></section>
  <section class="how-section wrap" id="how-it-works"><div class="section-title"><h2>A heist with <em>better loot.</em></h2><p>No trivia genius required.<br>Just bring a little you.</p></div>
    <div class="how-play"><div class="how-tabs" role="tablist" aria-label="How to play">${['Bring your taste', 'Connect the clues', 'Get away with something new'].map((label, i) => `<button type="button" role="tab" id="how-tab-${i}" aria-selected="${state.tutorial === i}" aria-controls="how-panel" tabindex="${state.tutorial === i ? 0 : -1}" data-action="tutorial" data-value="${i}"><span>0${i + 1}</span>${label}${icon('arrow')}</button>`).join('')}</div>
      <div class="how-preview ${['mint', 'blue', 'gold'][state.tutorial]}" id="how-panel" role="tabpanel" aria-labelledby="how-tab-${state.tutorial}">${tutorial()}</div></div>
  </section>
  <section class="last-call wrap"><h2>Strangers to something.<br><em>Accomplices in everything.</em></h2>${button('Let’s get into trouble ' + icon('arrow'), 'create')}<p>A cooperative game about the things that bring us together.</p></section>`;
}
function tutorial() {
  if (state.tutorial === 0) return `<div class="preview-fan">${[{type:'movie',color:'coral',name:'Your favourite film'},{type:'book',color:'blue',name:'A book you love'},{type:'artist',color:'mint',name:'Your kind of music'}].map(item => `<div class="mini-culture">${tile(item)}<strong>${item.name}</strong></div>`).join('')}</div><p>Pick the films, books and music you love.</p>`;
  if (state.tutorial === 1) return `<div class="preview-clues"><span>${icon('orbit')} = 4</span>${avatar(1)}<span>${icon('wave')} = 8</span></div><p>You get a clue. Your friends get the others. Talk it out.</p>`;
  return `<div class="preview-discovery">${icon('spark')}${tile({ type: 'book', color: 'coral' })}${icon('spark')}</div><p>The real treasure? A discovery you can share.</p>`;
}
function characterPicker() {
  return `<div class="character-picker" role="group" aria-label="Choose your character">${CHARACTERS.map((c, i) => `<button type="button" class="character-option ${c.color} ${state.avatar === i ? 'selected' : ''}" data-action="pick-avatar" data-value="${i}" aria-pressed="${state.avatar === i}">${avatar(i)}<span><strong>${c.name}</strong><small>${c.role}</small></span><span class="selection-tick">${icon('check')}</span></button>`).join('')}</div>`;
}
function setup() {
  const joining = state.screen === 'join';
  return `<section class="setup-page wrap"><div class="setup-heading"><h1>${joining ? 'Every crew needs<br><em>a little you.</em>' : 'Good company.<br><em>Questionable intentions.</em>'}</h1><p>${joining ? 'Got an invite? Your accomplices are waiting.' : 'Pick a character. Invite your people. Make a little trouble.'}</p></div>
    <form id="crew-form" class="setup-form">${!transport.online ? '<p class="notice">The archive server is temporarily unavailable. Your crew needs a live connection.</p>' : !transport.research.configured ? '<p class="notice">The archive’s research connection needs attention. Please try again shortly.</p>' : ''}${joining && state.room && state.room.phase !== 'debrief' ? `<p class="notice">Joining another crew will switch this browser’s session from crew ${e(state.room.code)}.</p>` : ''}<label class="field-label" for="agent-name">What should we call you?</label><input id="agent-name" name="name" placeholder="Your agent name" maxlength="24" required autocomplete="nickname" value="${e(state.name)}">
      <span class="field-label">Choose your accomplice</span>${characterPicker()}
      ${joining ? `<label class="field-label" for="crew-code">Your five-character crew code</label><input id="crew-code" name="code" class="code-field" placeholder="CREW5" maxlength="5" minlength="5" pattern="[A-Za-z2-9]{5}" required autocomplete="off" value="${e(state.joinCode)}">` : '<p class="small-note live-note">Bring 2–4 friends. Discoveries come from live Qloo research.</p>'}
      <p id="form-error" class="form-error" role="alert" ${formError ? '' : 'hidden'}>${e(formError)}</p>
      <button class="button primary wide" type="submit">${state.busy ? joining ? 'Joining…' : 'Assembling…' : joining ? 'Join the crew' : 'Make it a heist'}${icon('arrow')}</button>
    </form></section>`;
}
function crewRow(room, large = false) {
  return `<div class="crew-row ${large ? 'large' : ''}">${room.players.map(p => `<div class="crew-member ${p.id === room.self.id ? 'is-you' : ''}">${avatar(p.avatar, '', room.phase === 'debrief')}<span>${e(p.name)}${p.id === room.self.id ? ' <small class="you-label">(you)</small>' : ''}<small class="member-status">${room.phase === 'playing' ? p.readyForNext ? 'Ready to continue' : p.cleared ? 'Room cleared' : 'Solving this room' : ['briefing', 'familiarity'].includes(room.phase) ? p.routeReady ? 'Route chosen' : p.confirmed ? 'Cards checked' : 'Checking cards' : p.id === room.host ? 'Crew host' : 'Accomplice'}</small></span>${(room.phase === 'playing' ? p.cleared : ['briefing', 'familiarity'].includes(room.phase) ? p.confirmed : p.ready) ? `<span class="ready-dot" aria-label="Ready">${icon('check')}</span>` : ''}</div>`).join('')}</div>`;
}
function roomView() {
  const room = state.room; if (!room) return home();
  if (room.phase === 'lobby') return lobby(room);
  if (room.phase === 'intake') return intake(room);
  if (room.phase === 'researching') return research(room);
  if (room.phase === 'familiarity') return familiarity(room);
  if (room.phase === 'briefing') return briefing(room);
  if (room.phase === 'playing') return game(room);
  if (room.phase === 'debrief') return debrief(room);
  return '';
}
function roomBar(room, label) {
  return `<div class="room-bar"><span>${label}</span><div>${sourceBadge()}<span id="connection" class="connection"></span></div></div>`;
}
function lobby(room) {
  return `<section class="lobby wrap">${roomBar(room, 'Your crew is coming together')}<div class="lobby-layout"><div><h1>It takes<br><em>good accomplices.</em></h1><p>Send your friends the code.<br>Everyone brings a different piece of the puzzle.</p><div class="invite-code"><span>CREW CODE</span><strong>${e(room.code)}</strong>${button(icon('copy') + ' Copy invite', 'copy', 'outline')}</div>${crewRow(room, true)}<div class="lobby-actions">${room.host === room.self.id ? button('Everybody in? Let’s go ' + icon('arrow'), 'begin', 'primary', room.players.length < 2 ? 'disabled' : '') : '<p class="waiting-note">Your host will start when everybody is here.</p>'}<small>${room.players.length}/4 agents · no account needed</small></div></div><div class="lobby-art"><img src="/assets/archive.webp" alt="Your three-room cultural archive" width="1536" height="1024">${room.players.map((p, i) => `<div class="lobby-toy lobby-toy-${i}">${avatar(p.avatar)}</div>`).join('')}</div></div></section>`;
}
function intake(room) {
  const ready = room.players.find(p => p.id === room.self.id).ready;
  const catalog = [...new Map([...(room.self.resolved || []), ...room.self.favorites, ...state.searchResults].map(f => [f.id, f])).values()];
  const displayedIds = state.searched ? new Set([...state.searchResults.map(entity => entity.id), ...state.selected]) : null;
  const filtered = catalog.filter(entity => (!displayedIds || displayedIds.has(entity.id)) && (state.filter === 'all' || entity.type === state.filter));
  return `<section class="taste-page wrap">${roomBar(room, 'First, a little you')}<div class="taste-heading"><div><h1>Your taste.<br><em>Our way in.</em></h1><p>Choose 2–4 things you love. No guilty pleasures here.</p></div><div class="taste-character">${avatar(room.players.find(p => p.id === room.self.id).avatar, '', state.selected.length >= 2)}<span>Excellent taste.<br>I can work with this.</span></div></div>
    ${ready ? `<div class="notice">${icon('check')} Your tastes are in. Waiting for ${room.players.filter(p => !p.ready).map(p => e(p.name)).join(', ')}.</div>` : ''}
    <form id="search-form" class="live-search"><label class="sr-only" for="search-query">Search your favourites</label><input id="search-query" value="${e(state.searchQuery)}" placeholder="A favourite film, book or artist…" minlength="2" maxlength="100" required><label class="sr-only" for="search-type">Category</label><select id="search-type">${[['movie','Films'],['book','Books'],['artist','Music']].map(([value,label]) => `<option value="${value}" ${state.searchType === value ? 'selected' : ''}>${label}</option>`).join('')}</select><button class="button outline" type="submit" ${state.searching ? 'disabled' : ''}>${state.searching ? 'Searching…' : state.errors.search ? 'Try search again' : 'Search'}</button></form>${errorRegion('search')}<p class="small-note">Choose the right title, edition or artist. Every result comes from Qloo.</p><p class="privacy-note">Qloo uses your selected favourites for recommendations. A favourite may appear in the crew’s discovery cards when it fits the group. Your crew sees your name and favourites in the final dossier.</p>
    ${state.searching ? '<div class="search-loading" role="status"><span class="loading-track"><i></i></span><p>Following your cultural trail…</p></div>' : !filtered.length ? `<div class="search-empty">${icon(state.searched ? 'help' : 'spark')}<h2>${state.searched ? 'A different trail?' : 'What have you been loving?'}</h2><p>${state.searched ? 'No matches this time. Try another spelling or category.' : 'Search for a film, book or artist to bring a little you.'}</p></div>` : ''}
    <div class="taste-grid">${filtered.map(f => `<button type="button" class="taste-card ${state.selected.includes(f.id) ? 'selected' : ''}" data-action="taste" data-value="${e(f.id)}" aria-pressed="${state.selected.includes(f.id)}">${tile(f)}<span class="taste-card-content"><span class="type-label">${f.type === 'artist' ? 'Music' : f.type === 'movie' ? 'Film' : 'Book'}</span><strong>${e(f.name)}</strong><span class="taste-detail">${e(f.detail)}</span>${artCredit(f)}</span><span class="taste-check">${icon(state.selected.includes(f.id) ? 'check' : 'plus')}</span></button>`).join('')}</div>
    ${errorRegion('intake')}<div class="selection-bar"><div class="selected-tokens">${state.selected.length ? state.selected.map(id => { const item = catalog.find(f => f.id === id); return `<span>${icon(item?.type)}${e(item?.name || 'Selected')}</span>`; }).join('') : '<span>What makes you, you?</span>'}</div><button class="button primary" type="button" data-action="submit-tastes" ${state.selected.length < 2 ? 'disabled' : ''}>${state.selected.length}/4 selected ${icon('arrow')}</button></div></section>`;
}
function research(room) {
  const failed = room.research?.status === 'error', empty = room.research?.status === 'empty', host = room.host === room.self.id;
  const progress = room.research?.total ? `${room.research.completed || 0} of ${room.research.total} category checks complete` : 'Starting the cultural trail';
  return `<section class="research-page wrap">${roomBar(room, 'Following the cultural trail')}<div class="research-crew">${room.players.map(p => avatar(p.avatar, 'research-toy')).join('')}</div><h1>${empty ? 'Different tastes.<br><em>A wider adventure.</em>' : failed ? 'A small detour.' : 'Connecting<br><em>your kind of things.</em>'}</h1><p>${failed || empty ? e(room.research.message) : room.research?.stage === 'widening' ? 'Looking a little further for a discovery your whole crew can share.' : room.research?.stage === 'metadata' ? 'Collecting the artwork and details for your crew’s discoveries.' : 'Researching each agent separately across film, books and music.'}</p>${failed && host ? button('Check research again ' + icon('arrow'), 'retry') : failed ? '<p>The host can retry once the research connection is ready.</p>' : empty ? '' : `<span class="loading-track" aria-label="Research in progress"><i></i></span><p class="research-count" role="status">${progress}</p>`}${failed || empty ? button('Change my favourites', 'retaste', 'text-button') : ''}${errorRegion('research')}</section>`;
}
function familiarity(room) {
  const index = Math.min(state.familiarIndex, room.candidates.length - 1); const entity = room.candidates[index];
  const entering = state.lastCardPaint !== entity.id; state.lastCardPaint = entity.id;
  const mark = room.self.familiarity[entity.id]; const count = room.candidates.filter(item => ['new', 'known', 'skip'].includes(room.self.familiarity[item.id])).length;
  return `<section class="familiarity-page wrap">${roomBar(room, 'A quick curiosity check')}<div class="section-title"><div><h1>Seen it?<br><em>Or something new?</em></h1><p>Tell us what you already know. That’s how we find real discoveries.</p></div><span class="page-counter">${index + 1}<small> / ${room.candidates.length}</small></span></div>
    <div class="familiarity-layout"><div class="familiarity-portrait">${avatar(room.players.find(p => p.id === room.self.id).avatar)}<p>Never heard of it?<br><em>That’s the fun part.</em></p></div>
      <div class="discovery-flip ${entering ? 'card-enter' : ''}" data-card-id="${e(entity.id)}">${tile(entity, 'large-art')}<div class="discovery-copy"><span class="type-label">${entity.type === 'artist' ? 'Music' : entity.type === 'movie' ? 'Film' : 'Book'}</span><h2 id="discovery-title" tabindex="-1">${e(entity.name)}</h2><p>${e(entity.detail)}</p>${artCredit(entity)}<div class="tag-row">${(entity.tags || []).map(t => `<span>${e(t)}</span>`).join('')}</div></div></div>
      <div class="familiarity-actions">${[['known', 'Already know it', 'check'], ['new', 'New to me', 'spark'], ['skip', 'Skip this one', 'arrow']].map(([value, label, glyph]) => `<button type="button" class="familiarity-button ${value} ${mark === value ? 'selected' : ''}" data-action="familiar" data-value="${value}" data-id="${e(entity.id)}" aria-pressed="${mark === value}" ${value === 'new' && room.self.favorites.some(favorite => favorite.id === entity.id) ? 'disabled' : ''}>${icon(glyph)}${label}${mark === value ? icon('check') : ''}</button>`).join('')}<span class="small-note">No assumptions. You decide what’s new.</span></div></div>
    ${errorRegion('familiarity')}<div class="familiarity-bottom"><button class="icon-button" data-action="previous-card" aria-label="Previous discovery" ${index === 0 ? 'disabled' : ''}>${icon('back')}</button><div class="card-dots">${room.candidates.map((item, i) => `<button type="button" class="${i === index ? 'current' : ''} ${room.self.familiarity[item.id] !== 'unknown' ? 'marked' : ''}" data-action="card" data-value="${i}" aria-label="${e(item.name)}: ${e(room.self.familiarity[item.id])}" aria-current="${i === index ? 'step' : 'false'}">${i + 1}</button>`).join('')}</div><button class="icon-button" data-action="next-card" aria-label="Next discovery" ${index === room.candidates.length - 1 ? 'disabled' : ''}>${icon('arrow')}</button></div>
    <div class="familiarity-finish"><span>${count}/${room.candidates.length} checked${room.self.confirmed ? ' · Waiting for your crew' : ''}</span>${button(room.self.confirmed ? 'Your cards are in ' + icon('check') : 'That’s me. Find our connection ' + icon('arrow'), 'confirm', 'primary', count !== room.candidates.length || room.self.confirmed ? 'disabled' : '')}</div></section>`;
}
function briefing(room) {
  const waiting = room.players.filter(player => !player.confirmed).length;
  const voted = room.players.filter(player => player.routeReady).length;
  return `<section class="briefing wrap">${roomBar(room, 'Your crew. Your route.')}<h1>A familiar spark.<br><em>A new obsession.</em></h1><p>${waiting ? `Your cards are in. ${waiting} ${waiting === 1 ? 'accomplice is' : 'accomplices are'} still exploring.` : 'One discovery for the whole crew. Everyone chooses a route, then you agree on the discovery together.'}</p>
    ${room.notice ? `<p class="notice">${e(room.notice)}</p>` : ''}
    <div class="route-options">${[['shared', 'Find a new favourite', 'One discovery that fits everyone. New to every agent.', 'spark', 'mint'], ['mentor', 'Pass a good thing on', 'One discovery that fits everyone. Known to some, new to the others.', 'link', 'gold']].map(([route, title, description, glyph, color]) => {
      const available = room.availableRoutes.find(item => item.route === route)?.available;
      const selected = room.self.routeChoice === route;
      const action = waiting || available ? 'route' : room.canRefine ? 'refine' : 'retaste';
      return `<article class="route-card ${color} ${selected ? 'route-selected' : ''}">${icon(glyph, 'route-icon')}<h2>${title}</h2><p>${description}</p>${button(selected ? 'Your choice ' + icon('check') : waiting ? 'Waiting for everyone’s cards' : available ? 'Choose this route ' + icon('arrow') : room.canRefine ? 'Find more discoveries ' + icon('spark') : 'Explore different tastes ' + icon('arrow'), action, selected || available ? 'dark' : 'outline', `data-value="${route}" ${available || waiting ? `aria-pressed="${selected}"` : ''} ${waiting ? 'disabled' : ''}`)}<small>${waiting ? 'Your crew’s familiarity checks come first.' : available ? 'Everyone agrees on the route and the final discovery.' : room.canRefine ? 'Keep your favourites and completed reviews. Explore more of the cultural trail.' : 'This trail needs a different direction. Adjust your favourites or revisit your familiarity cards.'}</small></article>`;
    }).join('')}</div>
    ${errorRegion('route')}${room.routeConflict ? '<p class="notice" role="status">Your crew chose different routes. Talk it out below, then choose the same adventure.</p>' : !waiting ? `<p class="route-status" role="status">${voted}/${room.players.length} agents have chosen. Every accomplice gets a say.</p>` : ''}
    <div class="briefing-bottom">${crewRow(room)}<div class="briefing-revisit">${room.candidates.length ? button('Revisit my cards', 'revise', 'text-button') : ''}${button('Change my favourites', 'retaste', 'text-button')}</div></div>
    ${chat(room)}
  </section>`;
}
function chat(room) {
  return `<div class="crew-chat"><h3>Crew talk</h3><div class="chat-messages" aria-label="Crew messages">${room.messages.slice(-5).map(message => `<p><strong>${e(room.players.find(player => player.id === message.playerId)?.name)}:</strong> ${e(message.text)}</p>`).join('') || '<p class="chat-empty">Say what you see. Talk it out here or on a call.</p>'}</div><form id="chat-form"><label class="sr-only" for="chat-input">Message your crew</label><input id="chat-input" value="${e(state.chatDraft)}" placeholder="A thought for the crew…" maxlength="180" required autocomplete="off"><button type="submit" class="icon-button" aria-label="Send message">${icon('arrow')}</button></form>${errorRegion('chat')}</div>`;
}
function checkpoint(room) {
  const ready = room.players.filter(player => player.readyForNext).length;
  const proposal = room.proposals.find(item => item.playerId === room.self.id)?.entity;
  return `<div class="personal-checkpoint"><div class="checkpoint-mark">${icon('check')}</div><h2 tabindex="-1">${room.stage === 1 ? 'Your proposal is in.' : 'You cracked it.'}</h2><p>${room.stage === 1 ? `You proposed ${e(proposal?.name)}. Everyone must choose the same discovery before the crew moves on.` : 'Your answer is private. Your crew has time to find theirs.'}</p>${button(room.self.readyForNext ? 'You’re ready ' + icon('check') : room.stage === 1 ? 'Confirm my proposal ' + icon('check') : room.stage === 2 ? 'Ready for the reveal ' + icon('arrow') : 'I’m ready for the next room ' + icon('arrow'), 'continue', 'primary', room.self.readyForNext || room.paused ? 'disabled' : '')}${room.stage === 1 ? button('Change my proposal', 'reconsider', 'text-button', room.paused ? 'disabled' : '') : ''}<span class="checkpoint-count" role="status">${ready}/${room.players.length} ready · ${room.stage === 1 ? 'One choice. Everyone agrees.' : 'Every agent checks their own answer.'}</span></div>`;
}
function proposals(room) {
  if (room.stage !== 1) return '';
  return `<section class="discovery-consensus" aria-label="Crew discovery proposals"><h2>Our next discovery</h2><p>Discuss your picks. Choose one thing to experience together.</p><ul>${room.proposals.map(proposal => `<li><strong>${e(room.players.find(player => player.id === proposal.playerId)?.name)}</strong><span>${proposal.entity ? e(proposal.entity.name) : 'Still exploring…'}</span></li>`).join('')}</ul>${room.discoveryConflict ? '<p class="notice" role="status">Different discoveries on the table. Change a proposal until everyone agrees on one.</p>' : ''}</section>`;
}
function clue(clue) {
  if (!clue) return '';
  if (clue.kind === 'order') return `<div class="symbol-order">${clue.symbols.map(s => `<span class="symbol">${icon(s)}<small>${e(s)}</small></span>`).join(`<span class="clue-arrow">${icon('arrow')}</span>`)}</div>`;
  if (clue.kind === 'mapping') return `<div class="symbol-mappings">${clue.pairs.map(([symbol, digit]) => `<span class="mapping">${icon(symbol)}<span>=</span><strong>${digit}</strong><span class="sr-only">${e(symbol)}</span></span>`).join('')}</div>`;
  if (clue.kind === 'connections') return `<ul class="connection-list">${clue.entities.map(item => `<li><span>${e(item.name)}</span><strong class="familiarity-tag ${e(item.familiarity)}">${{ new: 'New to me', known: 'Know it', skip: 'Skipped' }[item.familiarity] || 'Unknown'}</strong></li>`).join('')}</ul>`;
  if (clue.constraints) return `<div class="sequence-clues">${clue.constraints.map(rule => `<div><span>${icon(rule.a)}<small>${e(rule.a)}</small></span><span class="rule-relation">${icon(rule.relation === 'beside' ? 'link' : 'arrow')}<small>${rule.relation === 'beside' ? 'beside · either order' : 'before · a gap is allowed'}</small></span><span>${icon(rule.b)}<small>${e(rule.b)}</small></span></div>`).join('')}</div>`;
  return `<div class="sequence-clues">${clue.first ? `<div><span>${icon(clue.first)}<small>${e(clue.first)} goes first</small></span></div>` : ''}${clue.pairs.map(pair => `<div>${pair.map(item => `<span>${icon(item)}<small>${e(item)}</small></span>`).join(icon('arrow'))}</div>`).join('')}</div>`;
}
function game(room) {
  const own = room.players.find(p => p.id === room.self.id); const shared = room.board.some(b => b.playerId === own.id && b.stage === room.stage);
  return `<section class="game-page wrap">${roomBar(room, `Crew ${e(room.code)} · ${room.route === 'shared' ? 'A new favourite for everyone' : 'Pass a good thing on'}`)}
    <div class="mission-header"><ol class="room-progress">${ROOM_NAMES.map((name, i) => `<li class="${room.stage === i ? 'current' : room.stage > i ? 'solved' : ''}" ${room.stage === i ? 'aria-current="step"' : ''}><span>${room.stage > i ? icon('check') : `0${i + 1}`}</span><strong>${name}</strong></li>`).join('')}</ol><div class="timer-box"><span id="timer" data-elapsed="${room.elapsed}">${formatTime(displayElapsed(room))}</span>${room.host === own.id ? `<button type="button" class="icon-button" data-action="pause" aria-label="${room.paused ? 'Resume' : 'Pause'} heist">${icon(room.paused ? 'play' : 'pause')}</button>` : ''}</div></div>
    ${room.paused ? '<div class="notice paused-notice">The heist is paused. Take your time. The archive can wait.</div>' : ''}
    <div class="game-layout"><div class="game-main"><div class="puzzle-panel"><div class="puzzle-heading"><div><h1>${['Tune in.<br><em>Crack the code.</em>', 'Your next discovery.<br><em>Choose it together.</em>', 'The loot is yours.<br><em>Find the way out.</em>'][room.stage]}</h1><p>${['One agent has the symbols. The others have their numbers.', room.route === 'shared' ? 'We found discoveries that fit everyone and are new to the whole crew. Choose your next shared experience.' : 'We found discoveries that fit everyone: familiar to some, new to others. Choose one to share together.', 'Arrange the souvenirs into one chain using your crew’s private rules.'][room.stage]}</p></div><div class="puzzle-mascot">${avatar(own.avatar)}</div></div>${room.self.solved ? checkpoint(room) : puzzleInput(room)}${errorRegion('puzzle')}${proposals(room)}<div class="puzzle-tools">${button(icon('help') + (room.stage === 1 ? ' How to choose' : ' A private nudge'), 'hint', 'text-button', room.hints >= 3 ? 'disabled' : '')}${room.hint ? `<p class="hint-text" role="status">${e(room.hint)}</p>` : '<span>No rush. Curiosity beats speed.</span>'}</div></div>
      <section class="private-dossier"><div class="panel-label">${icon('lock')} ${room.stage === 1 ? 'Your connection' : 'Your private clue'} <span>Only you can see this</span></div>${clue(room.self.clue)}<p>${e(room.self.clue.text)}</p>${button(shared ? 'Shared with your crew ' + icon('check') : (room.stage === 1 ? 'Share my connection ' : 'Pin my clue to the board ') + icon('plus'), 'share', 'outline', shared ? 'disabled' : '')}</section>
    </div><aside class="crew-board"><div class="board-heading"><h2>The crew board</h2><span>${room.players.length} agents</span></div>${crewRow(room)}

      <div class="pinned-clues">${room.board.filter(b => b.stage === room.stage).map(b => { const person = room.players.find(p => p.id === b.playerId); return `<article class="pinned-clue"><h3>${avatar(person.avatar)}${e(person.name)}’s clue</h3>${clue(b.clue)}</article>`; }).join('') || '<div class="empty-board">'+icon('plus')+'<p>A good crew shares.<br>Pin a clue to get things moving.</p></div>'}</div>
      ${chat(room)}
    </aside></div><div class="archive-progress"><img src="/assets/archive.webp" alt="The three-room cultural archive" width="1536" height="1024"><div>${ROOM_NAMES.map((name, i) => `<span class="${i <= room.stage ? 'active' : ''}">${i < room.stage ? icon('check') : i === room.stage ? icon('play') : icon('lock')} ${name}</span>`).join('')}</div></div></section>`;
}
function puzzleInput(room) {
  if (room.stage === 0) return `<form id="code-form" class="code-puzzle"><label for="vault-code">Check your ${room.signalLength}-digit vault code</label><div><input id="vault-code" value="${e(state.codeInput)}" inputmode="numeric" pattern="[0-9]{${room.signalLength}}" maxlength="${room.signalLength}" minlength="${room.signalLength}" placeholder="${'·'.repeat(room.signalLength)}" autocomplete="off" required aria-describedby="code-help puzzle-error" ${room.paused ? 'disabled' : ''}><button type="submit" class="button primary" ${room.paused ? 'disabled' : ''}>Check my code ${icon('arrow')}</button></div><small id="code-help">Every symbol has a number. Your crew has the pieces.</small></form>`;
  if (room.stage === 1) return discoveryChoices(room);
  return `<div class="exit-puzzle"><p>Tap two souvenirs to swap their places.</p><div class="exit-order">${state.exit.map((item, i) => `<button type="button" class="souvenir ${state.swapping === i ? 'selected' : ''}" data-action="swap" data-value="${i}" aria-pressed="${state.swapping === i}" aria-label="Position ${i + 1}: ${item}. Select to swap." ${room.paused ? 'disabled' : ''}><span class="souvenir-number">0${i + 1}</span>${icon(item)}<strong>${item}</strong></button>`).join('')}</div>${button('Check my escape route ' + icon('arrow'), 'solve-exit', 'primary', room.paused ? 'disabled' : '')}</div>`;
}
function discoveryChoices(room) {
  return `<p class="discovery-intro">Every card below fits your crew’s route. Pick the one you’d like to experience together.</p><div class="discovery-choices" role="group" aria-label="Choose from your crew’s matched discoveries">${room.candidates.map(item => {
    const connection = item.connection;
    const familiarity = room.route === 'shared' ? 'New to everyone' : `Known to ${connection.known} · New to ${connection.new}`;
    return `<button type="button" class="discovery-choice ${e(item.color)} ${state.discoveryChoice === item.id ? 'selected' : ''}" data-action="pick-discovery" data-value="${e(item.id)}" aria-pressed="${state.discoveryChoice === item.id}" ${room.paused ? 'disabled' : ''}>${tile(item, 'choice-art')}<span><strong>${e(item.name)}</strong><small>${item.type === 'artist' ? 'Music' : item.type === 'movie' ? 'Film' : 'Book'}</small><small class="discovery-fit">Fits all ${connection.total} tastes</small><small class="discovery-familiarity">${e(familiarity)}</small>${artCredit(item)}</span>${icon(state.discoveryChoice === item.id ? 'check' : 'plus')}</button>`;
  }).join('')}</div>${button('Propose our discovery ' + icon('arrow'), 'solve-discovery', 'primary', !room.candidates.some(item => item.id === state.discoveryChoice) || room.paused ? 'disabled' : '')}<p class="private-answer-note">Your draft is private. Submitting shares your proposal with the crew. Everyone must agree on one discovery.</p>`;
}
function debrief(room) {
  const discovery = room.discovery;
  return `<section class="debrief wrap">${roomBar(room, 'Case closed. Curiosity wide open.')}<div class="debrief-top"><div><span class="success-seal">${icon('check')} A very good getaway</span><h1>You came for a heist.<br><em>You found a connection.</em></h1><p>${room.route === 'shared' ? 'New to every agent. One discovery to explore together.' : 'Known to some. New to others. One discovery for the whole crew.'}</p></div><div class="celebrating-crew">${room.players.map(p => avatar(p.avatar, '', true)).join('')}</div></div>
    <div class="loot-card">${tile(discovery, 'loot-art')}<div><span class="type-label">YOUR CREW’S DISCOVERY · ${discovery.type === 'artist' ? 'MUSIC' : discovery.type.toUpperCase()}</span><h2>${e(discovery.name)}</h2><p>${e(discovery.detail)}</p>${artCredit(discovery)}<div class="tag-row">${(discovery.tags || []).map(t => `<span>${e(t)}</span>`).join('')}</div><div class="loot-actions">${button(icon('download') + ' Keep the crew dossier', 'download', 'dark')}${button('Another little adventure ' + icon('arrow'), 'create', 'outline')}</div></div></div>
    <div class="debrief-evidence"><div><h2>How you connected</h2><p>A Qloo recommendation or selected favourite for every agent. Familiarity confirmed by each person. Chosen together by everyone.</p><div class="finish-time">${formatTime(room.elapsed)} <span>well spent</span></div></div><div class="evidence-people">${room.evidence.map((person, i) => `<article>${avatar(room.players[i].avatar, '', true)}<div><h3>${e(person.name)} <span>${person.familiarity === 'new' ? 'New to them' : 'Passing it on'}</span></h3><p>Started with ${person.favorites.map(e).join(' + ')}</p><small>${person.selectedFavorite ? 'One of their selected favourites' : 'Included in their Qloo research'}</small>${sourceReceipts(person)}</div></article>`).join('')}</div></div></section>`;
}
function displayElapsed(room = state.room) {
  if (!room) return 0;
  return room.elapsed + (room.phase === 'playing' && !room.paused ? Math.max(0, Date.now() - elapsedAt) : 0);
}
function formatTime(ms) { const seconds = Math.max(0, Math.floor(ms / 1000)); return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`; }
function motionAllowed() { return state.motion && !matchMedia('(prefers-reduced-motion: reduce)').matches; }
function updateConnection() { const node = document.querySelector('#connection'); if (node) node.textContent = state.connection === 'connected' ? 'Crew connected' : state.connection === 'reconnecting' ? 'Reconnecting…' : state.connection === 'polling' ? 'Crew synchronized' : state.connection === 'expired' ? 'Session expired' : ''; }
function celebrate() { document.documentElement.classList.add('celebrating'); setTimeout(() => document.documentElement.classList.remove('celebrating'), 1600); }
let audio;
function tone() {
  if (!state.sound) return;
  try { audio ||= new AudioContext(); audio.resume(); [523.25, 659.25, 783.99].forEach((frequency, i) => { const oscillator = audio.createOscillator(); const gain = audio.createGain(); oscillator.connect(gain); gain.connect(audio.destination); oscillator.frequency.value = frequency; const start = audio.currentTime + i * .1; gain.gain.setValueAtTime(0, start); gain.gain.linearRampToValueAtTime(.04, start + .02); gain.gain.exponentialRampToValueAtTime(.001, start + .35); oscillator.start(start); oscillator.stop(start + .4); }); } catch {}
}
document.addEventListener('click', async event => {
  const target = event.target.closest('[data-action]'); if (!target || target.disabled) return;
  const action = target.dataset.action; const value = target.dataset.value;
  if (target.tagName === 'A') event.preventDefault();
  if (action === 'home') { state.following = false; state.screen = 'home'; render(true); }
  if (action === 'resume') { state.following = true; state.screen = 'room'; render(true); }
  if (action === 'create' || action === 'join') { state.following = false; state.screen = action; state.errors = {}; formError = ''; render(true); }
  if (action === 'motion') { state.motion = !state.motion; savePreference('heist:motion', state.motion ? 'on' : 'off'); document.documentElement.dataset.motion = state.motion ? 'on' : 'off'; render(); announce(`Animations ${state.motion ? 'on' : 'off'}`); }
  if (action === 'theme') { state.theme = state.theme === 'dark' ? 'light' : 'dark'; savePreference('heist:theme', state.theme); applyTheme(state.theme); renderHeader(); document.querySelector('.theme-toggle')?.focus({ preventScroll: true }); announce(`${state.theme === 'dark' ? 'Dark' : 'Light'} mode enabled`); }
  if (action === 'sound') { state.sound = !state.sound; tone(); render(); announce(`Game sounds ${state.sound ? 'on' : 'off'}`); }
  if (action === 'peek') { state.tutorial = 2; render(); document.getElementById('how-it-works')?.scrollIntoView({ behavior: motionAllowed() ? 'smooth' : 'instant', block: 'center' }); }
  if (action === 'character' || action === 'pick-avatar') { state.avatar = Number(value); render(); if (motionAllowed()) document.querySelector(`.avatar-${state.avatar}`)?.animate?.([{ transform: 'rotate(-7deg)' }, { transform: 'rotate(7deg)' }, { transform: 'rotate(0)' }], { duration: 450 }); }
  if (action === 'tutorial') { state.tutorial = Number(value); render(); document.querySelector(`#how-tab-${value}`)?.focus({ preventScroll: true }); }
  if (action === 'reconsider') state.discoveryChoice = null;
  if (['begin', 'retry', 'refine', 'confirm', 'revise', 'retaste', 'share', 'pause', 'hint', 'continue', 'reconsider'].includes(action)) await act(action);
  if (action === 'route') await act('route', { route: value });
  if (action === 'filter') { state.filter = value; render(); }
  if (action === 'taste') { if (state.busy) return; if (state.selected.includes(value)) state.selected = state.selected.filter(id => id !== value); else if (state.selected.length < 4) state.selected.push(value); else { toast('Four favourites is plenty. Swap one out to add another.'); return; } const previous = state.room.self.draft; render(); if (!await act('selection', { ids: state.selected })) { state.selected = previous; render(); } }
  if (action === 'submit-tastes') await act('favorites', { ids: state.selected });
  if (action === 'card') { state.familiarIndex = Number(value); clearError('familiarity'); render(); focusDiscovery(); }
  if (action === 'previous-card' || action === 'next-card') { state.familiarIndex += action === 'next-card' ? 1 : -1; clearError('familiarity'); render(); focusDiscovery(); }
  if (action === 'familiar') await perform(async () => { const current = state.familiarIndex; await transport.act({ type: 'familiarity', id: target.dataset.id, value }); const marks = state.room.self.familiarity; const next = state.room.candidates.findIndex((c, i) => i > current && marks[c.id] === 'unknown'); if (next >= 0) state.familiarIndex = next; render(); focusDiscovery(); }, 'familiarity');
  if (action === 'copy') { const invite = `${location.origin}/?join=${state.room.code}`; try { await navigator.clipboard.writeText(invite); toast('Invite copied. Your accomplices await.'); } catch { toast(`Share this crew code: ${state.room.code}`); } }
  if (action === 'pick-discovery') { clearError('puzzle'); state.discoveryChoice = value; render(); }
  if (action === 'solve-discovery' && state.discoveryChoice) await act('solve', { answer: state.discoveryChoice });
  if (action === 'swap') { clearError('puzzle'); const index = Number(value); if (state.swapping === null) state.swapping = index; else { [state.exit[index], state.exit[state.swapping]] = [state.exit[state.swapping], state.exit[index]]; state.swapping = null; } render(); announce(`Souvenir order: ${state.exit.join(', ')}. ${state.swapping === null ? 'Swap complete.' : 'Choose a second souvenir to swap.'}`); }
  if (action === 'solve-exit') await act('solve', { answer: state.exit });
  if (action === 'download') {
    const room = state.room; const dossier = { title: 'Taste Heist · Your discovery dossier', discovery: room.discovery, source: 'Live Qloo research and crew-confirmed familiarity', route: room.route, evidence: room.evidence, elapsed: formatTime(room.elapsed), created: new Date().toISOString() };
    const url = URL.createObjectURL(new Blob([JSON.stringify(dossier, null, 2)], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = 'taste-heist-dossier.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); toast('A little piece of the heist, saved.');
  }
});
document.addEventListener('submit', async event => {
  event.preventDefault();
  if (event.target.id === 'crew-form') {
    const data = new FormData(event.target); state.name = String(data.get('name')).trim();
    await perform(async () => { await boot; return state.screen === 'join' ? transport.join({ name: state.name, avatar: state.avatar, code: String(data.get('code')).toUpperCase() }) : transport.create({ name: state.name, avatar: state.avatar }); });
  }
  if (event.target.id === 'code-form') await act('solve', { answer: document.querySelector('#vault-code').value });
  if (event.target.id === 'chat-form') { const text = document.querySelector('#chat-input').value; await perform(async () => { await transport.act({ type: 'chat', text }); if (state.chatDraft === text) { state.chatDraft = ''; const input = document.querySelector('#chat-input'); if (input) input.value = ''; } }, 'chat'); }
  if (event.target.id === 'search-form') await perform(async () => {
    const query = document.querySelector('#search-query').value, type = document.querySelector('#search-type').value;
    state.searchQuery = query; state.searchType = type; state.searching = true; render();
    try { state.searchResults = await transport.search(query, type); state.searched = true; state.filter = 'all'; }
    finally { state.searching = false; render(); }
  }, 'search');
});
document.addEventListener('input', event => { if (['agent-name','crew-code'].includes(event.target.id)) clearError('form'); if (event.target.id === 'chat-input') clearError('chat'); if (event.target.id === 'search-query') clearError('search'); if (event.target.id === 'vault-code') clearError('puzzle'); if (event.target.id === 'crew-code') state.joinCode = event.target.value; if (event.target.id === 'chat-input') state.chatDraft = event.target.value; if (event.target.id === 'search-query') state.searchQuery = event.target.value; if (event.target.id === 'agent-name') state.name = event.target.value; if (event.target.id === 'vault-code') { state.codeInput = event.target.value.replace(/\D/g, '').slice(0, state.room?.signalLength || 4); event.target.value = state.codeInput; } });
document.addEventListener('change', event => { if (event.target.id === 'search-type') state.searchType = event.target.value; });
document.addEventListener('error', event => { if (event.target.matches?.('img[data-artwork]')) event.target.closest('.culture-art')?.classList.add('image-error'); }, true);
document.addEventListener('keydown', event => {
  if (event.target.matches('[role="tab"]') && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
    event.preventDefault(); state.tutorial = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (state.tutorial + (event.key === 'ArrowRight' ? 1 : 2)) % 3; render(); document.querySelector(`#how-tab-${state.tutorial}`)?.focus({ preventScroll: true });
  }
});
document.addEventListener('pointermove', event => {
  const stage = event.target.closest('.hero-stage'); if (!stage || !state.motion || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const bounds = stage.getBoundingClientRect(); stage.style.setProperty('--look-x', `${((event.clientX - bounds.left) / bounds.width - .5) * 8}px`); stage.style.setProperty('--look-y', `${((event.clientY - bounds.top) / bounds.height - .5) * 5}px`);
});
document.addEventListener('visibilitychange', () => document.documentElement.classList.toggle('page-hidden', document.hidden));
setInterval(() => { const timer = document.querySelector('#timer'); if (timer && state.room) timer.textContent = formatTime(displayElapsed()); }, 1000);
const systemTheme = matchMedia('(prefers-color-scheme: dark)');
systemTheme.addEventListener?.('change', event => { if (!readPreference('heist:theme')) { state.theme = event.matches ? 'dark' : 'light'; applyTheme(state.theme); renderHeader(); } });
render();
const boot = transport.init();
await boot;
if (state.joinCode && state.room?.code !== state.joinCode.toUpperCase()) { state.screen = 'join'; render(true); } else render();
