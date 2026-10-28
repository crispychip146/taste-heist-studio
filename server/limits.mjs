export function positiveInteger(value, name, max = 1000000) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > max) throw new Error(`${name} must be an integer between 1 and ${max}.`);
  return number;
}
export const setting = (name, fallback, max) => positiveInteger(process.env[name] ?? fallback, name, max);

export function publicOrigin() {
  const value = process.env.PUBLIC_ORIGIN;
  if (!value) {
    if (process.env.NODE_ENV === 'production') throw new Error('PUBLIC_ORIGIN is required in production.');
    return null;
  }
  let url; try { url = new URL(value); } catch { throw new Error('PUBLIC_ORIGIN must be an absolute HTTPS origin.'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback && process.env.NODE_ENV !== 'production'))) throw new Error('PUBLIC_ORIGIN must be an HTTPS origin without a path or credentials.');
  return url.origin;
}
