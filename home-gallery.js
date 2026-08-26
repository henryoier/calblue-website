const homeGallery = document.querySelector('[data-home-gallery]');

if (homeGallery) {
  const slots = [...homeGallery.querySelectorAll('figure')];
  const shuffle = (items) => {
    const shuffled = [...items];

    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const randomIndex = Math.floor(Math.random() * (index + 1));
      [shuffled[index], shuffled[randomIndex]] = [shuffled[randomIndex], shuffled[index]];
    }

    return shuffled;
  };
  const chooseHighlight = (competition, album) => ({
    competition: competition.competition,
    dateLabel: album.dateLabel,
    href: album.href,
    imageSrc: album.imageSrc,
    imageAlt: album.imageAlt,
    title: album.title,
  });

  fetch('gallery.html')
    .then((response) => {
      if (!response.ok) throw new Error(`Gallery request failed: ${response.status}`);
      return response.text();
    })
    .then((markup) => {
      const galleryPage = new DOMParser().parseFromString(markup, 'text/html');
      const competitions = [...galleryPage.querySelectorAll('.gallery-category')]
        .map((category) => {
          const categoryHeading = category.querySelector('.gallery-category-heading h3');
          const albumCards = [...category.querySelectorAll('.album-card')]
            .map((card) => {
              const image = card.querySelector('img');
              const dateLabel = card.querySelector('.album-card-copy > span')?.textContent.trim();
              const title = card.querySelector('.album-card-copy h3')?.textContent.trim();
              const href = card.getAttribute('href');
              const imageSrc = image?.getAttribute('src');
              const imageAlt = image?.getAttribute('alt');

              if (!dateLabel || !href || !imageSrc || !title) return null;

              return {
                dateLabel,
                href,
                imageAlt: imageAlt || 'CalBlue match-day photograph',
                imageSrc,
                title,
              };
            })
            .filter(Boolean);

          if (!categoryHeading || !albumCards.length) return null;

          return {
            competition: categoryHeading.textContent.trim().replace(/^2026\s+/, ''),
            albums: albumCards,
          };
        })
        .filter(Boolean);

      const competitionHighlights = shuffle(competitions)
        .map((competition) => chooseHighlight(competition, shuffle(competition.albums)[0]))
        .slice(0, slots.length);

      if (competitionHighlights.length < slots.length) {
        const selectedImages = new Set(competitionHighlights.map((highlight) => highlight.imageSrc));
        const remainingHighlights = shuffle(
          competitions.flatMap((competition) => competition.albums.map((album) => chooseHighlight(competition, album))),
        ).filter((highlight) => !selectedImages.has(highlight.imageSrc));

        competitionHighlights.push(...remainingHighlights.slice(0, slots.length - competitionHighlights.length));
      }

      competitionHighlights.forEach((highlight, index) => {
        const slot = slots[index];
        const link = slot.querySelector('.photo-feature-link');
        const image = slot.querySelector('img');
        const caption = slot.querySelector('figcaption');

        link.href = highlight.href;
        link.setAttribute('aria-label', `Open the ${highlight.title.replace(/^CalBlue vs\s+/, '')} match album`);
        image.src = highlight.imageSrc;
        image.alt = highlight.imageAlt;
        caption.replaceChildren(document.createTextNode(highlight.competition));

        if (index === 0) {
          const date = document.createElement('span');
          date.textContent = highlight.dateLabel;
          caption.append(date);
        }
      });
    })
    .catch(() => {
      // Keep the cross-competition HTML fallback when the archive cannot be loaded.
    });
}
