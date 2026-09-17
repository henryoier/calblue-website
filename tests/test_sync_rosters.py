import unittest
from scripts.sync_rosters import enrich_nccsf_photos, parse_roster, safe_url


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

    def test_original_photo_matches_id_and_retains_thumbnail(self):
        thumbnail = 'https://nccsf.org/en/img/player/photo/216/thumb-21641.jpeg'
        original = 'https://nccsf.org/en/img/player/photo//216/21641_lcysaqTB4x.jpeg'
        source = {'name': 'Lan An', 'photo': thumbnail}
        player, = enrich_nccsf_photos([source], {'21641': original})
        self.assertEqual(player['photos'], [original, thumbnail])
        self.assertEqual(player['photo'], original)
        self.assertIn('a=atpf&tid=621&pid=21641', player['profile'])
        self.assertEqual(source['photo'], thumbnail)
        unchanged, = enrich_nccsf_photos([source], {})
        self.assertEqual(unchanged['photo'], thumbnail)
        with self.assertRaises(ValueError):
            enrich_nccsf_photos([source], {'21641': original.replace('21641_', '1122_')})


if __name__ == '__main__':
    unittest.main()


class RosterHistoryTests(unittest.TestCase):
    ROSTERS = {
        'swpl': {'seasonStartsOn': '2026-09-13', 'players': [{'name': 'Sheng Qin', 'profile': 'https://x/sq', 'photo': 'https://x/sq.jpg'}, {'name': 'Suhau Kuo'}]},
        'nccsf': {'seasonStartsOn': '2026-09-12', 'players': [{'name': 'Sheng Qin'}]},
    }

    def test_first_run_seeds_the_squad_without_reporting_anyone(self):
        from scripts.sync_rosters import update_history
        history, newly = update_history({}, self.ROSTERS, '2026-09-09')
        self.assertEqual(newly, [])
        self.assertEqual(sorted(history['players']), ['nccsf:sheng qin', 'swpl:sheng qin', 'swpl:suhau kuo'], 'players are tracked per league')
        self.assertEqual(history['players']['swpl:sheng qin']['firstSeen'], '2026-09-13', 'seeded players are dated to the season start')
        self.assertTrue(history['players']['swpl:sheng qin']['seeded'])
        self.assertEqual(history['players']['swpl:sheng qin']['profile'], 'https://x/sq')

    def test_later_runs_report_new_players_and_keep_everyone_else(self):
        from scripts.sync_rosters import update_history
        history, _ = update_history({}, self.ROSTERS, '2026-09-09')
        rosters = {
            'swpl': {'seasonStartsOn': '2026-09-13', 'players': [{'name': 'Sheng Qin'}, {'name': 'Zheng Chang', 'photo': 'https://x/zc.jpg'}]},
            'nccsf': {'seasonStartsOn': '2026-09-12', 'players': [{'name': 'Sheng Qin'}, {'name': 'Lu Fang'}]},
        }
        history, newly = update_history(history, rosters, '2026-09-16')
        self.assertEqual([(p['league'], p['name'], p['firstSeen'], p['seeded']) for p in newly],
                         [('swpl', 'Zheng Chang', '2026-09-16', False), ('nccsf', 'Lu Fang', '2026-09-16', False)])
        self.assertEqual(newly[0]['photo'], 'https://x/zc.jpg')
        self.assertIn('swpl:suhau kuo', history['players'], 'a player missing from one sync is not forgotten')
        self.assertEqual(history['players']['swpl:suhau kuo']['lastSeen'], '2026-09-09')
        self.assertEqual(history['players']['swpl:sheng qin']['lastSeen'], '2026-09-16')
        again, newly_again = update_history(history, rosters, '2026-09-17')
        self.assertEqual(newly_again, [], 'already-known players are not reported twice')
        self.assertEqual(again['players']['swpl:zheng chang']['firstSeen'], '2026-09-16', 'first-seen dates are stable')
