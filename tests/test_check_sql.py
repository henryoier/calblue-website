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


def money_fixture():
    """Independent structural contract; executable billing tests live in SQL."""
    sql = ["begin;"]
    mutable = {"fee_schedules", "billing_periods", "charges", "payments"}
    for table in (
        "fee_schedules", "billing_periods", "charges", "payments",
        "period_player_summaries", "period_account_summaries", "audit_log",
    ):
        updated = ", updated_at timestamptz not null default now()" if table in mutable else ""
        sql.append(f"""create table public.{table} (
            id uuid primary key,
            account_id uuid references public.profiles(id),
            created_at timestamptz not null default now(){updated}
        );
        alter table public.{table} enable row level security;
        revoke all on table public.{table} from public, anon, authenticated;""")
        if table in mutable:
            sql.append(f"""create trigger {table}_touch before update on public.{table}
                for each row execute function public.touch_updated_at();""")
    sql.append("""revoke all on sequence public.audit_log_id_seq from public, anon, authenticated;
        create unique index charges_auto_once on public.charges(game_id, player_id, kind)
            where source = 'auto' and voided_at is null and game_id is not null;
        alter table public.billing_periods add constraint billing_periods_no_overlap
            exclude using gist (daterange(start_date, end_date, '[]') with &&);""")
    for view in ("v_account_balance", "v_account_ledger", "v_public_roster"):
        sql.append(f"""create or replace view public.{view} with (security_invoker = true) as
            select id from public.profiles;
            revoke all on table public.{view} from public, anon, authenticated;""")
    for name, declaration, signature in (
        ("charges_are_immutable", "", ""),
        ("finalise_game_attendance", "p_game uuid", "uuid"),
        ("require_open_billing_date", "p_date date, p_period uuid", "date, uuid"),
    ):
        sql.append(f"""create function public.{name}({declaration}) returns void
            language plpgsql security definer set search_path = '' as $money$
            begin return; end $money$;
            revoke all on function public.{name}({signature}) from public, anon, authenticated;""")
    sql.append("""create trigger charges_immutable before update or delete on public.charges
        for each row execute function public.charges_are_immutable();
        commit;""")
    return "\n".join(sql)


