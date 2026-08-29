#!/usr/bin/env python3
"""Structural checks on the generated migrations.

    python3 scripts/check_sql.py

There is no Postgres on the development machine, so nothing here proves the SQL *runs*. What it can
prove is a set of structural properties that are cheap to get wrong and expensive to discover late:
unbalanced dollar-quoting, a foreign key pointing at a table created later in the run, a table with
row-level security never enabled, or a policy that queries `profiles` and therefore recurses.

Treat a pass as "no obvious structural defect", not as "this applies cleanly". Applying it to a
scratch Supabase project is still the real test.
"""

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
MIG_DIR = ROOT / "supabase" / "migrations"


def strip_noise(sql):
    """Remove line comments, string literals and dollar-quoted bodies.

    Replaces each with equivalent-length whitespace so byte offsets still line up with the original,
    which keeps reported line numbers honest.
    """
    out = list(sql)
    i, n = 0, len(sql)
    while i < n:
        two = sql[i:i + 2]
        if two == "--":
            j = sql.find("\n", i)
            j = n if j == -1 else j
            for k in range(i, j):
                out[k] = " "
            i = j
        elif two == "/*":
            j = sql.find("*/", i + 2)
            j = n if j == -1 else j + 2
            for k in range(i, j):
                if out[k] != "\n":
                    out[k] = " "
            i = j
        elif sql[i] == "'":
            j = i + 1
            while j < n:
                if sql[j] == "'":
                    if j + 1 < n and sql[j + 1] == "'":
                        j += 2
                        continue
                    j += 1
                    break
                j += 1
            for k in range(i, min(j, n)):
                if out[k] != "\n":
                    out[k] = " "
            i = j
        elif two == "$$":
            j = sql.find("$$", i + 2)
            j = n if j == -1 else j + 2
            for k in range(i, j):
                if out[k] != "\n":
                    out[k] = " "
            i = j
        else:
            i += 1
    return "".join(out)


def line_of(text, index):
    return text.count("\n", 0, index) + 1


def check_dollar_quotes(name, sql, problems):
    if sql.count("$$") % 2 != 0:
        problems.append(f"{name}: odd number of $$ markers — a function body is unterminated")


def check_parens(name, clean, problems):
    depth = 0
    for i, ch in enumerate(clean):
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth < 0:
                problems.append(f"{name}:{line_of(clean, i)}: unbalanced closing parenthesis")
                return
    if depth:
        problems.append(f"{name}: {depth} unclosed parenthesis/es")


def main():
    files = sorted(MIG_DIR.glob("*.sql")) if MIG_DIR.exists() else []
    if not files:
        print("check_sql: no migrations yet, nothing to check")
        return 0

    problems = []
    created = {}          # table -> (file, global order index)
    order = 0
    combined_clean = []
    combined_raw = []

    for path in files:
        sql = path.read_text()
        clean = strip_noise(sql)
        combined_clean.append((path.name, clean))
        combined_raw.append(sql)
        check_dollar_quotes(path.name, sql, problems)
        check_parens(path.name, clean, problems)

        for m in re.finditer(r"create table (?:if not exists )?public\.(\w+)", clean):
            order += 1
            if m.group(1) in created:
                problems.append(f"{path.name}:{line_of(clean, m.start())}: {m.group(1)} created twice")
            created[m.group(1)] = (path.name, order)

    # --- foreign keys must not point at a table created later in the run
    order = 0
    for name, clean in combined_clean:
        events = []
        for m in re.finditer(r"create table (?:if not exists )?public\.(\w+)", clean):
            events.append((m.start(), "create", m.group(1)))
        for m in re.finditer(r"references\s+public\.(\w+)", clean):
            events.append((m.start(), "ref", m.group(1)))
        for pos, kind, table in sorted(events):
            order += 1
            if kind == "create":
                created[table] = (name, order)
            elif table not in created:
                problems.append(
                    f"{name}:{line_of(clean, pos)}: references public.{table} before it is created")
            elif created[table][1] > order:
                problems.append(
                    f"{name}:{line_of(clean, pos)}: references public.{table}, created later")

    all_clean = "\n".join(c for _, c in combined_clean)
    # Invariants live inside function bodies and string literals, which strip_noise
    # blanks out, so they are searched in the untouched source.
    all_raw = "\n".join(combined_raw)

    # --- every table must have RLS enabled somewhere
    rls_on = set(re.findall(r"alter table public\.(\w+)\s+enable row level security", all_clean))
    rls_file = MIG_DIR / "0003_rls.sql"
    if rls_file.exists():
        for table in sorted(created):
            if table not in rls_on:
                problems.append(f"0003_rls.sql: public.{table} never has row-level security enabled")

    # --- a policy that queries profiles recurses into its own policy
    for name, clean in combined_clean:
        for m in re.finditer(r"create policy\b", clean):
            end = clean.find(";", m.start())
            body = clean[m.start(): end if end != -1 else len(clean)]
            if re.search(r"from\s+public\.profiles", body):
                problems.append(
                    f"{name}:{line_of(clean, m.start())}: policy selects from public.profiles — "
                    "this recurses; read roles from the JWT via app_roles() instead")

    # --- invariants the design depends on, asserted so a refactor cannot quietly drop them
    invariants = [
        ("pg_advisory_xact_lock", "capacity enforcement must take a per-game advisory lock"),
        ("players_one_per_account", "at most one identity per account (unique index) is missing"),
        ("payer_account_id", "players.payer_account_id generated column is missing"),
    ]
    money = MIG_DIR / "0002_money.sql"
    if money.exists():
        invariants += [
            ("charges_auto_once", "the partial unique index making finalisation idempotent is missing"),
            ("charges cannot be deleted", "charge immutability trigger is missing"),
            ("billing_periods_no_overlap", "billing periods must not be allowed to overlap"),
        ]
    for needle, why in invariants:
        if needle not in all_raw:
            problems.append(f"invariant lost: {why} (looked for {needle!r})")

    # --- profiles.roles must be a set, not the scalar it used to be
    if re.search(r"\brole\s+text\s+not null default 'user'", all_clean):
        problems.append("profiles still has a scalar `role` column; it should be `roles text[]`")

    # --- seed data must be re-runnable and must not contain real people
    seed = ROOT / "supabase" / "seed.sql"
    if seed.exists():
        seed_sql = seed.read_text()
        seed_clean = strip_noise(seed_sql)
        inserts = len(re.findall(r"insert into ", seed_clean))
        guarded = len(re.findall(r"on conflict", seed_clean))
        if guarded < inserts:
            problems.append(
                f"seed.sql: {inserts - guarded} insert(s) without ON CONFLICT — seed must be re-runnable")
        if "begin;" not in seed_clean or "commit;" not in seed_clean:
            problems.append("seed.sql: should be wrapped in a transaction")
        # emails live inside string literals, which strip_noise blanks — search the raw text
        for m in re.finditer(r"[\w.+-]+@(?!example\.com\b)[\w.-]+\.\w+", seed_sql):
            problems.append(f"seed.sql: non-example.com address {m.group(0)!r} — no real PII in seed")

    if problems:
        print("check_sql: FAILED")
        for p in problems:
            print(f"  - {p}")
        return 1

    print(f"check_sql: ok ({len(files)} migration(s), {len(created)} tables, "
          f"{len(rls_on)} with RLS enabled)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
