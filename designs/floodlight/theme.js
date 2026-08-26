/*
  Floodlight design — optional behaviour layer.

  Loaded by designs/switcher.js only while the Floodlight design is active, so
  nothing here affects the other designs. It only adds progressive enhancement:
  scroll-in reveals and a count-up for the "at a glance" numbers.
*/
(() => {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const ANIMATED = [
    '.intro-grid > *',
    '.number-grid > div',
    '.section-heading > *',
    '.team-card',
    '.league-banner',
    '.schedule-heading > *',
    '.match-card',
    '.values-title',
    '.value-list article',
    '.photo-feature-heading > *',
    '.photo-feature-grid figure',
    '.join-inner > *',
    '.roster-heading > *',
    '.player-card',
    '.gallery-heading > *',
    '.gallery-category-nav a',
    '.album-card',
    '.gallery-item',
  ].join(',');

  const countUp = (element) => {
    const target = Number(element.dataset.count);
    if (!Number.isFinite(target) || target <= 0) return;

    const duration = 1100;
    const start = performance.now();

    const step = (now) => {
      const progress = Math.min((now - start) / duration, 1);
      const eased = 1 - (1 - progress) ** 3;
      element.textContent = String(Math.round(target * eased));
      if (progress < 1) requestAnimationFrame(step);
    };

    element.textContent = '0';
    requestAnimationFrame(step);
  };

  const start = () => {
    if (document.documentElement.dataset.design !== 'floodlight') return;

    const counters = [...document.querySelectorAll('[data-count]')];

    if (reducedMotion || !('IntersectionObserver' in window)) {
      return;
    }

    const groups = new Map();

    document.querySelectorAll(ANIMATED).forEach((element) => {
      if (element.closest('.hero')) return;
      const parent = element.parentElement;
      const index = groups.get(parent) || 0;
      groups.set(parent, index + 1);
      element.style.setProperty('--fl-i', String(Math.min(index, 6)));
      element.dataset.flAnim = '';
    });

    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      });
    }, { rootMargin: '0px 0px -12% 0px', threshold: 0.12 });

    document.querySelectorAll('[data-fl-anim]').forEach((element) => observer.observe(element));

    counters.forEach((counter) => {
      const counterObserver = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          countUp(counter);
          counterObserver.unobserve(counter);
        });
      }, { threshold: 0.6 });
      counterObserver.observe(counter);
    });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
