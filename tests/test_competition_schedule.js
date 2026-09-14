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
  fixtures: [fixture('next', '2099-01-01'), fixture('done', '2099-01-02')],
  results: [
    fixture('done', '2020-01-01', { status: 'completed', score: { home: 0, away: 10 } }),
    fixture('invalid', '2020-01-02', { status: 'completed' }),
    fixture('future', '2099-01-03', { status: 'completed', score: { home: 2, away: 1 } }),
  ],
});
const rows = nodes['[data-competition-fixtures]'].children;
assert(rows.length === 2, 'Reject invalid/future results and suppress completed fixture duplicates');
assert(rows[0].className.includes('is-completed') && !rows[0].className.includes('is-next'), 'Completed fixture stays in chronological order without next-game highlight');
assert(rows[1].className.includes('is-next'), 'Highlight the first upcoming fixture');
assert(rows[0].children[1].children[0].children[3].textContent === '0', 'Render zero home goals');
assert(rows[0].children[1].children[1].children[3].textContent === '10', 'Render multi-digit away goals');
assert(rows[0].children[2].children[0].textContent === 'Final', 'Label completed fixture Final');
assert(rows[1].children[1].children[0].children.length === 3, 'Upcoming games must not invent scores');
assert(nodes['[data-competition-count]'].textContent === '1 upcoming · 1 completed', 'Count both kinds of fixture');
render({ fixtures: [], results: [] });
assert(nodes['[data-competition-fixtures]'].children[0].textContent === 'No fixtures are currently published.', 'Empty fixture state');
assert(!read('index.html').includes('data-results-feeds'), 'No homepage results section');
console.log('Competition fixture rendering checks passed');
