from __future__ import annotations

from datetime import datetime
import json
import unittest
from zoneinfo import ZoneInfo

from scripts.sync_nccsf import attach_goals, build_snapshot, merge_goals, parse_goals


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
    def test_completed_away_result_and_zero_draw_are_retained(self):
        payload = json.loads(SAMPLE)
        checked = datetime(2026, 9, 26, 23, tzinfo=ZoneInfo("America/Los_Angeles"))
        payload["data"][0]["score"] = "1:6"
        payload["data"][1]["score"] = "0 : 0"
        snapshot = build_snapshot(json.dumps(payload), TEAMS, checked)
        self.assertEqual(snapshot["fixtures"], [])
        self.assertEqual(snapshot["results"][0]["score"], {"home": 0, "away": 0})
        self.assertEqual(snapshot["results"][1]["score"], {"home": 1, "away": 6})
        self.assertEqual(snapshot["results"][1]["away"]["name"], "CalBlue")

    def test_elapsed_date_without_score_is_not_a_result(self):
        checked = datetime(2026, 9, 20, tzinfo=ZoneInfo("America/Los_Angeles"))
        snapshot = build_snapshot(SAMPLE, TEAMS, checked)
        self.assertEqual(snapshot["results"], [])
        played = [f for f in snapshot["fixtures"] if f["status"] == "played"]
        self.assertEqual([f["id"] for f in played], ["nccsf-3388"], "a played game without a published score stays listed as result pending")
        self.assertNotIn("score", played[0])
        self.assertEqual([f["id"] for f in snapshot["fixtures"] if f["status"] == "scheduled"], ["nccsf-3401"])

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


GOALS = json.dumps(
    {
        "data": [
            {"week": '<a href="game?a=editGameForm&gid=3388&id=1669&tab=goals">Week01</a>', "player": '<a href="team?a=atpf&tid=621&pid=1137"><img src="x.jpg"> Kuo, Suhau</a>', "team": '<a href="team?a=tp&tid=621">CalBlue</a>', "opponent": '<a href="team?a=tp&tid=623">GSF United</a>', "video": "", "like": ""},
            {"week": '<a href="game?a=editGameForm&gid=3388&id=1670&tab=goals">Week01</a>', "player": '<a href="team?a=atpf&tid=621&pid=22495"> Peng, William</a>', "team": '<a href="team?a=tp&tid=621">CalBlue</a>', "opponent": "", "video": ""},
            {"week": '<a href="game?a=editGameForm&gid=3388&id=1671&tab=goals">Week01</a>', "player": '<a href="team?a=atpf&tid=621&pid=22495"> Peng, William</a>', "team": '<a href="team?a=tp&tid=621">CalBlue</a>', "opponent": "", "video": ""},
            {"week": '<a href="game?a=editGameForm&gid=3388&id=1672&tab=goals">Week01</a>', "player": '<a href="team?a=atpf&tid=623&pid=900"> Doe, John*</a>', "team": '<a href="team?a=tp&tid=623">GSF United</a>', "opponent": "", "video": "https://youtu.be/x"},
            {"week": '<a href="game?a=editGameForm&gid=3389&id=1680&tab=goals">Week01</a>', "player": '<a href="team?a=atpf&tid=700&pid=1"> Pu, Donglin</a>', "team": '<a href="team?a=tp&tid=700">GSF-Locomotive</a>', "opponent": "", "video": ""},
            {"week": "no game id", "player": "Nobody", "team": "", "opponent": "", "video": ""},
        ]
    }
)


class GoalScorerTest(unittest.TestCase):
    def test_goal_list_is_grouped_by_game_with_display_names(self):
        goals = parse_goals(GOALS)
        self.assertEqual(sorted(goals), ["3388", "3389"], "rows without a game id are ignored")
        players = [(g["player"], g["teamId"], g["highlight"]) for g in goals["3388"]]
        self.assertEqual(players, [("Suhau Kuo", 621, False), ("William Peng", 621, False), ("William Peng", 621, False), ("John Doe", 623, True)])
        self.assertEqual(goals["3388"][0]["playerId"], 1137)

    def test_scorers_attach_to_the_matching_result_by_side(self):
        checked = datetime(2026, 9, 20, tzinfo=ZoneInfo("America/Los_Angeles"))
        payload = json.loads(SAMPLE)
        payload["data"][0]["score"] = "1:6"
        snapshot = build_snapshot(json.dumps(payload), TEAMS, checked)
        attached = attach_goals(snapshot, parse_goals(GOALS))
        self.assertEqual(attached, 1)
        result = snapshot["results"][0]
        self.assertEqual(result["id"], "nccsf-3388")
        self.assertEqual([(g["player"], g["side"]) for g in result["goals"] if not g["highlight"]],
                         [("Suhau Kuo", "away"), ("William Peng", "away"), ("William Peng", "away")], "CalBlue were the away side")
        self.assertEqual(result["goalsNote"], "partial", "three published goals do not yet explain a 1:6 score")
        self.assertNotIn("goals", snapshot["fixtures"][0], "upcoming fixtures never carry scorers")

    def test_complete_scorer_list_has_no_partial_note(self):
        checked = datetime(2026, 9, 20, tzinfo=ZoneInfo("America/Los_Angeles"))
        payload = json.loads(SAMPLE)
        payload["data"][0]["score"] = "0:3"
        snapshot = build_snapshot(json.dumps(payload), TEAMS, checked)
        attach_goals(snapshot, parse_goals(GOALS))
        self.assertNotIn("goalsNote", snapshot["results"][0])

    def test_cache_merge_keeps_earlier_weeks(self):
        cached = {"3300": [{"player": "Old Goal", "teamId": 621}], "3388": [{"player": "Stale", "teamId": 621}]}
        merged = merge_goals(cached, parse_goals(GOALS))
        self.assertEqual(list(merged), ["3300", "3388", "3389"])
        self.assertEqual(merged["3388"][0]["player"], "Suhau Kuo", "fresh data replaces the cached game")

    def test_bad_goal_list_is_rejected(self):
        with self.assertRaises(ValueError):
            parse_goals("not json")
        with self.assertRaises(ValueError):
            parse_goals("{}")
