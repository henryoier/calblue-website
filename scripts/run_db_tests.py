#!/usr/bin/env python3
"""Run the migrations and their SQL checks against a throwaway local database.

    python3 scripts/run_db_tests.py smoke --db-url postgresql://postgres:postgres@127.0.0.1:54322/postgres
    python3 scripts/run_db_tests.py seed  --db-url postgresql://postgres:postgres@127.0.0.1:54322/postgres

Each command needs an EMPTY database that looks like a new Supabase project: the `auth` schema and
the `anon` and `authenticated` roles, and nothing of ours in `public`. CI starts one inside its
runner with the Supabase CLI and throws it away afterwards. The address must be on this machine:
anything but a loopback host is refused, because `smoke` applies migrations and `seed` commits
demo data.

smoke  Apply each migration in order and, straight after it, run the scripts written for it
       (supabase/tests/NNNN_*.sql). Every script must finish without an error, say that it is
       rolling back, and leave no account behind. This is the order the guides in supabase/ give
       for a scratch project: a migration's checks belong before the next migration.
seed   Apply the migrations the seed was written for. Check that the seed refuses to run without
       its opt-in line, run it with the line enabled, verify, run it again and verify again: the
       two fingerprints must match. Then apply the later migrations on top of that data.

Needs `psql` and nothing else. No hosted project is ever contacted.
"""

import argparse
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import time
import urllib.parse

if __package__:
    from . import check_seed
else:
    import check_seed

ROOT = pathlib.Path(__file__).resolve().parent.parent
MIGRATION = re.compile(r"^(\d{4})_.+\.sql$")
OPT_IN_OFF = "-- SET LOCAL calblue.seed_confirmation = 'disposable-demo-only';"
OPT_IN_ON = "SET LOCAL calblue.seed_confirmation = 'disposable-demo-only';"
REFUSAL = "seed_disposable_confirmation_required"
FINGERPRINT = re.compile(r"^([0-9a-f]{32})\|Fixture and read-access assertions passed", re.MULTILINE)
NOTICE = re.compile(r"NOTICE:\s+(.*)")
LOOPBACK = ("127.0.0.1", "localhost", "::1")


class Failure(Exception):
    """A step did not do what it must. The message is what the person reads."""


def check_local(url):
    """Refuse every address that is not a database on this machine."""
    parts = urllib.parse.urlsplit(url)
    if parts.scheme not in ("postgresql", "postgres"):
        raise Failure("--db-url must be a postgresql:// address")
    redirects = set(urllib.parse.parse_qs(parts.query)) & {"host", "hostaddr", "service"}
    if parts.hostname not in LOOPBACK or redirects:
        raise Failure(f"refusing to touch {parts.hostname or 'an unnamed host'}: this runs only against a "
                      "database on this machine (127.0.0.1, localhost or ::1)")


def migrations(root):
    """[(number, path)] for supabase/migrations/NNNN_*.sql, in order."""
    found = []
    for path in sorted((pathlib.Path(root) / "supabase" / "migrations").glob("*.sql")):
        match = MIGRATION.match(path.name)
        if match:
            found.append((match.group(1), path))
    if not found:
        raise Failure("no migrations found under supabase/migrations")
    return found


def scripts_for(root, number):
    return sorted((pathlib.Path(root) / "supabase" / "tests").glob(f"{number}_*.sql"))


def tail(text, lines=25):
    kept = [line for line in text.strip().splitlines() if line.strip()][-lines:]
    return "\n".join(f"    {line[:400]}" for line in kept)


