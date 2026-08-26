const albumPage = document.querySelector('[data-album-page]');

if (albumPage) {
  const media = window.CALBLUE_MEDIA || {};
  const mediaBaseUrl = (media.baseUrl || '').replace(/\/$/, '');
  const albums = {
    tiger: { opponent: 'Tiger', date: 'May 24, 2026', count: 135, competition: '2026 NCCSF' },
    nbh: { opponent: 'NBH', date: 'May 23, 2026', count: 58, competition: '2026 NCCSF' },
    sfu: { opponent: 'SFU', date: 'May 16, 2026', count: 24, competition: '2026 NCCSF' },
    hehe: { opponent: 'Hehe', date: 'May 17, 2026', count: 66, competition: '2026 NCCSF' },
    btg: { opponent: 'Real Santa Clara', date: 'June 28, 2026', count: 28, competition: 'Beyond the Game' },
    'upsl-athletico': { opponent: 'Athletico San Jose', date: 'January 18, 2026', count: 34, competition: '2026 UPSL California Cup' },
    'upsl-bay-area': { opponent: 'Bay Area United', date: 'January 24, 2026', count: 32, competition: '2026 UPSL California Cup' },
    'upsl-san-ramon': { opponent: 'San Ramon FC', date: 'January 31, 2026', count: 51, competition: '2026 UPSL California Cup' },
  };
  const slug = albumPage.dataset.albumPage;
  const album = albums[slug];
  const grid = albumPage.querySelector('[data-album-grid]');

  if (album && grid && mediaBaseUrl) {
    const fragment = document.createDocumentFragment();

    for (let index = 1; index <= album.count; index += 1) {
      const number = String(index).padStart(3, '0');
      const remoteThumbnail = `${mediaBaseUrl}/gallery/${slug}/thumb/${number}.jpg`;
      const remoteFullImage = `${mediaBaseUrl}/gallery/${slug}/full/${number}.jpg`;
      const alt = `CalBlue vs ${album.opponent}, ${album.competition} photo ${index} of ${album.count}`;
      const caption = `CalBlue vs ${album.opponent} • ${album.date} • Photo ${index} of ${album.count}`;
      const button = document.createElement('button');
      const image = document.createElement('img');
      const label = document.createElement('span');

      button.className = 'album-photo';
      button.type = 'button';
      button.dataset.galleryItem = '';
      button.dataset.gallerySrc = remoteFullImage;
      button.dataset.galleryAlbum = slug;
      button.dataset.galleryPhoto = number;
      button.dataset.galleryAlt = alt;
      button.dataset.galleryCaption = caption;
      button.setAttribute('aria-label', `Open photo ${index} of ${album.count}`);

      image.src = remoteThumbnail;
      image.alt = alt;
      image.loading = index <= 4 ? 'eager' : 'lazy';
      image.decoding = 'async';
      image.addEventListener('error', () => {
        image.src = remoteFullImage;
      }, { once: true });
      label.textContent = `${index} / ${album.count}`;

      button.append(image, label);
      fragment.append(button);
    }

    grid.append(fragment);
  }
}
