import { lookup } from 'node:dns/promises';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Harness, harnessCommand, harnessEnvironment } from '../server/harness.mjs';
import { ProviderError } from '../server/errors.mjs';

const require = createRequire(import.meta.url);
let failed = false;
console.log(`Node ${process.versions.node}: ${Number(process.versions.node.split('.')[0]) >= 24 ? 'ready' : 'Node 24+ required'}`);
console.log(`Server credential: ${process.env.QLOO_API_KEY ? 'configured (hidden)' : 'missing'}`);
for (const dependency of ['@qloo/qloo-harness', '@modelcontextprotocol/sdk']) {
  try {
    if (dependency === '@qloo/qloo-harness') {
      const packagePath = resolve(import.meta.dirname, '../node_modules/@qloo/qloo-harness/package.json');
      let version;
      if (existsSync(packagePath)) version = JSON.parse(readFileSync(packagePath, 'utf8')).version.match(/^(\d+)\.(\d+)\.(\d+)$/);
      else {
        const result = spawnSync(harnessCommand(), ['--version'], { env: harnessEnvironment(), encoding: 'utf8', timeout: 5000 });
        if (result.error || result.status) throw new Error('Harness cannot start');
        version = result.stdout?.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
      }
      if (!version || (Number(version[1]) === 0 && Number(version[2]) === 1 && Number(version[3]) < 26) || (Number(version[1]) === 0 && Number(version[2]) < 1)) throw new Error('Missing or old harness');
    } else require.resolve('@modelcontextprotocol/sdk/client/index.js');
    console.log(`${dependency}: installed`);
  }
  catch { console.log(`${dependency}: not installed; run npm install`); failed = true; }
}
for (const host of ['registry.npmjs.org', 'hackathon.api.qloo.com']) {
  try { await lookup(host); console.log(`${host}: DNS available`); }
  catch { console.log(`${host}: DNS unavailable`); failed = true; }
}
if (!process.env.QLOO_API_KEY) failed = true;
if (!failed) {
  const harness = new Harness();
  try { await harness.connect(); console.log('Harness capabilities: credential ready (no live data request made)'); }
  catch (error) { console.log(error instanceof ProviderError ? `${error.code}: ${error.message}` : 'Harness check failed.'); failed = true; }
  finally { await harness.close(); }
}
console.log(failed ? 'Live verification is blocked. No credential has been printed.' : 'Ready for npm run verify:live.');
if (failed) process.exitCode = 1;
