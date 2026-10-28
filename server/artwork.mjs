import { ProviderError } from './errors.mjs';
import { positiveInteger, setting } from './limits.mjs';

const MAX_BYTES = 2500000;
const MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif']);
export function trustedImage(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    const extra = (process.env.QLOO_IMAGE_HOSTS || '').split(',').map(host => host.trim()).filter(Boolean);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || (!/^(?:[a-z0-9-]+\.)?images\.qloo\.com$/.test(url.hostname) && !extra.includes(url.hostname))) return null;
    return url.href;
  } catch { return null; }
}
export function imagePathFor(entity) {
  return trustedImage(entity.imageSource) ? `/api/artwork/${encodeURIComponent(entity.id)}` : null;
}
export class Artwork {
  constructor({ fetcher = fetch, now = Date.now, concurrency = setting('ARTWORK_CONCURRENCY', 4, 16), queueLimit = setting('ARTWORK_QUEUE_LIMIT', 24, 200) } = {}) {
    this.fetcher = fetcher; this.now = now; this.cache = new Map(); this.inflight = new Map(); this.bytes = 0;
    this.concurrency = positiveInteger(concurrency, 'ARTWORK_CONCURRENCY', 16); this.queueLimit = positiveInteger(queueLimit, 'ARTWORK_QUEUE_LIMIT', 200);
    this.active = 0; this.waiters = [];
  }
  async limited(task) {
    if (this.active >= this.concurrency) {
      if (this.waiters.length >= this.queueLimit) throw new ProviderError('ARTWORK_BUSY', 'Artwork is busy. The title is still available.', { status: 503, retryable: true, retryAfter: 5 });
      await new Promise(resolve => this.waiters.push(resolve));
    } else this.active++;
    try { return await task(); }
    finally { const next = this.waiters.shift(); if (next) next(); else this.active--; }
  }
  async get(source) {
    const url = trustedImage(source);
    if (!url) throw new ProviderError('IMAGE_UNAVAILABLE', 'Artwork is unavailable for this title.', { status: 404 });
    const cached = this.cache.get(url);
    if (cached && cached.expires > this.now()) return cached;
    if (this.inflight.has(url)) return this.inflight.get(url);
    const task = this.limited(() => this.fetchImage(url)).then(result => {
      const replaced = this.cache.get(url);
      if (replaced) { this.bytes -= replaced.body.length; this.cache.delete(url); }
      while (this.bytes + result.body.length > 16 * 1024 * 1024 && this.cache.size) {
        const oldest = this.cache.keys().next().value; this.bytes -= this.cache.get(oldest).body.length; this.cache.delete(oldest);
      }
      this.cache.set(url, result); this.bytes += result.body.length; return result;
    }).finally(() => this.inflight.delete(url));
    this.inflight.set(url, task); return task;
  }
  async fetchImage(initial) {
    let url = initial;
    for (let redirects = 0; redirects <= 2; redirects++) {
      let response;
      try { response = await this.fetcher(url, { redirect: 'manual', signal: AbortSignal.timeout(8000), headers: { accept: 'image/avif,image/webp,image/png,image/jpeg' } }); }
      catch { throw new ProviderError('IMAGE_UNAVAILABLE', 'Artwork could not be reached.', { status: 404 }); }
      if (response.status >= 300 && response.status < 400) {
        const next = trustedImage(new URL(response.headers.get('location') || '', url).href);
        await response.body?.cancel().catch(() => {});
        if (!next) break; url = next; continue;
      }
      const type = (response.headers.get('content-type') || '').split(';')[0];
      if (!response.ok || !MIME.has(type) || Number(response.headers.get('content-length') || 0) > MAX_BYTES) { await response.body?.cancel().catch(() => {}); break; }
      const chunks = []; let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.length; if (bytes > MAX_BYTES) throw new ProviderError('IMAGE_UNAVAILABLE', 'Artwork exceeds the supported size.', { status: 404 });
        chunks.push(Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks);
      const valid = type === 'image/jpeg' ? body[0] === 0xff && body[1] === 0xd8
        : type === 'image/png' ? body.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
        : type === 'image/webp' ? body.subarray(0, 4).toString() === 'RIFF' && body.subarray(8, 12).toString() === 'WEBP'
        : body.subarray(4, 8).toString() === 'ftyp' && /avif|avis/.test(body.subarray(8, 32).toString());
      if (!valid) break;
      return { body, type, expires: this.now() + 15 * 60000 };
    }
    throw new ProviderError('IMAGE_UNAVAILABLE', 'Artwork is unavailable for this title.', { status: 404 });
  }
}
