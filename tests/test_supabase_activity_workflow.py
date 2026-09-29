"""Offline contracts for our small workflow/config; not a general YAML parser."""

import json
from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[1]


class SupabaseActivityWorkflowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workflow = (ROOT / ".github/workflows/supabase-activity.yml").read_text()
        cls.config = json.loads((ROOT / ".github/supabase-activity.json").read_text())

    def test_only_daily_schedule_and_manual_dispatch_generate_traffic(self):
        events = self.workflow.split("on:\n", 1)[1].split("\npermissions:", 1)[0]
        self.assertEqual(re.findall(r"^  ([a-z_]+):", events, re.M),
                         ["schedule", "workflow_dispatch"])
        self.assertEqual(re.findall(r"cron: '([^']+)'", events), ["23 16 * * *"])

    def test_job_is_read_only_bounded_and_excludes_forks(self):
        permissions = self.workflow.split("permissions:\n", 1)[1].split("\nconcurrency:", 1)[0]
        self.assertEqual(permissions.strip(), "contents: read")
        self.assertIn("if: github.repository == 'henryoier/calblue-website'", self.workflow)
        self.assertIn("timeout-minutes: 5", self.workflow)
        self.assertIn("group: supabase-daily-activity", self.workflow)
        self.assertIn("cancel-in-progress: false", self.workflow)
        self.assertNotIn("continue-on-error:", self.workflow)

    def test_workflow_only_checks_out_source_and_runs_reviewed_checker(self):
        self.assertEqual(re.findall(r"^\s+uses: (.+)$", self.workflow, re.M),
                         ["actions/checkout@v4"])
        self.assertIn("persist-credentials: false", self.workflow)
        self.assertEqual(re.findall(r"^\s+run: (.+)$", self.workflow, re.M),
                         ["python3 -B scripts/check_supabase_activity.py"])
        self.assertNotIn("secrets.", self.workflow)
        self.assertNotIn("env:", self.workflow)

    def test_config_contains_only_the_two_approved_public_key_targets(self):
        self.assertEqual(set(self.config), {"projects"})
        self.assertEqual(len(self.config["projects"]), 2)
        self.assertEqual([(p["label"], p["ref"]) for p in self.config["projects"]], [
            ("website", "rmksoklavpoartewjvus"),
            ("verification-test", "njsprzewuxmrfpgwktmf"),
        ])
        for project in self.config["projects"]:
            self.assertEqual(set(project), {"label", "ref", "publishable_key"})
            self.assertTrue(bool(re.fullmatch(r"sb_publishable_[A-Za-z0-9_-]{16,128}", project["publishable_key"])),
                            "Project key must be a publishable key; value withheld")

    def test_website_target_matches_the_existing_public_app_configuration(self):
        source = (ROOT / "app/config.js").read_text()
        url = re.search(r'SUPABASE_URL = "([^"]+)"', source)[1]
        key = re.search(r'SUPABASE_ANON_KEY = "([^"]+)"', source)[1]
        project = self.config["projects"][0]
        self.assertEqual(url, f"https://{project['ref']}.supabase.co")
        self.assertTrue(key == project["publishable_key"],
                        "Website publishable key differs from app/config.js; values withheld")


if __name__ == "__main__":
    unittest.main()