def policy_fixture():
    """Independent policy/ACL shape, not an executable authorization model."""
    tables = (
        "profiles", "players", "venues", "clubs", "teams", "competitions", "games",
        "role_grants", "competition_registrations", "game_registrations", "fee_schedules",
        "billing_periods", "charges", "payments", "period_player_summaries",
        "period_account_summaries", "audit_log",
    )
    helpers = (
        ("app_roles", "", ""), ("has_role", "r text", "text"), ("is_admin", "", ""),
        ("has_grant_on_competition", "c uuid, roles text[]", "uuid,text[]"),
        ("owns_player", "p uuid", "uuid"), ("can_register_player", "p uuid", "uuid"),
        ("manages_game", "g uuid", "uuid"),
        ("can_register_for_game", "g uuid, p uuid", "uuid,uuid"),
        ("read_game_emergency_contacts", "g uuid", "uuid"),
        ("finalise_game_attendance", "p_game uuid", "uuid"),
        ("close_billing_period", "p_period uuid", "uuid"),
    )
    sql = ["begin;"]
    for name, arguments, types in helpers:
        sql.append(f"""create function public.{name}({arguments}) returns boolean
            language sql stable security definer set search_path = '' as $$ select true; $$;
            revoke all on function public.{name}({types}) from public, anon, authenticated;
            grant execute on function public.{name}({types}) to authenticated;""")
    sql.append("""create function public.read_public_roster()
        returns table(id uuid, display_name text, preferred_number integer,
                      default_positions text[], photo_url text)
        language sql stable security definer set search_path = '' as $$
        select p.id, p.display_name, p.preferred_number, p.default_positions, p.photo_url
          from public.players p where p.is_public and p.verification_status = 'verified';
        $$;
        revoke all on function public.read_public_roster() from public, anon, authenticated;
        grant execute on function public.read_public_roster() to anon, authenticated;
        create or replace view public.v_public_roster with (security_invoker = true) as
          select id, display_name, preferred_number, default_positions, photo_url
          from public.read_public_roster();""")
    for table, helper in (
        ("profiles", "guard_role_change"), ("players", "guard_verification"),
        ("game_registrations", "guard_attendance"),
    ):
        sql.append(f"""create function public.{helper}() returns trigger
            language plpgsql security invoker set search_path = '' as $$ begin return new; end $$;
            revoke all on function public.{helper}() from public, anon, authenticated;
            create trigger {table}_guard before insert or update on public.{table}
              for each row execute function public.{helper}();""")
    for table in tables:
        sql.append(f"""alter table public.{table} enable row level security;
            create policy {table}_read on public.{table} for select to authenticated
              using (public.is_admin());""")
    sql.append("""grant usage on schema public to anon, authenticated;
        grant select on table public.profiles, public.players, public.teams,
          public.competitions, public.games, public.role_grants,
          public.competition_registrations, public.game_registrations,
          public.fee_schedules, public.billing_periods, public.charges, public.payments,
          public.period_player_summaries, public.period_account_summaries, public.audit_log,
          public.v_account_balance, public.v_account_ledger, public.v_public_roster
          to authenticated;
        grant select on table public.competitions, public.teams,
          public.fee_schedules, public.v_public_roster to anon;
        grant select(id,competition_id,team_id,game_type,title,opponent,home_away,
          home_team_id,away_team_id,stage_label,round_number,venue_id,field_label,
          timezone,gather_time,start_time,end_time,game_date,capacity,min_players,
          waitlist_enabled,registration_opens_at,registration_closes_at,kit_color,
          fee_override,no_show_fee_override,status,cancellation_reason,
          attendance_locked_at,created_at,updated_at) on table public.games to anon;
        grant select(id,name,short_name,crest_url,city,is_us,created_at,updated_at)
          on table public.clubs to anon, authenticated;
        grant select(id,name,address,map_url,surface,timezone,created_at,updated_at)
          on table public.venues to anon, authenticated;
        grant insert, update on table public.players, public.competitions, public.games,
          public.competition_registrations, public.game_registrations, public.clubs,
          public.venues, public.teams, public.fee_schedules, public.billing_periods to authenticated;
        grant update(display_name,phone,locale,roles) on table public.profiles to authenticated;
        grant insert on table public.payments to authenticated;
        grant insert(id,player_id,account_id,game_id,competition_id,billing_period_id,
          kind,description,amount,charge_date,source) on table public.charges to authenticated;
        grant update(voided_at,void_reason) on table public.charges to authenticated;
        grant insert, delete on table public.role_grants to authenticated;
        commit;""")
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
        return check_sql.check_migrations({"0001_core.sql": sql, **others},
                                          required_targets=(check_sql.CORE,))

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


