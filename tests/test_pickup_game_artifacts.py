"""Offline issue33 contracts, not a PostgreSQL parser or execution substitute."""

import hashlib
from pathlib import Path
import re
import unittest

from scripts import build_migrations, check_sql


ROOT = Path(__file__).resolve().parents[1]
NAME = "0005_pickup_games.sql"
SAFE_COLUMNS = (
    "id", "team_id", "venue_id", "title", "field_label", "timezone", "gather_time",
    "start_time", "end_time", "game_date", "capacity", "registration_opens_at",
    "registration_closes_at", "kit_color", "notes", "fee_override", "status",
    "cancellation_reason", "updated_at", "created_at",
)


class PickupGameArtifactTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sql = (ROOT / "supabase/migrations" / NAME).read_text()
        cls.scan = check_sql.scan_sql(cls.sql)
        cls.bodies = {}
        cls.declarations = {}
        for start, end, statement in check_sql.statements(cls.scan):
            function = check_sql.matches(check_sql.FUNCTION, statement)
            if function:
                position, _, body = next(item for item in cls.scan.bodies if start <= item[0] < end)
                cls.bodies[function[1]] = check_sql.scan_sql(body)
                cls.declarations[function[1]] = cls.scan.comments_removed[start:position]

    def code(self, name, strings=False):
        body = self.bodies[name]
        return re.sub(r"\s+", " ", body.comments_removed if strings else body.clean).lower()

    def test_released_migrations_remain_byte_identical(self):
        released = {
            "0001_core.sql": "140466986aa886b33767c951fbe5f265884d4bde6e44484e94a77599badb2668",
            "0002_money.sql": "a9faa4f25bfda89c5bf616cfe4b72008d9b994e219c2501db7362868bec4bad3",
            "0003_rls.sql": "f20c2464f946f6c7209142120a8618330a65d3dc4ba4efc0af622088c3b9946b",
            "0004_player_verification.sql": "43d226a01ba88a1731d5c673273e426f29217453f533272a503925aec5339d4b",
        }
        for name, digest in released.items():
            with self.subTest(name=name):
                self.assertEqual(hashlib.sha256((ROOT / "supabase/migrations" / name).read_bytes()).hexdigest(), digest)

    def test_generator_and_linter_match_five_landed_migrations(self):
        generated = build_migrations.build()
        self.assertEqual(len(generated), 5)
        self.assertEqual(generated[NAME], self.sql)
        self.assertEqual(check_sql.check_migrations(generated), [])
        self.assertEqual(build_migrations.PLAN[NAME][1], [12])

    def test_all_three_row_rpcs_return_only_twenty_game_fields(self):
        for name in ("list_pickup_games", "save_pickup_game", "transition_pickup_game"):
            with self.subTest(name=name):
                declaration = self.declarations[name]
                projection = re.search(r"returns\s+table\((.*?)\)\s*language", declaration, re.I | re.S)[1]
                self.assertEqual(tuple(field.strip().split()[0] for field in projection.split(",")), SAFE_COLUMNS)
                self.assertNotRegex(self.code(name), r"\b(?:public\.players|medical_notes|emergency_contact_phone)\b")

    def test_scope_is_explicit_calblue_team_organiser_not_global_developer(self):
        body = self.code("can_manage_pickup_team", strings=True)
        for required in ("auth.uid() is not null", "public.is_admin()", "r.role = 'organiser'",
                         "r.team_id = p_team_id", "r.account_id = auth.uid()", "c.is_us"):
            self.assertIn(required, body)
        self.assertNotIn("developer", body)
        self.assertNotIn("competition_id", body)
        self.assertNotIn("manages_game", body)

    def test_every_public_rpc_checks_auth_and_scope_before_private_access(self):
        for name in ("pickup_game_options", "list_pickup_games", "save_pickup_game", "transition_pickup_game"):
            body = self.code(name)
            with self.subTest(name=name):
                self.assertIn("if auth.uid() is null or not (public.is_admin() or exists", body)
                self.assertIn("public.can_manage_pickup_team(t.id)", body)
                self.assertIn("from public.profiles p where p.id = auth.uid()", body)
                self.assertNotIn("current_user", body)

    def test_write_lock_precedes_profiles_and_game_rows(self):
        for name in ("save_pickup_game", "transition_pickup_game"):
            body = self.code(name)
            with self.subTest(name=name):
                lock = body.index("perform public.lock_billing();")
                self.assertLess(lock, body.index("from public.profiles"))
                self.assertLess(lock, body.index("for update"))
                self.assertIn("previous.updated_at is distinct from p_expected_updated_at", body)
                self.assertIn("g.updated_at = p_expected_updated_at", body)
                self.assertIn("get diagnostics affected = row_count;", body)
                self.assertIn("if affected <> 1", body)
                self.assertIn("public.can_manage_pickup_team(previous.team_id) is not true", body)
                self.assertIn("previous.attendance_locked_at is not null", body)
                self.assertIn("from public.charges c where c.game_id = p_game_id", body)

    def test_validator_has_strict_shape_types_lengths_and_dates(self):
        body = self.code("validate_pickup_game_details", strings=True)
        for required in ("jsonb_typeof(p_details) is distinct from 'object'", "p_details ?& required_keys",
                         "jsonb_object_keys(p_details)", "required_keys || array['fee_override']",
                         "not isfinite(parsed_time)", "not between 1 and 9999",
                         "invalid_time_zone_displacement_value", "from pg_catalog.pg_timezone_names",
                         "from public.venues v where v.id = result.venue_id for share",
                         "result.timezone := value", "result.gather_time > result.start_time",
                         "result.end_time <= result.start_time", "result.registration_opens_at > result.registration_closes_at",
                         "char_length(result.title) > 200", "char_length(result.field_label) > 200",
                         "char_length(result.kit_color) > 100", "char_length(result.notes) > 4000",
                         "not between 1 and 10000", "99999999.99"):
            with self.subTest(required=required):
                self.assertIn(required, body)
        self.assertLess(body.index("jsonb_object_keys(p_details)"), body.index("jsonb_populate_record"))

    def test_fee_omission_preserves_and_organisers_cannot_supply_fee(self):
        body = self.code("save_pickup_game", strings=True)
        self.assertIn("public.is_admin() is not true and p_details ? 'fee_override'", body)
        self.assertIn("fee_override=case when p_details ? 'fee_override' then details.fee_override else g.fee_override end", body)
        self.assertIn("public.can_manage_pickup_team(details.team_id) is not true", body)
        self.assertIn("where t.id = details.team_id and c.is_us for share of t,c", body)
        self.assertNotRegex(body, r"\b(?:upsert|on conflict|delete from)\b")

    def test_occupancy_guard_and_cancel_do_not_mutate_registrations_or_charges(self):
        body = self.code("save_pickup_game", strings=True)
        self.assertIn("details.capacity < (select count(*) from public.game_registrations", body)
        self.assertIn("r.status = 'registered' and r.participation in ('player','keeper')", body)
        for name in ("save_pickup_game", "transition_pickup_game"):
            self.assertNotRegex(self.code(name), r"\b(?:insert\s+into|update|delete\s+from)\s+public\.(?:charges|game_registrations)\b")

    def test_transition_matrix_and_nonblank_bounded_reason(self):
        body = self.code("transition_pickup_game", strings=True)
        for required in ("p_action not in ('publish','close','cancel')", "char_length(reason) > 2000",
                         "p_action = 'cancel' and reason is null", "'^[[:space:]]+|[[:space:]]+$'",
                         "p_action = 'publish' and previous.status = 'draft' and previous.start_time > statement_timestamp()",
                         "p_action = 'close' and previous.status = 'published'",
                         "p_action = 'cancel' and previous.status in ('draft','published','reg_closed')"):
            self.assertIn(required, body)
        self.assertIn("if p_action = 'publish' then", body)
        self.assertIn("validated := public.validate_pickup_game_details(jsonb_build_object(", body)
        self.assertIn("is distinct from (previous.title,previous.field_label", body)

    def test_direct_guard_covers_conversion_both_directions_and_versions(self):
        body = self.code("guard_pickup_game_write", strings=True)
        for required in ("old.game_type = 'pickup'", "new.game_type = 'pickup'",
                         "current_user is distinct from pg_catalog.pg_get_userbyid",
                         "from pg_catalog.pg_class where oid = tg_relid", "'pickup_rpc_required'",
                         "new.updated_at := greatest(statement_timestamp(), old.updated_at + interval '1 microsecond')"):
            self.assertIn(required, body)
        self.assertNotIn("current_setting", body)
        self.assertNotIn("public.is_admin", body)
        self.assertIn("create trigger games_u_pickup_guard", self.scan.comments_removed)

    def test_options_and_list_are_bounded_and_stably_ordered(self):
        self.assertIn("jsonb_array_length(teams_json) > 1000", self.code("pickup_game_options"))
        self.assertIn("jsonb_array_length(venues_json) > 1000", self.code("pickup_game_options"))
        self.assertIn("order by g.created_at desc,g.id desc limit 21 offset p_offset", self.code("list_pickup_games"))

    def test_smokes_are_balanced_single_rollback_transactions(self):
        for filename, isolation in (("0005_pickup_games_smoke.sql", "read committed"),
                                    ("0005_pickup_games_isolation_smoke.sql", "repeatable read")):
            with self.subTest(filename=filename):
                sql = (ROOT / "supabase/tests" / filename).read_text()
                scan = check_sql.scan_sql(sql)
                self.assertEqual(scan.problems, [])
                statements = [part.strip().lower() for _, _, part in check_sql.statements(scan)]
                self.assertEqual(statements[0], "begin isolation level " + isolation)
                self.assertEqual(statements[-1], "rollback")
                self.assertFalse(any(re.match(r"(?:begin|commit|rollback|start\s+transaction)\b", part)
                                     for part in statements[1:-1]))
                self.assertNotIn("SECURITY DEFINER", sql)
                for _, _, body in scan.bodies:
                    nested = check_sql.scan_sql(body)
                    self.assertEqual(nested.problems, [])
                    findings = []
                    check_sql.check_parens(filename, nested.clean, findings)
                    self.assertEqual(findings, [])

    def test_main_smoke_guards_all_fixture_sources_and_names_expected_coverage(self):
        sql = (ROOT / "supabase/tests/0005_pickup_games_smoke.sql").read_text()
        self.assertLess(sql.index("zero or one scratch Auth account"), sql.index("INSERT INTO auth.users"))
        self.assertLess(sql.index("empty scratch ' || relation_name"), sql.index("INSERT INTO auth.users"))
        for table in (check_sql.CORE_TABLES | check_sql.MONEY_TABLES) - {"profiles", "audit_log"}:
            self.assertIn("'" + table + "'", sql[:sql.index("INSERT INTO auth.users")])
        for label in ("confirmed matching admin bootstrap only", "bootstrap audit history only",
                      "empty scratch profiles and audit", "synthetic account ID and email collision guard"):
            self.assertLess(sql.index(label), sql.index("INSERT INTO auth.users"))
        for label in ("existing bootstrap Auth metadata unchanged", "existing bootstrap profile and roles unchanged",
                      "preexisting audit history unchanged"):
            self.assertLess(sql.index(label), sql.index("RAISE NOTICE"))
        self.assertNotRegex(sql, r"(?i)grant\s+.*?\s+on\s+(?:table\s+)?pg_temp\.pickup_baseline")
        self.assertIn("CASE WHEN n=603 THEN 'waitlisted' ELSE 'registered' END", sql)
        for label in ("empty admin options", "ordinary competition organiser edit", "other organiser cannot list drafts",
                      "ordinary member cannot read either draft", "anonymous safe-column reads cannot see drafts",
                      "ordinary member sees published pickup but not admin draft",
                      "anonymous safe-column reads see published pickup but not admin draft",
                      "venue authoritative timezone and local date", "monotonic same-transaction CAS version",
                      "pickup_fee_forbidden", "pickup_capacity_conflict", "pickup_rpc_required",
                      "cancel preserves registrations, no promotion or charges", "existing trusted billing finalization still works"):
            self.assertIn(label, sql)


if __name__ == "__main__":
    unittest.main()
