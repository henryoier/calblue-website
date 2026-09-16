"""Offline seed-shape regressions; none of these tests execute SQL."""

from contextlib import redirect_stderr, redirect_stdout
import io
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from scripts import check_seed


def uid(group, number):
    return f"'{group:08d}-0000-4000-8000-{number:012d}'"


def insert(table, columns, rows):
    return f"insert into {table} ({','.join(columns)}) values\n" + ",\n".join(
        "(" + ",".join(row) + ")" for row in rows
    ) + ";"


def fixture():
    tables = (
        "profiles", "players", "clubs", "venues", "teams", "competitions", "games", "role_grants",
        "competition_registrations", "game_registrations", "fee_schedules", "billing_periods",
        "charges", "payments", "period_player_summaries", "period_account_summaries", "audit_log",
    )
    empty = " or ".join("exists(select 1 from " + table + ")" for table in
                        ("auth.users", *("public." + table for table in tables)))
    counts = '{{"accounts":6,"players":12,"clubs":1,"teams":1,"venues":2,"competitions":1,"games":5,"competition_registrations":10,"game_registrations":29,"role_grants":1,"fee_schedules":2,"billing_periods":1,"charges":3,"payments":1}}'
    sql = [f"""begin isolation level read committed;
set local search_path = '';
set local calblue.seed_confirmation = '';
-- set local calblue.seed_confirmation = 'disposable-demo-only';
do $seed$
declare v_marker jsonb; v_owner oid; table_name text; table_oid oid;
  expected_counts jsonb := '{counts.replace('{{', '{').replace('}}', '}')}'::jsonb;
begin
  if current_setting('calblue.seed_confirmation', true) is distinct from 'disposable-demo-only' then
    raise exception 'explicit confirmation required';
  end if;
  select relowner into v_owner
    from pg_catalog.pg_class where oid = pg_catalog.to_regclass('public.profiles') and relkind = 'r';
  if not found then
    raise exception 'migrations required';
  end if;
  if current_user <> pg_catalog.pg_get_userbyid(v_owner) then
    raise exception 'owner required';
  end if;
  if current_setting('transaction_isolation') is distinct from 'read committed' then
    raise exception 'READ COMMITTED required';
  end if;
  if to_regprocedure('public.finalise_game_attendance_internal(uuid)') is null
     or to_regprocedure('public.read_public_roster()') is null then
    raise exception 'all migrations required';
  end if;
  foreach table_name in array array[{','.join(repr(table) for table in tables)}] loop
    perform relrowsecurity from pg_catalog.pg_class where oid = to_regclass('public.' || table_name);
    perform 1 from pg_catalog.pg_policy where polrelid = to_regclass('public.' || table_name);
  end loop;
  perform public.lock_billing();
  perform pg_advisory_xact_lock(hashtextextended('calblue:demo-seed:v1', 0));
  select raw_app_meta_data -> 'calblue_demo_seed' into v_marker from auth.users where id = {uid(1, 1)};
  if found then
    if jsonb_typeof(v_marker) is distinct from 'object'
       or v_marker -> 'version' is distinct from '1'::jsonb
       or v_marker ->> 'status' is distinct from 'complete'
       or v_marker ->> 'seed' is distinct from 'calblue-demo'
       or v_marker -> 'counts' is distinct from expected_counts
       or jsonb_typeof(v_marker -> 'anchor_date') is distinct from 'string'
       or jsonb_typeof(v_marker -> 'installed_at') is distinct from 'string' then
      raise exception 'invalid marker';
    end if;
    return;
  end if;
  lock table auth.users, {','.join('public.' + table for table in tables)} in share row exclusive mode;
  if {empty} then
    raise exception 'empty database required';
  end if;
  perform set_config('request.jwt.claims', '{{}}', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', '', true);
"""]
    sql.append(insert("auth.users", ("id", "email"),
                      [(uid(1, number), f"'person{number}@example.com'") for number in range(1, 7)]))
    for number in range(1, 7):
        sql.append(f"update public.profiles set display_name='Person {number}', roles='{{player}}' where id={uid(1, number)};")
    sql.append(insert("public.clubs", ("id", "name"), [(uid(2, 1), "'Demo Club'")]))
    sql.append(insert("public.teams", ("id", "club_id", "is_default"), [(uid(3, 1), uid(2, 1), "true")]))
    sql.append(insert("public.venues", ("id", "name"), [(uid(4, n), f"'Demo venue {n}'") for n in (1, 2)]))
    sql.append(insert("public.players", ("id", "account_id", "guardian_account_id", "display_name"), [
        (uid(5, number), uid(1, number) if number <= 6 else "null",
         uid(1, 5) if number == 8 else "null", f"'Player {number}'") for number in range(1, 13)
    ]))
    sql.append(insert("public.competitions", ("id", "name"), [(uid(6, 1), "'Demo Cup'")]))
    sql.append(insert("public.role_grants", ("id", "account_id", "competition_id", "role"),
                      [(uid(7, 1), uid(1, 4), uid(6, 1), "'organiser'")]))
    sql.append(insert("public.games", ("id", "competition_id", "team_id", "venue_id", "game_type", "status", "capacity"), [
        (uid(8, 1), "null", uid(3, 1), uid(4, 1), "'pickup'", "'published'", "4"),
        (uid(8, 2), "null", uid(3, 1), uid(4, 1), "'pickup'", "'completed'", "12"),
        *((uid(8, number), uid(6, 1), uid(3, 1), uid(4, 2), "'cup'", "'published'", "16") for number in (3, 4, 5)),
    ]))
    sql.append(insert("public.competition_registrations", ("id", "competition_id", "player_id"),
                      [(uid(9, n), uid(6, 1), uid(5, n)) for n in range(1, 11)]))
    registrations = [(uid(10, n), uid(8, 1), uid(5, n), "'registered'" if n <= 4 else "'waitlisted'", "'unknown'")
                     for n in range(1, 7)]
    registrations.extend((uid(10, 10 + n), uid(8, 2), uid(5, n), "'registered'" if n < 5 else "'cancelled'",
                          "'present'" if n <= 3 else "'absent'") for n in range(1, 6))
    registrations.extend((uid(10, game * 10 + n), uid(8, game), uid(5, n), "'registered'", "'unknown'")
                         for game in (3, 4, 5) for n in range(1, 7))
    sql.append(insert("public.game_registrations", ("id", "game_id", "player_id", "status", "attendance"), registrations))
    sql.append(insert("public.fee_schedules", ("id", "amount"), [(uid(11, 1), "10"), (uid(11, 2), "25")]))
    sql.append(insert("public.billing_periods", ("id", "status"), [(uid(12, 1), "'open'")]))
    sql.append(f"perform public.finalise_game_attendance_internal({uid(8, 2)});")
    sql.append(insert("public.payments", ("id", "account_id", "amount"), [(uid(13, 1), uid(1, 1), "10")]))
    sql.append("perform public.assign_to_periods();")
    sql.append(f"""update auth.users set raw_app_meta_data = coalesce(raw_app_meta_data, '{{}}'::jsonb)
       || jsonb_build_object('calblue_demo_seed', jsonb_build_object('version', 1)) where id={uid(1, 1)};
  raise notice 'fixture complete';
end;
$seed$;
commit;
""")
    return "\n".join(sql)