class MoneyMigrationCheckTest(unittest.TestCase):
    def findings(self, sql):
        return check_sql.check_migrations({check_sql.CORE: core_fixture(), check_sql.MONEY: sql},
                                          required_targets=(check_sql.CORE, check_sql.MONEY))

    def assert_problem(self, sql, fragment):
        self.assertTrue(any(fragment in problem for problem in self.findings(sql)), fragment)

    def test_complete_money_baseline_passes(self):
        self.assertEqual(self.findings(money_fixture()), [])
        self.assertEqual(self.findings(money_fixture().upper().replace("'AUTO'", "'auto'")), [])

    def test_money_is_required_by_default_and_by_cli(self):
        problems = check_sql.check_migrations({check_sql.CORE: core_fixture()})
        self.assertIn("0002_money.sql: required money migration is missing", problems)
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / check_sql.CORE).write_text(core_fixture(), encoding="utf-8")
            with mock.patch.object(check_sql, "MIG_DIR", Path(directory)), \
                    mock.patch("sys.argv", ["check_sql.py"]), redirect_stdout(io.StringIO()) as output:
                self.assertEqual(check_sql.main(), 1)
            self.assertIn("0002_money.sql: required money migration is missing", output.getvalue())

    def test_focused_core_contract_can_be_requested_explicitly(self):
        self.assertEqual(check_sql.check_migrations(
            {check_sql.CORE: core_fixture()}, required_targets=(check_sql.CORE,),
        ), [])

    def test_cli_requires_rls_after_both_complete_installations(self):
        with tempfile.TemporaryDirectory() as directory:
            for name, source in ((check_sql.CORE, core_fixture()), (check_sql.MONEY, money_fixture())):
                (Path(directory) / name).write_text(source, encoding="utf-8")
            with mock.patch.object(check_sql, "MIG_DIR", Path(directory)), \
                    mock.patch("sys.argv", ["check_sql.py"]), redirect_stdout(io.StringIO()) as output:
                self.assertEqual(check_sql.main(), 1)
            self.assertIn("0003_rls.sql: required RLS migration is missing", output.getvalue())

    def test_money_is_one_atomic_installation(self):
        self.assert_problem(money_fixture().replace("begin;", "", 1), "money installation must start with BEGIN")
        self.assert_problem(money_fixture().removesuffix("commit;"), "money installation must end with COMMIT")
        self.assert_problem(money_fixture().replace("commit;", "commit; begin; commit;"), "transaction boundaries cannot appear inside")

    def test_every_money_table_is_required(self):
        source = money_fixture().replace("create table public.audit_log", "create table public.extra_log")
        self.assert_problem(source, "required money table public.audit_log is missing")

    def test_every_money_table_needs_rls_now_and_at_installation_end(self):
        for table in check_sql.MONEY_TABLES:
            with self.subTest(table=table):
                source = money_fixture().replace(f"alter table public.{table} enable row level security;", "")
                self.assert_problem(source, f"public.{table} must enable RLS in the money migration")
        self.assert_problem(money_fixture().replace("commit;", "alter table public.charges disable row level security; commit;"),
                            "public.charges must enable RLS")

    def test_table_privileges_are_revoked_for_all_api_roles(self):
        for table in check_sql.MONEY_TABLES:
            with self.subTest(table=table):
                source = money_fixture().replace(f"revoke all on table public.{table} from public, anon, authenticated;", "")
                self.assert_problem(source, f"public.{table} must revoke ALL table privileges")
        source = money_fixture().replace("from public, anon, authenticated", "from public, authenticated")
        self.assert_problem(source, "public.charges must revoke ALL table privileges from anon")

    def test_api_regrants_and_policies_are_not_allowed_in_money(self):
        for statement in (
            "grant select on table public.charges to authenticated;",
            "grant execute on function public.finalise_game_attendance(uuid) to anon;",
            "grant usage on sequence public.audit_log_id_seq to public;",
        ):
            with self.subTest(statement=statement):
                self.assert_problem(money_fixture().replace("commit;", statement + "commit;"),
                                    "API role grants belong in the later policy migration")
        self.assert_problem(money_fixture().replace("commit;", "create policy open_charges on public.charges using (true); commit;"),
                            "access policies belong in the later policy migration")

    def test_mutable_money_tables_need_timestamps_and_touch(self):
        for table in check_sql.MONEY_MUTABLE_TABLES:
            with self.subTest(table=table):
                self.assert_problem(money_fixture().replace(f"before update on public.{table}", f"after update on public.{table}"),
                                    f"public.{table} needs a row BEFORE UPDATE")
        for column in ("created_at", "updated_at"):
            self.assert_problem(money_fixture().replace(f"{column} timestamptz not null default now()", f"{column} timestamptz"),
                                f"public.charges.{column} needs timestamptz")

    def test_immutable_snapshots_and_audit_do_not_require_updated_at(self):
        self.assertEqual(self.findings(money_fixture()), [])
        source = money_fixture().replace("created_at timestamptz not null default now()", "created_at timestamptz")
        self.assert_problem(source, "public.audit_log.created_at needs timestamptz")
        self.assert_problem(source, "public.period_account_summaries.created_at needs timestamptz")

    def test_every_view_is_required_invoker_and_revoked(self):
        for view in check_sql.MONEY_VIEWS:
            with self.subTest(view=view):
                self.assert_problem(money_fixture().replace(f"view public.{view}", f"view public.other_{view}"),
                                    f"required view public.{view} is missing")
                self.assert_problem(money_fixture().replace(f"public.{view} with (security_invoker = true)", f"public.{view}"),
                                    f"public.{view} needs security_invoker = true")
                self.assert_problem(money_fixture().replace(f"revoke all on table public.{view} from public, anon, authenticated;", ""),
                                    f"public.{view} must revoke ALL view privileges")

    def test_invoker_setting_cannot_be_comment_or_later_disabled(self):
        self.assert_problem(money_fixture().replace("with (security_invoker = true)", "/* with (security_invoker = true) */"),
                            "needs security_invoker = true")
        for option in ("set (security_invoker = false)", "reset (security_invoker)"):
            self.assert_problem(money_fixture().replace("commit;", f"alter view public.v_account_ledger {option}; commit;"),
                                "public.v_account_ledger needs security_invoker = true")

    def test_audit_identity_sequence_privileges_are_separately_revoked(self):
        source = money_fixture().replace("revoke all on sequence public.audit_log_id_seq", "revoke all on table public.audit_log_id_seq")
        self.assert_problem(source, "public.audit_log_id_seq must revoke ALL sequence privileges")
        source = money_fixture().replace("revoke all on sequence public.audit_log_id_seq from public, anon, authenticated;",
                                         "revoke all on sequence public.audit_log_id_seq from anon, authenticated;")
        self.assert_problem(source, "public.audit_log_id_seq must revoke ALL sequence privileges from public")

    def test_every_money_helper_has_fixed_empty_path_and_execute_revokes(self):
        source = money_fixture().replace("set search_path = ''", "set search_path = pg_catalog")
        self.assert_problem(source, "public.require_open_billing_date(date,uuid) needs a fixed empty search_path")
        source = money_fixture().replace("set search_path = ''", "/* set search_path = '' */")
        self.assert_problem(source, "needs a fixed empty search_path")
        source = money_fixture().replace("revoke all on function public.require_open_billing_date(date, uuid)",
                                         "revoke all on function public.require_open_billing_date(uuid, date)")
        self.assert_problem(source, "public.require_open_billing_date(date,uuid) must revoke EXECUTE")
        new_helper = "create function public.future_money_guard() returns void language sql as $$ select 1; $$;"
        source = money_fixture().replace("commit;", new_helper + "commit;")
        self.assert_problem(source, "public.future_money_guard() needs a fixed empty search_path")
        self.assert_problem(source, "public.future_money_guard() must revoke EXECUTE")

    def test_non_public_helper_cannot_bypass_generic_inspection(self):
        source = money_fixture().replace("function public.finalise_game_attendance(p_game uuid)",
                                         "function finalise_game_attendance(p_game uuid)")
        self.assert_problem(source, "function declaration is outside this checker's supported")

    def test_partial_unique_index_covers_exact_key_and_active_auto_predicate(self):
        for original, replacement in (
            ("create unique index charges_auto_once", "create index charges_auto_once"),
            ("charges(game_id, player_id, kind)", "charges(game_id, player_id)"),
            ("charges(game_id, player_id, kind)", "payments(game_id, player_id, kind)"),
            ("source = 'auto'", "source = 'manual'"),
            ("source = 'auto'", "source = 'AUTO'"),
            ("and voided_at is null", ""),
            ("and game_id is not null", ""),
        ):
            with self.subTest(replacement=replacement):
                self.assert_problem(money_fixture().replace(original, replacement), "missing charges_auto_once unique index")

    def test_overlap_constraint_covers_inclusive_billing_dates(self):
        for original, replacement in (
            ("alter table public.billing_periods add constraint", "alter table public.charges add constraint"),
            ("exclude using gist", "exclude using btree"),
            ("daterange(start_date, end_date, '[]')", "daterange(start_date, end_date, '[)')"),
            ("daterange(start_date, end_date, '[]')", "daterange(end_date, start_date, '[]')"),
            ("with &&", "with ="),
        ):
            with self.subTest(replacement=replacement):
                self.assert_problem(money_fixture().replace(original, replacement), "missing billing_periods_no_overlap exclusion constraint")

    def test_immutable_trigger_covers_update_and_delete_before_each_charge(self):
        for original, replacement in (
            ("before update or delete on public.charges", "before update on public.charges"),
            ("before update or delete on public.charges", "after update or delete on public.charges"),
            ("before update or delete on public.charges", "before update or delete on public.payments"),
            ("for each row execute function public.charges_are_immutable", "for each statement execute function public.charges_are_immutable"),
            ("execute function public.charges_are_immutable", "execute function public.touch_updated_at"),
        ):
            with self.subTest(replacement=replacement):
                self.assert_problem(money_fixture().replace(original, replacement), "missing row BEFORE UPDATE OR DELETE charge immutability trigger")
        self.assertEqual(self.findings(money_fixture().replace("before update or delete on public.charges",
                                                               "before delete or update on public.charges")), [])

    def test_function_bodies_cannot_supply_top_level_money_invariants(self):
        source = money_fixture().replace("create unique index charges_auto_once", "create index charges_auto_once")
        source = source.replace("begin return; end $money$", """begin
            create unique index charges_auto_once on public.charges(game_id, player_id, kind)
                where source = 'auto' and voided_at is null and game_id is not null;
            return; end $money$""")
        self.assert_problem(source, "missing charges_auto_once unique index")


