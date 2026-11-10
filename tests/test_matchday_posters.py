"""The match-day poster manifest must stay consistent with the SWPL schedule and the shipped image files."""

import json
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]


def slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


class MatchdayPosterManifestTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manifest = json.loads((ROOT / "data" / "matchday-posters.json").read_text(encoding="utf-8"))
        cls.swpl = json.loads((ROOT / "data" / "swpl.json").read_text(encoding="utf-8"))

    def test_schema(self):
        self.assertEqual(self.manifest["schemaVersion"], 1)
        self.assertIsInstance(self.manifest["fixtures"], dict)
        self.assertTrue(self.manifest["fixtures"], "manifest lists no fixtures")

    def test_every_entry_has_two_existing_posters(self):
        entries = {**self.manifest.get("archivedFixtures", {}), **self.manifest["fixtures"]}
        for key, entry in entries.items():
            posters = entry["posters"]
            self.assertEqual(len(posters), 2, f"{key}: expected two designs to rotate between")
            self.assertEqual({p["style"] for p in posters}, {"styled", "classic"}, key)
            for poster in posters:
                path = ROOT / poster["src"]
                self.assertTrue(path.is_file(), f"{key}: missing {poster['src']}")
                self.assertTrue(poster["src"].endswith(".webp"), f"{key}: posters ship as WebP")
                self.assertLess(path.stat().st_size, 700_000, f"{key}: {poster['src']} is too large for the homepage")
                self.assertEqual((poster["width"], poster["height"]), (1296, 1616), key)

    @staticmethod
    def key_for(fixture):
        opponent = fixture["away"] if fixture["home"]["name"].startswith("CalBlue") else fixture["home"]
        return f"{fixture['date']}-{slug(opponent['name'])}"

    def test_keys_match_schedule_fixtures(self):
        """Active artwork must match a published game; new fixtures can await artwork."""
        upcoming = {self.key_for(f): f for f in self.swpl["fixtures"]}
        played = {self.key_for(f): f for f in self.swpl.get("results", [])}
        known = {**played, **upcoming}
        for key, entry in self.manifest["fixtures"].items():
            self.assertIn(key, known, f"{key}: no such game in data/swpl.json (schedule changed? regenerate and re-key posters)")
            self.assertEqual(entry["date"], known[key]["date"], key)

    def test_rescheduled_artwork_is_archived_without_claiming_the_new_fixture(self):
        archived = self.manifest.get("archivedFixtures", {})
        self.assertFalse(set(archived) & set(self.manifest["fixtures"]),
                         "Archived posters must not be selected as active fixture artwork")
        self.assertIn("2026-10-17-club-deportivo-oakland", archived)
        replacement = self.manifest["fixtures"].get("2026-12-13-club-deportivo-oakland")
        if replacement:
            old_images = {p["src"] for p in archived["2026-10-17-club-deportivo-oakland"]["posters"]}
            self.assertTrue(old_images.isdisjoint(p["src"] for p in replacement["posters"]),
                            "December 13 artwork must not reuse the poster that prints October 17")


if __name__ == "__main__":
    unittest.main()
