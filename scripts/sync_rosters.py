#!/usr/bin/env python3
"""Import public CalBlue roster fields from official competition team pages."""
import argparse
from datetime import datetime, timezone
from html.parser import HTMLParser
import json
from pathlib import Path
import re
from urllib.parse import urljoin, urlparse
from urllib.request import Request, urlopen

SOURCES = {
    'swpl': 'https://pacific.swplsoccer.com/teams/calblue-fc',
    'nccsf': 'https://nccsf.org/en/league/team?a=tp&tid=621&tab=player',
}
SEASON_STARTS = {'swpl': '2026-09-13', 'nccsf': '2026-09-12'}


def safe_url(base, value):
    url = urljoin(base, value or '')
    return url if urlparse(url).scheme == 'https' else ''


class RosterParser(HTMLParser):
    def __init__(self, source):
        super().__init__()
        self.source = source
        self.active = False
        self.found = False
        self.players = []
        self.row = None
        self.cell = None
        self.field = None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'table' and attrs.get('id') == ('rosterTable' if self.source == 'swpl' else 'playerList'):
            self.active = self.found = True
        if not self.active:
            return
        if tag == 'tr':
            self.row = {'name': '', 'number': '', 'position': '', 'photo': '', 'profile': '', 'cells': []}
        if self.row is None:
            return
        if tag == 'td':
            self.cell = []
        if tag == 'div':
            fields = {'gridPlayerName': 'name', 'gridPlayerNumber': 'number', 'gridPlayerPosition': 'position'}
            self.field = fields.get(attrs.get('class'))
            if attrs.get('class') == 'gridPlayerPhoto':
                match = re.search(r'url\([\"\']?([^\)\"\']+)', attrs.get('style', ''))
                if match:
                    self.row['photo'] = safe_url(SOURCES[self.source], match[1])
        if tag == 'img' and self.cell is not None and not self.row['photo']:
            self.row['photo'] = safe_url(SOURCES[self.source], attrs.get('src'))
        if tag == 'a' and self.source == 'swpl':
            href = attrs.get('href', '')
            if href.startswith('/roster/'):
                self.row['profile'] = safe_url(SOURCES[self.source], href)

    def handle_data(self, text):
        if self.row is not None and self.active:
            if self.cell is not None:
                self.cell.append(text)
            if self.field:
                self.row[self.field] += text

    def handle_endtag(self, tag):
        if not self.active:
            return
        if tag == 'div':
            self.field = None
        if tag == 'td' and self.cell is not None and self.row is not None:
            self.row['cells'].append(' '.join(''.join(self.cell).split()))
            self.cell = None
        if tag == 'tr' and self.row is not None:
            row = self.row
            cells = row.pop('cells')
            if self.source == 'nccsf' and len(cells) >= 4:
                # A departed player is no longer on this competition's roster.
                if cells[3].casefold() == 'left':
                    self.row = None
                    return
                row['name'] = f'{cells[2]} {cells[1]}'.strip()
            row = {key: ' '.join(value.split()) for key, value in row.items()}
            if row['name']:
                self.players.append(row)
            self.row = None
        if tag == 'table':
            self.active = False


def parse_roster(source, html):
    identity = 'teamPageName' if source == 'swpl' else 'tid=621'
    if identity not in html or 'CalBlue' not in html:
        raise ValueError(f'{source}: expected the official CalBlue team page')
    parser = RosterParser(source)
    parser.feed(html)
    if not parser.found or not parser.players:
        raise ValueError(f'{source}: roster missing or empty; preserving previous snapshot')
    names = [player['name'].casefold() for player in parser.players]
    if len(names) != len(set(names)):
        raise ValueError(f'{source}: duplicate player names')
    return parser.players


def enrich_nccsf_photos(players, photos):
    """Use confirmed original URLs keyed by NCCSF player ID, retaining thumbnails."""
    result = []
    for player in players:
        player = dict(player)
        thumbnail = player['photo']
        match = re.search(r'/thumb-(\d+)\.[a-zA-Z]+$', urlparse(thumbnail).path)
        if match:
            player_id = match[1]
            player['profile'] = SOURCES['nccsf'].replace('&tab=player', f'&pid={player_id}').replace('a=tp&', 'a=atpf&')
            original = photos.get(player_id)
            if original:
                parsed = urlparse(original)
                if (parsed.scheme != 'https' or parsed.netloc != 'nccsf.org'
                        or not re.fullmatch(rf'/en/img/player/photo/+\d+/{player_id}_[\w-]+\.(?:jpeg|jpg|png)', parsed.path)):
                    raise ValueError(f'Invalid NCCSF original photo for player {player_id}')
                player['photo'] = original
                player['photos'] = [original, thumbnail]
        result.append(player)
    return result


def main():
    args = argparse.ArgumentParser()
    args.add_argument('--swpl-file', type=Path)
    args.add_argument('--nccsf-file', type=Path)
    args.add_argument('--output', type=Path, default=Path('data/rosters.json'))
    options = args.parse_args()
    photo_map = json.loads((Path(__file__).resolve().parent.parent / 'data/nccsf-player-photos.json').read_text())
    result = {'updatedAt': datetime.now(timezone.utc).isoformat(), 'competitions': {}}
    for source, url in SOURCES.items():
        path = getattr(options, source + '_file')
        if path:
            html = path.read_text()
        else:
            with urlopen(Request(url, headers={'User-Agent': 'CalBlueRosterSync/1.0'}), timeout=30) as response:
                raw = response.read(5_000_001)
            if len(raw) > 5_000_000:
                raise ValueError('Official roster response too large')
            html = raw.decode('utf-8')
        players = parse_roster(source, html)
        if source == 'nccsf':
            players = enrich_nccsf_photos(players, photo_map)
        result['competitions'][source] = {'sourceUrl': url, 'seasonStartsOn': SEASON_STARTS[source], 'players': players}
        print(f'{source}: {len(players)} players')
    options.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = options.output.with_suffix('.tmp')
    temporary.write_text(json.dumps(result, indent=2, ensure_ascii=False) + '\n')
    temporary.replace(options.output)


if __name__ == '__main__':
    main()
