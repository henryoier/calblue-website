"""The database runner, tested without a database: a stand-in executable plays psql."""

import io
import json
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

from scripts.run_db_tests import OPT_IN_OFF, OPT_IN_ON, Failure, check_local, main, migrations, scripts_for


ROOT = Path(__file__).resolve().parents[1]
LOCAL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"

# Behaves like psql for the handful of things the runner asks. Its state lives in a JSON file:
# which files were run (in order), how many accounts exist, and which faults to inject.
STAND_IN = r'''
import json, pathlib, sys
state_path = pathlib.Path(__file__).with_name("state.json")
state = json.loads(state_path.read_text())
faults = state["faults"]
args = sys.argv[1:]
code, out, err = 0, "", ""
if "-c" in args:
    sql = args[args.index("-c") + 1]
    if "to_regclass('auth.users') is not null" in sql:
        out = "false" if "not_supabase" in faults else "true"
    elif "to_regclass('public.profiles') is null" in sql:
        out = "true" if not state["applied"] and not state["accounts"] and "not_empty" not in faults else "false"
    elif "count(*) from auth.users" in sql:
        out = str(state["accounts"])
    else:
        code, err = 3, "ERROR:  unexpected query"
else:
    path = pathlib.Path(args[args.index("-f") + 1])
    name, text = path.name, path.read_text()
    if path.parent.name == "migrations":
        state["log"].append("apply " + name)
        if "break " + name in faults:
            code, err = 3, "psql:" + name + ":7: ERROR:  relation already exists"
        else:
            state["applied"].append(name)
    elif name == "seed.sql":
        opted_in = any(line.startswith("SET LOCAL calblue.seed_confirmation = 'disposable") for line in text.splitlines())
        if opted_in or "seed_guard_off" in faults:
            state["log"].append("seed with opt-in" if opted_in else "seed unguarded")
            if not state["accounts"]:
                state["accounts"] = 6
        else:
            state["log"].append("seed refused")
            code, err = 3, "psql:seed.sql:60: ERROR:  seed_disposable_confirmation_required"
    elif name == "seed_verify.sql":
        state["log"].append("verify")
        state["verified"] += 1
        value = "b" * 32 if "seed_rewrites" in faults and state["verified"] > 1 else "a" * 32
        out = "{}\n\n\n" + value + "|Fixture and read-access assertions passed; compare this fingerprint across the seed rerun."
    else:
        state["log"].append("check " + name)
        if "error " + name in faults:
            code, err = 3, "psql:" + name + ":41: ERROR:  core smoke assertion failed: capacity is enforced"
        elif "silent " + name not in faults:
            err = "psql:" + name + ":9: NOTICE:  Synthetic assertions passed; rolling back all test changes."
        if "leak " + name in faults:
            state["accounts"] += 1
state_path.write_text(json.dumps(state))
sys.stdout.write(out + ("\n" if out else ""))
sys.stderr.write(err + ("\n" if err else ""))
sys.exit(code)
'''


class Scratch:
    """A repository with four migrations, their checks and a seed, plus the stand-in psql."""

    def __init__(self, directory, faults=()):
        self.root = Path(directory)
        tests = self.root / "supabase" / "tests"
        (self.root / "supabase" / "migrations").mkdir(parents=True)
        tests.mkdir()
        for name in ("0001_core.sql", "0002_money.sql", "0003_rls.sql", "0004_player_verification.sql"):
            (self.root / "supabase" / "migrations" / name).write_text("select 1;\n", encoding="utf-8")
        for name in ("0001_core_smoke.sql", "0001_core_isolation_smoke.sql", "0002_money_smoke.sql",
                     "0003_rls_smoke.sql", "0004_player_verification_smoke.sql", "seed_verify.sql"):
            (tests / name).write_text("select 1;\n", encoding="utf-8")
        self.seed = self.root / "supabase" / "seed.sql"
        self.seed.write_text(f"BEGIN;\nSET LOCAL calblue.seed_confirmation = '';\n{OPT_IN_OFF}\nCOMMIT;\n",
                             encoding="utf-8")
        tools = self.root / "tools"
        tools.mkdir()
        (tools / "stand_in_psql.py").write_text(textwrap.dedent(STAND_IN), encoding="utf-8")
        self.state = tools / "state.json"
        self.state.write_text(json.dumps(
            {"applied": [], "accounts": 0, "verified": 0, "log": [], "faults": list(faults)}), encoding="utf-8")
        self.psql = tools / "psql"
        self.psql.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{tools / "stand_in_psql.py"}" "$@"\n',
                             encoding="utf-8")
        self.psql.chmod(0o755)

    def run(self, command, url=LOCAL):
        out = io.StringIO()
        code = main([command, "--db-url", url, "--psql", str(self.psql), "--root", str(self.root)], out=out)
        return code, out.getvalue()

    @property
    def log(self):
        return json.loads(self.state.read_text())["log"]


