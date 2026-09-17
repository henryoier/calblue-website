// Run with node, or macOS: osascript -l JavaScript tests/test_news_feed.js
// Club news feed: renders newest-first cards, honours limits and filters, shows a post article from ?post=slug.
var read;
if (typeof require === 'function') {
  read = path => require('fs').readFileSync(path, 'utf8');
} else {
  ObjC.import('Foundation');
  read = path => $.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, null).js;
}
const assert = (condition, message) => { if (!condition) throw new Error(message); };
class Element {
  constructor(tag) {
    this.tag = tag || 'div'; this.children = []; this.nodes = {}; this.dataset = {}; this.attributes = {};
    this.className = ''; this.textContent = ''; this.hidden = false; this.listeners = {};
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  querySelector(selector) {
    if (!this.nodes[selector]) {
      const node = new Element();
      if (selector === '[data-news-filters]') {
        // Browsers expose element.children as a live HTMLCollection: iterable and indexable, but without forEach/map.
        let items = [];
        Object.defineProperty(node, 'children', {
          get: () => ({ length: items.length, [Symbol.iterator]: () => items[Symbol.iterator](), ...Object.fromEntries(items.map((item, index) => [index, item])) }),
          set: (value) => { items = value; },
        });
      }
      this.nodes[selector] = node;
    }
    return this.nodes[selector];
  }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name]; }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  click() { this.listeners.click(); }
}
class Resolved { constructor(value) { this.value = value; } then(callback) { return new Resolved(callback(this.value)); } }
const items = [
  { slug: 'matchday-2026-09-19-bay-area-united', category: 'Match day', date: '2026-09-19', title: 'Match day: CalBlue FC vs Bay Area United', summary: 'Saturday', image: 'assets/matchday/x.webp', href: 'index.html#matchday', cta: 'See the poster', poster: true },
  { slug: 'welcome', category: 'Club', date: '2026-09-15', title: 'Welcome', summary: 'Intro.', image: '', href: 'news.html?post=welcome', cta: 'Read more', body: ['One.', 'Two.'] },
  { slug: 'instagram-1', category: 'Instagram', date: '2026-09-14', title: 'Three points!', summary: '', image: 'assets/news/instagram/1.jpg', href: 'https://www.instagram.com/p/1/', external: true, cta: 'View on Instagram' },
  { slug: 'result-2026-09-13-sf-glens', category: 'Result', outcome: 'Win', date: '2026-09-13', title: 'CalBlue 3-2 SF Glens', summary: 'Win · Away', image: '', href: 'gallery-swpl-sf-glens.html', cta: 'See the photos', scoreline: { home: { name: 'SF Glens', logo: 'https://cdn/glens.png' }, away: { name: 'CalBlue FC', logo: 'assets/calblue-logo-web.jpg' }, score: { home: 2, away: 3 } } },
  { slug: 'squad-2026-09-12-swpl', category: 'Squad', date: '2026-09-12', title: '2 new faces on the SWPL roster', summary: 'Welcome A and B.', image: 'a.jpg', href: 'competition-swpl.html#roster', cta: 'Meet the squad', players: [{ name: 'A Player', photo: 'a.jpg' }, { name: 'B Player', photo: '' }] },
  { slug: 'gallery-2026-09-13-sf-glens', category: 'Gallery', date: '2026-09-13', title: 'Photos: CalBlue vs SF Glens', summary: '99 photos', image: 'g.jpg', href: 'gallery-swpl-sf-glens.html', cta: 'Open the album' },
];
var document; var fetch; var location = { search: '' };
const run = ({ feedDataset = {}, withArticle = false, search = '', data = { items } } = {}) => {
  const feed = new Element('section'); feed.dataset = { ...feedDataset };
  const article = withArticle ? new Element('article') : null;
  location = { search };
  document = {
    querySelectorAll: selector => (selector === '[data-news-feed]' ? [feed] : []),
    querySelector: selector => (selector === '[data-news-article]' ? article : null),
    createElement: tag => new Element(tag),
    title: 'Latest News | CalBlue',
  };
  fetch = () => new Resolved({ ok: true, json: () => data });
  eval(read('news.js'));
  return { feed, article };
};

