import { readdir, readFile, access } from 'node:fs/promises';
import { SourceTextModule, Script } from 'node:vm';
import assert from 'node:assert/strict';
let checked = 0;
for (const folder of ['public', 'server', 'shared', 'scripts', 'tests']) {
  for (const entry of await readdir(folder)) if (/\.(mjs|js)$/.test(entry)) {
    const filename = `${folder}/${entry}`, source = await readFile(filename, 'utf8');
    if (entry.endsWith('.mjs')) new SourceTextModule(source, { identifier: filename });
    else new Script(source, { filename });
    checked++;
  }
}
const html = await readFile('public/index.html', 'utf8');
const css = await readFile('public/style.css', 'utf8');
for (const [, resource] of [...html.matchAll(/(?:src|href)="(\/[^"#]+)"/g), ...css.matchAll(/url\('(\/[^']+)'\)/g)]) await access(`public${resource}`);
const app = await readFile('public/app.mjs', 'utf8');
assert(!/innerHTML\s*\+=/.test(app));
assert(!/QLOO_API_KEY/.test(app));
assert(css.includes('prefers-reduced-motion'));
assert(html.includes('lang="en"'));
assert(html.includes('aria-live="polite"'));
const clientSources = [];
for (const folder of ['public', 'shared']) for (const entry of await readdir(folder)) if (/\.(mjs|js|html|css)$/.test(entry)) clientSources.push(await readFile(`${folder}/${entry}`, 'utf8'));
const bundle = clientSources.join('\n');
assert(!/FAVORITES|DISCOVERIES|sampleResearch|localRoom|\/shared\/game\.mjs|QLOO_API_KEY/.test(bundle), 'Client must not contain a fake catalogue, local game engine or server credentials.');
let environment = ''; try { environment = await readFile('.env', 'utf8'); } catch {}
const credential = environment.match(/^QLOO_API_KEY="?([^"\n]+)/m)?.[1];
if (credential && credential.length > 12 && bundle.includes(credential)) throw new Error('A server credential was detected in client sources.');
assert((await readdir('shared')).every(name => name === 'catalog.mjs'), 'Only public character/puzzle constants belong in shared/.');
console.log(`Checked ${checked} JavaScript modules, local assets, live-only client, secret boundary and accessibility hooks.`);
