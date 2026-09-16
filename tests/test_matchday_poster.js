// Run with node, or macOS: osascript -l JavaScript tests/test_matchday_poster.js
// Homepage match-day poster: follows the next fixture with posters, rotates two designs at random, hides otherwise.
var read;
var URL;
if (typeof require === 'function') {
  read = path => require('fs').readFileSync(path, 'utf8');
  URL = require('url').URL;
} else {
  ObjC.import('Foundation');
  read = path => $.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, null).js;
  URL = function (value) {
    const parsed = $.NSURL.URLWithString(value);
    this.protocol = `${parsed.scheme.js}:`;
    this.href = parsed.absoluteString.js;
  };
}
const assert = (condition, message) => { if (!condition) throw new Error(message); };
class Element {
  constructor() {
    this.children = [];
    this.nodes = {};
    this.dataset = {};
    this.attributes = {};
    this.className = '';
    this.textContent = '';
    this.hidden = false;
    this.classList = {
      add: (...names) => { this.className = [...new Set([...this.className.split(' ').filter(Boolean), ...names])].join(' '); },
      remove: (...names) => { this.className = this.className.split(' ').filter(name => !names.includes(name)).join(' '); },
      toggle: (name, force) => { if (force) this.classList.add(name); else this.classList.remove(name); },
    };
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  querySelector(selector) { return this.nodes[selector] || (this.nodes[selector] = new Element()); }
  querySelectorAll(selector) { return [this.querySelector(selector)]; }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name]; }
  removeAttribute(name) { delete this.attributes[name]; delete this[name]; }
  addEventListener() {}
}
class Resolved {
  constructor(value) { this.value = value; }
  then(callback) { return new Resolved(callback(this.value)); }
}
const Promise = {
  allSettled: values => new Resolved(values.map(value => ({ status: 'fulfilled', value: value.value }))),
};
const calblue = { name: 'CalBlue FC' };
const opponent = { name: 'Bay Area United', logo: 'https://nisa.sportzstudio.com/team_images/1662309840_thumb_a.png' };
const southSF = { name: 'South San Francisco AC', logo: 'https://nisa.sportzstudio.com/team_images/1663784092_thumb_a.png' };
const fixture = (id, date, extra = {}) => ({
  id, date, competition: 'League', home: calblue, away: opponent,
  venue: { name: 'Fair Oaks Park Field 3' }, timeLabel: '7:30 pm PT', startsAt: `${date}T19:30:00-07:00`,
  sourceUrl: 'https://pacific.swplsoccer.com/teams/calblue-fc', ...extra,
});
const posters = (stem) => [
  { src: `assets/matchday/2026-fall/${stem}-styled.webp`, style: 'styled', width: 1296, height: 1616 },
  { src: `assets/matchday/2026-fall/${stem}-classic.webp`, style: 'classic', width: 1296, height: 1616 },
];
const manifest = { schemaVersion: 1, fixtures: {
  '2099-01-01-bay-area-united': { date: '2099-01-01', posters: posters('2099-01-01-bay-area-united') },
  '2099-01-05-south-san-francisco-ac': { date: '2099-01-05', posters: posters('2099-01-05-south-san-francisco-ac') },
} };

var document;
var fetch;
var Math = Object.create(globalThis.Math || Math);
var location = { search: '' };
const run = (feeds, random) => {
  const schedule = new Element();
  schedule.dataset = { swplSource: 'https://pacific.swplsoccer.com/teams/calblue-fc', nccsfSource: 'https://nccsf.org/' };
  schedule.querySelector('[data-team-home]').dataset.side = 'home';
  schedule.querySelector('[data-team-away]').dataset.side = 'away';
  const poster = new Element();
  poster.querySelector('[data-poster-link]').setAttribute('aria-label', 'Open the full-size CalBlue match-day poster');
  document = {
    querySelector: selector => (selector === '[data-swpl-schedule]' ? schedule : selector === '[data-matchday-poster]' ? poster : null),
    createElement: () => new Element(),
    createTextNode: text => Object.assign(new Element(), { textContent: text }),
  };
  fetch = url => new Resolved(url in feeds ? { ok: true, json: () => feeds[url] } : { ok: false, json: () => null });
  Math.random = () => random;
  eval(read('swpl-schedule.js'));
  return { schedule, poster };
};

