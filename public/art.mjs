export const escapeHTML = text => String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const paths = {
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  moon: '<path d="M20.5 13.2A8.5 8.5 0 0 1 10.8 3.5a8.6 8.6 0 1 0 9.7 9.7Z"/>',
  arrow: '<path d="M4 12h15m-6-6 6 6-6 6"/>',
  back: '<path d="M20 12H5m6-6-6 6 6 6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  link: '<path d="m9 15 6-6m-6 9-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m0-3 2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0"/>',
  play: '<path d="m9 5 11 7-11 7z"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  motion: '<path d="M4 7h9a4 4 0 1 0-4-4M2 12h16a3 3 0 1 1-3 3M5 18h3a3 3 0 1 1-3 3"/>',
  sound: '<path d="M4 9h4l5-4v14l-5-4H4zM17 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
  book: '<path d="M12 6c-4-3-9-2-9-2v15s5-1 9 2c4-3 9-2 9-2V4s-5-1-9 2v15"/>',
  artist: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2"/><path d="M12 6a6 6 0 0 1 6 6m-12 0a6 6 0 0 0 6 6"/>',
  movie: '<rect x="3" y="5" width="18" height="15" rx="2"/><path d="M3 10h18M7 5l3 5m4-5 3 5"/>',
  record: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2"/>',
  ticket: '<path d="M3 5h18v5a2 2 0 0 0 0 4v5H3v-5a2 2 0 0 0 0-4zM15 5v14"/>',
  key: '<circle cx="8" cy="8" r="5"/><path d="m12 12 9 9m-5-5 3-3m0 6 3-3"/>',
  orbit: '<circle cx="12" cy="12" r="7"/><path d="M3 18 21 6"/>',
  spark: '<path d="m12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3z"/>',
  wave: '<path d="M2 8c4-8 6 8 10 0s6 8 10 0M2 16c4-8 6 8 10 0s6 8 10 0"/>',
  leaf: '<path d="M5 19C-1 5 13 3 21 3c0 10-3 19-16 16Zm0 0L16 8"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9 8a3 3 0 0 1 6 0c0 3-3 2-3 5m0 4h.01"/>',
};
export function icon(name, className = '') { return `<svg class="icon ${className}" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${paths[name] || paths.spark}</svg>`; }
export function avatar(index, className = '', happy = false) { return `<span aria-hidden="true" class="avatar avatar-${index} ${happy ? 'happy' : ''} ${className}" style="--character:${index}"></span>`; }
export function vault() { return '<span class="vault-logo" aria-hidden="true"><i></i></span>'; }
export function tile(entity, size = '') {
  const image = typeof entity.imageUrl === 'string' && /^\/api\/artwork\/[a-f0-9-]{36}$/.test(entity.imageUrl) ? entity.imageUrl : null;
  return `<div class="culture-art ${escapeHTML(entity.color || 'mint')} ${size} entity-${escapeHTML(entity.type)} ${image ? 'has-image' : ''}" aria-hidden="true"><span class="culture-disc">${icon(entity.type)}</span><span class="art-line one"></span><span class="art-line two"></span>${image ? `<img data-artwork src="${escapeHTML(image)}" alt="" loading="lazy" decoding="async">` : ''}</div>`;
}
