const albumPage = document.querySelector('[data-album-page]');

if (albumPage) {
  const albums = {
    tiger: { opponent: 'Tiger', date: 'May 24, 2026', count: 135 },
    nbh: { opponent: 'NBH', date: 'May 23, 2026', count: 58 },
    sfu: { opponent: 'SFU', date: 'May 16, 2026', count: 24 },
    hehe: { opponent: 'Hehe', date: 'May 17, 2026', count: 66 },
  };
  const slug = albumPage.dataset.albumPage;
  const album = albums[slug];
  const grid = albumPage.querySelector('[data-album-grid]');

  if (album && grid) {
    const fragment = document.createDocumentFragment();

    for (let index = 1; index <= album.count; index += 1) {
      const number = String(index).padStart(3, '0');
      const source = `assets/gallery/${slug}/${number}.jpg`;
      const alt = `CalBlue vs ${album.opponent}, tournament photo ${index} of ${album.count}`;
      const caption = `CalBlue vs ${album.opponent} • ${album.date} • Photo ${index} of ${album.count}`;
      const button = document.createElement('button');
      const image = document.createElement('img');
      const label = document.createElement('span');

      button.className = 'album-photo';
      button.type = 'button';
      button.dataset.galleryItem = '';
      button.dataset.gallerySrc = source;
      button.dataset.galleryAlt = alt;
      button.dataset.galleryCaption = caption;
      button.setAttribute('aria-label', `Open photo ${index} of ${album.count}`);

      image.src = source;
      image.alt = alt;
      image.loading = index <= 4 ? 'eager' : 'lazy';
      image.decoding = 'async';
      label.textContent = `${index} / ${album.count}`;

      button.append(image, label);
      fragment.append(button);
    }

    grid.append(fragment);
  }
}
