// Runs before the stylesheet to avoid flashing the wrong theme on reload.
(() => {
  let saved; try { saved = localStorage.getItem('heist:theme'); } catch {}
  const theme = saved === 'light' || saved === 'dark' ? saved : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#000000' : '#fff6ce');
})();
