"""Offline seed artifact checks; no PostgreSQL execution or idempotency claim."""

import hashlib
from pathlib import Path
import re
import unittest

from scripts import check_sql


ROOT = Path(__file__).resolve().parents[1]


class SeedArtifactTest(unittest.TestCase):
    def test_all_released_migrations_remain_unchanged(self):
        for name, digest in {
            "0001_core.sql": "140466986aa886b33767c951fbe5f265884d4bde6e44484e94a77599badb2668",
            "0002_money.sql": "a9faa4f25bfda89c5bf616cfe4b72008d9b994e219c2501db7362868bec4bad3",
            "0003_rls.sql": "f20c2464f946f6c7209142120a8618330a65d3dc4ba4efc0af622088c3b9946b",
        }.items():
            with self.subTest(name=name):
                self.assertEqual(hashlib.sha256((ROOT / "supabase/migrations" / name).read_bytes()).hexdigest(), digest)

    def test_verification_is_explicitly_read_only(self):
        sql = (ROOT / "supabase/tests/seed_verify.sql").read_text()
        scan = check_sql.scan_sql(sql)
        self.assertEqual(scan.problems, [])
        statements = [part.strip().lower() for _, _, part in check_sql.statements(scan)]
        self.assertEqual(statements[0], "begin isolation level repeatable read read only")
        self.assertEqual(statements[-1], "commit")
        for part in statements[1:-1]:
            self.assertFalse(re.match(r"(?:begin|commit|rollback|insert|update|delete|truncate|drop|create|alter|grant|revoke)\b", part), part)
        for _, _, body in scan.bodies:
            nested = check_sql.scan_sql(body)
            self.assertEqual(nested.problems, [])
            self.assertFalse(re.search(r"\b(?:insert\s+into|update\s+public\.|delete\s+from|truncate\s+table)\b", nested.clean))
            problems = []
            check_sql.check_parens("seed_verify.sql", nested.clean, problems)
            self.assertEqual(problems, [])
        self.assertIn("AS dataset_fingerprint", sql)
        self.assertIn("public.audit_log_id_seq", sql)
        self.assertIn("FROM auth.users", sql)
        # Sequences have no composite row type; whole-row to_jsonb(seq) fails.
        self.assertRegex(sql, r"'audit_sequence',\(SELECT jsonb_build_object\(\s*"
                         r"'last_value',last_value,'log_cnt',log_cnt,'is_called',is_called\)\s*"
                         r"FROM public\.audit_log_id_seq\)")

    def test_guide_distinguishes_persistent_seed_and_read_only_verification(self):
        guide = (ROOT / "supabase/seed.md").read_text()
        self.assertIn("commits persistent demo rows", guide)
        self.assertIn("disposable-demo-only", guide)
        self.assertIn("exactly match", guide)
        self.assertIn("Do not rerun any migration", guide)
        self.assertIn("Second opted-in seed.sql run: not run", guide)
        self.assertIn("does not supply destructive cleanup/reset SQL", guide)


if __name__ == "__main__":
    unittest.main()
