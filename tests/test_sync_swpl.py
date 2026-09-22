from __future__ import annotations

from datetime import datetime
import json
from pathlib import Path
import unittest
from zoneinfo import ZoneInfo

from scripts.sync_swpl import build_snapshot


SAMPLE = """
<div class="teamPageLogo"><img src="//nisa.sportzstudio.com/team_images/calblue.png"></div>
<div class="teamPageName"> CalBlue FC </div>
<div class="teamPageConference">Mens Open Pacific - Sunnyvale, CA</div>
<table id="scheduleTable">
  <tr class="dayRow"><td colspan="8">Sat 08/29/2026</td></tr>
  <tr class="dataRow SMStatus_Fixture">
    <td>7:00 pm PT</td><td>Regular Season</td><td><div>CalBlue FC</div></td><td>2 - 1</td>
    <td><div>Past FC</div></td><td>Old Ground</td><td>Mens Open Pacific</td><td></td>
  </tr>
  <tr class="dayRow"><td colspan="8">Sat 09/05/2026</td></tr>
  <tr class="dataRow SMStatus_Fixture">
    <td class="schedule_time">7:00 pm PT</td><td class="schedule_round">Regular Season</td>
    <td class="schedule_team_A_name"><a href="/teams/calblue-fc"><div style="background-image:url(http://nisa.sportzstudio.com/team_images/calblue.png)"></div><div>CalBlue FC</div></a></td>
    <td class="schedule_result">-</td>
    <td class="schedule_team_B_name"><a href="/teams/sf-glens"><div style="background-image:url(//nisa.sportzstudio.com/team_images/glens.png)"></div><div>SF Glens</div></a></td>
    <td class="schedule_venueName"><a href="https://maps.example.test/one">Sunnyvale Soccer Complex</a></td>
    <td class="schedule_time">Mens Open Pacific</td><td></td>
  </tr>
  <tr class="dayRow"><td colspan="8">Sun 09/13/2026</td></tr>
  <tr class="dataRow SMStatus_Fixture">
    <td class="schedule_time">4:30 pm PT</td><td class="schedule_round">Regular Season</td>
    <td class="schedule_team_A_name"><a href="/teams/bay-area-united"><div>Bay Area United</div></a></td>
    <td class="schedule_result"></td>
    <td class="schedule_team_B_name"><a href="/teams/calblue-fc"><div>CalBlue FC</div></a></td>
    <td class="schedule_venueName">Venue TBA</td><td class="schedule_time">Mens Open Pacific</td><td></td>
  </tr>
  <tr class="dayRow"><td colspan="8">Sun 09/20/2026</td></tr>
  <tr class="dataRow SMStatus_Fixture">
    <td>2:00 pm PT</td><td>Regular Season</td><td><div>Other FC</div></td><td>-</td>
    <td><div>Another FC</div></td><td>Elsewhere</td><td>Mens Open Pacific</td><td></td>
  </tr>
</table>
"""

EMPTY_CALBLUE_SCHEDULE = """
<div class="teamPageLogo"><img src="//nisa.sportzstudio.com/team_images/calblue.png"></div>
<div class="teamPageName">CalBlue FC</div>
<div class="teamPageConference">Mens Open Pacific - Sunnyvale, CA</div>
<table id="scheduleTable"></table>
"""

OFFICIAL_SCHEDULE_UPDATES = """
<div class="teamPageName">CalBlue FC</div>
<div class="teamPageConference">Mens Open Pacific - Sunnyvale, CA</div>
<table id="scheduleTable">
  <tr class="dayRow"><td>Sat 10/17/2026</td></tr>
  <tr class="dataRow">
    <td>TBA</td><td>Regular Season</td><td>Club Deportivo Oakland</td><td>-</td>
    <td>CalBlue FC</td><td>Albany Middle School - Cougar Field</td><td>Mens Open Pacific</td>
  </tr>
  <tr class="dayRow"><td>Sun 11/08/2026</td></tr>
  <tr class="dataRow">
    <td>11:00 am PT</td><td>Regular Season</td><td>South San Francisco AC</td><td>-</td>
    <td>CalBlue FC</td><td>El Camino High School Stadium</td><td>Mens Open Pacific</td>
  </tr>
  <tr class="dayRow"><td>Sun 11/22/2026</td></tr>
  <tr class="dataRow">
    <td>7:30 pm PT</td><td>Abronzino Cup</td><td>CalBlue FC</td><td>-</td>
    <td>South San Francisco AC</td><td>Fair Oaks Park Field 3</td><td>Group C</td>
  </tr>
</table>
"""


