"""Offline artifact checks only; these do not execute PostgreSQL or prove billing semantics."""

import hashlib
from pathlib import Path
import re
import unittest

from scripts import check_sql


ROOT = Path(__file__).resolve().parents[1]


class MoneyArtifactTest(unittest.TestCase):
    def test_released_core_migration_is_unchanged(self):
        # 0001 was applied in the owner's scratch project and merged in PR #79.
        # Changes to released schemas belong in subsequent migrations.
        core = (ROOT / "supabase/migrations/0001_core.sql").read_bytes()
        self.assertEqual(hashlib.sha256(core).hexdigest(),
                         "140466986aa886b33767c951fbe5f265884d4bde6e44484e94a77599badb2668")

    def test_money_smoke_scripts_are_single_rollback_transactions(self):
        for name, isolation in (("0002_money_smoke.sql", "read committed"),
                                ("0002_money_isolation_smoke.sql", "repeatable read")):
            with self.subTest(name=name):
                sql = (ROOT / "supabase/tests" / name).read_text()
                scan = check_sql.scan_sql(sql)
                self.assertEqual(scan.problems, [])
                statements = [statement.strip().lower()
                              for _, _, statement in check_sql.statements(scan)]
                self.assertEqual(statements[0], "begin isolation level " + isolation)
                self.assertEqual(statements[-1], "rollback")
                self.assertFalse(any(re.match(r"(?:begin|commit|rollback|start transaction)\b", statement)
                                     for statement in statements[1:-1]))
                # The lexer hides function/DO bodies, so inspect their balanced
                # delimiters separately without pretending to parse PL/pgSQL.
                for _, _, body in scan.bodies:
                    body_scan = check_sql.scan_sql(body)
                    self.assertEqual(body_scan.problems, [])
                    problems = []
                    check_sql.check_parens(name, body_scan.clean, problems)
                    self.assertEqual(problems, [])

    def test_money_guide_uses_existing_core_and_keeps_runtime_checks_pending(self):
        guide = (ROOT / "supabase/0002-money.md").read_text()
        self.assertIn("Do not rerun 0001", guide)
        self.assertIn("0002_money_smoke.sql: not run", guide)
        self.assertIn("Two-session concurrency: not tested", guide)
        self.assertIn("sequence numbers may advance", guide)


if __name__ == "__main__":
    unittest.main()
