import { randomInt } from 'node:crypto';

export const secureRandom = () => randomInt(0x100000000) / 0x100000000;

const permutations = items => items.length ? items.flatMap((item, i) => permutations(items.filter((_, j) => j !== i)).map(rest => [item, ...rest])) : [[]];
const orders = permutations([0, 1, 2, 3]);
const accepts = (order, rule) => rule.relation === 'before' ? order.indexOf(rule.a) < order.indexOf(rule.b) : Math.abs(order.indexOf(rule.a) - order.indexOf(rule.b)) === 1;
const candidates = [];
for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) {
  candidates.push({ relation: 'before', a, b });
  if (b === a + 1) candidates.push({ relation: 'beside', a, b });
}
const templates = [];
for (let a = 0; a < candidates.length; a++) for (let b = a + 1; b < candidates.length; b++) for (let c = b + 1; c < candidates.length; c++) for (let d = c + 1; d < candidates.length; d++) {
  const rules = [candidates[a], candidates[b], candidates[c], candidates[d]];
  if (orders.filter(order => rules.every(rule => accepts(order, rule))).length !== 1) continue;
  if (rules.every((_, withheld) => orders.filter(order => rules.every((rule, seat) => seat === withheld || accepts(order, rule))).length >= 2)) templates.push(rules);
}
if (!templates.length) throw new Error('No valid four-seat puzzle templates.');

export function exitClues(exit, count, random = secureRandom) {
  if (count === 4) {
    const rules = templates[Math.floor(random() * templates.length)].map(rule => ({ ...rule, a: exit[rule.a], b: exit[rule.b] }));
    for (let i = rules.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [rules[i], rules[j]] = [rules[j], rules[i]]; }
    return rules.map(rule => {
      if (rule.relation === 'beside' && random() < .5) [rule.a, rule.b] = [rule.b, rule.a];
      return { kind: 'sequence', first: null, pairs: [], constraints: [rule], text: 'Combine every agent’s rule. Before allows a gap. Beside means neighbours, in either order.' };
    });
  }
  return Array.from({ length: count }, (_, seat) => ({ kind: 'sequence', first: null,
    pairs: exit.slice(0, -1).map((item, i) => [item, exit[i + 1]]).filter((_, i) => i % count === seat),
    text: 'Each arrow means immediately before. Combine your crew’s arrows into one sequence.' }));
}