class BuildSnapshotTest(unittest.TestCase):
    def test_results_preserve_scores_and_suppress_same_day_preview(self):
        checked = datetime(2026, 9, 5, 23, tzinfo=ZoneInfo("America/Los_Angeles"))
        source = SAMPLE.replace('<td class="schedule_result">-</td>', '<td class="schedule_result">10 - 0</td>')
        preview = {"id": "preview", "date": "2026-09-05", "home": {"name": "CalBlue FC"}, "away": {"name": "SF Glens"}, "venue": {"name": "Ground"}, "status": "scheduled"}
        snapshot = build_snapshot(source, checked, [preview])
        self.assertEqual(snapshot["results"][0]["score"], {"home": 10, "away": 0})
        self.assertEqual(snapshot["results"][1]["score"], {"home": 2, "away": 1})
        self.assertEqual(snapshot["results"][0]["status"], "completed")
        self.assertFalse(any(game["away"]["name"] == "SF Glens" for game in snapshot["fixtures"]))

    def test_past_unscored_game_is_not_a_result(self):
        checked = datetime(2026, 9, 6, tzinfo=ZoneInfo("America/Los_Angeles"))
        snapshot = build_snapshot(SAMPLE, checked)
        self.assertEqual(len(snapshot["results"]), 1)
        self.assertEqual(snapshot["results"][0]["away"]["name"], "Past FC")
        played = [f for f in snapshot["fixtures"] if f["status"] == "played"]
        self.assertTrue(played, "a played game without a published score stays listed as result pending")
        self.assertTrue(all("score" not in f for f in played))

    def test_extracts_only_upcoming_calblue_fixtures(self) -> None:
        checked_at = datetime(2026, 9, 2, 12, tzinfo=ZoneInfo("America/Los_Angeles"))
        snapshot = build_snapshot(SAMPLE, checked_at)

        self.assertEqual(snapshot["team"]["name"], "CalBlue FC")
        self.assertEqual(snapshot["team"]["competition"], "Mens Open Pacific")
        self.assertEqual(snapshot["team"]["location"], "Sunnyvale, CA")
        self.assertEqual(len(snapshot["fixtures"]), 2)
        self.assertEqual(snapshot["fixtures"][0]["home"]["name"], "CalBlue FC")
        self.assertEqual(snapshot["fixtures"][0]["away"]["name"], "SF Glens")
        self.assertEqual(snapshot["fixtures"][0]["startsAt"], "2026-09-05T19:00:00-07:00")
        self.assertEqual(snapshot["fixtures"][1]["away"]["name"], "CalBlue FC")
        self.assertEqual(snapshot["diagnostics"]["ignoredNonCalBlueRows"], 1)

    def test_uses_an_editorial_fixture_until_swpl_publishes_it(self) -> None:
        checked_at = datetime(2026, 9, 2, 12, tzinfo=ZoneInfo("America/Los_Angeles"))
        override = {
            "id": "poster-fixture",
            "date": "2026-09-13",
            "startsAt": "2026-09-13T19:00:00-07:00",
            "timeLabel": "7:00 pm PT",
            "competition": "SWPL Pacific League",
            "home": {"name": "CalBlue FC", "url": None, "logo": None},
            "away": {"name": "SF Glens", "url": None, "logo": None},
            "venue": {"name": "Central Park, Fremont, CA", "mapUrl": None},
            "conference": "Mens Open Pacific",
            "sourceUrl": "https://pacific.swplsoccer.com/teams/calblue-fc",
            "status": "scheduled",
            "editorial": True,
        }

        snapshot = build_snapshot(EMPTY_CALBLUE_SCHEDULE, checked_at, [override])

        self.assertEqual(len(snapshot["fixtures"]), 1)
        self.assertEqual(snapshot["fixtures"][0]["id"], "poster-fixture")
        self.assertEqual(snapshot["diagnostics"]["editorialOverrides"], 1)

    def test_prefers_the_official_row_over_a_matching_override(self) -> None:
        checked_at = datetime(2026, 9, 2, 12, tzinfo=ZoneInfo("America/Los_Angeles"))
        override = {
            "id": "poster-fixture",
            "date": "2026-09-05",
            "startsAt": "2026-09-05T19:00:00-07:00",
            "timeLabel": "7:00 pm PT",
            "competition": "SWPL Pacific League",
            "home": {"name": "CalBlue FC"},
            "away": {"name": "SF Glens"},
            "venue": {"name": "Central Park"},
            "editorial": True,
        }

        snapshot = build_snapshot(SAMPLE, checked_at, [override])

        self.assertEqual(len(snapshot["fixtures"]), 2)
        self.assertNotIn("poster-fixture", [fixture["id"] for fixture in snapshot["fixtures"]])
        self.assertEqual(snapshot["diagnostics"]["editorialOverrides"], 0)

    def test_official_matchup_replaces_a_preview_on_a_changed_date(self) -> None:
        checked_at = datetime(2026, 9, 2, 12, tzinfo=ZoneInfo("America/Los_Angeles"))
        override = {
            "id": "preview-fixture",
            "date": "2026-09-06",
            "home": {"name": "CalBlue FC"},
            "away": {"name": "SF Glens"},
            "venue": {"name": "Preview venue"},
            "editorial": True,
        }

        snapshot = build_snapshot(SAMPLE, checked_at, [override])

        self.assertNotIn("preview-fixture", [fixture["id"] for fixture in snapshot["fixtures"]])
        self.assertEqual(snapshot["fixtures"][0]["date"], "2026-09-05")

    def test_official_cup_fixture_replaces_a_preview_cup_date(self) -> None:
        checked_at = datetime(2026, 9, 2, 12, tzinfo=ZoneInfo("America/Los_Angeles"))
        cup_html = SAMPLE.replace("Regular Season", "Abronzino Cup")
        override = {
            "id": "preview-cup-date",
            "date": "2026-09-05",
            "home": {"name": "CalBlue FC"},
            "away": {"name": "Opponent TBA"},
            "venue": {"name": "Venue TBA"},
            "competition": "Abronzino Cup",
            "eventOnly": True,
            "editorial": True,
        }

        snapshot = build_snapshot(cup_html, checked_at, [override])

        self.assertNotIn("preview-cup-date", [fixture["id"] for fixture in snapshot["fixtures"]])

    def test_rejects_an_unrecognized_team_page(self) -> None:
        checked_at = datetime(2026, 9, 2, 12, tzinfo=ZoneInfo("America/Los_Angeles"))
        with self.assertRaisesRegex(ValueError, "did not identify CalBlue"):
            build_snapshot('<div class="teamPageName">Other FC</div><table id="scheduleTable"></table>', checked_at)

    def test_rejects_a_missing_schedule_table(self) -> None:
        checked_at = datetime(2026, 9, 2, 12, tzinfo=ZoneInfo("America/Los_Angeles"))
        with self.assertRaisesRegex(ValueError, "schedule table was not found"):
            build_snapshot('<div class="teamPageName">CalBlue FC</div>', checked_at)

    def test_official_tba_kickoff_keeps_date_and_updated_venue(self) -> None:
        checked_at = datetime(2026, 9, 14, 12, tzinfo=ZoneInfo("America/Los_Angeles"))
        snapshot = build_snapshot(OFFICIAL_SCHEDULE_UPDATES, checked_at)
        fixture = snapshot["fixtures"][0]

        self.assertEqual(fixture["date"], "2026-10-17")
        self.assertIsNone(fixture["startsAt"])
        self.assertEqual(fixture["timeLabel"], "TBA")
        self.assertEqual(fixture["venue"]["name"], "Albany Middle School - Cougar Field")

    def test_official_rescheduled_league_game_and_same_opponent_cup_are_retained(self) -> None:
        checked_at = datetime(2026, 9, 14, 12, tzinfo=ZoneInfo("America/Los_Angeles"))
        snapshot = build_snapshot(OFFICIAL_SCHEDULE_UPDATES, checked_at)
        league, cup = snapshot["fixtures"][1:]

        self.assertEqual(league["competition"], "Regular Season")
        self.assertEqual(league["date"], "2026-11-08")
        self.assertEqual(league["startsAt"], "2026-11-08T11:00:00-08:00")
        self.assertEqual(league["home"]["name"], "South San Francisco AC")
        self.assertEqual(league["away"]["name"], "CalBlue FC")
        self.assertEqual(league["venue"]["name"], "El Camino High School Stadium")
        self.assertEqual(cup["competition"], "Abronzino Cup")
        self.assertEqual(cup["date"], "2026-11-22")
        self.assertEqual(cup["startsAt"], "2026-11-22T19:30:00-08:00")
        self.assertEqual(cup["home"]["name"], "CalBlue FC")
        self.assertEqual(cup["away"]["name"], "South San Francisco AC")
        self.assertEqual(cup["venue"]["name"], "Fair Oaks Park Field 3")
        self.assertNotIn("2026-11-07", [fixture["date"] for fixture in snapshot["fixtures"]])


