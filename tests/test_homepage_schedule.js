// Run with node, or macOS: osascript -l JavaScript tests/test_homepage_schedule.js
var read;
var URL;
if (typeof require === 'function') {
  read = path => require('fs').readFileSync(path, 'utf8');
  URL = require('url').URL;
} else {
  ObjC.import('Foundation');
  read = path => $.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, null).js;
  // JavaScriptCore has no browser URL constructor; preserve real URL parsing.
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
    this.classList = {
      add: (...names) => { this.className = [...new Set([...this.className.split(' ').filter(Boolean), ...names])].join(' '); },
      remove: (...names) => { this.className = this.className.split(' ').filter(name => !names.includes(name)).join(' '); },
      toggle: (name, force) => {
        if (force) this.classList.add(name);
        else this.classList.remove(name);
      },
    };
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  querySelector(selector) { return this.nodes[selector] || (this.nodes[selector] = new Element()); }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; delete this[name]; }
  addEventListener() {}
}
const schedule = new Element();
schedule.dataset = {
  swplSource: 'https://pacific.swplsoccer.com/teams/calblue-fc',
  nccsfSource: 'https://nccsf.org/',
};
schedule.querySelector('[data-team-home]').dataset.side = 'home';
schedule.querySelector('[data-team-away]').dataset.side = 'away';
var document = {
  querySelector: selector => selector === '[data-swpl-schedule]' ? schedule : null,
  createElement: () => new Element(),
  createTextNode: text => Object.assign(new Element(), { textContent: text }),
};
const calblue = { name: 'CalBlue FC' };
const opponent = {
  name: 'Bay Area United',
  logo: 'https://nisa.sportzstudio.com/team_images/1662309840_thumb_a.png',
};
const fixture = (id, date, extra = {}) => ({
  id, date, competition: 'SWPL Abronzino Cup', home: calblue, away: opponent,
  venue: { name: 'Fair Oaks Park Field 3' }, timeLabel: '7:30 PM PT',
  round: 'Group stage', sourceUrl: schedule.dataset.swplSource, ...extra,
});
const feeds = {
  'data/swpl.json': { fixtures: [
    fixture('home-cup', '2099-01-03'),
    fixture('past', '2020-01-01'),
    fixture('away-cup', '2099-01-02', { home: opponent, away: calblue }),
    fixture('next-cup', '2099-01-01', { home: opponent, away: calblue }),
    fixture('placeholder', '2099-01-05', { eventOnly: true, round: 'Semifinal', away: { name: 'Opponent TBA' } }),
  ] },
  'data/nccsf.json': { fixtures: [
    fixture('nccsf', '2099-01-04', { competition: 'NCCSF League' }),
  ] },
};
// Resolve the actual fetch/render pipeline synchronously in Node and JavaScriptCore.
class Resolved {
  constructor(value) { this.value = value; }
  then(callback) { return new Resolved(callback(this.value)); }
}
var fetch = url => new Resolved({ ok: true, json: () => feeds[url] });
const Promise = {
  allSettled: values => new Resolved(values.map(value => ({ status: 'fulfilled', value: value.value }))),
};
eval(read('swpl-schedule.js'));

assert(schedule.querySelector('[data-match-date]').dateTime === '2099-01-01', 'Select the earliest upcoming fixture across unordered feeds and ignore elapsed dates');
assert(schedule.querySelector('[data-next-match]').className.includes('is-cup'), 'Next named Cup fixture retains Cup styling');
assert(schedule.querySelector('[data-team-home]').querySelector('[data-team-name]').textContent === opponent.name, 'Next Cup fixture shows the actual home opponent');
assert(schedule.querySelector('[data-team-home]').querySelector('[data-team-crest]').src === opponent.logo, 'Next Cup fixture retains the official opponent crest');
assert(schedule.querySelector('[data-team-away]').querySelector('[data-team-name]').textContent === calblue.name, 'Next Cup fixture preserves CalBlue away assignment');
assert(schedule.querySelector('[data-match-link]').href === 'competition-swpl.html', 'Next Cup fixture links to the SWPL competition');

const rows = schedule.querySelector('[data-fixture-list]').children;
assert(rows.length === 4, 'Upcoming list excludes the next-match card and elapsed fixture');
const copy = row => row.children[1].children[1];
assert(copy(rows[0]).children[0].textContent === `Away vs ${opponent.name}`, 'Named away Cup fixture shows its opponent instead of a generic Cup placeholder');
assert(copy(rows[1]).children[0].textContent === `Home vs ${opponent.name}`, 'Named home Cup fixture shows its opponent instead of a generic Cup placeholder');
for (const row of rows.slice(0, 2)) {
  assert(row.className.includes('is-cup'), 'Named Cup row retains Cup styling');
  assert(row.children[1].href === 'competition-swpl.html', 'Named Cup row links to the SWPL competition');
  assert(row.children[1].children[0].children[0].src === opponent.logo, 'Named Cup row uses the official opponent crest');
  assert(copy(row).children[1].textContent.includes('Group stage'), 'Named Cup row retains its stage in metadata');
}
assert(rows[2].className.includes('is-nccsf'), 'Mixed upcoming list preserves NCCSF styling');
assert(copy(rows[3]).children[0].textContent === 'Abronzino Cup · Semifinal', 'Event-only Cup dates keep the generic stage label');
assert(rows[3].children[1].children[0].textContent === '?', 'Undecided Cup opponent keeps a question-mark crest');
console.log('Homepage Cup fixture rendering checks passed');
