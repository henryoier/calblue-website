"""Offline issue32 artifacts and negative checks, not PostgreSQL execution."""

import hashlib
from pathlib import Path
import re
import unittest

from scripts import build_migrations, check_sql


ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "supabase/migrations"
NAME = "0004_player_verification.sql"


class PlayerVerificationArtifactTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sql = (MIGRATIONS / NAME).read_text()

    def findings(self, sql):
        problems = []
        check_sql.verification_checks(check_sql.scan_sql(sql), problems)
        return problems

    def assert_rejected(self, original, replacement, expected):
        self.assertIn(original, self.sql)
        changed = self.sql.replace(original, replacement)
        self.assertIn(expected, "\n".join(self.findings(changed)))

    def test_released_migrations_remain_byte_identical(self):
        released = {
            "0001_core.sql": "140466986aa886b33767c951fbe5f265884d4bde6e44484e94a77599badb2668",
            "0002_money.sql": "a9faa4f25bfda89c5bf616cfe4b72008d9b994e219c2501db7362868bec4bad3",
            "0003_rls.sql": "f20c2464f946f6c7209142120a8618330a65d3dc4ba4efc0af622088c3b9946b",
        }
        for name, digest in released.items():
            with self.subTest(name=name):
                self.assertEqual(hashlib.sha256((MIGRATIONS / name).read_bytes()).hexdigest(), digest)

    def test_generated_migrations_and_full_checks_match(self):
        generated = build_migrations.build()
        self.assertEqual(tuple(generated), check_sql.LANDED_TARGETS)
        self.assertEqual(generated[NAME], self.sql)
        self.assertEqual(check_sql.check_migrations(generated), [])
        self.assertEqual(self.findings(self.sql), [])

    def test_private_fields_cannot_enter_rpc_projection(self):
        self.assert_rejected("returns table(id uuid, display_name text, legal_name text,",
                             "returns table(id uuid, medical_notes text, legal_name text,",
                             "nine safe verification columns")

    def test_admin_gate_must_be_executable_and_has_no_owner_bypass(self):
        gate = "if auth.uid() is null or public.is_admin() is not true then"
        self.assert_rejected(gate, "-- " + gate + "\n  if false then", "fail-closed JWT admin")
        self.assert_rejected(gate, gate + "\n    perform current_user;", "must not authorize")

    def test_function_security_modes_and_search_path_are_checked(self):
        mutations = (
            ("language plpgsql stable security invoker", "language plpgsql stable security definer", "SECURITY INVOKER"),
            ("language plpgsql security invoker", "language plpgsql security definer", "SECURITY INVOKER"),
            ("set search_path = ''", "set search_path = public", "fixed empty search_path"),
        )
        for original, replacement, expected in mutations:
            with self.subTest(expected=expected, original=original):
                self.assert_rejected(original, replacement, expected)

    def test_acl_remains_two_authenticated_rpcs_only(self):
        revoke = "revoke all on function public.guard_player_verification_decision() from public, anon, authenticated;"
        self.assert_rejected(revoke, "-- " + revoke, "must revoke PUBLIC/anon/authenticated")
        self.assert_rejected(" to authenticated;", " to anon, authenticated;", "only the two authenticated")
        self.assertTrue(self.findings(self.sql.replace("COMMIT;", "grant select on public.players to anon;\nCOMMIT;")))

    def test_guard_stamps_and_insert_versions_cannot_be_comments(self):
        for statement, expected in (
            ("new.decided_by := actor;", "trusted reviewer stamp"),
            ("new.decided_at := statement_timestamp();", "trusted decision timestamp"),
            ("new.updated_at := statement_timestamp();", "insert version normalization"),
        ):
            with self.subTest(expected=expected):
                self.assert_rejected(statement, "-- " + statement, expected)

    def test_atomic_decision_shape_is_checked(self):
        for original, replacement, expected in (
            ("perform public.lock_billing();", "-- perform public.lock_billing();", "billing lock must precede"),
            ("p.updated_at = wanted.expected_at", "true", "optimistic version comparison"),
            ("requested not between 1 and 50", "requested < 1", "bounded batch size"),
            ("get diagnostics affected = row_count;", "-- get diagnostics affected = row_count;", "affected-row assertion"),
            ("if affected <> requested then", "if false then", "all-or-nothing result check"),
        ):
            with self.subTest(expected=expected):
                self.assert_rejected(original, replacement, expected)

    def test_queue_is_bounded_stable_and_literal(self):
        self.assert_rejected("limit 51 offset p_offset", "limit 500 offset p_offset", "51-row pagination")
        self.assert_rejected("strpos(lower(p.display_name), needle) > 0",
                             "lower(p.display_name) ilike needle", "search must stay literal")

    def test_smokes_are_single_rollback_transactions_with_balanced_bodies(self):
        for filename, isolation in (
            ("0004_player_verification_smoke.sql", "read committed"),
            ("0004_player_verification_isolation_smoke.sql", "repeatable read"),
        ):
            with self.subTest(filename=filename):
                sql = (ROOT / "supabase/tests" / filename).read_text()
                scan = check_sql.scan_sql(sql)
                self.assertEqual(scan.problems, [])
                parts = [part.strip().lower() for _, _, part in check_sql.statements(scan)]
                self.assertEqual(parts[0], "begin isolation level " + isolation)
                self.assertEqual(parts[-1], "rollback")
                self.assertFalse(any(re.match(r"(?:begin|commit|rollback|start\s+transaction)\b", part)
                                     for part in parts[1:-1]))
                for _, _, body in scan.bodies:
                    nested = check_sql.scan_sql(body)
                    self.assertEqual(nested.problems, [])
                    problems = []
                    check_sql.check_parens(filename, nested.clean, problems)
                    self.assertEqual(problems, [])
                self.assertNotIn("SECURITY DEFINER", sql)

    def test_main_smoke_guards_empty_scratch_before_synthetic_fixtures(self):
        sql = (ROOT / "supabase/tests/0004_player_verification_smoke.sql").read_text()
        self.assertLess(sql.index("empty scratch Auth users"), sql.index("INSERT INTO auth.users"))
        self.assertLess(sql.index("empty scratch ' || relation_name"), sql.index("INSERT INTO auth.users"))
        for coverage in (
            "SET LOCAL ROLE anon", "SET LOCAL ROLE authenticated", "verification_metadata_forbidden",
            "client insert timestamp normalized", "missing batch member rolls back every decision",
            "ordinary owner and guardian edits preserve decision metadata",
            "ordinary guardian edit preserves unknown legacy decision",
            "direct admin rejection stamps and trims", "verification_conflict",
        ):
            self.assertIn(coverage, sql)


if __name__ == "__main__":
    unittest.main()
