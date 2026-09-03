from __future__ import annotations

from datetime import datetime
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


class BuildSnapshotTest(unittest.TestCase):
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

    def test_rejects_an_unrecognized_team_page(self) -> None:
        checked_at = datetime(2026, 9, 2, 12, tzinfo=ZoneInfo("America/Los_Angeles"))
        with self.assertRaisesRegex(ValueError, "did not identify CalBlue"):
            build_snapshot('<div class="teamPageName">Other FC</div><table id="scheduleTable"></table>', checked_at)

    def test_rejects_a_missing_schedule_table(self) -> None:
        checked_at = datetime(2026, 9, 2, 12, tzinfo=ZoneInfo("America/Los_Angeles"))
        with self.assertRaisesRegex(ValueError, "schedule table was not found"):
            build_snapshot('<div class="teamPageName">CalBlue FC</div>', checked_at)


if __name__ == "__main__":
    unittest.main()
