export function shortlist(results, excluded = new Set(), take = 9) {
  const pool = new Map();
  for (const result of results) for (const entity of result.entities) if (!excluded.has(entity.id)) pool.set(entity.id, entity);
  const membership = id => results.filter(result => result.entities.some(entity => entity.id === id)).length;
  const sorted = [...pool.values()].sort((a, b) => membership(b.id) - membership(a.id) || a.id.localeCompare(b.id));
  // Keep cultural categories visible while putting verified shared options first within each category.
  const picked = [], types = ['movie', 'book', 'artist'];
  for (let round = 0; round < 3 && picked.length < take; round++) for (const type of types) {
    const next = sorted.filter(entity => entity.type === type)[round]; if (next && picked.length < take) picked.push(next);
  }
  for (const entity of sorted) if (picked.length < take && !picked.some(item => item.id === entity.id)) picked.push(entity);
  // A rare shared result must never disappear behind unsupported category fillers.
  const shared = sorted.find(entity => membership(entity.id) === results.length);
  if (shared && !picked.some(entity => entity.id === shared.id)) picked[picked.length - 1] = shared;
  return picked;
}