// 1. Homepage: limit honoured, newest first, card anatomy.
let { feed } = run({ feedDataset: { newsLimit: '3' } });
let cards = feed.querySelector('[data-news-grid]').children;
assert(cards.length === 3, 'Homepage feed shows at most data-news-limit cards');
assert(cards[0].className.includes('is-match-day') && cards[0].className.includes('is-poster'), 'First card is the upcoming match-day preview with poster styling');
const link = cards[0].children[0];
assert(link.href === 'index.html#matchday', 'Card links to the item href');
assert(link.children[0].children[0].src === 'assets/matchday/x.webp', 'Card image comes from the item');
const copy = link.children[1];
assert(copy.children[0].children[0].textContent === 'Match day', 'Category tag rendered');
assert(copy.children[0].children[1].dateTime === '2026-09-19', 'Date rendered as a time element');
assert(copy.children[1].textContent === 'Match day: CalBlue FC vs Bay Area United', 'Title rendered');
assert(copy.children[3].textContent === 'See the poster →', 'Call to action rendered');
assert(feed.querySelector('[data-news-empty]').hidden === true, 'Empty message hidden when there are cards');
const insta = cards[2].children[0];
assert(insta.target === '_blank' && insta.rel === 'noopener', 'External items open in a new tab');

// 2. Result outcome shows in the tag.
({ feed } = run({}));
cards = feed.querySelector('[data-news-grid]').children;
assert(cards.length === 6, 'News page shows every item without a limit');
const squadFigure = cards[4].children[0].children[0];
assert(squadFigure.className === 'news-portraits has-2' && squadFigure.children.length === 2, 'Squad cards show one portrait per new player');
assert(squadFigure.children[0].alt === 'A Player' && squadFigure.children[1].src === 'assets/calblue-logo-web.jpg', 'Portraits are labelled and fall back to the club crest');
assert(cards[3].children[0].children[1].children[0].children[0].textContent === 'Result · Win', 'Result tag includes the outcome');
const scoreFigure = cards[3].children[0].children[0];
assert(scoreFigure.className === 'news-scoreline' && scoreFigure.children.length === 3, 'A result without its own photo gets a generated scoreline tile');
assert(scoreFigure.children[1].textContent === '2 – 3' && scoreFigure.children[0].children[0].src === 'https://cdn/glens.png', 'Scoreline shows home crest, score, away crest');
const clubFigure = cards[1].children[0].children[0];
assert(clubFigure.className === 'news-generic', 'Cards with no image at all get the club tile');

// 3. Filters: buttons per category; clicking one filters the grid.
const bar = feed.querySelector('[data-news-filters]');
assert([...bar.children].map(b => b.textContent).join('|') === 'All|Match day|Club|Instagram|Result|Squad|Gallery', 'Filter bar lists All plus each category once');
bar.children[4].click();
assert(feed.querySelector('[data-news-grid]').children.length === 1, 'Filtering by Result shows one card');
assert(bar.children[4].getAttribute('aria-pressed') === 'true' && bar.children[0].getAttribute('aria-pressed') === 'false', 'Pressed state follows the active filter');

// 4. Article view from ?post=slug, only for items with a body.
let { article } = run({ withArticle: true, search: '?post=welcome' });
assert(article.hidden === false, 'Article shown for a post slug');
assert(article.querySelector('[data-article-title]').textContent === 'Welcome', 'Article title set');
assert(article.querySelector('[data-article-body]').children.map(p => p.textContent).join('|') === 'Intro.|One.|Two.', 'Summary leads the body paragraphs');
assert(document.title === 'Welcome | CalBlue', 'Page title follows the post');
({ article } = run({ withArticle: true, search: '?post=result-2026-09-13-sf-glens' }));
assert(article.hidden === true, 'Items without a body never open as an article');

// 5. Empty feed and failed fetch.
({ feed } = run({ data: { items: [] } }));
assert(feed.querySelector('[data-news-grid]').children.length === 0 && feed.querySelector('[data-news-empty]').hidden === false, 'Empty message shown when nothing is published');
fetch = () => new Resolved({ ok: false });
({ feed } = run({}));
console.log('Club news feed checks passed');