// 1. Next fixture has posters: random pick lands on the second design, copy follows the fixture.
let { poster } = run({
  'data/swpl.json': { fixtures: [fixture('bau', '2099-01-01'), fixture('ssf', '2099-01-05', { home: southSF, away: calblue, venue: { name: 'El Camino High School Stadium' }, timeLabel: '11:00 am PT' })] },
  'data/nccsf.json': { fixtures: [] },
  'data/matchday-posters.json': manifest,
}, 0.99);
assert(poster.hidden === false, 'Poster section is shown when the next fixture has posters');
assert(poster.querySelector('[data-poster-image]').src === 'assets/matchday/2026-fall/2099-01-01-bay-area-united-classic.webp', 'Random draw of 0.99 picks the second (classic) design');
assert(poster.dataset.posterStyle === 'classic', 'Chosen design is recorded on the section');
assert(poster.querySelector('[data-poster-link]').href === poster.querySelector('[data-poster-image]').src, 'Full-poster links open the chosen design');
assert(poster.querySelector('[data-poster-matchup]').children.map(node => node.textContent).join('') === 'CalBlue FC vs Bay Area United', 'Home matchup reads CalBlue first');
assert(poster.querySelector('[data-poster-kickoff]').textContent === '7:30 pm PT', 'Kickoff comes from the feed');
assert(poster.querySelector('[data-poster-venue]').textContent === 'Fair Oaks Park Field 3', 'Venue comes from the feed');
assert(poster.querySelector('[data-poster-competition]').textContent === 'League', 'Competition tag comes from the feed');
assert(/days to kickoff$/.test(poster.querySelector('[data-matchday-countdown]').textContent), 'Countdown is computed from the fixture date');

// 2. Random draw of 0 picks the first (styled) design.
({ poster } = run({
  'data/swpl.json': { fixtures: [fixture('bau', '2099-01-01')] },
  'data/nccsf.json': { fixtures: [] },
  'data/matchday-posters.json': manifest,
}, 0));
assert(poster.querySelector('[data-poster-image]').src === 'assets/matchday/2026-fall/2099-01-01-bay-area-united-styled.webp', 'Random draw of 0 picks the first (styled) design');

// 3. ?poster=2 forces the second design regardless of the draw.
location = { search: '?poster=2' };
({ poster } = run({
  'data/swpl.json': { fixtures: [fixture('bau', '2099-01-01')] },
  'data/nccsf.json': { fixtures: [] },
  'data/matchday-posters.json': manifest,
}, 0));
assert(poster.dataset.posterStyle === 'classic', '?poster=2 forces the classic design for review');
location = { search: '' };

// 4. Next fixture has no posters (NCCSF game first): the first later fixture with posters is used, away wording applied.
({ poster } = run({
  'data/swpl.json': { fixtures: [fixture('ssf', '2099-01-05', { home: southSF, away: calblue, venue: { name: 'El Camino High School Stadium' }, timeLabel: 'TBA PT' })] },
  'data/nccsf.json': { fixtures: [fixture('nccsf', '2099-01-02', { competition: 'NCCSF League', home: { name: 'Some FC' }, away: calblue })] },
  'data/matchday-posters.json': manifest,
}, 0));
assert(poster.hidden === false && poster.querySelector('[data-poster-image]').src.includes('2099-01-05-south-san-francisco-ac'), 'Skips fixtures without posters and uses the next one that has them');
assert(poster.querySelector('[data-poster-matchup]').children.map(node => node.textContent).join('') === 'South San Francisco AC vs CalBlue FC', 'Away matchup reads the host first');
assert(poster.querySelector('[data-poster-kickoff]').textContent === 'Kickoff TBA', 'TBA kickoff is shown as Kickoff TBA');
assert(poster.querySelector('[data-poster-note]').textContent.startsWith('Away day'), 'Away note is used for away fixtures');

// 5. No manifest (request failed) or elapsed fixtures only: the section hides.
({ poster } = run({ 'data/swpl.json': { fixtures: [fixture('bau', '2099-01-01')] }, 'data/nccsf.json': { fixtures: [] } }, 0));
assert(poster.hidden === true, 'Section hides when the poster manifest is unavailable');
({ poster } = run({ 'data/swpl.json': { fixtures: [fixture('old', '2020-01-01')] }, 'data/nccsf.json': { fixtures: [] }, 'data/matchday-posters.json': manifest }, 0));
assert(poster.hidden === true, 'Section hides when no upcoming fixture has posters');
console.log('Homepage match-day poster rotation checks passed');
