import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ProviderError } from './errors.mjs';
import { positiveInteger } from './limits.mjs';

const ORIGIN = 'https://hackathon.api.qloo.com';
const MAX_OUTPUT = 3 * 1024 * 1024;
const MCP_TIMEOUT = -32001, MCP_CLOSED = -32000;
const SAFE_TRANSPORT_CODES = new Set([-32001, -32000, -32600, -32601, -32602, -32603, -32700, 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);
export function harnessEnvironment(env = process.env) {
  for (const field of ['QLOO_BASE_URL', 'QLOO_TRUSTED_BASE_URL']) {
    if (env[field] && env[field].replace(/\/$/, '') !== ORIGIN) throw new ProviderError('QLOO_HOST', `${field} must point to the hackathon API.`, { status: 503 });
  }
  return { ...env, QLOO_BASE_URL: ORIGIN, QLOO_TRUSTED_BASE_URL: ORIGIN };
}
export function harnessCommand(env = process.env) {
  const local = resolve(import.meta.dirname, '../node_modules/.bin/qloo');
  return env.QLOO_HARNESS_COMMAND || (existsSync(local) ? local : 'qloo');
}
// No shell interpolation, credentials in environment only, bounded output, no raw stderr in logs.
export function runHarness(args, { env = process.env, timeout = 25000, spawnProcess = spawn } = {}) {
  return new Promise((resolveResult, reject) => {
    let child, output = '', size = 0, settled = false;
    const finish = (error, result) => {
      if (settled) return; settled = true; clearTimeout(timer);
      error ? reject(error) : resolveResult(result);
    };
    const timer = setTimeout(() => { child?.kill('SIGKILL'); finish(new ProviderError('QLOO_TIMEOUT', 'Qloo took too long. Your crew is saved; try again shortly.', { retryable: true })); }, timeout);
    try { child = spawnProcess(harnessCommand(env), args, { shell: false, env: harnessEnvironment(env), stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { finish(new ProviderError('HARNESS_MISSING', 'Install the official Qloo harness with npm install before starting research.')); return; }
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_OUTPUT) { child.kill('SIGKILL'); finish(new ProviderError('QLOO_CONTRACT', 'The provider response exceeded the supported size.')); return; }
      output += chunk;
    });
    child.stderr.on('data', () => {});
    child.once('error', () => finish(new ProviderError('HARNESS_MISSING', 'The official Qloo harness could not start. Run npm install and check the server configuration.')));
    child.once('close', code => {
      if (settled) return;
      let parsed; try { parsed = JSON.parse(output); }
      catch { finish(new ProviderError('QLOO_TRANSPORT', code ? 'The Qloo command failed. Run npm run doctor for a redacted diagnosis.' : 'The Qloo command did not return valid JSON.', { retryable: code !== 0 })); return; }
      // A workflow may deliberately exit nonzero and still provide a structured recovery response.
      if (code && !parsed.status && !parsed.error) { finish(new ProviderError('QLOO_TRANSPORT', 'Qloo could not complete the request.', { retryable: true })); return; }
      finish(null, parsed);
    });
  });
}
export function unwrapTool(result) {
  if (result?.structuredContent) return result.structuredContent;
  const content = result?.content?.find(item => item.type === 'text');
  if (content) { try { return JSON.parse(content.text); } catch {} }
  throw new ProviderError('QLOO_CONTRACT', 'Qloo returned an unsupported tool response. No substitute data was used.');
}
export function workflowEntities(envelope) {
  const status = envelope?.status;
  if (status === 'empty') return [];
  if (status === 'needs_input') throw new ProviderError('QLOO_NEEDS_INPUT', 'Qloo needs a more specific cultural match. Review the selected favourites.', { status: 422 });
  if (status === 'partial' || status === 'degraded') throw new ProviderError('QLOO_INCOMPLETE', 'Qloo returned incomplete research. Your crew is saved; retry before choosing a discovery.', { retryable: true });
  if (status === 'error') {
    const raw = String(envelope.error?.code || 'QLOO_ERROR');
    const code = /^[A-Z0-9_]{1,50}$/.test(raw) ? raw : 'QLOO_ERROR';
    const message = /AUTH|CREDENTIAL|KEY/.test(code) ? 'Qloo rejected the server credential. Check the key and its expiration.'
      : /RATE|QUOTA|LIMIT/.test(code) ? 'Qloo’s request allowance has been reached. Wait before retrying.'
      : 'Qloo could not complete this request. Your crew and confirmed favourites are saved.';
    throw new ProviderError(code, message, { retryable: envelope.error?.retryable === true });
  }
  if (status !== 'ok' || !Array.isArray(envelope.results)) throw new ProviderError('QLOO_CONTRACT', 'The Qloo workflow response did not match its documented contract.');
  return envelope.results;
}
export class Harness {
  constructor({ env = process.env, runner = runHarness, clientFactory } = {}) {
    this.env = harnessEnvironment(env); this.runner = runner; this.clientFactory = clientFactory;
    this.workflowTimeout = positiveInteger(this.env.QLOO_WORKFLOW_TIMEOUT_MS ?? 60000, 'QLOO_WORKFLOW_TIMEOUT_MS', 120000);
    this.client = null; this.connecting = null; this.tools = new Map(); this.credentialReady = false;
  }
  async connect() {
    if (this.closed) throw new ProviderError('HARNESS_CLOSED', 'Research is stopping. Reconnect to the archive.');
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      let client;
      try {
        if (this.clientFactory) client = await this.clientFactory();
        else {
          let Client, StdioClientTransport;
          try {
            ({ Client } = await import('@modelcontextprotocol/sdk/client/index.js'));
            ({ StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js'));
          } catch { throw new ProviderError('HARNESS_MISSING', 'Install the official Qloo harness and MCP SDK with npm install.'); }
          client = new Client({ name: 'taste-heist-backend', version: '2.0.0' });
          const transport = new StdioClientTransport({ command: harnessCommand(this.env), args: ['mcp'], env: this.env, stderr: 'pipe' });
          await client.connect(transport, { timeout: 15000 });
          transport.stderr?.on('data', () => {});
        }
        const listed = await client.listTools();
        this.tools = new Map(listed.tools.map(tool => [tool.name, tool]));
        if (!this.tools.has('qloo_recommend') || !this.tools.has('qloo_capabilities')) throw new ProviderError('QLOO_CONTRACT', 'This harness does not expose the required Qloo workflows. Install version 0.1.26 or newer.');
        const capabilities = unwrapTool(await client.callTool({ name: 'qloo_capabilities', arguments: {} }, undefined, { timeout: 15000 }));
        this.credentialReady = capabilities.adapter?.ready === true;
        if (!this.credentialReady) throw new ProviderError('QLOO_AUTH', 'The Qloo harness has no ready server credential. Run npm run doctor.');
        client.onclose = () => { if (this.client === client) { this.client = null; this.credentialReady = false; } };
        this.client = client; return client;
      } catch (error) {
        try { await client?.close(); } catch {}
        if (error instanceof ProviderError) throw error;
        throw new ProviderError('HARNESS_CONNECTION', 'The official Qloo harness could not connect. Check the installation and server network.', { retryable: true });
      }
    })().finally(() => { this.connecting = null; });
    return this.connecting;
  }
  async call(name, args) {
    const client = await this.connect();
    try { return unwrapTool(await client.callTool({ name, arguments: args }, undefined, { timeout: this.workflowTimeout, maxTotalTimeout: this.workflowTimeout })); }
    catch (error) {
      if (error instanceof ProviderError) throw error;
      if (this.client === client) {
        this.client = null; this.credentialReady = false;
        try { await client.close(); } catch {}
      }
      if (this.closed) throw new ProviderError('HARNESS_CLOSED', 'Research is stopping. Reconnect to the archive.');
      const timeout = error?.code === MCP_TIMEOUT || error?.code === 'ETIMEDOUT' || ['TimeoutError', 'AbortError'].includes(error?.name);
      const disconnected = error?.code === MCP_CLOSED || ['ECONNRESET', 'EPIPE', 'ECONNREFUSED'].includes(error?.code);
      const failure = new ProviderError(timeout ? 'QLOO_TIMEOUT' : disconnected ? 'QLOO_CONNECTION_CLOSED' : 'QLOO_TRANSPORT',
        timeout ? 'The Qloo workflow exceeded its time limit. Your crew is saved; retry research shortly.'
          : disconnected ? 'The research connection closed. Your crew is saved; retry to reconnect.'
            : 'The Qloo workflow was interrupted. Your crew is saved; retry research shortly.', { retryable: true });
      if (SAFE_TRANSPORT_CODES.has(error?.code)) failure.transportCode = error.code;
      throw failure;
    }
  }
  async search(query, type) {
    return this.runner(['api', 'search', '--query', query, '--type', type, '--take', '8', '--json'], { env: this.env });
  }
  async entities(ids) {
    return this.runner(['api', 'entity', '--id', ids.join(','), '--json'], { env: this.env });
  }
  async close() { this.closed = true; const client = this.client; this.client = null; this.credentialReady = false; await client?.close(); }
}
