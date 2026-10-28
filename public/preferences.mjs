export function readPreference(key) { try { return localStorage.getItem(key); } catch { return null; } }
export function savePreference(key, value) { try { localStorage.setItem(key, value); } catch {} }
export function preferredTheme() {
  const saved = readPreference('heist:theme');
  return saved === 'light' || saved === 'dark' ? saved : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#191b20' : '#fafbfc');
}
