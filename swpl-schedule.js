(() => {
  const schedule = document.querySelector('[data-swpl-schedule]');
  if (!schedule) return;

  const sourceUrl = schedule.dataset.swplSource;
  const nccsfSourceUrl = schedule.dataset.nccsfSource;
  const status = schedule.querySelector('[data-swpl-status-text]');
  const card = schedule.querySelector('[data-next-match]');
  const dateElement = schedule.querySelector('[data-match-date]');
  const venueElement = schedule.querySelector('[data-match-venue]');
  const countdownElement = schedule.querySelector('[data-match-countdown]');
  const competitionElement = schedule.querySelector('[data-match-competition]');
  const timeElement = schedule.querySelector('[data-match-time]');
  const detailsLink = schedule.querySelector('[data-match-link]');
  const fixturePanel = schedule.querySelector('[data-upcoming-fixtures]');
  const fixtureList = schedule.querySelector('[data-fixture-list]');
  const fixtureToggle = schedule.querySelector('[data-fixture-toggle]');
  const checkedElement = schedule.querySelector('[data-swpl-checked]');
  const matchdayPoster = document.querySelector('[data-matchday-poster]');
  let upcomingExpanded = false;
  let upcomingSchedule = [];

  const pacificDateParts = (value = new Date()) => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(value);
    return Object.fromEntries(parts.map(({ type, value: partValue }) => [type, partValue]));
  };

  const dayDifference = (date) => {
    const today = pacificDateParts();
    const target = date.split('-').map(Number);
    const todayUtc = Date.UTC(Number(today.year), Number(today.month) - 1, Number(today.day));
    const targetUtc = Date.UTC(target[0], target[1] - 1, target[2]);
    return Math.round((targetUtc - todayUtc) / 86400000);
  };

  if (matchdayPoster) {
    const posterDays = dayDifference(matchdayPoster.dataset.matchdayDate);
    const posterCountdown = matchdayPoster.querySelector('[data-matchday-countdown]');
    if (posterDays < 0) {
      matchdayPoster.hidden = true;
    } else if (posterCountdown) {
      posterCountdown.textContent = posterDays === 0
        ? 'Match day'
        : posterDays === 1
          ? 'Tomorrow'
          : `${posterDays} days to kickoff`;
    }
  }

  const formatDate = (fixture, options) => {
    const instant = fixture.startsAt
      ? new Date(fixture.startsAt)
      : new Date(`${fixture.date}T12:00:00-08:00`);
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      ...options,
    }).format(instant);
  };

  const safeHttpsUrl = (value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' ? url.href : null;
    } catch {
      return null;
    }
  };

  const isCalBlue = (name) => ['calblue', 'calbluefc'].includes(
    name.toLowerCase().replace(/[^a-z0-9]/g, ''),
  );

  const setTeam = (side, team) => {
    const name = side.querySelector('[data-team-name]');
    const role = side.querySelector('[data-team-role]');
    const image = side.querySelector('[data-team-crest]');
    const placeholder = side.querySelector('[data-team-placeholder]');
    const logo = isCalBlue(team.name) ? 'assets/calblue-logo-web.jpg' : safeHttpsUrl(team.logo);

    name.textContent = team.name;
    role.textContent = side.dataset.side === 'home' ? 'Home' : 'Away';
    side.classList.toggle('opponent', !isCalBlue(team.name));
    if (logo) {
      image.onerror = () => {
        image.hidden = true;
        placeholder.hidden = false;
        placeholder.textContent = team.name.slice(0, 1).toUpperCase() || '?';
      };
      image.src = logo;
      image.alt = `${team.name} crest`;
      image.hidden = false;
      placeholder.hidden = true;
    } else {
      image.onerror = null;
      image.removeAttribute('src');
      image.hidden = true;
      placeholder.hidden = false;
      placeholder.textContent = /tba|unknown|undecided/i.test(team.name)
        ? '?'
        : team.name.slice(0, 1).toUpperCase() || '?';
    }
  };

  const opponentFor = (fixture) => (
    isCalBlue(fixture.home.name) ? fixture.away : fixture.home
  );

  const createFixtureCrest = (team) => {
    const crest = document.createElement('span');
    const logo = safeHttpsUrl(team.logo);
    crest.className = 'fixture-row-crest';
    if (!logo) {
      crest.textContent = /tba|unknown|undecided/i.test(team.name)
        ? '?'
        : team.name.slice(0, 1).toUpperCase() || '?';
      return crest;
    }
    const image = document.createElement('img');
    image.src = logo;
    image.alt = `${team.name} crest`;
    image.loading = 'lazy';
    image.addEventListener('error', () => {
      crest.replaceChildren(document.createTextNode('?'));
    });
    crest.append(image);
    return crest;
  };

  const fixtureSummary = (fixture) => {
    if (fixture.eventOnly || fixture.competition.toLowerCase().includes('abronzino')) {
      return `Abronzino Cup · ${fixture.round || 'Fixture TBA'}`;
    }
    const opponent = isCalBlue(fixture.home.name) ? fixture.away.name : fixture.home.name;
    const side = isCalBlue(fixture.home.name) ? 'Home' : 'Away';
    return `${side} vs ${opponent}`;
  };

  const competitionDestination = (fixture) => {
    const competition = fixture.competition.toLowerCase();
    if (competition.includes('nccsf')) {
      return { href: 'competition-nccsf.html', label: 'NCCSF' };
    }
    if (competition.includes('swpl') || fixture.sourceUrl?.includes('swplsoccer.com')) {
      return { href: 'competition-swpl.html', label: 'SWPL' };
    }
    return { href: safeHttpsUrl(fixture.sourceUrl) || sourceUrl, label: 'competition' };
  };

  const renderUpcoming = (fixtures) => {
    upcomingSchedule = fixtures;
    fixtureList.replaceChildren();
    const remaining = fixtures.slice(1);
    const visible = upcomingExpanded ? remaining : remaining.slice(0, 4);
    visible.forEach((fixture) => {
      const item = document.createElement('li');
      const date = document.createElement('time');
      const details = document.createElement('a');
      const copy = document.createElement('div');
      const opponent = document.createElement('strong');
      const meta = document.createElement('span');

      item.classList.toggle('is-cup', fixture.competition.toLowerCase().includes('abronzino'));

      date.dateTime = fixture.startsAt || fixture.date;
      date.textContent = formatDate(fixture, { month: 'short', day: 'numeric' });
      opponent.textContent = fixtureSummary(fixture);
      const destination = competitionDestination(fixture);
      details.className = 'fixture-row-link';
      details.href = destination.href;
      details.setAttribute('aria-label', `${fixtureSummary(fixture)} — view ${destination.label} schedule`);
      meta.textContent = `${fixture.competition} · ${fixture.timeLabel} · ${fixture.venue.name} · View schedule →`;
      copy.append(opponent, meta);
      details.append(createFixtureCrest(opponentFor(fixture)), copy);
      item.append(date, details);
      fixtureList.append(item);
    });
    if (fixtureToggle) {
      fixtureToggle.hidden = remaining.length <= 4;
      fixtureToggle.textContent = upcomingExpanded
        ? 'Show next five'
        : `View all ${fixtures.length} dates`;
      fixtureToggle.setAttribute('aria-expanded', String(upcomingExpanded));
    }
    fixturePanel.hidden = fixtures.length < 2;
  };

  fixtureToggle?.addEventListener('click', () => {
    upcomingExpanded = !upcomingExpanded;
    renderUpcoming(upcomingSchedule);
  });

  const renderNextMatch = (fixture) => {
    const days = dayDifference(fixture.date);
    const countdown = days === 0 ? 'Match day' : days === 1 ? 'Tomorrow' : `In ${days} days`;

    card.classList.remove('match-card-empty');
    countdownElement.textContent = countdown;
    countdownElement.classList.toggle('is-match-day', days === 0);
    dateElement.dateTime = fixture.startsAt || fixture.date;
    dateElement.textContent = formatDate(fixture, {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    });
    venueElement.textContent = fixture.venue.name;
    competitionElement.textContent = fixture.competition;
    timeElement.textContent = fixture.timeLabel;
    const destination = competitionDestination(fixture);
    detailsLink.href = destination.href;
    detailsLink.textContent = `View ${destination.label} schedule →`;
    setTeam(schedule.querySelector('[data-team-home]'), fixture.home);
    setTeam(schedule.querySelector('[data-team-away]'), fixture.away);
  };

  const renderEmpty = () => {
    card.classList.add('match-card-empty');
    countdownElement.textContent = 'Awaiting fixtures';
    dateElement.removeAttribute('datetime');
    dateElement.textContent = 'Schedule pending';
    venueElement.textContent = 'No upcoming CalBlue fixture is published yet';
    competitionElement.textContent = 'CalBlue fixtures';
    timeElement.textContent = 'TBA';
    detailsLink.href = sourceUrl;
    detailsLink.textContent = 'Check official schedule ↗';
    fixturePanel.hidden = true;
  };

  const feeds = [
    { name: 'SWPL', dataUrl: 'data/swpl.json' },
    { name: 'NCCSF', dataUrl: 'data/nccsf.json' },
  ];
  const loadFeed = (feed) => fetch(feed.dataUrl, { cache: 'no-cache' })
    .then((response) => {
      if (!response.ok) throw new Error(`${feed.name} schedule request failed (${response.status})`);
      return response.json();
    })
    .then((data) => ({ ...feed, data }));

  Promise.allSettled(feeds.map(loadFeed)).then((results) => {
    const loaded = results
      .filter((result) => result.status === 'fulfilled')
      .map((result) => result.value);
    const failed = feeds.filter((feed) => !loaded.some((item) => item.name === feed.name));
    const fixtures = loaded.flatMap(({ data }) => (
      Array.isArray(data.fixtures)
        ? data.fixtures.filter((fixture) => (
          /^\d{4}-\d{2}-\d{2}$/.test(fixture.date)
          && fixture.home?.name
          && fixture.away?.name
          && fixture.venue?.name
          && dayDifference(fixture.date) >= 0
        ))
        : []
    ));
    fixtures.sort((left, right) => (
      (left.startsAt || `${left.date}T23:59:59`).localeCompare(
        right.startsAt || `${right.date}T23:59:59`,
      )
    ));

    const previewFixtures = loaded.reduce((total, { data }) => (
      total + Number(data.diagnostics?.editorialOverrides || 0)
    ), 0);
    if (loaded.length === feeds.length) {
      status.textContent = previewFixtures
        ? 'Official feeds + SWPL preview schedule'
        : fixtures.length
          ? 'Synced from official SWPL + NCCSF'
          : 'Watching official SWPL + NCCSF';
    } else if (loaded.length) {
      status.textContent = `Synced from official ${loaded.map(({ name }) => name).join(' + ')}`;
    } else {
      status.textContent = 'Official schedules temporarily unavailable';
    }

    if (fixtures.length) renderNextMatch(fixtures[0]);
    else renderEmpty();
    renderUpcoming(fixtures);

    const checkedTimes = loaded
      .map(({ data }) => Date.parse(data.checkedAt))
      .filter(Number.isFinite);
    if (checkedTimes.length) {
      const checked = new Date(Math.min(...checkedTimes));
      const suffix = failed.length ? ` · ${failed.map(({ name }) => name).join(' + ')} unavailable` : '';
      checkedElement.textContent = `Schedules checked ${new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Los_Angeles',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short',
      }).format(checked)}${suffix}`;
    } else {
      checkedElement.textContent = `Use the official ${nccsfSourceUrl ? 'NCCSF or ' : ''}SWPL link for the latest update.`;
    }
  });
})();