class PolicyMigrationCheckTest(unittest.TestCase):
    def findings(self, source):
        return check_sql.check_migrations({
            check_sql.CORE: core_fixture(), check_sql.MONEY: money_fixture(),
            check_sql.POLICIES: source,
        }, required_targets=(check_sql.CORE, check_sql.MONEY, check_sql.POLICIES))

    def assert_problem(self, source, fragment):
        self.assertTrue(any(fragment in finding for finding in self.findings(source)), fragment)

    def test_independent_policy_contract_passes(self):
        self.assertEqual(self.findings(policy_fixture()), [])

    def test_cli_requires_verification_after_three_complete_installations(self):
        with tempfile.TemporaryDirectory() as directory:
            for name, source in ((check_sql.CORE, core_fixture()),
                                 (check_sql.MONEY, money_fixture()),
                                 (check_sql.POLICIES, policy_fixture())):
                (Path(directory) / name).write_text(source, encoding="utf-8")
            with mock.patch.object(check_sql, "MIG_DIR", Path(directory)), \
                    mock.patch("sys.argv", ["check_sql.py"]), redirect_stdout(io.StringIO()) as output:
                self.assertEqual(check_sql.main(), 1)
            self.assertIn("0004_player_verification.sql", output.getvalue())

    def test_missing_third_is_required_by_default(self):
        self.assertIn("0003_rls.sql: required RLS migration is missing",
                      check_sql.check_migrations({check_sql.CORE: core_fixture(),
                                                  check_sql.MONEY: money_fixture()}))

    def test_policy_installation_is_atomic(self):
        self.assert_problem(policy_fixture().replace("begin;", "", 1), "RLS installation must start with BEGIN")
        self.assert_problem(policy_fixture().removesuffix("commit;"), "RLS installation must end with COMMIT")
        self.assert_problem(policy_fixture().replace("commit;", "commit; begin; commit;"),
                            "transaction boundaries cannot appear inside")

    def test_all_seventeen_tables_need_real_policies(self):
        for table in check_sql.CORE_TABLES | check_sql.MONEY_TABLES:
            with self.subTest(table=table):
                source = policy_fixture().replace(f"create policy {table}_read on public.{table}",
                                                  f"create policy {table}_read on public.unrelated")
                self.assert_problem(source, f"public.{table} needs at least one real policy")

    def test_comment_or_string_cannot_supply_policy_coverage(self):
        statement = "create policy players_read on public.players for select to authenticated\n              using (public.is_admin());"
        for replacement in ("/* " + statement + " */", "select '" + statement + "';"):
            with self.subTest(replacement=replacement):
                self.assert_problem(policy_fixture().replace(statement, replacement),
                                    "public.players needs at least one real policy")

    def test_dropped_policy_and_late_rls_disable_fail(self):
        self.assert_problem(policy_fixture().replace("commit;", "drop policy players_read on public.players; commit;"),
                            "public.players needs at least one real policy")
        self.assert_problem(policy_fixture().replace("commit;", "alter table public.payments disable row level security; commit;"),
                            "public.payments must keep RLS enabled")

    def test_profile_queries_in_any_policy_are_rejected(self):
        for query in (
            "select 1 from public.profiles", "select 1 from profiles",
            "select 1 from public.players p join public.profiles a on true",
            "select 1 from public.players p, public.profiles a",
        ):
            with self.subTest(query=query):
                source = policy_fixture().replace("using (public.is_admin());", f"using (exists({query}));", 1)
                self.assert_problem(source, "policy queries profiles")
        source = policy_fixture().replace("using (public.is_admin());",
                                          "using (public.is_admin() /* from public.profiles */ and 'from public.profiles' <> '');", 1)
        self.assertFalse(any("policy queries profiles" in issue for issue in self.findings(source)))

    def test_policy_roles_must_be_explicit_and_not_public(self):
        for roles in ("to public", "to postgres", ""):
            self.assert_problem(policy_fixture().replace("for select to authenticated", "for select " + roles),
                                "must explicitly target anon/authenticated and supply a predicate")

    def test_broad_grants_and_grant_options_are_rejected(self):
        for grant in (
            "grant all on table public.players to authenticated;",
            "grant all privileges on public.profiles to public;",
            "grant execute on all functions in schema public to authenticated;",
            "grant select on all tables in schema public to anon;",
            "grant authenticated to anon;",
            "grant select on table public.games to authenticated with grant option;",
        ):
            with self.subTest(grant=grant):
                self.assert_problem(policy_fixture().replace("commit;", grant + "commit;"), "unsupported or broad GRANT")

    def test_public_and_private_base_table_grants_are_forbidden(self):
        for grant in (
            "grant select on table public.games to public;",
            "grant select on table public.players to anon;",
            "grant select on table public.profiles to anon;",
            "grant select on table public.games to anon;",
            "grant select on table public.v_account_ledger to anon;",
            "grant select on table public.clubs to authenticated;",
            "grant select on table public.venues to anon;",
        ):
            with self.subTest(grant=grant):
                self.assert_problem(policy_fixture().replace("commit;", grant + "commit;"), "unapproved client grant")

    def test_column_and_operation_allowlist_is_narrow(self):
        for grant in (
            "grant update on table public.profiles to authenticated;",
            "grant update(email) on table public.profiles to authenticated;",
            "grant update(amount) on table public.charges to authenticated;",
            "grant insert on table public.charges to authenticated;",
            "grant insert(entry_id) on table public.charges to authenticated;",
            "grant select(notes) on table public.games to anon;",
            "grant select(created_by) on table public.games to anon;",
            "grant update on table public.payments to authenticated;",
            "grant update on table public.role_grants to authenticated;",
            "grant select(contact_email) on table public.clubs to anon;",
            "grant delete on table public.games to authenticated;",
            "grant usage on sequence public.audit_log_id_seq to authenticated;",
        ):
            with self.subTest(grant=grant):
                self.assert_problem(policy_fixture().replace("commit;", grant + "commit;"), "unapproved client grant")

    def test_private_money_and_trigger_helpers_cannot_be_client_rpc(self):
        for helper in (
            "write_game_attendance_charges(uuid)", "write_billing_period_summaries(uuid)",
            "finalise_game_attendance_internal(uuid)", "close_billing_period_internal(uuid)",
            "assign_to_periods()", "lock_billing()", "handle_new_user()",
            "guard_role_change()", "promote_from_waitlist(uuid)",
        ):
            with self.subTest(helper=helper):
                grant = f"grant execute on function public.{helper} to authenticated;"
                self.assert_problem(policy_fixture().replace("commit;", grant + "commit;"), "unapproved client grant")
        self.assert_problem(policy_fixture().replace("commit;", "grant execute on function public.is_admin() to anon; commit;"),
                            "unapproved client grant")
        self.assert_problem(policy_fixture().replace("commit;", "grant execute on function public.read_public_roster() to public; commit;"),
                            "unapproved client grant")

    def test_default_privilege_regrants_are_not_hidden_from_allowlist(self):
        source = policy_fixture().replace("commit;",
            "alter default privileges in schema public grant execute on functions to public; commit;")
        self.assert_problem(source, "default privilege changes are outside the explicit client allowlist")

    def test_client_grants_must_exist_at_end(self):
        source = policy_fixture().replace("grant execute on function public.can_register_player(uuid) to authenticated;", "")
        self.assert_problem(source, "missing explicit client grant: authenticated EXECUTE on function public.can_register_player(uuid)")
        source = policy_fixture().replace("commit;", "revoke select on table public.players from authenticated; commit;")
        self.assert_problem(source, "missing explicit client grant: authenticated SELECT on table public.players")
        source = policy_fixture().replace("commit;", "revoke all on function public.read_public_roster() from anon; commit;")
        self.assert_problem(source, "missing explicit client grant: anon EXECUTE on function public.read_public_roster()")

    def test_each_function_requires_fixed_empty_path_and_exact_revocations(self):
        self.assert_problem(policy_fixture().replace("set search_path = ''", "set search_path = public"),
                            "needs a fixed empty search_path")
        self.assert_problem(policy_fixture().replace("set search_path = ''", "/* set search_path = '' */"),
                            "needs a fixed empty search_path")
        source = policy_fixture().replace("revoke all on function public.has_grant_on_competition(uuid,text[])",
                                          "revoke all on function public.has_grant_on_competition(uuid,text)")
        self.assert_problem(source, "public.has_grant_on_competition(uuid,text[]) must revoke EXECUTE")
        source = policy_fixture().replace("from public, anon, authenticated", "from anon, authenticated")
        self.assert_problem(source, "must revoke EXECUTE from public")
        source = policy_fixture().replace("commit;", "create function public.new_policy_helper() returns bool language sql as $$ select true; $$; commit;")
        self.assert_problem(source, "public.new_policy_helper() needs a fixed empty search_path")
        self.assert_problem(source, "public.new_policy_helper() must revoke EXECUTE")

    def test_required_function_overloads_cannot_be_substituted(self):
        source = policy_fixture().replace("function public.can_register_for_game(g uuid, p uuid)",
                                          "function public.can_register_for_game(g uuid, p text)")
        self.assert_problem(source, "required client helper public.can_register_for_game(uuid,uuid) is missing")

    def test_late_function_alterations_cannot_weaken_checked_headers(self):
        for statement in (
            "alter function public.read_public_roster() set search_path=public;",
            "alter function read_public_roster() set search_path=public;",
            "alter function public.guard_role_change() security definer;",
            "alter function public.is_admin() reset all;",
            "alter function public.read_public_roster() rename to unsafe_projection;",
        ):
            with self.subTest(statement=statement):
                self.assert_problem(policy_fixture().replace("commit;", statement + "commit;"),
                                    "function alterations must not bypass checked search paths/privileges")
        source = policy_fixture().replace("begin;", """begin;
            alter function public.finalise_game_attendance(uuid) rename to finalise_game_attendance_internal;
            alter function public.close_billing_period(uuid) rename to close_billing_period_internal;""", 1)
        self.assertEqual(self.findings(source), [])

    def test_catalog_owner_lookup_cannot_resolve_temporary_pg_class(self):
        for relation in ("pg_class", "pg_temp.pg_class", "public.pg_class"):
            with self.subTest(relation=relation):
                source = policy_fixture().replace("begin return new; end",
                    f"begin perform relowner from {relation} where oid=tg_relid; return new; end")
                self.assert_problem(source, "must qualify pg_class as pg_catalog.pg_class")
        source = policy_fixture().replace("begin return new; end",
            "begin perform relowner from pg_catalog.pg_class where oid=tg_relid; return new; end")
        self.assertEqual(self.findings(source), [])

    def test_guards_cover_insert_and_update_at_row_level(self):
        for table, helper in check_sql.GUARD_FUNCTIONS.items():
            for replacement in ("before update", "before insert", "after insert or update"):
                with self.subTest(table=table, replacement=replacement):
                    source = policy_fixture().replace(f"before insert or update on public.{table}",
                                                       f"{replacement} on public.{table}")
                    self.assert_problem(source, f"public.{table} needs row BEFORE INSERT and UPDATE protection using {helper}()")
        source = policy_fixture().replace("for each row execute function public.guard_role_change()",
                                          "for each statement execute function public.guard_role_change()")
        self.assert_problem(source, "public.profiles needs row BEFORE INSERT and UPDATE protection")

    def test_guard_context_wrong_target_and_late_drop_are_detected(self):
        source = policy_fixture().replace("security invoker", "security definer")
        self.assert_problem(source, "public.guard_role_change() must keep SECURITY INVOKER caller context")
        source = policy_fixture().replace("execute function public.guard_verification()", "execute function public.guard_role_change()")
        self.assert_problem(source, "public.players needs row BEFORE INSERT and UPDATE protection using guard_verification()")
        source = policy_fixture().replace("commit;", "drop trigger game_registrations_guard on public.game_registrations; commit;")
        self.assert_problem(source, "public.game_registrations needs row BEFORE INSERT and UPDATE protection")

    def test_public_roster_function_cannot_return_private_columns(self):
        source = policy_fixture().replace("photo_url text)", "photo_url text, emergency_contact_phone text)")
        self.assert_problem(source, "SECURITY DEFINER projection of the five safe roster columns")
        source = policy_fixture().replace("p.photo_url\n", "p.emergency_contact_phone\n")
        self.assert_problem(source, "select only the five safe columns of opt-in verified players")
        source = policy_fixture().replace("p.id, p.display_name, p.preferred_number, p.default_positions, p.photo_url", "p.*")
        self.assert_problem(source, "select only the five safe columns of opt-in verified players")

    def test_public_roster_projection_filter_cannot_be_widened(self):
        for original, replacement in (
            ("p.is_public and p.verification_status = 'verified'", "p.is_public or p.verification_status = 'verified'"),
            ("p.is_public and p.verification_status = 'verified'", "p.is_public"),
            ("p.verification_status = 'verified'", "p.verification_status = 'pending'"),
        ):
            with self.subTest(replacement=replacement):
                self.assert_problem(policy_fixture().replace(original, replacement),
                                    "select only the five safe columns of opt-in verified players")

    def test_public_roster_view_is_only_an_invoker_of_safe_projection(self):
        self.assert_problem(policy_fixture().replace("with (security_invoker = true)", "with (security_invoker = false)"),
                            "v_public_roster must be an invoker view")
        self.assert_problem(policy_fixture().replace("from public.read_public_roster();", "from public.players;"),
                            "v_public_roster must be an invoker view")

    def test_later_policy_or_view_mutations_cannot_bypass_checked_definitions(self):
        for statement, expected in (
            ("alter policy players_read on public.players using (true);", "ALTER POLICY is outside"),
            ("alter view public.v_public_roster set (security_invoker=false);", "view alterations/drops are outside"),
            ("drop view public.v_public_roster;", "view alterations/drops are outside"),
            ("create or replace view public.v_account_balance as select * from public.charges;", "only the public roster view may be replaced"),
            ("create or replace view public.v_public_roster as select * from public.players;", "every v_public_roster replacement must preserve"),
        ):
            with self.subTest(statement=statement):
                self.assert_problem(policy_fixture().replace("commit;", statement + "commit;"), expected)


if __name__ == "__main__":
    unittest.main()
