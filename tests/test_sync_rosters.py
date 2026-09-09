import unittest
from scripts.sync_rosters import parse_roster, safe_url


class RosterTests(unittest.TestCase):
    def test_swpl_public_fields_and_entities(self):
        html = '''<div class="teamPageName">CalBlue FC</div><table id="rosterTable"><tr><td><a href="/roster/test"><div class="gridPlayerPhoto" style="background-image:url('//cdn.example.com/photo.jpg')"></div></a></td><td><div class="gridPlayerNumber">31</div><div class="gridPlayerName">A &amp; B</div><div class="gridPlayerPosition">Defender</div></td></tr></table>'''
        player, = parse_roster('swpl', html)
        self.assertEqual(player['name'], 'A & B')
        self.assertEqual(player['number'], '31')
        self.assertEqual(player['photo'], 'https://cdn.example.com/photo.jpg')
        self.assertEqual(player['position'], 'Defender')

    def test_nccsf_excludes_departed_and_private_fields(self):
        html = '''CalBlue tid=621 <table id="playerList"><tr><td><img src="../img/a.jpg"></td><td>Qin</td><td>Sheng</td><td>Accepted</td><td>local</td><td>07/17</td></tr><tr><td></td><td>Former</td><td>Player</td><td>Left</td></tr></table>'''
        player, = parse_roster('nccsf', html)
        self.assertEqual(player['name'], 'Sheng Qin')
        self.assertNotIn('status', player)
        self.assertNotIn('local', player.values())

    def test_missing_empty_and_duplicate_rosters_fail(self):
        for html in ['<html>Login</html>', 'CalBlue teamPageName <table id="rosterTable"></table>', 'CalBlue teamPageName <table id="rosterTable">' + '<tr><td><div class="gridPlayerName">Same</div></td></tr>' * 2 + '</table>']:
            with self.assertRaises(ValueError):
                parse_roster('swpl', html)

    def test_reject_unsafe_url(self):
        self.assertEqual(safe_url('https://example.com', 'javascript:alert(1)'), '')


if __name__ == '__main__':
    unittest.main()