class SeedCheckTest(unittest.TestCase):
    def assert_problem(self, source, fragment):
        findings = check_seed.check_seed(source)
        self.assertTrue(any(fragment in finding for finding in findings), (fragment, findings))

    def test_independent_fixture_passes(self):
        self.assertEqual(check_seed.check_seed(fixture()), [])

    def test_all_three_prerequisite_files_are_required(self):
        for name in check_seed.REQUIRED_MIGRATIONS:
            with self.subTest(name=name):
                self.assertIn("required prerequisite migration is missing: " + name,
                              check_seed.check_seed(fixture(), set(check_seed.REQUIRED_MIGRATIONS) - {name}))

    def test_empty_malformed_and_unbalanced_source_fail(self):
        self.assert_problem("", "one BEGIN ISOLATION LEVEL READ COMMITTED")
        self.assert_problem(fixture().replace("$seed$;", "$$;"), "unterminated dollar body")
        self.assert_problem(fixture().replace("end if;", "end;", 1), "unterminated IF")

    def test_default_opt_in_is_off_and_comments_cannot_change_it(self):
        self.assert_problem(fixture().replace("set local calblue.seed_confirmation = '';",
                                              "set local calblue.seed_confirmation = 'disposable-demo-only';"), "default OFF")
        self.assertEqual(check_seed.check_seed(fixture()), [])

    def test_transaction_and_do_are_not_split_or_executable_outside_wrapper(self):
        for source in (fixture().replace("commit;", "rollback;"), fixture() + "delete from public.players;",
                       fixture().replace("begin isolation level read committed;", "begin;")):
            self.assert_problem(source, "transaction" if "delete from" in source or "begin;" in source else "DO block followed by COMMIT")

    def test_comments_and_strings_cannot_supply_confirmation_guard(self):
        guard = "current_setting('calblue.seed_confirmation', true) is distinct from 'disposable-demo-only'"
        for replacement in ("false /* " + guard + " */", "'" + guard.replace("'", "''") + "' = ''"):
            self.assert_problem(fixture().replace(guard, replacement), "confirmation must be rejected before")
        self.assert_problem(fixture().replace(guard, guard + " and false"), "confirmation must be rejected before")

    def test_marker_needs_version_one_and_real_return_before_dml(self):
        self.assert_problem(fixture().replace("v_marker -> 'version' is distinct from '1'::jsonb", "false"),
                            "verified completion-marker RETURN")
        self.assert_problem(fixture().replace("return;", "raise notice 'return';", 1),
                            "verified completion-marker RETURN")
        self.assert_problem(fixture().replace('"accounts":6', '"accounts":7'), "expected_counts must describe")

    def test_first_run_emptiness_guard_covers_every_table_with_or_not_and(self):
        self.assert_problem(fixture().replace(" or exists(select 1 from public.audit_log)", ""),
                            "reject ANY rows in auth.users or all 17")
        self.assert_problem(fixture().replace("or exists(select 1 from public.players)", "and exists(select 1 from public.players)"),
                            "reject ANY rows in auth.users or all 17")
        self.assert_problem(fixture().replace("in share row exclusive mode", "in access share mode"),
                            "SHARE ROW EXCLUSIVE locks")

    def test_owner_guard_cannot_be_inverted_or_sourced_from_temp_catalog(self):
        self.assert_problem(fixture().replace("current_user <> pg_catalog.pg_get_userbyid(v_owner)",
                                              "current_user = pg_catalog.pg_get_userbyid(v_owner)"), "catalog-backed owner guard")
        self.assert_problem(fixture().replace("from pg_catalog.pg_class", "from pg_class"), "catalog-backed owner guard")

    def test_fixture_counts_and_unique_ids_are_checked(self):
        self.assert_problem(fixture().replace(uid(5, 12), uid(5, 11)), "duplicate fixture id")
        source = fixture().replace("insert into public.venues", "insert into public.unrelated")
        self.assert_problem(source, "public.venues: expected 2 explicit fixture rows")

    def test_references_must_point_to_earlier_fixtures(self):
        self.assert_problem(fixture().replace(f"({uid(3, 1)},{uid(2, 1)},true)", f"({uid(3, 1)},{uid(2, 9)},true)"),
                            "public.teams.club_id: must reference an earlier public.clubs fixture")

    def test_parent_inserts_cannot_be_hidden_by_comments_or_strings(self):
        statement = insert("public.clubs", ("id", "name"), [(uid(2, 1), "'Demo Club'")])
        self.assert_problem(fixture().replace(statement, "/* " + statement + " */"), "public.clubs: expected 1 explicit fixture rows")
        self.assert_problem(fixture().replace(statement, "perform '" + statement.replace("'", "''") + "';"),
                            "public.clubs: expected 1 explicit fixture rows")

    def test_real_email_and_secret_shapes_are_rejected_without_echoing_them(self):
        source = fixture().replace("person1@example.com", "person1@nonexample.test")
        self.assert_problem(source, "non-example.com email")
        secret = "sb_" + "secret_" + "notARealSecret12345"
        self.assert_problem(fixture() + "\n-- " + secret, "credential-shaped secret")
        self.assertFalse(any(secret in issue for issue in check_seed.check_seed(fixture() + "\n-- " + secret)))

    def test_dangerous_sql_and_dynamic_sql_are_rejected(self):
        for statement in (
            "delete from public.players;", "truncate public.games;",
            "alter table public.players disable row level security;",
            "grant all on public.players to anon;", "drop table public.games;",
            "execute 'select 1';",
        ):
            with self.subTest(statement=statement):
                self.assert_problem(fixture().replace("raise notice 'fixture complete';", statement), "seed may not use")

    def test_charges_must_be_generated_not_inserted_directly(self):
        source = fixture().replace("raise notice 'fixture complete';",
            insert("public.charges", ("id", "amount"), [(uid(14, 1), "10")]))
        self.assert_problem(source, "public.charges: direct seed INSERT is not allowed")

    def test_broad_or_unapproved_updates_are_rejected(self):
        source = fixture().replace(f"where id={uid(1, 1)};", ";", 1)
        self.assert_problem(source, "UPDATE must target fixed fixture ids")
        source = fixture().replace("set display_name='Person 1'", "set email='person1@example.com'")
        self.assert_problem(source, "unapproved seed UPDATE columns")

    def test_upcoming_capacity_waitlist_and_past_status_are_checked(self):
        self.assert_problem(fixture().replace("'pickup','published',4", "'pickup','published',5"), "published capacity-four pickup")
        self.assert_problem(fixture().replace("'waitlisted'", "'registered'"), "four registered and two waitlisted")
        self.assert_problem(fixture().replace("'completed'", "'locked'"), "past game must start completed")

    def test_billing_calls_cannot_be_comments_or_wrong_game(self):
        call = f"perform public.finalise_game_attendance_internal({uid(8, 2)});"
        self.assert_problem(fixture().replace(call, "-- " + call), "finalize the completed fixture once")
        self.assert_problem(fixture().replace(call, f"perform public.finalise_game_attendance_internal({uid(8, 1)});"),
                            "finalize the completed fixture once")

    def test_completion_marker_must_be_last_dml(self):
        self.assert_problem(fixture().replace("raise notice 'fixture complete';",
            f"update public.profiles set roles='{{player}}' where id={uid(1, 1)};"), "single final auth.users UPDATE")

    def test_jwt_clearing_must_be_transaction_local_and_not_forged(self):
        for before, after in (("'{}', true", "'{}', false"), ("'request.jwt.claim.role', ''", "'request.jwt.claim.role', 'authenticated'")):
            self.assert_problem(fixture().replace(before, after), "only clear transaction-local JWT context")
        source = fixture().replace("raise notice 'fixture complete';", "set local session_replication_role='replica';")
        self.assert_problem(source, "may not change session, role, trigger or constraint settings")


class SeedCommandTest(unittest.TestCase):
    def test_missing_seed_fails(self):
        with tempfile.TemporaryDirectory() as directory, redirect_stderr(io.StringIO()) as output:
            with mock.patch.object(check_seed, "SEED", Path(directory) / "seed.sql"):
                self.assertEqual(check_seed.main([]), 1)
            self.assertIn("required supabase/seed.sql cannot be read", output.getvalue())

    def test_cli_checks_prerequisites_and_never_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            seed = root / "seed.sql"
            seed.write_text(fixture(), encoding="utf-8")
            before = (seed.read_bytes(), seed.stat().st_mtime_ns)
            with mock.patch.multiple(check_seed, SEED=seed, MIG_DIR=root), redirect_stdout(io.StringIO()) as output:
                self.assertEqual(check_seed.main([]), 1)
                self.assertIn("required prerequisite migration is missing", output.getvalue())
                for name in check_seed.REQUIRED_MIGRATIONS:
                    (root / name).write_text("-- fixture prerequisite\n", encoding="utf-8")
                self.assertEqual(check_seed.main([]), 0)
            self.assertEqual((seed.read_bytes(), seed.stat().st_mtime_ns), before)


if __name__ == "__main__":
    unittest.main()
