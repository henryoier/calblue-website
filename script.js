const header = document.querySelector('[data-header]');
const toggle = document.querySelector('[data-menu-toggle]');
const nav = document.querySelector('[data-nav]');

const updateHeader = () => header.classList.toggle('scrolled', window.scrollY > 24);
updateHeader();
window.addEventListener('scroll', updateHeader, { passive: true });

toggle.addEventListener('click', () => {
  const open = nav.classList.toggle('open');
  toggle.setAttribute('aria-expanded', String(open));
  toggle.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
});

nav.addEventListener('click', (event) => {
  if (!event.target.closest('a')) return;
  nav.classList.remove('open');
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-label', 'Open navigation');
});

document.querySelector('[data-year]').textContent = new Date().getFullYear();

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
