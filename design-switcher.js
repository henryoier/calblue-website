(() => {
  const STORAGE_KEY = 'calblue-site-design';
  const DEFAULT_DESIGN = 'codex-pro';
  const designs = window.CALBLUE_DESIGNS = window.CALBLUE_DESIGNS || [
    {
      id: 'codex-pro',
      label: 'Codex Pro',
      description: 'Stadium editorial',
      themeColor: '#061724',
    },
    {
      id: 'classic',
      label: 'Classic',
      description: 'Original CalBlue',
      themeColor: '#071b3f',
    },
  ];

  const validDesign = (id) => designs.some((design) => design.id === id);
  const readStoredDesign = () => {
    try {
      return window.localStorage.getItem(STORAGE_KEY);
    } catch (error) {
      return null;
    }
  };
  const requestedDesign = new URLSearchParams(window.location.search).get('design');
  const storedDesign = readStoredDesign();
  const initialDesign = validDesign(requestedDesign)
    ? requestedDesign
    : validDesign(storedDesign)
      ? storedDesign
      : DEFAULT_DESIGN;

  document.documentElement.dataset.design = initialDesign;

  if (validDesign(requestedDesign)) {
    try {
      window.localStorage.setItem(STORAGE_KEY, requestedDesign);
    } catch (error) {
      // Query-string previews still work when storage is unavailable.
    }
  }

  const setThemeColor = (designId) => {
    const themeColor = designs.find((design) => design.id === designId)?.themeColor;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (themeColor && meta) meta.content = themeColor;
  };

  const applyDesign = (designId, persist = true) => {
    if (!validDesign(designId)) return;
    document.documentElement.dataset.design = designId;
    setThemeColor(designId);
    if (persist) {
      try {
        window.localStorage.setItem(STORAGE_KEY, designId);
      } catch (error) {
        // The selected design still works when storage is unavailable.
      }
    }
    const url = new URL(window.location.href);
    url.searchParams.set('design', designId);
    window.history.replaceState(null, '', url);
    document.dispatchEvent(new CustomEvent('calblue:designchange', { detail: { designId } }));
  };

  window.CalBlueDesign = Object.freeze({
    designs,
    set: applyDesign,
    current: () => document.documentElement.dataset.design,
  });

  document.addEventListener('DOMContentLoaded', () => {
    setThemeColor(initialDesign);

    const switcher = document.createElement('div');
    switcher.className = 'design-switcher';
    switcher.innerHTML = `
      <button class="design-switcher-toggle" type="button" aria-label="Choose website design" aria-expanded="false" aria-controls="design-switcher-panel" aria-haspopup="true">
        <span class="design-switcher-icon" aria-hidden="true"><i></i><i></i></span>
        <span><small>Website design</small><strong data-design-current aria-live="polite"></strong></span>
      </button>
      <div class="design-switcher-panel" id="design-switcher-panel" hidden>
        <div class="design-switcher-heading"><span>Design lab</span><small>Choose your view</small></div>
        <div class="design-switcher-options" role="group" aria-label="Website design">
          ${designs.map((design) => `
            <button type="button" data-design-option="${design.id}" aria-pressed="false">
              <span class="design-option-swatch design-option-swatch-${design.id}" aria-hidden="true"></span>
              <span><strong>${design.label}</strong><small>${design.description}</small></span>
              <b aria-hidden="true">✓</b>
            </button>
          `).join('')}
        </div>
      </div>
    `;
    document.body.append(switcher);

    const toggle = switcher.querySelector('.design-switcher-toggle');
    const panel = switcher.querySelector('.design-switcher-panel');
    const currentLabel = switcher.querySelector('[data-design-current]');
    const optionButtons = [...switcher.querySelectorAll('[data-design-option]')];

    const updateControls = () => {
      const current = document.documentElement.dataset.design;
      currentLabel.textContent = designs.find((design) => design.id === current)?.label || current;
      optionButtons.forEach((button) => {
        button.setAttribute('aria-pressed', String(button.dataset.designOption === current));
      });
    };

    const closePanel = (restoreFocus = false) => {
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

    optionButtons.forEach((button) => {
      button.addEventListener('click', () => {
        applyDesign(button.dataset.designOption);
        updateControls();
        closePanel(true);
      });
    });

    document.addEventListener('click', (event) => {
      if (!switcher.contains(event.target)) closePanel();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closePanel(true);
    });
    document.addEventListener('calblue:navigation', (event) => {
      if (event.detail?.open) closePanel();
    });
    document.addEventListener('calblue:designchange', updateControls);
    updateControls();
  });
})();
