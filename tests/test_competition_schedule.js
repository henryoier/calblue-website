// Run with node, or macOS: osascript -l JavaScript tests/test_competition_schedule.js
var read;
if (typeof require === 'function') {
  read = path => require('fs').readFileSync(path, 'utf8');
} else {
  ObjC.import('Foundation');
  read = path => $.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, null).js;
}
const assert = (condition, message) => { if (!condition) throw new Error(message); };
class Element {
  constructor() { this.children = []; this.className = ''; this.textContent = ''; }
  append(...children) { this.children.push(...children); }
  prepend(...children) { this.children.unshift(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute() {}
  addEventListener() {}
}
const nodes = {};
const schedule = {
  dataset: { feed: 'test.json', source: 'https://example.com' },
  querySelector: selector => nodes[selector] || (nodes[selector] = new Element()),
};
var document = { querySelector: () => schedule, createElement: () => new Element() };
const fixture = (id, date, extra = {}) => ({
  id, date, competition: 'SWPL', home: { name: 'CalBlue FC' },
  away: { name: 'Opponent' }, venue: { name: 'Pitch' }, timeLabel: 'TBA', ...extra,
});
let feed;
// Resolve the fetch chain synchronously so the harness also runs in JavaScriptCore.
var fetch = () => ({ then: callback => {
  callback({ ok: true, json: () => feed });
  return { then: render => { render(feed); return { catch: () => {} }; } };
} });
const render = data => { feed = data; eval(read('competition-schedule.js')); };
render({
  fixtures: [fixture('next', '2099-01-01'), fixture('done', '2099-01-02'), fixture('played', '2020-01-05', { status: 'played' })],
  results: [
    fixture('done', '2020-01-01', { status: 'completed', score: { home: 0, away: 10 }, goals: [
      { player: 'Ada Lovelace', side: 'away' }, { player: 'Ada Lovelace', side: 'away' }, { player: 'Grace Hopper', side: 'away' }, { player: 'Clip Only', side: 'home', highlight: true },
    ], goalsNote: 'partial' }),
    fixture('invalid', '2020-01-02', { status: 'completed' }),
    fixture('future', '2099-01-03', { status: 'completed', score: { home: 2, away: 1 } }),

  ],
});
const rows = nodes['[data-competition-fixtures]'].children;
assert(rows.length === 3, 'Reject invalid/future results, suppress completed duplicates, keep played games awaiting a result');
assert(rows[1].className.includes('is-played') && !rows[1].className.includes('is-next'), 'A played game without a score is marked played and is never the next game');
assert(rows[1].children[2].children[0].textContent === 'Result pending', 'Played game is labelled Result pending');
assert(rows[1].children[1].children[0].children.length === 3, 'Played game shows no invented score');
assert(rows[0].className.includes('is-completed') && !rows[0].className.includes('is-next'), 'Completed fixture stays in chronological order without next-game highlight');
assert(rows[2].className.includes('is-next'), 'Highlight the first upcoming fixture');
assert(rows[0].children[1].children[0].children[3].textContent === '0', 'Render zero home goals');
assert(rows[0].children[1].children[1].children[3].textContent === '10', 'Render multi-digit away goals');
assert(rows[0].children[2].children[0].textContent === 'Final', 'Label completed fixture Final');
const scorers = rows[0].children[1].children[2];
assert(scorers.className === 'season-fixture-scorers' && scorers.children.length === 2, 'Completed fixture with published goals gets a scorers block (one line per scoring side plus the partial note)');
assert(scorers.children[0].textContent === 'Opponent: Ada Lovelace ×2, Grace Hopper', 'Scorers are grouped per player in first-goal order; highlight clips are not goals');
assert(scorers.children[1].textContent === 'Scorers as published so far', 'Partial scorer lists are labelled');
assert(rows[2].children[1].children.length === 2, 'Upcoming fixtures have no scorers block');
assert(rows[2].children[1].children[0].children.length === 3, 'Upcoming games must not invent scores');
assert(nodes['[data-competition-count]'].textContent === '1 upcoming · 1 completed · 1 awaiting result', 'Count upcoming, completed and pending games');
render({ fixtures: [], results: [] });
assert(nodes['[data-competition-fixtures]'].children[0].textContent === 'No fixtures are currently published.', 'Empty fixture state');
assert(!read('index.html').includes('data-results-feeds'), 'No homepage results section');
console.log('Competition fixture rendering checks passed');
