from __future__ import annotations

from datetime import datetime
import json
import unittest
from zoneinfo import ZoneInfo

from scripts.sync_nccsf import build_snapshot


SAMPLE = json.dumps(
    {
        "data": [
            {
                "game": '<a href="game?a=editGameForm&gid=3388">Sat-1</a>',
                "home": '<a href="team?a=tp&tid=623">GSF United</a> <font>(White/Blue)</font>',
                "away": '<a href="team?a=tp&tid=621">CalBlue</a> <font>(Blue/White)</font>',
                "date": "09-12 19:00",
                "field": '<a href="https://maps.example.test/nordvik">Nordvik Park</a>',
                "score": "",
                "division": "Open",
            },
            {
                "game": '<a href="game?a=editGameForm&gid=3401">Sat-3</a>',
                "home": '<a href="team?a=tp&tid=621">CalBlue</a>',
                "away": '<a href="team?a=tp&tid=625">HeHeFC</a>',
                "date": "09-26 20:00",
                "field": '<a href="https://maps.example.test/newark">Newark Right</a>',
                "score": "",
                "division": "Open",
            },
            {
                "game": '<a href="game?a=editGameForm&gid=3390">Sun-1</a>',
                "home": '<a href="team?a=tp&tid=620">Athletic Capybara</a>',
                "away": '<a href="team?a=tp&tid=630">THU West</a>',
                "date": "09-13 20:00",
                "field": '<a href="https://maps.example.test/newark">Newark Right</a>',
                "score": "",
                "division": "Open",
            },
        ]
    }
)

TEAMS = """
<table id="teamList"><tbody>
  <tr><td><a href="team?a=tp&tid=621"><img src="../img/team/logo/621.jpeg"> CalBlue</a></td></tr>
  <tr><td><a href="team?a=tp&tid=623"><img src="../img/team/logo/623.jpeg"> GSF United</a></td></tr>
  <tr><td><a href="team?a=tp&tid=625"><img src="../img/team/logo/625.png"> HeHeFC</a></td></tr>
  <tr><td><a href="team?a=tp&tid=620"><img src="../img/team/logo/620.png"> Athletic Capybara</a></td></tr>
  <tr><td><a href="team?a=tp&tid=630"><img src="../img/team/logo/630.jpeg"> THU West</a></td></tr>
</tbody></table>
"""


class BuildSnapshotTest(unittest.TestCase):
    def test_extracts_only_upcoming_calblue_fixtures(self) -> None:
        checked_at = datetime(2026, 9, 3, 12, tzinfo=ZoneInfo("America/Los_Angeles"))
        snapshot = build_snapshot(SAMPLE, TEAMS, checked_at)

        self.assertEqual(snapshot["season"]["name"], "2026 NCCSF Fall League")
        self.assertEqual(snapshot["team"]["id"], 621)
        self.assertEqual(len(snapshot["fixtures"]), 2)
        first = snapshot["fixtures"][0]
        self.assertEqual(first["id"], "nccsf-3388")
        self.assertEqual(first["home"]["name"], "GSF United")
        self.assertEqual(first["away"]["name"], "CalBlue")
        self.assertEqual(first["home"]["logo"], "https://nccsf.org/en/img/team/logo/623.jpeg")
        self.assertEqual(first["away"]["logo"], "https://nccsf.org/en/img/team/logo/621.jpeg")
        self.assertEqual(first["startsAt"], "2026-09-12T19:00:00-07:00")
        self.assertEqual(first["timeLabel"], "7:00 PM PT")
        self.assertEqual(first["venue"]["name"], "Nordvik Park")
        self.assertEqual(snapshot["diagnostics"]["publishedCalBlueFixtures"], 2)

    def test_omits_past_and_completed_fixtures(self) -> None:
        payload = json.loads(SAMPLE)
        payload["data"][0]["score"] = "2 : 1"
        checked_at = datetime(2026, 9, 20, 12, tzinfo=ZoneInfo("America/Los_Angeles"))
        snapshot = build_snapshot(json.dumps(payload), TEAMS, checked_at)

        self.assertEqual([fixture["id"] for fixture in snapshot["fixtures"]], ["nccsf-3401"])

    def test_rejects_a_missing_game_list(self) -> None:
        checked_at = datetime(2026, 9, 3, 12, tzinfo=ZoneInfo("America/Los_Angeles"))
        with self.assertRaisesRegex(ValueError, "game list"):
            build_snapshot("{}", TEAMS, checked_at)

    def test_rejects_a_response_without_calblue(self) -> None:
        checked_at = datetime(2026, 9, 3, 12, tzinfo=ZoneInfo("America/Los_Angeles"))
        payload = json.loads(SAMPLE)
        payload["data"] = [payload["data"][2]]
        with self.assertRaisesRegex(ValueError, "did not identify CalBlue"):
            build_snapshot(json.dumps(payload), TEAMS, checked_at)

    def test_rejects_a_changed_team_identity(self) -> None:
        checked_at = datetime(2026, 9, 3, 12, tzinfo=ZoneInfo("America/Los_Angeles"))
        payload = json.loads(SAMPLE)
        payload["data"][0]["away"] = '<a href="team?a=tp&tid=621">Unknown FC</a>'
        with self.assertRaisesRegex(ValueError, "no longer identifies CalBlue"):
            build_snapshot(json.dumps(payload), TEAMS, checked_at)

    def test_rejects_a_missing_opponent_crest(self) -> None:
        checked_at = datetime(2026, 9, 3, 12, tzinfo=ZoneInfo("America/Los_Angeles"))
        incomplete_teams = TEAMS.replace(
            '<tr><td><a href="team?a=tp&tid=623"><img src="../img/team/logo/623.jpeg"> GSF United</a></td></tr>',
            "",
        )
        with self.assertRaisesRegex(ValueError, "missing a matching crest for GSF United"):
            build_snapshot(SAMPLE, incomplete_teams, checked_at)


if __name__ == "__main__":
    unittest.main()
