"""Regression cases for structural SQL checks; no database is used."""

from contextlib import redirect_stdout
import io
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from scripts import check_sql


def core_fixture():
    """Small static schema contract, independent of the generated migration."""
    tables = (
        "profiles", "clubs", "players", "venues", "teams", "competitions",
        "games", "role_grants", "competition_registrations", "game_registrations",
    )
    extra = {
        "profiles": "roles text[] not null default '{}',",
        "players": """account_id uuid references public.profiles(id),
            guardian_account_id uuid references public.profiles(id),
            home_club_id uuid references public.clubs(id),
            payer_account_id uuid generated always as
              (coalesce(account_id, guardian_account_id)) stored,""",
        "game_registrations": "game_id uuid, player_id uuid, unique (game_id, player_id),",
    }
    sql = ["begin;"]
    for table in tables:
        sql.append(f"""create table public.{table} (
            id uuid primary key,
            {extra.get(table, '')}
            created_at timestamptz not null default now(),
            updated_at timestamptz not null default now()
        );
        create trigger {table}_touch before update on public.{table}
            for each row execute function public.touch_updated_at();
        alter table public.{table} enable row level security;""")
    sql.append("""create unique index players_one_per_account
        on public.players(account_id) where account_id is not null;""")
    helpers = (
        "touch_updated_at", "handle_new_user", "sync_role_claim", "set_game_date",
        "enforce_game_capacity", "promote_from_waitlist", "on_slot_freed",
    )
    for name in helpers:
        argument = "p_game uuid" if name == "promote_from_waitlist" else ""
        signature = "uuid" if argument else ""
        sql.append(f"""create function public.{name}({argument}) returns trigger
            language plpgsql security definer set search_path = '' as $body$
            begin
              perform pg_advisory_xact_lock(hashtextextended('game', 0));
              return new;
            end $body$;
            revoke all on function public.{name}({signature})
                from public, anon, authenticated;""")
    sql.append("revoke all on table " + ", ".join("public." + table for table in tables)
               + " from public, anon, authenticated;")
    sql.append("commit;")
    return "\n".join(sql)


class LexerTest(unittest.TestCase):
    def test_noise_preserves_offsets_and_newlines(self):
        sql = "-- $$ (\n/* outer\n /* inner */ end */\nselect 'it''s $$)', E'escaped\\\' quote';"
        scan = check_sql.scan_sql(sql)
        self.assertEqual(scan.problems, [])
        self.assertEqual(len(scan.clean), len(sql))
        self.assertEqual([i for i, ch in enumerate(scan.clean) if ch == "\n"],
                         [i for i, ch in enumerate(sql) if ch == "\n"])
        self.assertNotIn("$$", scan.clean)
        self.assertNotIn("inner", scan.clean)
        self.assertIn("select", scan.clean)

    def test_tagged_body_hides_internal_semicolons_and_foreign_keys(self):
        sql = "create function public.f() returns void as $fn$ begin; references public.fake; end $fn$ language plpgsql;"
        scan = check_sql.scan_sql(sql)
        self.assertEqual(scan.problems, [])
        self.assertEqual(len(list(check_sql.statements(scan))), 1)
        self.assertNotIn("references", scan.clean)
        self.assertIn("references", scan.bodies[0][2])

    def test_reports_unterminated_constructs(self):
        for source, expected in (
            ("\n/* open /* nested */", "block comment"),
            ("\nselect 'open", "quoted string"),
            ("\nselect $tag$open$$", "dollar body $tag$"),
        ):
            with self.subTest(source=source):
                scan = check_sql.scan_sql(source)
                self.assertIn(expected, scan.problems[0][1])
                self.assertEqual(check_sql.line_of(source, scan.problems[0][0]), 2)

    def test_quoted_identifiers_are_explicitly_unsupported(self):
        self.assertIn("quoted identifiers", check_sql.scan_sql('create table public."profiles" (id uuid);').problems[0][1])


