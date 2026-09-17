(() => {
  const feeds = [...document.querySelectorAll('[data-news-feed]')];
  const article = document.querySelector('[data-news-article]');
  if (!feeds.length && !article) return;

  const formatDate = (iso) => new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', year: 'numeric',
  }).format(new Date(`${iso}T12:00:00-08:00`));
  const categoryClass = (category) => `is-${String(category).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  const queryParam = (name) => {
    if (typeof location === 'undefined' || !location.search) return null;
    const match = new RegExp(`[?&]${name}=([^&]*)`).exec(location.search);
    return match ? decodeURIComponent(match[1].replace(/\+/g, ' ')) : null;
  };

  const renderCard = (item) => {
    const card = document.createElement('article');
    card.className = `news-card ${categoryClass(item.category)}${item.poster ? ' is-poster' : ''}`;
    const link = document.createElement('a');
    link.className = 'news-card-link';
    link.href = item.href;
    if (item.external) { link.target = '_blank'; link.rel = 'noopener'; }
    const figure = document.createElement('figure');
    if (Array.isArray(item.players) && item.players.length) {
      // Squad cards: every new player's portrait, not just one image.
      figure.className = `news-portraits has-${Math.min(item.players.length, 6)}`;
      item.players.forEach((player) => {
        const portrait = document.createElement('img');
        portrait.src = player.photo || 'assets/calblue-logo-web.jpg';
        portrait.alt = player.name;
        portrait.title = player.name;
        portrait.loading = 'lazy';
        portrait.decoding = 'async';
        portrait.addEventListener('error', () => { portrait.src = 'assets/calblue-logo-web.jpg'; }, { once: true });
        figure.append(portrait);
      });
    } else if (!item.image && item.scoreline) {
      // Result without photos of its own: crests and the final score, never a photo from another game.
      figure.className = 'news-scoreline';
      [['home', item.scoreline.home], ['away', item.scoreline.away]].forEach(([side, team], index) => {
        if (index === 1) {
          const score = document.createElement('strong');
          score.textContent = `${item.scoreline.score.home} – ${item.scoreline.score.away}`;
          score.setAttribute('aria-label', `Final score ${item.scoreline.score.home} to ${item.scoreline.score.away}`);
          figure.append(score);
        }
        const team_ = document.createElement('span');
        team_.className = `news-scoreline-team is-${side}`;
        const crest = document.createElement('img');
        crest.src = team.logo || 'assets/calblue-logo-web.jpg';
        crest.alt = `${team.name} crest`;
        crest.loading = 'lazy';
        crest.addEventListener('error', () => { crest.src = 'assets/calblue-logo-web.jpg'; }, { once: true });
        const name = document.createElement('small');
        name.textContent = team.name;
        team_.append(crest, name);
        figure.append(team_);
      });
    } else if (!item.image) {
      figure.className = 'news-generic';
      const crest = document.createElement('img');
      crest.src = 'assets/calblue-logo-web.jpg';
      crest.alt = 'CalBlue FC crest';
      const label = document.createElement('span');
      label.textContent = item.category;
      figure.append(crest, label);
    } else {
      const image = document.createElement('img');
      image.src = item.image;
      image.alt = item.imageAlt || item.title;
      image.loading = 'lazy';
      image.decoding = 'async';
      figure.append(image);
    }
    const copy = document.createElement('div');
    copy.className = 'news-card-copy';
    const meta = document.createElement('p');
    meta.className = 'news-card-meta';
    const tag = document.createElement('span');
    tag.className = 'news-tag';
    tag.textContent = item.outcome ? `${item.category} · ${item.outcome}` : item.category;
    const time = document.createElement('time');
    time.dateTime = item.date;
    time.textContent = formatDate(item.date);
    meta.append(tag, time);
    const title = document.createElement('h3');
    title.textContent = item.title;
    const summary = document.createElement('p');
    summary.className = 'news-summary';
    summary.textContent = item.summary || '';
    const cta = document.createElement('span');
    cta.className = 'news-card-cta';
    cta.textContent = `${item.cta || 'Read more'} →`;
    copy.append(meta, title, summary, cta);
    link.append(figure, copy);
    card.append(link);
    return card;
  };

  const renderFeed = (feed, items) => {
    const grid = feed.querySelector('[data-news-grid]');
    const empty = feed.querySelector('[data-news-empty]');
    const limit = Number(feed.dataset.newsLimit) || 0;
    const active = feed.dataset.newsActive || '';
    let visible = active ? items.filter((item) => item.category === active) : items;
    if (limit) visible = visible.slice(0, limit);
    grid.replaceChildren(...visible.map(renderCard));
    if (empty) empty.hidden = visible.length > 0;
    feed.dataset.newsCount = String(visible.length);
  };

  const renderFilters = (feed, items) => {
    const bar = feed.querySelector('[data-news-filters]');
    if (!bar) return;
    const categories = [...new Set(items.map((item) => item.category))];
    const buttons = ['', ...categories].map((category) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = category || 'All';
      button.dataset.newsFilterButton = category;
      button.setAttribute('aria-pressed', String((feed.dataset.newsActive || '') === category));
      button.addEventListener('click', () => {
        feed.dataset.newsActive = category;
        [...bar.children].forEach((sibling) => sibling.setAttribute('aria-pressed', String(sibling === button)));
        renderFeed(feed, items);
      });
      return button;
    });
    bar.replaceChildren(...buttons);
  };

  const renderArticle = (items) => {
    const slug = queryParam('post');
    const post = slug ? items.find((item) => item.slug === slug && Array.isArray(item.body)) : null;
    if (!post) { article.hidden = true; return false; }
    article.hidden = false;
    article.querySelector('[data-article-category]').textContent = post.category;
    const time = article.querySelector('[data-article-date]');
    time.dateTime = post.date;
    time.textContent = formatDate(post.date);
    article.querySelector('[data-article-title]').textContent = post.title;
    const image = article.querySelector('[data-article-image]');
    image.src = post.image;
    image.alt = post.imageAlt || post.title;
    const body = article.querySelector('[data-article-body]');
    body.replaceChildren(...[post.summary, ...post.body].filter(Boolean).map((text, index) => {
      const paragraph = document.createElement('p');
      if (index === 0) paragraph.className = 'news-article-lead';
      paragraph.textContent = text;
      return paragraph;
    }));
    if (typeof document.title === 'string') document.title = `${post.title} | CalBlue`;
    return true;
  };

  fetch('data/news.json', { cache: 'no-cache' })
    .then((response) => (response.ok ? response.json() : null))
    .then((data) => {
      const items = data && Array.isArray(data.items) ? data.items : [];
      if (article) renderArticle(items);
      feeds.forEach((feed) => {
        renderFilters(feed, items);
        renderFeed(feed, items);
      });
    });
})();
