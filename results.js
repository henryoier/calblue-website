(() => {
  const isCalBlue = name => ['calblue', 'calbluefc'].includes(String(name).toLowerCase().replace(/[^a-z0-9]/g, ''));
  const valid = game => game.status === 'completed'
    && /^\d{4}-\d{2}-\d{2}$/.test(game.date)
    && game.home?.name && game.away?.name
    && (isCalBlue(game.home.name) || isCalBlue(game.away.name))
    && Number.isInteger(game.score?.home) && game.score.home >= 0
    && Number.isInteger(game.score?.away) && game.score.away >= 0;
  const text = (tag, value, className) => {
    const node = document.createElement(tag);
    node.textContent = value;
    if (className) node.className = className;
    return node;
  };
  for (const section of document.querySelectorAll('[data-results-feeds]')) {
    const list = section.querySelector('[data-results-list]');
    const status = section.querySelector('[data-results-status]');
    const feeds = section.dataset.resultsFeeds.split(',');
    Promise.allSettled(feeds.map(async league => {
      const response = await fetch(`data/${league}.json`, { cache: 'no-cache' });
      if (!response.ok) throw new Error('Results unavailable');
      const data = await response.json();
      if (!Array.isArray(data.results)) throw new Error('Results not yet available');
      return data.results.filter(valid).map(game => ({ ...game, league }));
    })).then(responses => {
      const successful = responses.filter(response => response.status === 'fulfilled');
      const games = successful.flatMap(response => response.value)
        .sort((a, b) => (b.startsAt || b.date).localeCompare(a.startsAt || a.date));
      const limit = Number(section.dataset.resultsLimit) || games.length;
      const items = games.slice(0, limit).map(game => {
        const home = isCalBlue(game.home.name);
        const difference = home ? game.score.home - game.score.away : game.score.away - game.score.home;
        const outcome = difference > 0 ? 'Win' : difference < 0 ? 'Loss' : 'Draw';
        const item = document.createElement('li');
        item.className = `result-card result-${outcome.toLowerCase()}`;
        const date = text('time', new Intl.DateTimeFormat('en-US', {
          timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', year: 'numeric',
        }).format(new Date(`${game.date}T12:00:00-08:00`)));
        date.dateTime = game.date;
        const label = game.league === 'nccsf' ? 'NCCSF League' : /abronzino/i.test(game.competition) ? 'Abronzino Cup' : 'SWPL League';
        const heading = text('div', '', 'result-meta');
        heading.append(text('span', label), date, text('strong', `Final · ${outcome}`));
        const score = text('div', '', 'result-scoreline');
        score.append(text('span', game.home.name), text('strong', `${game.score.home} – ${game.score.away}`), text('span', game.away.name));
        const roles = text('p', 'Home · Away', 'result-roles');
        const link = document.createElement('a');
        link.textContent = 'Official result ↗';
        try {
          const url = new URL(game.sourceUrl);
          if (url.protocol === 'https:') link.href = url.href;
        } catch { /* Keep invalid source links inert. */ }
        link.target = '_blank';
        link.rel = 'noopener';
        item.append(heading, score, roles, link);
        return item;
      });
      list.replaceChildren(...items);
      status.textContent = !successful.length ? 'Results are temporarily unavailable. Please check the official league website.'
        : successful.length < feeds.length ? 'One league feed is temporarily unavailable; showing available official results.'
          : !games.length ? 'No completed scores have been published yet.'
            : `Showing ${items.length} official result${items.length === 1 ? '' : 's'}. Scores are in home–away order.`;
    });
  }
})();
