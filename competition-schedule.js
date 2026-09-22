(() => {
  const schedule = document.querySelector('[data-competition-schedule]');
  if (!schedule) return;

  const list = schedule.querySelector('[data-competition-fixtures]');
  const status = schedule.querySelector('[data-competition-status]');
  const checked = schedule.querySelector('[data-competition-checked]');
  const count = schedule.querySelector('[data-competition-count]');
  const sourceUrl = schedule.dataset.source;

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

  const pacificToday = () => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date());
    const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
    return `${values.year}-${values.month}-${values.day}`;
  };

  const formatDate = (fixture, options) => {
    const instant = fixture.startsAt
      ? new Date(fixture.startsAt)
      : new Date(`${fixture.date}T12:00:00-08:00`);
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles', ...options,
    }).format(instant);
  };

  // "William Peng ×3, Suhau Kuo" in first-goal order.
  const summariseScorers = (goals) => {
    const counts = new Map();
    goals.forEach((goal) => counts.set(goal.player, (counts.get(goal.player) || 0) + 1));
    return [...counts].map(([player, count]) => (count > 1 ? `${player} ×${count}` : player)).join(', ');
  };

  const createTeam = (team, role, score) => {
    const row = document.createElement('div');
    const name = document.createElement('strong');
    const label = document.createElement('span');
    const logo = isCalBlue(team.name) ? 'assets/calblue-logo-web.jpg' : safeHttpsUrl(team.logo);

    row.className = `season-team${isCalBlue(team.name) ? ' is-calblue' : ''}`;
    name.textContent = team.name;
    label.textContent = role;
    if (logo) {
      const image = document.createElement('img');
      image.src = logo;
      image.alt = `${team.name} crest`;
      image.loading = 'lazy';
      image.addEventListener('error', () => {
        const fallback = document.createElement('span');
        fallback.className = 'season-team-placeholder';
        fallback.textContent = '?';
        image.replaceWith(fallback);
      });
      row.append(image);
    } else {
      const placeholder = document.createElement('span');
      placeholder.className = 'season-team-placeholder';
      placeholder.textContent = /tba|unknown|undecided/i.test(team.name)
        ? '?'
        : team.name.slice(0, 1).toUpperCase() || '?';
      row.append(placeholder);
    }
    row.append(name, label);
    if (Number.isInteger(score)) {
      const goals = document.createElement('b');
      row.className += ' has-score';
      goals.className = 'season-team-score';
      goals.textContent = String(score);
      goals.setAttribute('aria-label', `${score} goals`);
      row.append(goals);
    }
    return row;
  };

  const createFixture = (fixture, isNext) => {
    const item = document.createElement('li');
    const date = document.createElement('time');
    const marker = document.createElement('em');
    const dateText = document.createElement('strong');
    const timeText = document.createElement('span');
    const matchup = document.createElement('div');
    const details = document.createElement('div');
    const venue = document.createElement('strong');
    const meta = document.createElement('span');
    const link = document.createElement('a');

    const isCup = fixture.competition.toLowerCase().includes('abronzino');
    const isNccsf = fixture.competition.toLowerCase().includes('nccsf');
    const completed = fixture.status === 'completed';
    const played = fixture.status === 'played';   // date has passed, league has not published a score yet
    item.className = `season-fixture${isNext ? ' is-next' : ''}${isCup ? ' is-cup' : ''}${completed ? ' is-completed' : ''}${played ? ' is-played' : ''}`;
    date.className = 'season-fixture-date';
    date.dateTime = fixture.startsAt || fixture.date;
    marker.textContent = isCup ? 'Abronzino Cup' : isNccsf ? 'NCCSF League' : 'SWPL League';
    dateText.textContent = formatDate(fixture, { month: 'short', day: 'numeric' });
    timeText.textContent = formatDate(fixture, { weekday: 'long' });
    date.append(marker, dateText, timeText);

    matchup.className = 'season-fixture-matchup';
    matchup.append(
      createTeam(fixture.home, 'Home', completed ? fixture.score.home : undefined),
      createTeam(fixture.away, 'Away', completed ? fixture.score.away : undefined),
    );
    if (completed && Array.isArray(fixture.goals) && fixture.goals.length) {
      const scorers = document.createElement('div');
      scorers.className = 'season-fixture-scorers';
      [['home', fixture.home], ['away', fixture.away]].forEach(([side, team]) => {
        const summary = summariseScorers(fixture.goals.filter((goal) => goal.side === side && !goal.highlight));
        if (!summary) return;
        const line = document.createElement('span');
        line.className = `season-scorers is-${side}${isCalBlue(team.name) ? ' is-calblue' : ''}`;
        line.textContent = `${team.name}: ${summary}`;
        scorers.append(line);
      });
      if (fixture.goalsNote === 'partial') {
        const note = document.createElement('small');
        note.textContent = 'Scorers as published so far';
        scorers.append(note);
      }
      if (scorers.children.length) matchup.append(scorers);
    }

    details.className = 'season-fixture-details';
    venue.textContent = fixture.venue.name;
    meta.textContent = fixture.round
      ? `${fixture.round} · ${fixture.timeLabel}`
      : fixture.timeLabel;
    link.href = safeHttpsUrl(fixture.sourceUrl) || sourceUrl;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = 'Official details ↗';
    details.append(venue, meta, link);
    if (completed || played) {
      const final = document.createElement('span');
      final.className = `season-fixture-final${played ? ' is-pending' : ''}`;
      final.textContent = completed ? 'Final' : 'Result pending';
      details.prepend(final);
    }
    item.append(date, matchup, details);
    return item;
  };

  fetch(schedule.dataset.feed, { cache: 'no-cache' })
    .then((response) => {
      if (!response.ok) throw new Error(`Schedule request failed (${response.status})`);
      return response.json();
    })
    .then((data) => {
      const today = pacificToday();
      const validFixture = (fixture) => (
        /^\d{4}-\d{2}-\d{2}$/.test(fixture.date)
        && fixture.home?.name && fixture.away?.name && fixture.venue?.name
      );
      const results = Array.isArray(data.results)
        ? data.results.filter((fixture) => (
          validFixture(fixture) && fixture.date <= today && fixture.status === 'completed'
          && Number.isInteger(fixture.score?.home) && fixture.score.home >= 0
          && Number.isInteger(fixture.score?.away) && fixture.score.away >= 0
        ))
        : [];
      const completedIds = new Set(results.map((fixture) => fixture.id).filter(Boolean));
      const upcoming = Array.isArray(data.fixtures)
        ? data.fixtures.filter((fixture) => (
          validFixture(fixture)
          && (fixture.date >= today || fixture.status === 'played')
          && fixture.status !== 'completed'
          && !completedIds.has(fixture.id)
        ))
        : [];
      const pending = upcoming.filter((fixture) => fixture.status === 'played').length;
      const fixtures = [...results, ...upcoming];
      fixtures.sort((left, right) => (
        (left.startsAt || left.date).localeCompare(right.startsAt || right.date)
      ));
      list.replaceChildren();
      const nextFixture = fixtures.find((fixture) => fixture.status !== 'completed' && fixture.status !== 'played');
      fixtures.forEach((fixture) => list.append(createFixture(fixture, fixture === nextFixture)));
      if (!fixtures.length) {
        const empty = document.createElement('li');
        empty.className = 'season-empty';
        empty.textContent = 'No fixtures are currently published.';
        list.append(empty);
      }
      count.textContent = `${upcoming.length - pending} upcoming · ${results.length} completed${pending ? ` · ${pending} awaiting result` : ''}`;
      const previewCount = Number(data.diagnostics?.editorialOverrides || 0);
      status.textContent = previewCount
        ? `${previewCount} preview date${previewCount === 1 ? '' : 's'} · official updates take priority`
        : 'Synced from the official schedule';
      if (data.checkedAt) {
        checked.textContent = `Last checked ${new Intl.DateTimeFormat('en-US', {
          timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric',
          hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
        }).format(new Date(data.checkedAt))}`;
      }
    })
    .catch(() => {
      list.replaceChildren();
      const empty = document.createElement('li');
      empty.className = 'season-empty';
      empty.textContent = 'The schedule is temporarily unavailable. Please use the official league link.';
      list.append(empty);
      count.textContent = 'Schedule unavailable';
      status.textContent = 'Official schedule temporarily unavailable';
    });
})();
