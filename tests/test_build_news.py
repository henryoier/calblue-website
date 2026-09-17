"""The club news builder merges results, galleries, posters, posts and Instagram into one dated feed."""

from datetime import date
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("build_news", ROOT / "scripts" / "build_news.py")
NEWS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(NEWS)

GALLERY = """
<section class="gallery-category" id="swpl-2026">
  <div class="gallery-category-heading"><div><p>League</p><h3 id="swpl-2026-heading">2026 SWPL Pacific Premier League</h3></div></div>
  <div class="album-list">
    <a class="album-card" href="gallery-swpl-sf-glens.html">
      <img src="https://cdn.example/gallery/swpl-sf-glens/thumb/026.jpg" alt="CalBlue team before the opener" loading="lazy" />
      <div class="album-card-copy"><span>September 13, 2026 • Season opener</span><h3>CalBlue vs SF Glens</h3><span class="album-card-meta"><span>99 photos</span><span>Complete album →</span></span></div>
    </a>
  </div>
</section>
<section class="gallery-category" id="kylin-2026">
  <div class="gallery-category-heading"><div><p>Tournament</p><h3 id="kylin-2026-heading">2026 Kylin Cup</h3></div></div>
  <a class="album-card" href="gallery-kylin-aurora.html">
    <img src="https://cdn.example/gallery/kylin-aurora/thumb/001.jpg" alt="Kylin Cup" loading="lazy" />
    <div class="album-card-copy"><span>September 5, 2026 • Group stage</span><h3>CalBlue vs New York Aurora</h3><span class="album-card-meta"><span>44 photos</span><span>6 videos →</span></span></div>
  </a>
</section>
"""
CALBLUE = {"name": "CalBlue FC"}
GLENS = {"name": "SF Glens"}
BAU = {"name": "Bay Area United"}


def fixture(fid, day, home, away, **extra):
    return {"id": fid, "date": day, "startsAt": f"{day}T19:30:00-07:00", "timeLabel": "7:30 pm PT", "competition": "League",
            "home": home, "away": away, "venue": {"name": "Fair Oaks Park Field 3"}, "status": "scheduled", **extra}


class BuildNewsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "data").mkdir()
        (self.root / "gallery.html").write_text(GALLERY, encoding="utf-8")
        self.write("data/swpl.json", {
            "fixtures": [fixture("f1", "2026-09-19", CALBLUE, BAU), fixture("f2", "2026-10-03", {"name": "Albion SC"}, CALBLUE)],
            "results": [dict(fixture("r1", "2026-09-13", CALBLUE, GLENS, status="completed", score={"home": 3, "away": 2},
                                     venue={"name": "Central Park Soccer Field"}))],
        })
        self.write("data/nccsf.json", {
            "fixtures": [],
            "results": [dict(fixture("n1", "2026-09-12", {"name": "GSF United"}, {"name": "CalBlue"}, competition="2026 NCCSF Fall League",
                                     status="completed", score={"home": 1, "away": 6}, venue={"name": "Nordvik Park"}))],
        })
        self.write("data/matchday-posters.json", {"fixtures": {
            "2026-09-19-bay-area-united": {"date": "2026-09-19", "storylines": ["Luca's farewell game"],
                                            "posters": [{"src": "assets/matchday/x-styled.webp", "style": "styled"}, {"src": "assets/matchday/x-classic.webp", "style": "classic"}]},
            "2026-10-03-albion-sc": {"date": "2026-10-03", "posters": [{"src": "assets/matchday/y-styled.webp", "style": "styled"}]},
        }})
        self.write("data/news-posts.json", {"posts": [{"slug": "welcome", "date": "2026-09-15", "title": "Welcome to the new season",
                                                        "summary": "A short intro.", "body": ["Paragraph one.", "Paragraph two."]}]})
        self.write("data/instagram.json", {"items": [
            {"id": "ABC123", "permalink": "https://www.instagram.com/p/ABC123/", "timestamp": "2026-09-14T20:00:00+00:00",
             "caption": "Three points on opening night!\nWhat a start to the SWPL season.", "image": "assets/news/instagram/ABC123.jpg"},
            {"id": "BAD", "permalink": "https://www.instagram.com/p/BAD/", "timestamp": "", "caption": "no date", "image": "x.jpg"},
        ]})

        self.write("data/roster-history.json", {"players": {
            "swpl:sheng qin": {"name": "Sheng Qin", "league": "swpl", "firstSeen": "2026-09-13", "seeded": True},
            "swpl:zheng chang": {"name": "Zheng Chang", "league": "swpl", "firstSeen": "2026-09-16", "seeded": False, "photo": "https://x/zc.jpg"},
            "swpl:kevin yu": {"name": "Kevin Yu", "league": "swpl", "firstSeen": "2026-09-16", "seeded": False},
            "nccsf:lu fang": {"name": "Lu Fang", "league": "nccsf", "firstSeen": "2026-09-16", "seeded": False},
        }})

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, rel, payload):
        (self.root / rel).write_text(json.dumps(payload), encoding="utf-8")

    def build(self, today="2026-09-16"):
        return NEWS.build(self.root, date.fromisoformat(today))

    def by(self, feed, category):
        return [item for item in feed["items"] if item["category"] == category]

    def test_results_become_cards_with_outcome_and_matching_album(self):
        feed = self.build()
        results = self.by(feed, "Result")
        self.assertEqual([r["title"] for r in results], ["CalBlue 3-2 SF Glens", "CalBlue 6-1 GSF United"])
        glens = results[0]
        self.assertEqual(glens["outcome"], "Win")
        self.assertEqual(glens["href"], "gallery-swpl-sf-glens.html", "a result on a gallery date links to that album")
        self.assertTrue(glens["image"].endswith("swpl-sf-glens/thumb/026.jpg"))
        self.assertIn("SWPL Pacific Premier League", glens["summary"])
        nccsf = results[1]
        self.assertEqual(nccsf["href"], "competition-nccsf.html")
        self.assertIn("Away", nccsf["summary"])

    def test_gallery_cards_carry_competition_and_count(self):
        feed = self.build()
        galleries = self.by(feed, "Gallery")
        self.assertEqual([g["title"] for g in galleries], ["Photos: CalBlue vs SF Glens", "Photos: CalBlue vs New York Aurora"])
        self.assertEqual(galleries[1]["summary"], "44 photos · 2026 Kylin Cup · Group stage")

    def test_only_the_next_fixture_with_a_poster_is_previewed(self):
        feed = self.build()
        previews = self.by(feed, "Match day")
        self.assertEqual(len(previews), 1)
        self.assertEqual(previews[0]["title"], "Match day: CalBlue FC vs Bay Area United")
        self.assertIn("Luca's farewell game", previews[0]["summary"])
        self.assertEqual(previews[0]["image"], "assets/matchday/x-styled.webp")
        later = self.build(today="2026-09-20")
        self.assertEqual(self.by(later, "Match day")[0]["title"], "Match day: Albion SC vs CalBlue FC", "after the game the next poster takes over")

    def test_posts_and_instagram_are_included_and_undated_posts_dropped(self):
        feed = self.build()
        posts = self.by(feed, "Club")
        self.assertEqual(posts[0]["href"], "news.html?post=welcome")
        self.assertEqual(posts[0]["body"], ["Paragraph one.", "Paragraph two."])
        insta = self.by(feed, "Instagram")
        self.assertEqual(len(insta), 1)
        self.assertEqual(insta[0]["title"], "Three points on opening night!")
        self.assertTrue(insta[0]["external"])

    def test_feed_is_newest_first_with_unique_slugs(self):
        feed = self.build()
        dates = [item["date"] for item in feed["items"]]
        self.assertEqual(dates, sorted(dates, reverse=True))
        slugs = [item["slug"] for item in feed["items"]]
        self.assertEqual(len(slugs), len(set(slugs)))
        self.assertEqual(feed["items"][0]["category"], "Match day", "the upcoming preview leads the feed")

    def test_new_roster_players_become_squad_cards_per_league_and_day(self):
        feed = self.build()
        squad = self.by(feed, "Squad")
        self.assertEqual([s["title"] for s in squad], ["2 new faces on the SWPL roster", "1 new face on the NCCSF roster"], "SWPL leads when cards share a day")
        swpl = squad[0]
        self.assertEqual(swpl["summary"], "Welcome Kevin Yu and Zheng Chang, now registered for the SWPL Pacific Premier League.")
        self.assertEqual(swpl["image"], "https://x/zc.jpg", "a new player's photo fronts the card when one exists")
        self.assertEqual([(p["name"], p["photo"]) for p in swpl["players"]], [("Kevin Yu", "assets/calblue-logo-web.jpg"), ("Zheng Chang", "https://x/zc.jpg")], "every new player is listed with a portrait, club crest when none is published")
        self.assertEqual(swpl["href"], "competition-swpl.html#roster")
        self.assertNotIn("Sheng Qin", json.dumps(squad), "the seeded season squad is never announced as new")

    def test_missing_sources_do_not_break_the_build(self):
        for name in ("data/instagram.json", "data/news-posts.json", "data/matchday-posters.json", "data/nccsf.json", "data/roster-history.json"):
            (self.root / name).unlink()
        feed = self.build()
        self.assertEqual({item["category"] for item in feed["items"]}, {"Result", "Gallery"})

    def test_repository_feed_is_current(self):
        """data/news.json in the repository must match a fresh build of the committed sources."""
        committed = json.loads((ROOT / "data" / "news.json").read_text(encoding="utf-8"))
        fresh = NEWS.build(ROOT, date.fromisoformat(committed["today"]))
        self.assertEqual(committed["items"], fresh["items"], "run python3 scripts/build_news.py")


if __name__ == "__main__":
    unittest.main()
