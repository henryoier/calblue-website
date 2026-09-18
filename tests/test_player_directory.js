// Run with node, or macOS: osascript -l JavaScript tests/test_player_directory.js
var window = {};
var read;
if (typeof require === 'function') {
  read = path => require('fs').readFileSync(path, 'utf8');
} else {
  ObjC.import('Foundation');
  read = path => $.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, null).js;
}
eval(read('player-directory.js'));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const old = [{ name: 'Qibang Zhu 朱启邦', photo: 'old.jpg' }, { name: 'Club Only', photo: 'club.jpg' }];
const competitions = {
  newer: { seasonStartsOn: '2026-09-13', players: [{ name: 'Qibang Zhu', photo: 'new.jpg', number: '' }] },
  older: { seasonStartsOn: '2026-09-12', players: [{ name: ' qibang  zhu ', photo: 'middle.jpg', number: '16' }] },
};
const merged = window.CALBLUE_PLAYERS.merge(old, competitions);
assert(merged.length === 2, 'Deduplicate aliases and preserve club-only players');
const player = merged.find(p => p.name === 'Qibang Zhu');
assert(player.photo === 'new.jpg' && player.number === '16', 'Newest populated fields win');
assert(player.photos.join() === 'new.jpg,middle.jpg,old.jpg', 'Retain ordered photo fallbacks');
const pinned = window.CALBLUE_PLAYERS.merge([{ name: 'Bennett Lee', photo: 'assets/roster/bennett-lee.jpg', pinned: true }], {
  nccsf: { seasonStartsOn: '2026-09-12', players: [{ name: 'Bennett Lee', photo: 'https://nccsf.org/league.jpeg', photos: ['https://nccsf.org/league.jpeg', 'https://nccsf.org/thumb.jpeg'] }] },
}).find(p => p.name === 'Bennett Lee');
assert(pinned.photo === 'assets/roster/bennett-lee.jpg' && pinned.photos.join() === 'assets/roster/bennett-lee.jpg,https://nccsf.org/league.jpeg,https://nccsf.org/thumb.jpeg', 'A pinned club photo leads and league photos remain fallbacks');
assert(pinned.pinned === undefined, 'The pin flag is not carried into the rendered player');
assert(JSON.stringify(merged) === JSON.stringify(window.CALBLUE_PLAYERS.merge(old, { older: competitions.older, newer: competitions.newer })), 'Source object order must not affect priority');
const html = read('players.html');
const existing = [...html.matchAll(/<article class="player-card"><img src="([^"]+)"[^>]*\/><h2>([^<]+)<\/h2>/g)].map(match => ({ photo: match[1], name: match[2] }));
const actual = window.CALBLUE_PLAYERS.merge(existing, JSON.parse(read('data/rosters.json')).competitions);
assert(actual.filter(p => p.name === 'Qibang Zhu').length === 1, 'Live Qibang duplicate resolved');
assert(actual.find(p => p.name === 'Sheng Qin').photo.includes('sportzstudio.com'), 'Live newer SWPL photo takes precedence');
assert(actual.find(p => p.name === 'Lan An').photos[1].includes('thumb-21641'), 'Preserve official thumbnail fallback behind the full-size photo');
console.log(`Player directory checks passed: ${actual.length} unique players`);
const pinnedRoster = window.CALBLUE_PLAYERS.applyPins(
  [{ name: 'Bennett Lee', photo: 'https://nccsf.org/league.jpeg', photos: ['https://nccsf.org/league.jpeg', 'https://nccsf.org/thumb.jpeg'] }, { name: 'Other Player', photo: 'https://nccsf.org/other.jpeg' }],
  { 'bennett lee': 'assets/roster/bennett-lee.jpg' },
);
assert(pinnedRoster[0].photo === 'assets/roster/bennett-lee.jpg' && pinnedRoster[0].photos.join() === 'assets/roster/bennett-lee.jpg,https://nccsf.org/league.jpeg,https://nccsf.org/thumb.jpeg', 'Competition rosters lead with a pinned club photo and keep league photos as fallbacks');
assert(pinnedRoster[1].photo === 'https://nccsf.org/other.jpeg', 'Unpinned players are untouched');
console.log('Photo pin checks passed');

