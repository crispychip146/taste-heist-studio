// The browser never owns game state or Qloo credentials.
const identifier = () => crypto.randomUUID?.() || Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, '0')).join('');
export class Transport {
  constructor(onUpdate, onConnection) {
    this.onUpdate = onUpdate; this.onConnection = onConnection; this.online = false;
    this.research = { configured: false, harnessReady: false, verifiedAt: null };
    this.socket = null; this.poll = null; this.room = null; this.generation = 0;
    this.retryDelay = 1000;
  }
  async request(path, data) {
    let response;
    try {
      response = await fetch(`/api/${path}`, { method: data ? 'POST' : 'GET', headers: data ? { 'content-type': 'application/json' } : {}, body: data ? JSON.stringify(data) : undefined, signal: AbortSignal.timeout(path === 'health' ? 4000 : path === 'search' ? 35000 : 15000) });
    } catch { const error = new Error('The archive connection was interrupted. Your crew is saved. Please reconnect.'); error.code = 'NETWORK'; throw error; }
    let result; try { result = await response.json(); } catch { const error = new Error('The archive response was interrupted. Please try again.'); error.code = 'NETWORK'; throw error; }
    if (!response.ok) {
      const error = new Error(result.error || 'The archive could not complete that action.'); error.code = result.code;
      error.retryAfter = result.retryAfter || 0;
      if (result.code === 'STALE_ACTION') void this.refresh().catch(() => {}); throw error;
    }
    return result;
  }
  update(room, context = {}) {
    if (!room || (this.room?.code === room.code && this.room.createdAt === room.createdAt && this.room.version > room.version)) return;
    this.room = room; this.onUpdate(room, context);
  }
  async init() {
    // Clear unsupported persisted state before restoring the authenticated session.
    try { localStorage.removeItem('taste-heist:practice:v1'); } catch {}
    try {
      const health = await this.request('health'); this.online = health.ok; this.research = health.research;
      const { room } = await this.request('session');
      if (room) { this.update(room, { restored: true }); this.connect(); }
    } catch { this.online = false; }
  }
  async create(data) {
    if (!this.online) { await this.init(); if (!this.online) throw new Error('Crew play needs a connection to the archive server. Please try again shortly.'); }
    await this.enter('rooms', data);
  }
  async join(data) {
    if (!this.online) { await this.init(); if (!this.online) throw new Error('The archive server is unavailable. Reconnect before joining your crew.'); }
    await this.enter('join', data);
  }
  async enter(path, data) {
    const signature = JSON.stringify({ path, data });
    if (this.pendingEntry?.signature !== signature) this.pendingEntry = { signature, payload: { ...data, requestId: identifier() } };
    try {
      const result = await this.request(path, this.pendingEntry.payload);
      this.pendingEntry = null; this.pendingCommand = null;
      this.disconnect(); this.update(result.room, { entered: true }); this.connect();
    } catch (error) { if (error.code !== 'NETWORK') this.pendingEntry = null; throw error; }
  }
  async act(action) {
    const signature = JSON.stringify(action);
    const pending = this.pendingCommand?.signature === signature ? this.pendingCommand : { signature, payload: { ...action, commandId: identifier(), expectedPhase: this.room?.phase, expectedStage: this.room?.stage } };
    this.pendingCommand = pending;
    try { const result = await this.request('command', pending.payload); this.pendingCommand = null; this.update(result.room); }
    catch (error) { if (error.code !== 'NETWORK') this.pendingCommand = null; throw error; }
  }
  async search(query, type) { const result = await this.request('search', { query, type }); this.update(result.room); return result.matches; }
  async refresh() { const { room } = await this.request('session'); if (room) this.update(room); }
  connect() {
    this.disconnect(); const generation = this.generation;
    let pending = false;
    this.poll = setInterval(async () => {
      if (pending) return; pending = true;
      try {
        const { room } = await this.request('session');
        if (generation !== this.generation) return;
        if (room) { this.update(room); if (this.socket?.readyState !== WebSocket.OPEN) this.onConnection('polling'); }
        else { this.disconnect(); this.onConnection('expired'); }
      } catch { if (generation === this.generation) this.onConnection('reconnecting'); }
      finally { pending = false; }
    }, 5000);
    this.openSocket(generation);
  }
  openSocket(generation) {
    if (generation !== this.generation) return;
    this.onConnection('connecting');
    const reconnect = () => {
      if (generation !== this.generation) return;
      this.onConnection('reconnecting');
      clearTimeout(this.retry);
      this.retry = setTimeout(() => this.openSocket(generation), this.retryDelay);
      this.retryDelay = Math.min(30000, this.retryDelay * 2);
    };
    let socket;
    try { socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/live`); }
    catch { reconnect(); return; }
    this.socket = socket;
    socket.onopen = () => { if (this.socket === socket && generation === this.generation) { this.retryDelay = 1000; this.onConnection('connected'); } };
    socket.onmessage = event => { if (this.socket !== socket || generation !== this.generation) return; try { const data = JSON.parse(event.data); if (data.room) this.update(data.room); } catch {} };
    socket.onerror = () => socket.close();
    socket.onclose = () => { if (this.socket !== socket) return; this.socket = null; reconnect(); };
  }
  disconnect() { this.generation++; clearInterval(this.poll); this.poll = null; clearTimeout(this.retry); this.retryDelay = 1000; const old = this.socket; this.socket = null; old?.close(); }
}
