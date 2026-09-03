(() => {
  const schedule = document.querySelector('[data-swpl-schedule]');
  if (!schedule) return;

  const sourceUrl = schedule.dataset.swplSource;
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
  const checkedElement = schedule.querySelector('[data-swpl-checked]');

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

  const isCalBlue = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, '') === 'calbluefc';

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
      image.hidden = true;
      placeholder.hidden = false;
      placeholder.textContent = team.name.slice(0, 1).toUpperCase() || '?';
    }
  };

  const fixtureSummary = (fixture) => {
    const opponent = isCalBlue(fixture.home.name) ? fixture.away.name : fixture.home.name;
    const side = isCalBlue(fixture.home.name) ? 'Home' : 'Away';
    return `${side} vs ${opponent}`;
  };

  const renderUpcoming = (fixtures) => {
    fixtureList.replaceChildren();
    fixtures.slice(1, 5).forEach((fixture) => {
      const item = document.createElement('li');
      const date = document.createElement('time');
      const details = document.createElement('div');
      const opponent = document.createElement('strong');
      const meta = document.createElement('span');

      date.dateTime = fixture.startsAt || fixture.date;
      date.textContent = formatDate(fixture, { month: 'short', day: 'numeric' });
      opponent.textContent = fixtureSummary(fixture);
      meta.textContent = `${fixture.timeLabel} · ${fixture.venue.name}`;
      details.append(opponent, meta);
      item.append(date, details);
      fixtureList.append(item);
    });
    fixturePanel.hidden = fixtures.length < 2;
  };

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
    detailsLink.href = safeHttpsUrl(fixture.sourceUrl) || sourceUrl;
    detailsLink.textContent = 'Official match details ↗';
    setTeam(schedule.querySelector('[data-team-home]'), fixture.home);
    setTeam(schedule.querySelector('[data-team-away]'), fixture.away);
  };

  const renderEmpty = () => {
    card.classList.add('match-card-empty');
    countdownElement.textContent = 'Awaiting fixtures';
    dateElement.removeAttribute('datetime');
    dateElement.textContent = 'Schedule pending';
    venueElement.textContent = 'SWPL has not published a CalBlue fixture yet';
    competitionElement.textContent = 'SWPL Pacific';
    timeElement.textContent = 'TBA';
    detailsLink.href = sourceUrl;
    detailsLink.textContent = 'Check official SWPL page ↗';
    fixturePanel.hidden = true;
  };

  fetch('data/swpl.json', { cache: 'no-cache' })
    .then((response) => {
      if (!response.ok) throw new Error(`Schedule request failed (${response.status})`);
      return response.json();
    })
    .then((data) => {
      const fixtures = Array.isArray(data.fixtures)
        ? data.fixtures.filter((fixture) => (
          /^\d{4}-\d{2}-\d{2}$/.test(fixture.date)
          && fixture.home?.name
          && fixture.away?.name
          && fixture.venue?.name
          && dayDifference(fixture.date) >= 0
        ))
        : [];
      status.textContent = fixtures.length ? 'Synced from official SWPL' : 'Watching official SWPL';
      if (fixtures.length) renderNextMatch(fixtures[0]);
      else renderEmpty();
      renderUpcoming(fixtures);

      if (data.checkedAt) {
        const checked = new Date(data.checkedAt);
        checkedElement.textContent = `Last checked ${new Intl.DateTimeFormat('en-US', {
          timeZone: 'America/Los_Angeles',
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          timeZoneName: 'short',
        }).format(checked)}`;
      }
    })
    .catch(() => {
      status.textContent = 'Official schedule temporarily unavailable';
      checkedElement.textContent = 'Showing the safe fallback; use the official SWPL link for the latest update.';
    });
})();
