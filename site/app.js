// The hero carousel: two slides, switched by the tabs (click or arrow keys), and every 6 s unless it's
// paused, the pointer or focus is in it, or the visitor prefers reduced motion. Without this script the
// first slide shows and the second stays hidden (it's marked up hidden).
(() => {
  const hero = document.getElementById('top');
  const slides = [...hero.querySelectorAll('.slide')];
  const tabs = [...hero.querySelectorAll('[role="tab"]')];
  const pause = hero.querySelector('.pause');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let i = 0;
  let hovered = false;
  let stopped = reduced;
  const show = (k, focus = false) => {
    i = k;
    slides.forEach((s, n) => {
      s.setAttribute('aria-hidden', String(n !== k));
      // a hidden slide's links can't take focus
      s.toggleAttribute('inert', n !== k);
    });
    tabs.forEach((t, n) => {
      t.setAttribute('aria-selected', String(n === k));
      t.tabIndex = n === k ? 0 : -1;
    });
    if (focus) tabs[k].focus();
  };
  tabs.forEach((t, n) => {
    t.addEventListener('click', () => show(n));
    t.addEventListener('keydown', (e) => {
      const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
      if (step) {
        e.preventDefault();
        show((n + step + tabs.length) % tabs.length, true);
      } else if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        show(e.key === 'Home' ? 0 : tabs.length - 1, true);
      }
    });
  });
  // a visible stop for touch and keyboard users (WCAG 2.2.2)
  const label = () => {
    pause.textContent = stopped ? 'Play' : 'Pause';
    pause.setAttribute('aria-pressed', String(stopped));
  };
  if (!reduced) {
    pause.hidden = false;
    label();
    pause.addEventListener('click', () => {
      stopped = !stopped;
      label();
    });
  }
  hero.addEventListener('mouseenter', () => (hovered = true));
  hero.addEventListener('mouseleave', () => (hovered = false));
  hero.addEventListener('focusin', () => (hovered = true));
  hero.addEventListener('focusout', () => (hovered = false));
  show(0);
  setInterval(() => !stopped && !hovered && !document.hidden && show((i + 1) % slides.length), 6000);
})();