class MigrationCheckTest(unittest.TestCase):
    def findings(self, sql, **others):
        return check_sql.check_migrations({"0001_core.sql": sql, **others})

    def assert_problem(self, sql, fragment, **others):
        self.assertTrue(any(fragment in problem for problem in self.findings(sql, **others)), fragment)

    def test_complete_core_baseline_passes(self):
        self.assertEqual(self.findings(core_fixture()), [])
        self.assertEqual(self.findings(core_fixture().upper()), [])

    def test_empty_migration_directory_fails_cli(self):
        with tempfile.TemporaryDirectory() as directory:
            with mock.patch.object(check_sql, "MIG_DIR", Path(directory)), \
                    mock.patch("sys.argv", ["check_sql.py"]), redirect_stdout(io.StringIO()) as output:
                self.assertEqual(check_sql.main(), 1)
            self.assertIn("required core migration is missing", output.getvalue())

    def test_missing_core_is_not_replaced_by_later_file(self):
        self.assertIn("0001_core.sql: required core migration is missing",
                      check_sql.check_migrations({"0002_money.sql": ""}))

    def test_core_is_one_transaction(self):
        self.assert_problem(core_fixture().replace("begin;", "", 1), "start with BEGIN")
        self.assert_problem(core_fixture().removesuffix("commit;"), "end with COMMIT")
        self.assert_problem(core_fixture().replace("commit;", "commit; begin; commit;"), "transaction boundaries cannot appear inside")

    def test_forward_fk_after_multiple_earlier_references_is_detected(self):
        source = """create table public.profiles(id uuid primary key);
create table public.players(account_id uuid references public.profiles(id),
  guardian_id uuid references public.profiles(id),
  club_id uuid references public.clubs(id));
create table public.venues(id uuid);
create table public.clubs(id uuid);"""
        problems = self.findings(source)
        self.assertIn("0001_core.sql:4: references public.clubs before it is created", problems)

    def test_self_fk_and_prior_migration_fk_are_allowed(self):
        source = core_fixture().replace("id uuid primary key,", "id uuid primary key, parent_id uuid references public.profiles(id),", 1)
        problems = self.findings(source, **{"0004_extra.sql": "create table public.extra (id uuid references public.players(id));"})
        self.assertEqual(problems, [])

    def test_later_migration_does_not_satisfy_forward_fk(self):
        source = core_fixture().replace("home_club_id uuid references public.clubs(id)", "home_club_id uuid references public.later(id)")
        self.assert_problem(source, "references public.later before it is created",
                            **{"0004_extra.sql": "create table public.later (id uuid);"})

    def test_comment_literal_and_dollar_body_references_are_ignored(self):
        source = core_fixture().replace("begin;", "begin; -- references public.fake\n/* references public.fake */\nselect 'references public.fake';", 1)
        source = source.replace("return new;", "perform 'references public.fake'; return new;")
        self.assertEqual(self.findings(source), [])

    def test_duplicate_table_is_detected(self):
        self.assert_problem(core_fixture().replace("commit;", "create table public.clubs(id uuid); commit;"), "public.clubs created twice")

    def test_rls_cannot_be_deferred_to_policy_migration(self):
        line = "alter table public.players enable row level security;"
        self.assert_problem(core_fixture().replace(line, "-- " + line), "public.players must enable RLS in the core migration",
                            **{"0003_rls.sql": line})

    def test_rls_must_remain_enabled_at_core_end(self):
        self.assert_problem(core_fixture().replace("commit;", "alter table public.players disable row level security; commit;"), "public.players must enable RLS")

    def test_created_updated_timestamps_and_touch_are_required(self):
        for old, replacement, expected in (
            ("updated_at timestamptz not null default now()", "updated_at timestamptz", "updated_at needs timestamptz"),
            ("created_at timestamptz not null default now()", "created_at text", "created_at needs timestamptz"),
            ("before update on public.players", "after update on public.players", "public.players needs a row BEFORE UPDATE"),
        ):
            with self.subTest(expected=expected):
                self.assert_problem(core_fixture().replace(old, replacement), expected)

    def test_roles_must_be_an_actual_array_column(self):
        source = core_fixture().replace("roles text[] not null", "roles text not null /* roles text[] not null */")
        self.assert_problem(source, "profiles.roles must be a real non-null text[] column")

    def test_payer_requires_correct_stored_expression(self):
        source = core_fixture().replace("coalesce(account_id, guardian_account_id)", "coalesce(guardian_account_id, account_id)")
        self.assert_problem(source, "players.payer_account_id must store")
        source = core_fixture().replace("payer_account_id uuid generated always as", "fake_payer uuid generated always as")
        self.assert_problem(source + "\n-- payer_account_id", "players.payer_account_id must store")

    def test_uniqueness_cannot_be_satisfied_by_comments(self):
        source = core_fixture().replace("create unique index players_one_per_account", "create index players_one_per_account")
        self.assert_problem(source + "\n-- create unique index players_one_per_account", "players_one_per_account must be a unique index")
        source = core_fixture().replace("unique (game_id, player_id)", "check (true) /* unique (game_id, player_id) */")
        self.assert_problem(source, "game_registrations needs UNIQUE")

    def test_search_path_must_be_fixed_in_function_header(self):
        self.assert_problem(core_fixture().replace("set search_path = ''", "set search_path = public"), "fixed empty or pg_catalog search_path")
        source = core_fixture().replace("set search_path = ''", "/* set search_path = '' */")
        self.assert_problem(source, "fixed empty or pg_catalog search_path")
        source = core_fixture().replace("set search_path = ''", "set application_name = 'set search_path = '''' as'")
        self.assert_problem(source, "fixed empty or pg_catalog search_path")
        self.assertEqual(self.findings(core_fixture().replace("set search_path = ''", "set search_path = pg_catalog")), [])
        source = core_fixture().replace("set search_path = ''", "set search_path = '' set search_path = public")
        self.assert_problem(source, "fixed empty or pg_catalog search_path")

    def test_execute_revocation_covers_all_roles_and_exact_signature(self):
        source = core_fixture().replace("revoke all on function public.promote_from_waitlist(uuid)", "revoke all on function public.promote_from_waitlist(text)")
        self.assert_problem(source, "public.promote_from_waitlist(uuid) must revoke EXECUTE")
        source = core_fixture().replace("from public, anon, authenticated", "from anon, authenticated")
        self.assert_problem(source, "must revoke EXECUTE from public")

    def test_separate_execute_role_revocations_are_supported(self):
        source = core_fixture().replace("revoke all on function public.on_slot_freed()\n                from public, anon, authenticated;", """revoke execute on function public.on_slot_freed() from public;
revoke execute on function public.on_slot_freed() from anon, authenticated;""")
        self.assertEqual(self.findings(source), [])

    def test_table_grants_are_denied_and_not_regranted(self):
        source = core_fixture().replace("revoke all on table", "revoke execute on table")
        self.assert_problem(source, "must revoke ALL table privileges")
        source = core_fixture().replace("commit;", "grant select on public.players to authenticated; commit;")
        self.assert_problem(source, "API role grants belong in the later policy migration")

    def test_lock_words_in_comment_or_literal_do_not_satisfy_invariant(self):
        call = "perform pg_advisory_xact_lock(hashtextextended('game', 0));"
        for replacement in ("-- " + call, "perform 'pg_advisory_xact_lock(game)';"):
            with self.subTest(replacement=replacement):
                self.assert_problem(core_fixture().replace(call, replacement), "enforce_game_capacity must execute a per-game advisory lock")

    def test_trusted_trigger_work_needs_definer_context(self):
        source = core_fixture().replace("security definer", "security invoker")
        self.assert_problem(source, "on_slot_freed must be SECURITY DEFINER")
        self.assert_problem(source, "enforce_game_capacity must be SECURITY DEFINER")

    def test_policy_profile_join_is_detected(self):
        policy = "create policy bad on public.players using (exists(select 1 from public.players p join public.profiles pr on true));"
        self.assert_problem(core_fixture(), "policy queries profiles", **{"0003_rls.sql": policy})

    def test_money_comment_names_are_not_invariants(self):
        money = "-- charges_auto_once billing_periods_no_overlap charges cannot be deleted"
        self.assert_problem(core_fixture(), "missing charges_auto_once unique index", **{"0002_money.sql": money})


if __name__ == "__main__":
    unittest.main()
