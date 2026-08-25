(() => {
  const registry = window.CALBLUE_DESIGNS;
  if (!registry || !Array.isArray(registry.designs) || !registry.designs.length) return;

  const designs = registry.designs;
  const byId = Object.fromEntries(designs.map((design) => [design.id, design]));
  const params = new URLSearchParams(window.location.search);
  const embedded = params.get('switcher') === 'off';
  const aliases = { pro: 'musecode-pro' };
  const normalize = (id) => aliases[id] || id;
  const valid = (id) => Boolean(id && byId[normalize(id)]);

  const readStored = () => {
    const keys = [registry.storageKey, ...(registry.legacyStorageKeys || [])];
    for (const key of keys) {
      try {
        const value = normalize(window.localStorage.getItem(key));
        if (valid(value)) return value;
      } catch (error) {
        return null;
      }
    }
    return null;
  };

  const writeStored = (id) => {
    try {
      window.localStorage.setItem(registry.storageKey, id);
    } catch (error) {
      // Selection still works when storage is unavailable.
    }
  };

  const requested = normalize(params.get('design') || params.get('theme'));
  const activeId = valid(requested)
    ? requested
    : readStored() || (valid(registry.defaultId) ? registry.defaultId : designs[0].id);
  const active = byId[activeId];
  const root = document.documentElement;

  root.dataset.design = active.id;

  const installStylesheets = (design) => {
    const stylesheets = design.stylesheets || [];
    const main = document.querySelector('link[data-site-stylesheet]');
    if (!main || !stylesheets.length) return;

    document.querySelectorAll('link[data-active-design-stylesheet]').forEach((link) => link.remove());
    main.setAttribute('href', stylesheets[0]);

    stylesheets.slice(1).forEach((href) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      link.dataset.activeDesignStylesheet = design.id;
      document.head.append(link);
    });
  };

  installStylesheets(active);

  const themeMeta = document.querySelector('meta[name="theme-color"]');
  if (themeMeta && active.themeColor) themeMeta.content = active.themeColor;

  if (active.script) {
    const script = document.createElement('script');
    script.src = active.script;
    script.async = false;
    script.dataset.activeDesignScript = active.id;
    document.head.append(script);
  }

  if (valid(requested) && !embedded) writeStored(active.id);
  else if (!embedded && readStored() === active.id) writeStored(active.id);

  const select = (id) => {
    const nextId = normalize(id);
    if (!valid(nextId) || nextId === active.id) return;
    if (!embedded) writeStored(nextId);
    const url = new URL(window.location.href);
    url.searchParams.set('design', nextId);
    url.searchParams.delete('theme');
    window.location.replace(url.toString());
  };

  window.CalBlueDesign = Object.freeze({
    designs,
    current: () => active.id,
    set: select,
  });
  window.CalBlueDesigns = Object.freeze({
    all: designs,
    current: () => active,
    select,
  });

  const ensureUtility = () => {
    if (active.utility !== 'club-strip') return;
    const header = document.querySelector('.site-header');
    if (!header || document.querySelector('.pro-utility')) return;
    const utility = document.createElement('div');
    utility.className = 'pro-utility';
    utility.setAttribute('aria-label', 'Club information');
    utility.innerHTML = `
      <div class="shell">
        <span>EST. 1996 · BAY AREA · SWPL PACIFIC PREMIER</span>
        <span><a href="mailto:calblue1996@gmail.com">calblue1996@gmail.com</a> · <a href="https://www.instagram.com/calbluefc/" target="_blank" rel="noopener">Instagram</a></span>
      </div>`;
    header.parentNode.insertBefore(utility, header);
  };

  const preserveEmbeddedDesign = () => {
    if (!embedded) return;
    document.querySelectorAll('a[href]').forEach((link) => {
      const href = link.getAttribute('href');
      if (!href || href.startsWith('#')) return;
      const url = new URL(href, window.location.href);
      if (url.origin !== window.location.origin || !['http:', 'https:', 'file:'].includes(url.protocol)) return;
      url.searchParams.set('design', active.id);
      url.searchParams.set('switcher', 'off');
      link.href = url.toString();
    });
  };

  const escape = (value) => String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);

  const buildSwitcher = () => {
    if (embedded || document.querySelector('.design-switcher')) return;
    const switcher = document.createElement('div');
    switcher.className = 'design-switcher';
    switcher.innerHTML = `
      <button class="design-switcher-toggle" type="button" aria-label="Choose website design" aria-expanded="false" aria-controls="design-switcher-panel" aria-haspopup="true">
        <span class="design-switcher-icon" aria-hidden="true"><i></i><i></i></span>
        <span><small>Website design</small><strong>${escape(active.name)}</strong></span>
        <span class="design-switcher-mobile-label" aria-hidden="true">Design</span>
      </button>
      <div class="design-switcher-panel" id="design-switcher-panel" hidden>
        <div class="design-switcher-heading"><span>Design lab</span><small>Choose your view</small></div>
        <div class="design-switcher-options" role="group" aria-label="Website design">
          ${designs.map((design) => {
            const swatch = design.swatch || ['#071b3f', '#1268e8'];
            return `
              <button type="button" data-design-option="${escape(design.id)}" aria-pressed="${design.id === active.id}">
                <span class="design-option-swatch" style="--swatch-a:${escape(swatch[0])};--swatch-b:${escape(swatch[1])};--swatch-c:${escape(swatch[2] || swatch[1])}" aria-hidden="true"></span>
                <span><em>${escape(design.agent)}</em><strong>${escape(design.name)}</strong><small>${escape(design.tagline)}</small></span>
                <b aria-hidden="true">✓</b>
              </button>`;
          }).join('')}
        </div>
        <div class="design-switcher-foot"><a href="design-preview.html?design=${escape(active.id)}">Desktop + mobile preview</a><span>${designs.length} designs</span></div>
      </div>`;
    document.body.append(switcher);

    const toggle = switcher.querySelector('.design-switcher-toggle');
    const panel = switcher.querySelector('.design-switcher-panel');
    const close = (restoreFocus = false) => {
      const wasOpen = !panel.hidden;
      panel.hidden = true;
      toggle.setAttribute('aria-expanded', 'false');
      if (restoreFocus && wasOpen) toggle.focus();
    };

    toggle.addEventListener('click', () => {
      const open = panel.hidden;
      panel.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
    });
    switcher.querySelectorAll('[data-design-option]').forEach((button) => {
      button.addEventListener('click', () => {
        if (button.dataset.designOption === active.id) close(true);
        else select(button.dataset.designOption);
      });
    });
    document.addEventListener('click', (event) => {
      if (!switcher.contains(event.target)) close();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') close(true);
    });
    document.addEventListener('calblue:navigation', (event) => {
      if (event.detail?.open) close();
    });
  };

  const start = () => {
    ensureUtility();
    preserveEmbeddedDesign();
    buildSwitcher();
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
