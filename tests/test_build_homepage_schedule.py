"""Homepage HTML remains current even when browser schedule rendering never runs."""

from contextlib import redirect_stdout
from datetime import date, datetime, timezone
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from scripts import build_homepage_schedule as homepage


TEMPLATE = '''<!doctype html><title>CalBlue</title>
<p>Keep the rest of the website unchanged.</p>
<b data-swpl-status-text>Checking official schedules</b>
<span data-swpl-checked>Updates are checked automatically.</span>
<!-- homepage-poster:start -->
<p>Next match: Bay Area United, September 19</p>
<!-- homepage-poster:end -->
<!-- homepage-schedule:start -->
<p>Old match-card copy</p>
<!-- homepage-schedule:end -->
<footer>Keep this footer.</footer>
'''
CALBLUE = {"name": "CalBlue FC"}


def fixture(day, name="Legends SC", *, home=True, **extra):
    other = {"name": name, "logo": "https://example.test/crest.png"}
    return {
        "date": day, "startsAt": day + "T19:30:00-08:00", "timeLabel": "7:30 PM PT",
        "competition": "SWPL Pacific Premier League", "status": "scheduled",
        "home": CALBLUE if home else other, "away": other if home else CALBLUE,
        "venue": {"name": "Fair Oaks Park Field 3"}, **extra,
    }


class BuildHomepageScheduleTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        (self.root / "data").mkdir()
        (self.root / "index.html").write_text(TEMPLATE, encoding="utf-8")
        self.swpl = [fixture("2026-11-08", "South San Francisco AC", home=False), fixture("2026-11-14")]
        self.nccsf = [fixture("2026-11-08", "Hunters", competition="2026 NCCSF Fall League"),
                      fixture("2026-11-15", "Deep Shoreline", home=False, competition="2026 NCCSF Fall League")]
        self.manifest = {"fixtures": {}}
        self.add_poster(self.swpl[1])
        self.write_feeds()

    def write(self, name, value):
        (self.root / "data" / name).write_text(json.dumps(value), encoding="utf-8")

    def write_feeds(self):
        self.write("swpl.json", {"fixtures": self.swpl, "checkedAt": "2026-11-09T09:26:00-08:00"})
        self.write("nccsf.json", {"fixtures": self.nccsf, "checkedAt": "2026-11-09T09:26:00-08:00"})
        self.write("matchday-posters.json", self.manifest)

    def add_poster(self, game):
        opponent = homepage.opponent(game)["name"]
        slug = homepage.re.sub(r"[^a-z0-9]+", "-", opponent.lower()).strip("-")
        key = game["date"] + "-" + slug
        path = "assets/matchday/" + key + ".webp"
        (self.root / path).parent.mkdir(parents=True, exist_ok=True)
        (self.root / path).write_bytes(b"poster fixture")
        self.manifest["fixtures"][key] = {"posters": [{"src": path, "style": "styled"}]}

    def build(self, today="2026-11-09"):
        return homepage.build(self.root, date.fromisoformat(today))

    def test_november_double_header_rolls_over_to_legends_in_initial_html(self):
        html = self.build()
        self.assertIn('data-match-date datetime="2026-11-14T19:30:00-08:00">Saturday, November 14', html)
        self.assertIn('data-team-name>Legends SC', html)
        self.assertIn('data-team-home data-side="home"', html)
        self.assertIn('data-match-time>7:30 PM PT', html)
        self.assertIn('data-match-venue>Fair Oaks Park Field 3', html)
        self.assertIn('data-poster-matchup>CalBlue FC <span>vs</span> Legends SC', html)
        self.assertIn('data-poster-date>Saturday, November 14', html)
        self.assertIn('2026-11-14-legends-sc.webp', html)
        self.assertNotIn("September 19", html)
        self.assertNotIn("2026-11-08", html)
        self.assertNotIn("South San Francisco AC", html)
        self.assertNotIn("Hunters", html)
        self.assertIn("Keep the rest of the website unchanged.", html)
        self.assertIn("Keep this footer.", html)

    def test_next_card_and_only_four_following_games_are_chronological_across_feeds(self):
        self.swpl += [fixture("2026-11-22", "Cup opponent", competition="SWPL Abronzino Cup"),
                      fixture("2026-12-05", "December opponent"), fixture("2026-12-12", "Beyond five")]
        self.nccsf += [fixture("2026-11-21", "South Bay FC", competition="NCCSF Fall League")]
        self.swpl.reverse()
        self.nccsf.reverse()
        self.write_feeds()
        html = self.build()
        self.assertEqual(html.count('<li class="is-'), 4)
        self.assertLess(html.index("Deep Shoreline"), html.index("South Bay FC"))
        self.assertLess(html.index("South Bay FC"), html.index("Cup opponent"))
        self.assertLess(html.index("Cup opponent"), html.index("December opponent"))
        self.assertNotIn("Beyond five", html)
        self.assertIn('data-fixture-toggle aria-expanded="false" hidden', html)

    def test_an_earlier_nccsf_match_can_precede_the_next_available_swpl_poster(self):
        self.nccsf.append(fixture("2026-11-10", "NCCSF next", competition="NCCSF Fall League"))
        self.write_feeds()
        html = self.build()
        schedule = html.split("<!-- homepage-schedule:start -->", 1)[1]
        self.assertIn('data-match-date datetime="2026-11-10', schedule)
        self.assertIn('data-match-link href="competition-nccsf.html"', schedule)
        self.assertIn('data-poster-date>Saturday, November 14', html)
        self.assertNotIn("Next match:", html)

    def test_no_future_games_hides_poster_and_preserves_browser_hooks(self):
        html = self.build("2027-01-01")
        self.assertIn('data-match-date>Schedule pending', html)
        self.assertIn('data-matchday-poster data-poster-style="" aria-labelledby="matchday-poster-title" hidden', html)
        self.assertIn("data-poster-image", html)
        self.assertIn("data-poster-link", html)
        self.assertIn("data-poster-date", html)
        self.assertIn("data-poster-matchup", html)
        self.assertNotIn("Legends SC", html)
        self.assertNotIn("September 19", html)

    def test_rescheduled_fixture_without_new_art_still_becomes_next_up(self):
        self.swpl = [fixture("2026-12-13", "Club Deportivo Oakland", home=False,
                             startsAt=None, timeLabel="TBA PT")]
        self.nccsf = []
        self.write_feeds()
        html = self.build("2026-12-12")
        self.assertIn('data-match-date datetime="2026-12-13">Sunday, December 13', html)
        self.assertIn('data-team-name>Club Deportivo Oakland', html)
        self.assertIn('data-match-time>TBA PT', html)
        self.assertIn('data-matchday-poster data-poster-style="" aria-labelledby="matchday-poster-title" hidden', html)
        self.assertNotIn("legends-sc.webp", html)
        self.assertNotIn("October 17", html)

    def test_initial_checked_stamp_uses_the_older_feed_and_preserves_timezone(self):
        self.write("nccsf.json", {"fixtures": self.nccsf, "checkedAt": "2026-11-09T17:01:00+00:00"})
        self.assertIn('data-swpl-checked>Schedules checked Nov 9, 9:01 AM PST', self.build())

    def test_tba_and_terminal_or_unrelated_rows_do_not_invent_the_next_game(self):
        self.swpl[1].update(startsAt=None, timeLabel="TBA PT")
        self.swpl += [fixture("2026-11-10", "Cancelled", status="cancelled"),
                      fixture("2026-11-11", "Completed", status="completed"),
                      fixture("bad-date", "Malformed")]
        unrelated = fixture("2026-11-12", "Another team")
        unrelated["home"] = {"name": "Not CalBlue"}
        self.swpl.append(unrelated)
        self.write_feeds()
        html = self.build()
        self.assertIn('data-match-date datetime="2026-11-14"', html)
        self.assertIn('data-match-time>TBA PT', html)
        self.assertIn('data-poster-kickoff>Kickoff TBA', html)
        for name in ("Cancelled", "Completed", "Malformed", "Another team"):
            self.assertNotIn(name, html)

    def test_text_is_escaped_and_unsafe_logo_or_poster_paths_are_omitted(self):
        self.swpl[1]["away"] = {"name": '<script>Legends & "friends"</script>', "logo": "javascript:alert(1)"}
        self.swpl[1]["venue"]["name"] = '<img src=x onerror="alert(1)">'
        self.add_poster(self.swpl[1])
        key = next(key for key in self.manifest["fixtures"] if "script-legends" in key)
        self.manifest["fixtures"][key]["posters"] = [{"src": "assets/matchday/../../private.webp"}]
        self.write_feeds()
        html = self.build()
        self.assertNotIn("<script>", html)
        self.assertNotIn("<img src=x", html)
        self.assertNotIn("javascript:", html)
        self.assertNotIn("private.webp", html)
        self.assertIn("&lt;script&gt;Legends &amp; &quot;friends&quot;&lt;/script&gt;", html)
        for logo in ("https://:test-password@example.test/crest.png",
                     "https://test-user:test-password@example.test/crest.png"):
            self.swpl[1]["away"]["logo"] = logo
            self.write_feeds()
            self.assertTrue(logo not in self.build(), "Credential-bearing crest URLs must not be embedded")

    def test_missing_or_duplicate_markers_stop_before_writing(self):
        for source in (TEMPLATE.replace("<!-- homepage-poster:start -->", ""),
                       TEMPLATE + "<!-- homepage-schedule:end -->"):
            (self.root / "index.html").write_text(source, encoding="utf-8")
            with redirect_stdout(io.StringIO()), mock.patch("sys.stderr", new=io.StringIO()):
                self.assertEqual(homepage.main(["--root", str(self.root), "--today", "2026-11-09"]), 1)
            self.assertEqual((self.root / "index.html").read_text(encoding="utf-8"), source)

    def test_generated_regions_are_deterministic_and_check_reports_drift(self):
        html = self.build()
        (self.root / "index.html").write_text(html, encoding="utf-8")
        self.assertEqual(self.build(), html)
        with redirect_stdout(io.StringIO()):
            self.assertEqual(homepage.main(["--root", str(self.root), "--today", "2026-11-09", "--check"]), 0)
            self.assertEqual(homepage.main(["--root", str(self.root), "--today", "2026-11-16", "--check"]), 1)

    def test_default_clock_selects_by_pacific_day_near_utc_midnight(self):
        self.swpl.append(fixture("2026-11-09", "Pacific today"))
        self.write_feeds()
        instant = datetime(2026, 11, 10, 0, 30, tzinfo=timezone.utc)

        class Clock:
            fromisoformat = staticmethod(datetime.fromisoformat)

            @staticmethod
            def now(zone):
                return instant.astimezone(zone)

        with mock.patch.object(homepage, "datetime", Clock), redirect_stdout(io.StringIO()):
            self.assertEqual(homepage.main(["--root", str(self.root)]), 0)
        html = (self.root / "index.html").read_text(encoding="utf-8")
        self.assertIn('data-match-date datetime="2026-11-09', html)
        self.assertIn('data-schedule-as-of="2026-11-09"', html)


if __name__ == "__main__":
    unittest.main()
