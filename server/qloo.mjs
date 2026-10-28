import { createHash } from 'node:crypto';
import { Harness, workflowEntities } from './harness.mjs';
import { ProviderError } from './errors.mjs';
import { shortlist } from './shortlist.mjs';
import { setting, positiveInteger } from './limits.mjs';

export const TYPES = ['movie', 'book', 'artist'];
export const isEntityId = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const contractError = () => new ProviderError('QLOO_CONTRACT', 'The installed harness has an unsupported input schema. Check npm run doctor before continuing.');
function schemaAt(schema, root) {
  if (!schema) return {};
  if (schema.$ref?.startsWith('#/')) {
    const resolved = schema.$ref.slice(2).split('/').reduce((object, key) => object?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], root);
    if (!resolved) throw contractError(); return resolved;
  }
  return schema;
}
function variants(schema, root) { const value = schemaAt(schema, root); return value.anyOf || value.oneOf || [value]; }
function typeValue(schema, type, root) {
  const choices = variants(schema, root).flatMap(item => item.enum || (item.const ? [item.const] : []));
  if (!choices.length) return type;
  const value = choices.find(value => value === type || value === `urn:entity:${type}`);
  if (!value) throw contractError(); return value;
}
function entityReference(schema, entity, root, depth = 0) {
  if (depth > 5) throw contractError();
  for (let option of variants(schema, root)) {
    option = schemaAt(option, root);
    if (option.type === 'string') return entity.id;
    if (option.type === 'object' || option.properties) {
      const properties = option.properties || {}; const result = {};
      if (properties.entity_id) result.entity_id = entity.id;
      else if (properties.id) result.id = entity.id;
      else if (properties.entity) result.entity = entityReference(properties.entity, entity, root, depth + 1);
      else continue;
      for (const key of option.required || []) {
        if (key in result) continue;
        if (key === 'name' && entity.name) result.name = entity.name;
        else if (key === 'type') result.type = typeValue(properties.type, entity.type, root);
        else if (key === 'weight') result.weight = 1;
        else throw contractError();
      }
      return result;
    }
  }
  throw contractError();
}
export function recommendationArguments(tool, favorites, type, limit) {
  const root = tool?.inputSchema; if (!root) throw contractError();
  const properties = root.properties || {}; if (!properties.signals || !properties.target_type) throw contractError();
  const signalSchema = variants(properties.signals, root).find(s => s.type === 'array' || s.type === 'object' || s.properties);
  if (!signalSchema) throw contractError();
  let signals;
  if (signalSchema.type === 'array') signals = favorites.map(entity => entityReference(signalSchema.items, entity, root));
  else {
    const entities = signalSchema.properties?.entities;
    if (schemaAt(entities, root).type !== 'array') throw contractError();
    signals = { entities: favorites.map(entity => entityReference(schemaAt(entities, root).items, entity, root)) };
    if ((signalSchema.required || []).some(key => key !== 'entities')) throw contractError();
  }
  const args = { signals, target_type: typeValue(properties.target_type, type, root) };
  for (const field of ['limit', 'take']) if (properties[field]) { args[field] = Math.min(limit, schemaAt(properties[field], root).maximum || limit); break; }
  if ((root.required || []).some(key => !(key in args))) throw contractError();
  return args;
}
export function normalizeEntity(record, expectedType) {
  const entity = record?.entity || record;
  if (!entity || !isEntityId(entity.entity_id || entity.id) || typeof entity.name !== 'string' || !entity.name.trim()) return null;
  const declarations = [entity.subtype, ...(Array.isArray(entity.types) ? entity.types : []), entity.type]
    .filter(value => typeof value === 'string' && value !== 'urn:entity');
  if (declarations.length && !declarations.some(value => TYPES.includes(value.replace('urn:entity:', '')))) return null;
  const type = [...declarations, expectedType]
    .filter(value => typeof value === 'string').map(value => value.replace('urn:entity:', '')).find(value => TYPES.includes(value));
  if (!type) return null;
  const properties = entity.properties || {};
  const creator = properties.authors || properties.directors || properties.author || properties.director || [];
  const creators = (Array.isArray(creator) ? creator : [creator]).map(item => typeof item === 'string' ? item : item?.name).filter(Boolean).slice(0, 2);
  const rawYear = type === 'book' ? properties.publication_year || properties.release_year : properties.release_year || properties.publication_year;
  const year = /^\d{4}$/.test(String(rawYear)) ? Number(rawYear) : null;
  const description = typeof properties.description === 'string' ? properties.description.slice(0, 350) : '';
  const tags = (Array.isArray(entity.tags) ? entity.tags : Array.isArray(properties.tags) ? properties.tags : [])
    .filter(tag => tag?.name && (!tag.type || /genre|style|theme|category/.test(tag.type))).slice(0, 4).map(tag => String(tag.name).slice(0, 60));
  return {
    id: String(entity.entity_id || entity.id).toLowerCase(), name: entity.name.slice(0, 180), type,
    detail: [creators.join(', '), year].filter(Boolean).join(' · ') || description,
    description, year, creators, tags, color: { movie: 'coral', book: 'blue', artist: 'mint' }[type],
    imageSource: typeof properties.image?.url === 'string' ? properties.image.url : null,
    imageAttribution: typeof properties.image?.attribution === 'string' ? properties.image.attribution.slice(0, 200) : null,
    provider: 'qloo', evidence: { affinity: record?.affinity ?? record?.query?.affinity ?? entity.query?.affinity ?? null, explainability: record?.explainability ?? record?.query?.explainability ?? entity.query?.explainability ?? null },
  };
}
export class Qloo {
  constructor({ harness = new Harness(), maxRequests = process.env.QLOO_RESEARCH_BUDGET ?? 24, now = Date.now, reserve = () => {}, outcome = () => {}, queueLimit = setting('QLOO_QUEUE_LIMIT', 24, 200) } = {}) {
    this.harness = harness; this.maxRequests = positiveInteger(maxRequests, 'QLOO_RESEARCH_BUDGET', 36); this.now = now; this.reserve = reserve; this.outcome = outcome;
    this.queueLimit = positiveInteger(queueLimit, 'QLOO_QUEUE_LIMIT', 200);
    this.minuteLimit = setting('QLOO_REQUESTS_PER_MINUTE', 30);
    for (const name of ['QLOO_DAILY_BUDGET', 'QLOO_ROOM_DAILY_BUDGET', 'QLOO_PLAYER_DAILY_BUDGET']) setting(name, name === 'QLOO_DAILY_BUDGET' ? 1000 : 120);
    this.cache = new Map(); this.inflight = new Map(); this.waiters = []; this.active = 0; this.requestTimes = []; this.lastVerifiedAt = null;
  }
  status() { return { configured: !!this.harness.env?.QLOO_API_KEY, harnessReady: this.harness.credentialReady, verifiedAt: this.lastVerifiedAt }; }
  async limited(task, scope) {
    if (this.closed) throw new ProviderError('QLOO_CLOSED', 'Research is stopping. Reconnect to the archive.');
    if (this.active >= 2) {
      if (this.waiters.length >= this.queueLimit) throw new ProviderError('QLOO_BUSY', 'Research is busy. Your crew is saved; try again shortly.', { status: 503, retryable: true, retryAfter: 5 });
      await new Promise(resolve => this.waiters.push(resolve));
    }
    else this.active++;
    let dispatched = false;
    try {
      if (this.closed) throw new ProviderError('QLOO_CLOSED', 'Research is stopping. Reconnect to the archive.');
      this.requestTimes = this.requestTimes.filter(time => time > this.now() - 60000);
      if (this.requestTimes.length >= this.minuteLimit) throw new ProviderError('QLOO_LOCAL_RATE', 'The server is spacing out Qloo requests. Wait a minute before retrying.', { retryable: true, status: 429, retryAfter: 60 });
      this.requestTimes.push(this.now());
      await this.reserve(scope); dispatched = true;
      const value = await task(); await this.outcome(true); return value;
    } catch (error) {
      if (dispatched && /^(QLOO_AUTH|QLOO_TIMEOUT|QLOO_TRANSPORT|QLOO_CONNECTION_CLOSED|QLOO_UPSTREAM|QLOO_SEARCH|QLOO_METADATA|QLOO_INCOMPLETE|QLOO_CONTRACT|QLOO_RATE)/.test(error.code || '')) await this.outcome(false);
      throw error;
    } finally { const next = this.waiters.shift(); if (next) next(); else this.active--; }
  }
  async cached(key, task, scope) {
    const previous = this.cache.get(key);
    if (previous && previous.expires > this.now()) return structuredClone(previous.value);
    if (this.inflight.has(key)) return structuredClone(await this.inflight.get(key));
    const pending = this.limited(task, scope).then(value => {
      if (this.cache.size >= 200) this.cache.delete(this.cache.keys().next().value);
      this.cache.set(key, { value, expires: this.now() + 5 * 60000 }); return value;
    }).finally(() => this.inflight.delete(key));
    this.inflight.set(key, pending); return structuredClone(await pending);
  }
  async search(query, type, scope) {
    if (!TYPES.includes(type) || typeof query !== 'string' || query.trim().length < 2 || query.length > 100 || /[\x00-\x1f]/.test(query) || query.trim().startsWith('-')) throw new ProviderError('SEARCH_INPUT', 'Search for a film, book or artist using 2–100 characters.', { status: 422 });
    return this.cached(`search:${type}:${query.trim().toLowerCase()}`, async () => {
      const response = await this.harness.search(query.trim(), type);
      let rows;
      // qloo api search --json returns the formatted entity array, not the raw HTTP wrapper.
      if (Array.isArray(response)) rows = response;
      else if (response.code === 'NOT_FOUND' || response.status === 404 || response.error?.status === 404 || response.error?.status_code === 404) rows = [];
      else if (response.status) rows = workflowEntities(response);
      else if (response.error || response.success === false) throw new ProviderError(response.code === 'AUTH_FAILED' ? 'QLOO_AUTH' : 'QLOO_SEARCH', response.code === 'AUTH_FAILED' ? 'Qloo rejected the server credential. Check its expiration.' : 'Qloo could not complete the search. Check npm run doctor.');
      else rows = Array.isArray(response.results) ? response.results : response.results?.entities;
      if (!Array.isArray(rows)) throw new ProviderError('QLOO_CONTRACT', 'Qloo search returned an unsupported response shape.');
      const entities = rows.map(row => normalizeEntity(row, type)).filter(entity => entity?.type === type);
      if (rows.length && !entities.length) throw new ProviderError('QLOO_CONTRACT', 'Qloo returned search matches without supported cultural entity identities.');
      this.lastVerifiedAt = this.now(); return entities.slice(0, 8);
    }, scope);
  }
  async research(players, onProgress = () => {}, scope) {
    if (!Array.isArray(players) || players.length < 2 || players.length > 4 || players.some(p => p.favorites.length < 2 || p.favorites.length > 4 || p.favorites.some(f => !isEntityId(f.id)))) throw new ProviderError('PROFILE_INPUT', 'Each of two to four players needs two to four confirmed Qloo favourites.', { status: 422 });
    await this.harness.connect(); const tool = this.harness.tools.get('qloo_recommend');
    const exclude = new Set(players.flatMap(p => p.favorites.map(f => f.id)));
    const results = players.map(p => ({ playerId: p.id, entities: [], requests: [] }));
    let completed = 0, requested = 0, total = players.length * TYPES.length;
    const runRound = async limit => {
      await Promise.all(players.flatMap((player, index) => TYPES.map(type => ({ player, index, type }))).map(async ({ player, index, type }) => {
        const args = recommendationArguments(tool, player.favorites, type, limit);
        const hash = createHash('sha256').update(JSON.stringify(args)).digest('hex');
        const snapshot = await this.cached(`recommend:${hash}`, async () => {
          if (++requested > this.maxRequests) throw new ProviderError('QLOO_BUDGET', 'This research reached its request budget. Try different favourites.', { status: 422 });
          const response = await this.harness.call('qloo_recommend', args), rows = workflowEntities(response);
          const normalized = rows.map(row => normalizeEntity(row, type)).filter(Boolean);
          if (rows.length && !normalized.length) throw new ProviderError('QLOO_CONTRACT', 'Recommendations were returned without supported entity details.');
          this.lastVerifiedAt = this.now(); return { entities: normalized, receipt: { requestId: hash, category: type, inputIds: player.favorites.map(entity => entity.id), limit: args.limit ?? args.take ?? null, completedAt: this.now(), status: response.status, returnedIds: normalized.map(entity => entity.id) } };
        }, scope);
        const entities = snapshot.entities;
        const map = new Map(results[index].entities.map(entity => [entity.id, entity]));
        // Keep real cross-profile returns of a favourite: it may introduce that favourite to a friend.
        entities.forEach(entity => { map.set(entity.id, entity); });
        results[index].entities = [...map.values()]; results[index].requests.push(snapshot.receipt);
        completed++; await onProgress({ completed, total, stage: 'recommendations' });
      }));
    };
    await runRound(scope?.expanded ? 20 : 12);
    const shared = results[0].entities.some(entity => results.every(result => result.entities.some(item => item.id === entity.id)));
    const properties = tool.inputSchema?.properties || {};
    if (!scope?.expanded && !shared && (properties.limit || properties.take) && this.maxRequests >= total * 2) {
      const bound = schemaAt(properties.limit || properties.take, tool.inputSchema).maximum;
      if (!bound || bound > 12) { total *= 2; await onProgress({ completed, total, stage: 'widening' }); await runRound(20); }
    }
    if (this.harness.entities && results[0].entities.some(entity => results.every(result => result.entities.some(item => item.id === entity.id)))) {
      const ids = shortlist(results, exclude).map(entity => entity.id).sort();
      await onProgress({ completed, total: total + 1, stage: 'metadata' });
      // One batched raw entity request restores fields omitted by the compact workflow response.
      // Missing optional details never change recommendation membership or manufacture artwork.
      try {
        const metadata = await this.cached(`metadata:${ids.join(',')}`, async () => {
          const raw = await this.harness.entities(ids);
          if (raw?.code === 'AUTH_FAILED') throw new ProviderError('QLOO_AUTH', 'Qloo rejected the server credential while loading entity details.');
          if (raw?.error || raw?.success === false) throw new ProviderError('QLOO_METADATA', 'Some artwork and publication details could not be loaded.');
          const rows = Array.isArray(raw) ? raw : raw?.entity_id ? [raw] : Array.isArray(raw?.results) ? raw.results : raw?.results?.entities;
          if (!Array.isArray(rows)) throw new ProviderError('QLOO_CONTRACT', 'Entity metadata had an unsupported response shape.');
          return rows.map(row => normalizeEntity(row)).filter(entity => entity && ids.includes(entity.id));
        }, scope);
        const byId = new Map(metadata.map(entity => [entity.id, entity]));
        for (const result of results) result.entities = result.entities.map(entity => byId.has(entity.id) ? { ...entity, ...byId.get(entity.id), evidence: entity.evidence } : entity);
      } catch (error) {
        if (error?.code === 'QLOO_AUTH') throw error;
        for (const result of results) result.metadataWarning = 'Some artwork or publication details were unavailable. Recommendation membership is unchanged.';
      }
      await onProgress({ completed: total + 1, total: total + 1, stage: 'metadata' });
    }
    return results;
  }
  async close() { this.closed = true; await this.harness.close(); await Promise.allSettled([...this.inflight.values()]); }
}
