const homeGallery = document.querySelector('[data-home-gallery]');

if (homeGallery) {
  const slots = [...homeGallery.querySelectorAll('figure')];

  fetch('gallery.html')
    .then((response) => {
      if (!response.ok) throw new Error(`Gallery request failed: ${response.status}`);
      return response.text();
    })
    .then((markup) => {
      const galleryPage = new DOMParser().parseFromString(markup, 'text/html');
      const competitionHighlights = [...galleryPage.querySelectorAll('.gallery-category')]
        .map((category) => {
          const categoryHeading = category.querySelector('.gallery-category-heading h3');
          const albumCards = [...category.querySelectorAll('.album-card')]
            .map((card) => {
              const image = card.querySelector('img');
              const dateLabel = card.querySelector('.album-card-copy > span')?.textContent.trim();
              const timestamp = Date.parse(dateLabel || '');

              if (!image || !dateLabel || Number.isNaN(timestamp)) return null;

              return {
                imageSrc: image.getAttribute('src'),
                imageAlt: image.getAttribute('alt') || 'CalBlue match-day photograph',
                dateLabel,
                timestamp,
              };
            })
            .filter(Boolean)
            .sort((first, second) => second.timestamp - first.timestamp);

          if (!categoryHeading || !albumCards.length) return null;

          return {
            ...albumCards[0],
            competition: categoryHeading.textContent.trim().replace(/^2026\s+/, ''),
          };
        })
        .filter(Boolean)
        .sort((first, second) => second.timestamp - first.timestamp)
        .slice(0, slots.length);

      competitionHighlights.forEach((highlight, index) => {
        const slot = slots[index];
        const image = slot.querySelector('img');
        const caption = slot.querySelector('figcaption');

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
