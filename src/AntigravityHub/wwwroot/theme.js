(() => {
  const media = matchMedia('(prefers-color-scheme: dark)');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let preference = window.__hubTheme || 'system', active = null;
  const resolved = value => value === 'system' ? (media.matches ? 'dark' : 'light') : value;
  function paint(value) {
    document.documentElement.dataset.theme = resolved(value);
    const button = document.getElementById('theme-toggle');
    if (!button) return;
    const dark = resolved(value) === 'dark';
    button.setAttribute('aria-label', dark ? '切换为纸色' : '切换为墨色');
    button.title = button.getAttribute('aria-label');
    button.innerHTML = dark
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.5"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"/></svg>';
  }
  function steer(state) {
    if (!state.animation) return;
    // Keep the same snapshots and current radius, including when the user reverses twice.
    state.animation.updatePlaybackRate(resolved(preference) === state.end ? 1 : -1);
    if (state.animation.playState !== 'running') state.animation.play();
  }
  function apply(value, origin) {
    preference = ['system', 'light', 'dark'].includes(value) ? value : 'system';
    if (active && !reducedMotion.matches) { steer(active); return; }
    if (resolved(preference) === document.documentElement.dataset.theme) return;
    if (!origin || !document.startViewTransition || reducedMotion.matches) {
      active?.transition.skipTransition(); active = null; paint(preference); return;
    }
    const box = origin.getBoundingClientRect(), x = box.left + box.width / 2, y = box.top + box.height / 2;
    const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    const state = { end: resolved(preference), animation: null, transition: null };
    const inward = state.end === 'light';
    document.documentElement.dataset.themeReveal = inward ? 'inward' : 'outward';
    active = state;
    state.transition = document.startViewTransition(() => paint(state.end));
    state.transition.ready.then(() => {
      if (active !== state) return;
      const circles = [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`];
      state.animation = document.documentElement.animate({clipPath: inward ? circles.reverse() : circles}, {
        duration: 500, easing: 'cubic-bezier(.2,.7,.2,1)', fill: 'both',
        pseudoElement: inward ? '::view-transition-old(root)' : '::view-transition-new(root)'
      });
      steer(state);
      state.animation.finished.then(() => { if (active === state) paint(preference); }).catch(() => {});
    }).catch(() => { if (active === state) paint(preference); });
    state.transition.finished.finally(() => {
      if (active === state) { paint(preference); active = null; delete document.documentElement.dataset.themeReveal; }
      state.animation?.cancel();
    }).catch(() => {});
  }
  window.hubTheme = { apply, get preference() { return preference; }, get target() { return resolved(preference); } };
  // Chromium hit-tests captured root content as <html> while its snapshot is on screen.
  // Forward genuine clicks in the theme controls' live bounds; other clicks are untouched.
  document.addEventListener('click', event => {
    if (!active || !event.isTrusted || event.target !== document.documentElement || event.button !== 0) return;
    const control = [...document.querySelectorAll('#theme-toggle,#theme-system,#theme-light,#theme-dark')].find(button => {
      const r = button.getBoundingClientRect();
      return r.width && event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom;
    });
    if (control) { event.preventDefault(); control.click(); }
  }, true);
  media.addEventListener('change', () => { if (preference === 'system') apply(preference); });
  paint(preference);
  document.addEventListener('DOMContentLoaded', () => paint(preference), { once: true });
})();
