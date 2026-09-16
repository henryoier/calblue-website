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
        for key, entry in self.manifest["fixtures"].items():
            posters = entry["posters"]
            self.assertEqual(len(posters), 2, f"{key}: expected two designs to rotate between")
            self.assertEqual({p["style"] for p in posters}, {"styled", "classic"}, key)
            for poster in posters:
                path = ROOT / poster["src"]
                self.assertTrue(path.is_file(), f"{key}: missing {poster['src']}")
                self.assertTrue(poster["src"].endswith(".webp"), f"{key}: posters ship as WebP")
                self.assertLess(path.stat().st_size, 700_000, f"{key}: {poster['src']} is too large for the homepage")
                self.assertEqual((poster["width"], poster["height"]), (1296, 1616), key)

    def test_keys_match_schedule_fixtures(self):
        expected = {}
        for fixture in self.swpl["fixtures"]:
            opponent = fixture["away"] if fixture["home"]["name"].startswith("CalBlue") else fixture["home"]
            expected[f"{fixture['date']}-{slug(opponent['name'])}"] = fixture
        for key, entry in self.manifest["fixtures"].items():
            self.assertIn(key, expected, f"{key}: no such fixture in data/swpl.json (schedule changed? regenerate posters)")
            self.assertEqual(entry["date"], expected[key]["date"], key)
        missing = sorted(set(expected) - set(self.manifest["fixtures"]))
        self.assertEqual(missing, [], f"upcoming SWPL fixtures without posters: {missing}")


if __name__ == "__main__":
    unittest.main()
