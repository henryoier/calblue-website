const header = document.querySelector('[data-header]');
const toggle = document.querySelector('[data-menu-toggle]');
const nav = document.querySelector('[data-nav]');
const mobileNavigation = window.matchMedia('(max-width: 900px)');

if (header) {
  const updateHeader = () => header.classList.toggle('scrolled', window.scrollY > 24);
  updateHeader();
  window.addEventListener('scroll', updateHeader, { passive: true });
}

if (toggle && nav) {
  const setNavigationState = (open, restoreFocus = false) => {
    const shouldOpen = mobileNavigation.matches && open;
    nav.classList.toggle('open', shouldOpen);
    nav.inert = mobileNavigation.matches && !shouldOpen;
    toggle.setAttribute('aria-expanded', String(shouldOpen));
    toggle.setAttribute('aria-label', shouldOpen ? 'Close navigation' : 'Open navigation');
    document.body.classList.toggle('nav-open', shouldOpen);
    document.dispatchEvent(new CustomEvent('calblue:navigation', { detail: { open: shouldOpen } }));
    if (restoreFocus) toggle.focus();
  };

  setNavigationState(false);

  toggle.addEventListener('click', () => {
    setNavigationState(!nav.classList.contains('open'));
  });

  nav.addEventListener('click', (event) => {
    if (event.target.closest('a')) setNavigationState(false);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && nav.classList.contains('open')) setNavigationState(false, true);
  });

  mobileNavigation.addEventListener('change', () => setNavigationState(false));
}

const year = document.querySelector('[data-year]');
if (year) year.textContent = new Date().getFullYear();

const lightbox = document.querySelector('[data-lightbox]');
if (lightbox) {
  const lightboxImage = lightbox.querySelector('img');
  const lightboxCaption = lightbox.querySelector('[data-lightbox-caption]');
  const galleryItems = [...document.querySelectorAll('[data-gallery-item]')];
  const previousButton = lightbox.querySelector('[data-lightbox-prev]');
  const nextButton = lightbox.querySelector('[data-lightbox-next]');
  const media = window.CALBLUE_MEDIA || {};
  const mediaBaseUrl = (media.baseUrl || '').replace(/\/$/, '');
  let activeIndex = 0;

  if (mediaBaseUrl) {
    galleryItems.forEach((item) => {
      const image = item.querySelector('img');
      const fallbackSource = item.dataset.gallerySrc;

      if (!image || !fallbackSource || !item.dataset.galleryAlbum || !item.dataset.galleryPhoto) return;

      image.addEventListener('error', () => {
        image.src = fallbackSource;
      }, { once: true });
      image.src = `${mediaBaseUrl}/gallery/${item.dataset.galleryAlbum}/thumb/${item.dataset.galleryPhoto}.jpg`;
    });
  }

  const showImage = (index) => {
    activeIndex = (index + galleryItems.length) % galleryItems.length;
    const item = galleryItems[activeIndex];
    const fallbackSource = item.dataset.gallerySrc;
    const remoteSource = mediaBaseUrl && item.dataset.galleryAlbum && item.dataset.galleryPhoto
      ? `${mediaBaseUrl}/gallery/${item.dataset.galleryAlbum}/full/${item.dataset.galleryPhoto}.jpg`
      : fallbackSource;

    lightboxImage.onerror = null;
    if (remoteSource !== fallbackSource) {
      lightboxImage.onerror = () => {
        lightboxImage.onerror = null;
        lightboxImage.src = fallbackSource;
      };
    }
    lightboxImage.src = remoteSource;
    lightboxImage.alt = item.dataset.galleryAlt;
    lightboxCaption.textContent = item.dataset.galleryCaption;
  };

  galleryItems.forEach((item, index) => {
    item.addEventListener('click', () => {
      showImage(index);
      lightbox.showModal();
    });
  });

  lightbox.querySelector('[data-lightbox-close]').addEventListener('click', () => lightbox.close());
  previousButton?.addEventListener('click', () => showImage(activeIndex - 1));
  nextButton?.addEventListener('click', () => showImage(activeIndex + 1));
  lightbox.addEventListener('click', (event) => {
    if (event.target === lightbox) lightbox.close();
  });
  lightbox.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft') showImage(activeIndex - 1);
    if (event.key === 'ArrowRight') showImage(activeIndex + 1);
  });
}