class RunnerTests(unittest.TestCase):
    def scratch(self, *faults):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        return Scratch(directory.name, faults)

    # ---- smoke

    def test_each_migration_is_followed_by_its_own_checks(self):
        scratch = self.scratch()
        code, text = scratch.run("smoke")
        self.assertEqual(code, 0, text)
        self.assertEqual(scratch.log, [
            "apply 0001_core.sql", "check 0001_core_isolation_smoke.sql", "check 0001_core_smoke.sql",
            "apply 0002_money.sql", "check 0002_money_smoke.sql",
            "apply 0003_rls.sql", "check 0003_rls_smoke.sql",
            "apply 0004_player_verification.sql", "check 0004_player_verification_smoke.sql"])
        self.assertIn("ok    check 0003_rls_smoke.sql: Synthetic assertions passed; rolling back all test changes.", text)
        self.assertIn("run_db_tests: ok — smoke: 4 migrations applied to an empty database, 5 check scripts passed", text)

    def test_a_failing_check_stops_the_run_and_shows_the_database_error(self):
        scratch = self.scratch("error 0002_money_smoke.sql")
        code, text = scratch.run("smoke")
        self.assertEqual(code, 1)
        self.assertIn("run_db_tests: FAILED — 0002_money_smoke.sql failed (psql exit 3)", text)
        self.assertIn("core smoke assertion failed: capacity is enforced", text)
        self.assertNotIn("apply 0003_rls.sql", scratch.log)

    def test_a_check_must_announce_that_it_passed_and_rolls_back(self):
        scratch = self.scratch("silent 0001_core_smoke.sql")
        code, text = scratch.run("smoke")
        self.assertEqual(code, 1)
        self.assertIn("0001_core_smoke.sql ended without saying that its checks passed", text)

    def test_a_check_that_leaves_an_account_behind_fails(self):
        scratch = self.scratch("leak 0003_rls_smoke.sql")
        code, text = scratch.run("smoke")
        self.assertEqual(code, 1)
        self.assertIn("0003_rls_smoke.sql left 1 account(s) behind", text)

    def test_a_migration_that_does_not_apply_fails(self):
        scratch = self.scratch("break 0002_money.sql")
        code, text = scratch.run("smoke")
        self.assertEqual(code, 1)
        self.assertIn("0002_money.sql did not apply (psql exit 3)", text)
        self.assertIn("relation already exists", text)

    def test_a_migration_without_a_check_fails_before_anything_is_applied(self):
        scratch = self.scratch()
        (scratch.root / "supabase" / "migrations" / "0005_pickup_games.sql").write_text("select 1;\n")
        code, text = scratch.run("smoke")
        self.assertEqual(code, 1)
        self.assertIn("0005_pickup_games.sql has no check in supabase/tests/0005_*.sql", text)
        self.assertEqual(scratch.log, [])

    def test_only_an_empty_supabase_database_is_accepted(self):
        for fault, message in (("not_empty", "the database is not empty"),
                               ("not_supabase", "does not look like a Supabase project")):
            for command in ("smoke", "seed"):
                scratch = self.scratch(fault)
                code, text = scratch.run(command)
                self.assertEqual(code, 1)
                self.assertIn(message, text)
                self.assertEqual(scratch.log, [], f"{command} with {fault} must not run any file")

    # ---- where it may run

    def test_only_a_database_on_this_machine_is_touched(self):
        for url in ("postgresql://postgres:x@db.abcdefghijklmnop.supabase.co:5432/postgres",
                    "postgresql://postgres:x@10.0.0.5:5432/postgres",
                    "postgresql://postgres:x@127.0.0.1:5432/postgres?host=db.example.org",
                    "postgresql://postgres:x@localhost/postgres?hostaddr=10.0.0.5",
                    "postgresql:///postgres?service=production",
                    "mysql://root@127.0.0.1/app"):
            scratch = self.scratch()
            code, text = scratch.run("seed", url)
            self.assertEqual(code, 1, url)
            self.assertIn("run_db_tests: FAILED", text)
            self.assertEqual(scratch.log, [], f"{url} must be refused before psql starts")
        for url in (LOCAL, "postgres://postgres:x@localhost:5432/postgres", "postgresql://postgres:x@[::1]:5432/postgres"):
            check_local(url)
        with self.assertRaises(Failure):
            check_local("postgresql://postgres:x@127.0.0.1.example.org/postgres")

    def test_a_missing_psql_is_reported(self):
        scratch = self.scratch()
        out = io.StringIO()
        code = main(["smoke", "--db-url", LOCAL, "--psql", str(scratch.root / "no-psql"), "--root", str(scratch.root)], out=out)
        self.assertEqual(code, 1)
        self.assertIn("was not found", out.getvalue())

    # ---- seed

    def test_seed_is_refused_then_installed_once_then_left_alone(self):
        scratch = self.scratch()
        code, text = scratch.run("seed")
        self.assertEqual(code, 0, text)
        self.assertEqual(scratch.log, [
            "apply 0001_core.sql", "apply 0002_money.sql", "apply 0003_rls.sql",
            "seed refused", "seed with opt-in", "verify", "seed with opt-in", "verify",
            "apply 0004_player_verification.sql"])
        self.assertIn("seed.sql as committed is refused and writes nothing", text)
        self.assertIn("seed.sql with the opt-in line enabled: 6 demo accounts", text)
        self.assertIn("apply 0004_player_verification.sql over the seeded data", text)
        self.assertEqual(scratch.seed.read_text().count(OPT_IN_ON), 1, "the repository's seed stays opted out")
        self.assertIn(OPT_IN_OFF, scratch.seed.read_text())

    def test_a_second_seed_run_that_changes_data_fails(self):
        scratch = self.scratch("seed_rewrites")
        code, text = scratch.run("seed")
        self.assertEqual(code, 1)
        self.assertIn("the second seed run changed the data: fingerprint " + "a" * 32 + " became " + "b" * 32, text)

    def test_a_seed_that_runs_without_its_opt_in_fails(self):
        scratch = self.scratch("seed_guard_off")
        code, text = scratch.run("seed")
        self.assertEqual(code, 1)
        self.assertIn("the seed must refuse to run without its opt-in line", text)

    def test_the_opt_in_line_must_be_there_exactly_once_and_commented_out(self):
        for change in (lambda text: text.replace(OPT_IN_OFF, ""),
                       lambda text: text.replace(OPT_IN_OFF, OPT_IN_ON),
                       lambda text: text + OPT_IN_OFF + "\n"):
            scratch = self.scratch()
            scratch.seed.write_text(change(scratch.seed.read_text()), encoding="utf-8")
            code, text = scratch.run("seed")
            self.assertEqual(code, 1)
            self.assertIn("must hold its opt-in line exactly once, commented out", text)
            self.assertEqual(scratch.log, [])

    def test_a_later_migration_that_fails_over_data_is_reported(self):
        scratch = self.scratch("break 0004_player_verification.sql")
        code, text = scratch.run("seed")
        self.assertEqual(code, 1)
        self.assertIn("0004_player_verification.sql did not apply over the seeded data", text)

    # ---- the real repository

    def test_every_real_migration_has_a_check_and_the_real_seed_is_opted_out(self):
        ordered = migrations(ROOT)
        self.assertEqual([path.name for _, path in ordered][:3], ["0001_core.sql", "0002_money.sql", "0003_rls.sql"])
        self.assertEqual([number for number, _ in ordered], [f"{index:04d}" for index in range(1, len(ordered) + 1)])
        for number, path in ordered:
            self.assertTrue(scripts_for(ROOT, number), f"{path.name} has no check in supabase/tests")
        seed = (ROOT / "supabase" / "seed.sql").read_text(encoding="utf-8")
        self.assertEqual(seed.count(OPT_IN_OFF), 1)
        self.assertEqual(seed.count(OPT_IN_ON), 1)
        verify = (ROOT / "supabase" / "tests" / "seed_verify.sql").read_text(encoding="utf-8")
        # The runner finds the fingerprint by this column and this sentence; keep them in step.
        self.assertIn("AS dataset_fingerprint", verify)
        self.assertIn("'Fixture and read-access assertions passed", verify)

if __name__ == "__main__":
    unittest.main()
