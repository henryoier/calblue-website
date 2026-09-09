(() => {
  const competition = document.querySelector('[data-competition-roster]');
  const directory = document.querySelector('[data-club-players]');
  if (!competition && !directory) return;
  const key = name => name.normalize('NFKC').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
  function card(player) {
    const article = document.createElement('article');
    article.className = 'player-card';
    const image = document.createElement('img');
    image.alt = player.name;
    image.loading = 'lazy';
    image.src = /^https:\/\//.test(player.photo || '') ? player.photo : 'assets/calblue-logo-web.jpg';
    image.addEventListener('error', () => { image.src = 'assets/calblue-logo-web.jpg'; }, { once: true });
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
      const names = new Set([...directory.querySelectorAll('h2')].map(node => key(node.textContent)));
      for (const roster of Object.values(data.competitions)) {
        for (const player of roster.players) {
          if (!names.has(key(player.name))) {
            directory.append(card({ name: player.name, photo: player.photo }));
            names.add(key(player.name));
          }
        }
      }
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
