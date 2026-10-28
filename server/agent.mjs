// Agent-callable research uses exactly the same official-harness service as the web game.
import { createInterface } from 'node:readline';
import { Qloo, isEntityId } from './qloo.mjs';
import { ProviderError } from './errors.mjs';
import { Store } from './store.mjs';

function persistentResearch() {
  const store = new Store(undefined, { recoverResearch: false });
  return { qloo: new Qloo({ reserve: scope => store.reserveProvider(scope), outcome: success => store.providerOutcome(success) }), store };
}

export const tool = {
  name: 'research_taste_crew',
  description: 'Research 2–4 confirmed cultural profiles with the official Qloo harness. Return genuine recommendation intersections; collect human familiarity before treating an item as new.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['profiles'], properties: {
    profiles: { type: 'array', minItems: 2, maxItems: 4, items: { type: 'object', additionalProperties: false, required: ['id', 'entityIds'], properties: { id: { type: 'string', minLength: 1, maxLength: 40 }, entityIds: { type: 'array', minItems: 2, maxItems: 4, uniqueItems: true, items: { type: 'string', format: 'uuid' } } } } },
  } },
};
export async function researchCrew(args, suppliedQloo) {
  const profiles = args?.profiles;
  if (!Array.isArray(profiles) || profiles.length < 2 || profiles.length > 4 || profiles.some(p => typeof p.id !== 'string' || !p.id.length || p.id.length > 40 || !Array.isArray(p.entityIds) || p.entityIds.length < 2 || p.entityIds.length > 4 || new Set(p.entityIds).size !== p.entityIds.length || p.entityIds.some(id => !isEntityId(id)))) throw new ProviderError('PROFILE_INPUT', 'Provide 2–4 uniquely identified profiles, each with 2–4 confirmed Qloo UUIDs.', { status: 422 });
  if (new Set(profiles.map(p => p.id)).size !== profiles.length) throw new ProviderError('PROFILE_INPUT', 'Profile identifiers must be unique.', { status: 422 });
  const owned = suppliedQloo ? null : persistentResearch(), qloo = suppliedQloo || owned.qloo;
  try {
    const results = await qloo.research(profiles.map(p => ({ id: p.id, favorites: p.entityIds.map(id => ({ id: id.toLowerCase() })) })));
    const byId = new Map();
    for (const result of results) for (const entity of result.entities) {
      if (!byId.has(entity.id)) byId.set(entity.id, { id: entity.id, name: entity.name, type: entity.type, returnedFor: [] });
      byId.get(entity.id).returnedFor.push(result.playerId);
    }
    return { source: 'qloo', status: 'complete', sharedCandidates: [...byId.values()].filter(entity => new Set(entity.returnedFor).size === profiles.length),
      nextAction: 'Ask each person whether every candidate is known, new or skipped. Recommendation membership does not establish novelty or individual preference.',
      maxRequestBudget: qloo.maxRequests || 24 };
  } finally { if (owned) { await qloo.close(); owned.store.close(); } }
}
export async function rpc(message, qloo) {
  if (message.method === 'initialize') return { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'taste-heist', version: '2.0.0' } };
  if (message.method === 'tools/list') return { tools: [tool] };
  if (message.method === 'ping') return {};
  if (message.method === 'tools/call') {
    if (message.params?.name !== tool.name) throw new Error('Unknown tool.');
    try { return { content: [{ type: 'text', text: JSON.stringify(await researchCrew(message.params.arguments, qloo)) }] }; }
    catch (error) { return { isError: true, content: [{ type: 'text', text: error instanceof ProviderError ? `${error.code}: ${error.message}` : 'Research could not be completed. Check the server connection.' }] }; }
  }
  throw new Error('Unknown method.');
}
if (process.argv[1] === import.meta.filename) {
  const lines = createInterface({ input: process.stdin }), { qloo, store } = persistentResearch();
  try {
    for await (const line of lines) {
      let message;
      try {
        if (line.length > 20000) throw new Error('Request too large.');
        message = JSON.parse(line); if (message.id === undefined) continue;
        const result = await rpc(message, qloo); process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
      } catch { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32600, message: 'Invalid or unsupported request.' } }) + '\n'); }
    }
  } finally { await qloo.close(); store.close(); }
}