class Database:
    def __init__(self, url, psql="psql", run=subprocess.run):
        check_local(url)
        self.url, self.psql, self._run = url, psql, run

    def _psql(self, *arguments):
        # psql reads PG* variables; none of them may point this run anywhere else.
        environment = {key: value for key, value in os.environ.items() if not key.startswith("PG")}
        environment["PGCONNECT_TIMEOUT"] = "15"
        command = [self.psql, self.url, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", *arguments]
        try:
            done = self._run(command, capture_output=True, text=True, env=environment, timeout=900)
        except FileNotFoundError:
            raise Failure(f"{self.psql} was not found; install the PostgreSQL client or pass --psql PATH")
        except subprocess.TimeoutExpired:
            raise Failure("psql did not finish within 15 minutes")
        return done.returncode, done.stdout, done.stderr

    def file(self, path):
        return self._psql("-f", str(path))

    def value(self, sql):
        code, output, errors = self._psql("-c", sql)
        if code != 0:
            raise Failure(f"could not query the database (psql exit {code})\n{tail(errors)}")
        return output.strip()

    def accounts(self):
        return int(self.value("select count(*) from auth.users"))


def require_empty(database):
    looks_right = database.value(
        "select (to_regclass('auth.users') is not null"
        " and exists (select from pg_roles where rolname = 'anon')"
        " and exists (select from pg_roles where rolname = 'authenticated'))::text")
    if looks_right != "true":
        raise Failure("the database does not look like a Supabase project: it needs auth.users and the "
                      "anon and authenticated roles")
    empty = database.value(
        "select (to_regclass('public.profiles') is null and (select count(*) from auth.users) = 0)::text")
    if empty != "true":
        raise Failure("the database is not empty: public.profiles or an account already exists. "
                      "Start from a fresh scratch database.")


def apply(database, migration, say, note=""):
    started = time.monotonic()
    code, _, errors = database.file(migration)
    if code != 0:
        raise Failure(f"{migration.name} did not apply{note} (psql exit {code})\n{tail(errors)}")
    say(f"  ok    apply {migration.name}{note} ({time.monotonic() - started:.1f} s)")


def run_smoke(database, root, say):
    ordered = migrations(root)
    for number, migration in ordered:
        if not scripts_for(root, number):
            raise Failure(f"{migration.name} has no check in supabase/tests/{number}_*.sql")
    require_empty(database)
    count = 0
    for number, migration in ordered:
        apply(database, migration, say)
        for script in scripts_for(root, number):
            code, _, errors = database.file(script)
            if code != 0:
                raise Failure(f"{script.name} failed (psql exit {code})\n{tail(errors)}")
            verdicts = [text.strip() for text in NOTICE.findall(errors) if "rolling back" in text.lower()]
            if not verdicts:
                raise Failure(f"{script.name} ended without saying that its checks passed and that it rolls back"
                              f"\n{tail(errors)}")
            left = database.accounts()
            if left:
                raise Failure(f"{script.name} left {left} account(s) behind; a check must roll everything back")
            count += 1
            say(f"  ok    check {script.name}: {verdicts[-1]}")
    return f"smoke: {len(ordered)} migrations applied to an empty database, {count} check scripts passed"


def fingerprint(database, script, label):
    code, output, errors = database.file(script)
    if code != 0:
        raise Failure(f"{script.name} failed {label} (psql exit {code})\n{tail(errors)}")
    match = FINGERPRINT.search(output)
    if not match:
        raise Failure(f"{script.name} printed no fingerprint {label}\n{tail(output)}")
    return match.group(1)


def run_seed(database, root, say):
    require_empty(database)
    root = pathlib.Path(root)
    ordered = [path for _, path in migrations(root)]
    needed = list(check_seed.REQUIRED_MIGRATIONS)
    if [path.name for path in ordered[:len(needed)]] != needed:
        raise Failure(f"the seed is written for {', '.join(needed)}; they must be the first migrations")
    seed, verify = root / "supabase" / "seed.sql", root / "supabase" / "tests" / "seed_verify.sql"
    source = seed.read_text(encoding="utf-8")
    if source.count(OPT_IN_OFF) != 1 or source.count(OPT_IN_ON) != 1:
        raise Failure("supabase/seed.sql must hold its opt-in line exactly once, commented out")

    for migration in ordered[:len(needed)]:
        apply(database, migration, say)

    code, _, errors = database.file(seed)
    if code == 0 or REFUSAL not in errors:
        raise Failure(f"the seed must refuse to run without its opt-in line ({REFUSAL}); psql exit {code}"
                      f"\n{tail(errors)}")
    if database.accounts():
        raise Failure("the refused seed still wrote accounts")
    say("  ok    seed.sql as committed is refused and writes nothing")

    with tempfile.TemporaryDirectory(prefix="calblue-seed-") as directory:
        opted_in = pathlib.Path(directory) / "seed.sql"
        opted_in.write_text(source.replace(OPT_IN_OFF, OPT_IN_ON), encoding="utf-8")
        code, _, errors = database.file(opted_in)
        if code != 0:
            raise Failure(f"the seed failed with its opt-in line enabled (psql exit {code})\n{tail(errors)}")
        accounts = database.accounts()
        if not accounts:
            raise Failure("the seed reported success and wrote no account")
        say(f"  ok    seed.sql with the opt-in line enabled: {accounts} demo accounts")
        first = fingerprint(database, verify, "after the first seed run")
        say(f"  ok    check {verify.name}: fingerprint {first}")
        code, _, errors = database.file(opted_in)
        if code != 0:
            raise Failure(f"the second seed run failed (psql exit {code})\n{tail(errors)}")
        second = fingerprint(database, verify, "after the second seed run")
        if second != first:
            raise Failure(f"the second seed run changed the data: fingerprint {first} became {second}")
        say(f"  ok    second seed run changed nothing: fingerprint {second}")

    later = ordered[len(needed):]
    for migration in later:
        apply(database, migration, say, note=" over the seeded data")
    return (f"seed: refused without opt-in, installed once, unchanged by a second run; "
            f"{len(later)} later migration(s) applied over the data")


def main(argv=None, out=None, run=subprocess.run):
    out = sys.stdout if out is None else out
    parser = argparse.ArgumentParser(description="Run migrations and their SQL checks on a throwaway local database.")
    parser.add_argument("command", choices=("smoke", "seed"))
    parser.add_argument("--db-url", required=True, help="postgresql:// address of an EMPTY local Supabase database")
    parser.add_argument("--psql", default="psql", help="psql executable (default: psql)")
    parser.add_argument("--root", default=str(ROOT), help="repository root (default: this repository)")
    args = parser.parse_args(argv)

    def say(line=""):
        print(line, file=out, flush=True)

    try:
        database = Database(args.db_url, args.psql, run)
        summary = (run_smoke if args.command == "smoke" else run_seed)(database, args.root, say)
    except Failure as failure:
        say(f"run_db_tests: FAILED — {failure}")
        return 1
    say(f"run_db_tests: ok — {summary}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
