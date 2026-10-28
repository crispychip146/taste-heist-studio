// Runs before the stylesheet to avoid flashing the wrong theme on reload.
(() => {
  let saved; try { saved = localStorage.getItem('heist:theme'); } catch {}
  document.documentElement.dataset.theme = saved === 'light' || saved === 'dark' ? saved : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
})();