class OfficialScheduleConfigurationTest(unittest.TestCase):
    def setUp(self) -> None:
        path = Path(__file__).resolve().parent.parent / "data" / "swpl-overrides.json"
        self.overrides = json.loads(path.read_text(encoding="utf-8"))["fixtures"]

    def test_complete_official_schedule_has_no_active_preview_overrides(self) -> None:
        self.assertEqual(self.overrides, [])

    def test_empty_official_schedule_does_not_restore_retired_preview_games(self) -> None:
        checked_at = datetime(2026, 9, 2, 12, tzinfo=ZoneInfo("America/Los_Angeles"))
        snapshot = build_snapshot(EMPTY_CALBLUE_SCHEDULE, checked_at, self.overrides)

        self.assertEqual(snapshot["fixtures"], [])
        self.assertEqual(snapshot["results"], [])
        self.assertEqual(snapshot["diagnostics"]["editorialOverrides"], 0)

    def test_repository_configuration_does_not_reintroduce_old_dates(self) -> None:
        checked_at = datetime(2026, 9, 14, 12, tzinfo=ZoneInfo("America/Los_Angeles"))
        snapshot = build_snapshot(OFFICIAL_SCHEDULE_UPDATES, checked_at, self.overrides)

        self.assertEqual(
            [fixture["date"] for fixture in snapshot["fixtures"]],
            ["2026-10-17", "2026-11-08", "2026-11-22"],
        )
        self.assertEqual(snapshot["diagnostics"]["editorialOverrides"], 0)
        self.assertFalse(any(fixture.get("provisional") for fixture in snapshot["fixtures"]))


if __name__ == "__main__":
    unittest.main()
