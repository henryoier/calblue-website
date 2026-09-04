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

  const createTeam = (team, role) => {
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
    return row;
  };

  const createFixture = (fixture, index) => {
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
    item.className = `season-fixture${index === 0 ? ' is-next' : ''}${isCup ? ' is-cup' : ''}`;
    date.className = 'season-fixture-date';
    date.dateTime = fixture.startsAt || fixture.date;
    marker.textContent = isCup
      ? `Cup date · ${fixture.round || 'Details TBA'}`
      : fixture.provisional
        ? 'Preview · League fixture'
        : index === 0 ? 'Next match' : (fixture.round || 'League fixture');
    dateText.textContent = formatDate(fixture, { month: 'short', day: 'numeric' });
    timeText.textContent = formatDate(fixture, { weekday: 'long' });
    date.append(marker, dateText, timeText);

    matchup.className = 'season-fixture-matchup';
    matchup.append(createTeam(fixture.home, 'Home'), createTeam(fixture.away, 'Away'));

    details.className = 'season-fixture-details';
    venue.textContent = fixture.venue.name;
    meta.textContent = fixture.timeLabel;
    link.href = safeHttpsUrl(fixture.sourceUrl) || sourceUrl;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = 'Official details ↗';
    details.append(venue, meta, link);
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
      const fixtures = Array.isArray(data.fixtures)
        ? data.fixtures.filter((fixture) => (
          /^\d{4}-\d{2}-\d{2}$/.test(fixture.date)
          && fixture.date >= today
          && fixture.home?.name
          && fixture.away?.name
          && fixture.venue?.name
        ))
        : [];
      fixtures.sort((left, right) => (
        (left.startsAt || left.date).localeCompare(right.startsAt || right.date)
      ));
      list.replaceChildren();
      fixtures.forEach((fixture, index) => list.append(createFixture(fixture, index)));
      if (!fixtures.length) {
        const empty = document.createElement('li');
        empty.className = 'season-empty';
        empty.textContent = 'No upcoming fixtures are currently published.';
        list.append(empty);
      }
      count.textContent = `${fixtures.length} upcoming date${fixtures.length === 1 ? '' : 's'}`;
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
