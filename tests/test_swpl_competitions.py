from __future__ import annotations

from datetime import date, datetime
import unittest
from zoneinfo import ZoneInfo

from scripts.sync_swpl import build_snapshot, merge_overrides


TODAY = date(2026, 10, 25)
OPPONENTS = ("JSC JASA", "South San Francisco AC")


def fixture(
    identifier: str,
    competition: str,
    *,
    opponent: str = "JSC JASA",
    day: str = "2026-10-25",
    completed: bool = False,
    reverse: bool = False,
) -> dict[str, object]:
    home, away = {"name": "CalBlue FC"}, {"name": opponent}
    if reverse:
        home, away = away, home
    return {
        "id": identifier,
        "date": day,
        "competition": competition,
        "home": home,
        "away": away,
        "venue": {"name": "Test Ground"},
        "status": "completed" if completed else "scheduled",
        **({"score": {"home": 2, "away": 1}} if completed else {}),
    }


class CompetitionOverrideTest(unittest.TestCase):
    def test_official_games_do_not_suppress_other_competition_previews(self) -> None:
        for official_competition, preview_competition in (
            ("Regular Season", "Abronzino Cup"),
            ("2026 Abronzino Cup", "SWPL Pacific League"),
        ):
            for opponent in OPPONENTS:
                for completed in (False, True):
                    for preview_date in ("2026-10-25", "2026-11-22"):
                        with self.subTest(
                            official=official_competition,
                            opponent=opponent,
                            completed=completed,
                            preview_date=preview_date,
                        ):
                            official = fixture(
                                "official", official_competition,
                                opponent=opponent, completed=completed,
                            )
                            preview = fixture(
                                "preview", preview_competition,
                                opponent=opponent, day=preview_date,
                            )
                            merged = merge_overrides([official], [preview], TODAY)
                            self.assertEqual(
                                {game["id"] for game in merged}, {"official", "preview"}
                            )

    def test_same_competition_official_games_replace_matching_previews(self) -> None:
        for official_competition, preview_competition in (
            ("Regular Season", "SWPL Pacific League"),
            ("2026 ABRONZINO CUP", "Abronzino Cup"),
        ):
            for opponent in OPPONENTS:
                for completed in (False, True):
                    for preview_date in ("2026-10-25", "2026-11-22"):
                        with self.subTest(
                            official=official_competition,
                            opponent=opponent,
                            completed=completed,
                            preview_date=preview_date,
                        ):
                            official = fixture(
                                "official", official_competition,
                                opponent=opponent, completed=completed,
                            )
                            # An official update can change the date and home/away assignment.
                            preview = fixture(
                                "preview", preview_competition,
                                opponent=opponent, day=preview_date, reverse=True,
                            )
                            self.assertEqual(
                                merge_overrides([official], [preview], TODAY), [official]
                            )

    def test_same_day_previews_in_different_competitions_are_not_duplicates(self) -> None:
        league = fixture("league", "SWPL Pacific League")
        cup = fixture("cup", "Abronzino Cup")
        merged = merge_overrides([], [league, cup], TODAY)
        self.assertEqual({game["id"] for game in merged}, {"league", "cup"})

    def test_same_day_preview_aliases_in_one_competition_are_duplicates(self) -> None:
        preview = fixture("cup", "Abronzino Cup")
        duplicate = fixture("duplicate", "2026 Abronzino Cup", reverse=True)
        self.assertEqual(merge_overrides([], [preview, duplicate], TODAY), [preview])

    def test_unlabelled_legacy_preview_is_still_a_league_fixture(self) -> None:
        preview = fixture("preview", "")
        del preview["competition"]
        official = fixture("official", "Regular Season")
        self.assertEqual(merge_overrides([official], [preview], TODAY), [official])

    def test_event_only_cup_placeholder_requires_official_cup_on_same_date(self) -> None:
        placeholder = fixture("placeholder", "Abronzino Cup", opponent="Opponent TBA")
        placeholder["eventOnly"] = True
        for competition in ("Regular Season", "Abronzino Cup"):
            for official_date in ("2026-10-25", "2026-10-26"):
                with self.subTest(competition=competition, official_date=official_date):
                    official = fixture("official", competition, day=official_date)
                    merged = merge_overrides([official], [placeholder], TODAY)
                    should_replace = competition == "Abronzino Cup" and official_date == placeholder["date"]
                    self.assertEqual(
                        "placeholder" in {game["id"] for game in merged}, not should_replace
                    )

    def test_completed_cup_result_replaces_only_cup_preview_in_snapshot(self) -> None:
        html = """
        <div class="teamPageName">CalBlue FC</div>
        <table id="scheduleTable">
          <tr class="dayRow"><td>Sun 10/25/2026</td></tr>
          <tr class="dataRow">
            <td>7:00 pm PT</td><td>Abronzino Cup</td><td>JSC JASA</td><td>1 - 2</td>
            <td>CalBlue FC</td><td>Red Morton Park</td><td>Group C</td>
          </tr>
        </table>
        """
        checked_at = datetime(2026, 10, 25, 23, tzinfo=ZoneInfo("America/Los_Angeles"))
        cup_preview = fixture("cup-preview", "Abronzino Cup", day="2026-11-22")
        league_preview = fixture("league-preview", "SWPL Pacific League")
        snapshot = build_snapshot(html, checked_at, [cup_preview, league_preview])
        self.assertEqual([game["id"] for game in snapshot["fixtures"]], ["league-preview"])
        self.assertEqual(len(snapshot["results"]), 1)
        self.assertEqual(snapshot["results"][0]["competition"], "Abronzino Cup")
        self.assertEqual(snapshot["results"][0]["score"], {"home": 1, "away": 2})


if __name__ == "__main__":
    unittest.main()
