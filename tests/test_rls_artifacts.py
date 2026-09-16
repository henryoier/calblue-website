"""Offline artifact checks, not PostgreSQL execution or proof of authorization."""

import hashlib
from pathlib import Path
import re
import unittest

from scripts import check_sql


ROOT = Path(__file__).resolve().parents[1]


class RlsArtifactTest(unittest.TestCase):
    def test_released_migrations_remain_unchanged(self):
        released = {
            "0001_core.sql": "140466986aa886b33767c951fbe5f265884d4bde6e44484e94a77599badb2668",
            "0002_money.sql": "a9faa4f25bfda89c5bf616cfe4b72008d9b994e219c2501db7362868bec4bad3",
        }
        for name, digest in released.items():
            with self.subTest(name=name):
                self.assertEqual(hashlib.sha256((ROOT / "supabase/migrations" / name).read_bytes()).hexdigest(), digest)

    def test_rls_smoke_scripts_are_single_rollback_transactions(self):
        for name in ("0003_rls_smoke.sql", "0003_rls_jwt_smoke.sql"):
            with self.subTest(name=name):
                sql = (ROOT / "supabase/tests" / name).read_text()
                scan = check_sql.scan_sql(sql)
                self.assertEqual(scan.problems, [])
                parts = [statement.strip().lower() for _, _, statement in check_sql.statements(scan)]
                self.assertEqual(parts[0], "begin isolation level read committed")
                self.assertEqual(parts[-1], "rollback")
                self.assertFalse(any(re.match(r"(?:begin|commit|rollback|start transaction)\b", part)
                                     for part in parts[1:-1]))
                # Inspect delimiters inside DO/function bodies as well, without
                # pretending this lexer is a PL/pgSQL parser or a runtime test.
                for _, _, body in scan.bodies:
                    nested = check_sql.scan_sql(body)
                    self.assertEqual(nested.problems, [])
                    problems = []
                    check_sql.check_parens(name, nested.clean, problems)
                    self.assertEqual(problems, [])
                self.assertIn("SECURITY INVOKER", sql)
                self.assertNotIn("SECURITY DEFINER", sql)


if __name__ == "__main__":
    unittest.main()
