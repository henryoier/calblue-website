(() => {
  const competition = document.querySelector('[data-competition-roster]');
  const directory = document.querySelector('[data-club-players]');
  if (!competition && !directory) return;
  function card(player) {
    const article = document.createElement('article');
    article.className = 'player-card';
    const image = document.createElement('img');
    image.alt = player.name;
    image.loading = 'lazy';
    const photos = (player.photos || [player.photo]).filter(url => /^https:\/\//.test(url || '') || /^assets\/roster\/[\w-]+\.jpg$/.test(url || ''));
    photos.push('assets/calblue-logo-web.jpg');
    image.src = photos.shift();
    image.addEventListener('error', () => { if (photos.length) image.src = photos.shift(); });
    const heading = document.createElement('h2');
    heading.textContent = player.name;
    article.append(image, heading);
    const details = [player.number && `#${player.number}`, player.position].filter(Boolean);
    if (details.length) {
      const description = document.createElement('p');
      description.textContent = details.join(' · ');
      article.append(description);
    }
    return article;
  }
  fetch('data/rosters.json').then(response => {
    if (!response.ok) throw new Error('Roster unavailable');
    return response.json();
  }).then(data => {
    if (competition) {
      const roster = data.competitions[competition.dataset.competitionRoster];
      if (!Array.isArray(roster?.players) || !roster.players.length) throw new Error('Roster unavailable');
      competition.querySelector('[data-roster-grid]').replaceChildren(...roster.players.map(card));
      const updated = new Date(data.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      competition.querySelector('[data-roster-status]').textContent = `${roster.players.length} players listed by the competition. Updated ${updated}.`;
    }
    if (directory) {
      const existing = [...directory.querySelectorAll('.player-card')].map(node => ({
        name: node.querySelector('h2').textContent,
        photo: node.querySelector('img').getAttribute('src'),
      }));
      const players = window.CALBLUE_PLAYERS.merge(existing, data.competitions);
      directory.replaceChildren(...players.map(({ name, photo, photos }) => card({ name, photo, photos })));
      document.querySelector('[data-player-count]').textContent = `${players.length} CalBlue players`;
    }
  }).catch(() => {
    if (competition) competition.querySelector('[data-roster-status]').textContent = 'The roster is temporarily unavailable. Visit the official roster below.';
    if (directory) {
      const note = document.createElement('p');
      note.textContent = 'Competition player updates are temporarily unavailable. Showing our existing club directory.';
      directory.before(note);
    }
  });
})();
