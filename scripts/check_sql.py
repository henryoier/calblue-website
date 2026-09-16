#!/usr/bin/env python3
"""Check this repository's SQL conventions without running a database.

    python3 scripts/check_sql.py

This is a lexer plus checks for unquoted, public-qualified DDL, not a SQL
parser. Nested comments, standard/E strings and tagged dollar bodies are
supported. Quoted identifiers are rejected instead of bypassing checks.
Types, dynamic SQL, function semantics and concurrency need a scratch
Supabase execution test. The SQL is a one-time installation, not replayable.
Generation drift is checked separately and without writes:
    python3 scripts/build_migrations.py --check
"""

from dataclasses import dataclass
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
MIG_DIR = ROOT / "supabase" / "migrations"
CORE = "0001_core.sql"
CORE_TABLES = {
    "profiles", "players", "venues", "clubs", "teams", "competitions",
    "games", "role_grants", "competition_registrations", "game_registrations",
}
API_ROLES = {"public", "anon", "authenticated"}
DOLLAR = re.compile(r"\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$")


@dataclass
class Scan:
    clean: str
    comments_removed: str
    bodies: list
    problems: list


def line_of(text, index):
    return text.count("\n", 0, index) + 1


def scan_sql(sql):
    """Mask noise without changing character offsets or newline positions."""
    clean, comments_removed = list(sql), list(sql)
    problems, bodies = [], []
    i, n = 0, len(sql)

    def blank(target, start, end):
        for pos in range(start, end):
            if target[pos] != "\n":
                target[pos] = " "

    while i < n:
        start, comment = i, False
        if sql.startswith("--", i):
            end = sql.find("\n", i)
            i, comment = (n if end == -1 else end), True
        elif sql.startswith("/*", i):
            i, depth = i + 2, 1
            while i < n and depth:
                if sql.startswith("/*", i):
                    depth, i = depth + 1, i + 2
                elif sql.startswith("*/", i):
                    depth, i = depth - 1, i + 2
                else:
                    i += 1
            if depth:
                problems.append((start, "unterminated block comment"))
            comment = True
        elif sql[i] in "'\"":
            quote = sql[i]
            escaped = (quote == "'" and i > 0 and sql[i - 1] in "eE"
                       and (i < 2 or not (sql[i - 2].isalnum() or sql[i - 2] == "_")))
            i, closed = i + 1, False
            while i < n:
                if escaped and sql[i] == "\\":
                    i = min(i + 2, n)
                elif sql[i] == quote:
                    i += 1
                    if i < n and sql[i] == quote:
                        i += 1
                    else:
                        closed = True
                        break
                else:
                    i += 1
            if not closed:
                problems.append((start, "unterminated quoted string or identifier"))
            if quote == '"':
                problems.append((start, "quoted identifiers are outside this checker's supported DDL"))
        elif (sql[i] == "$" and (i == 0 or not (sql[i - 1].isalnum() or sql[i - 1] in "_$"))
              and (match := DOLLAR.match(sql, i))):
            delimiter = match.group()
            end = sql.find(delimiter, match.end())
            if end == -1:
                problems.append((start, f"unterminated dollar body {delimiter}"))
                i = n
            else:
                i = end + len(delimiter)
                bodies.append((start, i, sql[match.end():end]))
        else:
            i += 1
            continue
        blank(clean, start, i)
        if comment:
            blank(comments_removed, start, i)
    return Scan("".join(clean), "".join(comments_removed), bodies, problems)


def strip_noise(sql):
    return scan_sql(sql).clean


def check_parens(name, clean, problems):
    depth = 0
    for pos, char in enumerate(clean):
        depth += (char == "(") - (char == ")")
        if depth < 0:
            problems.append(f"{name}:{line_of(clean, pos)}: unbalanced closing parenthesis")
            return
    if depth:
        problems.append(f"{name}: {depth} unclosed parenthesis/es")


def statements(scan):
    start = 0
    for match in re.finditer(";", scan.clean):
        if scan.clean[start:match.start()].strip():
            yield start, match.start(), scan.clean[start:match.start()]
        start = match.end()
    if scan.clean[start:].strip():
        yield start, len(scan.clean), scan.clean[start:]


def matches(pattern, text):
    return re.search(pattern, text, re.I | re.S)


def split_columns(body):
    """Split an outer table list, ignoring nested parentheses."""
    depth, start, result = 0, 0, []
    for pos, char in enumerate(body):
        depth += (char == "(") - (char == ")")
        if char == "," and depth == 0:
            result.append(body[start:pos].strip())
            start = pos + 1
    result.append(body[start:].strip())
    return result


def function_signature(name, args, declaration=False):
    # Core helpers only have no arguments or named uuid arguments; this does
    # not attempt to parse every PostgreSQL argument mode/default/type.
    types = []
    for arg in args.split(","):
        words = arg.lower().split()
        if words:
            types.append(words[-1] if declaration else " ".join(words))
    return name.lower() + "(" + ",".join(types) + ")"


FUNCTION = r"^\s*create\s+(?:or\s+replace\s+)?function\s+public\.(\w+)\s*\(([^()]*)\)"
RLS = r"^\s*alter\s+table\s+public\.(\w+)\s+(enable|disable)\s+row\s+level\s+security\s*$"


def core_checks(scan, tables, problems):
    """Core must be safe independently of the later policy migration."""
    parts = list(statements(scan))
    if not parts or parts[0][2].strip().lower() not in {"begin", "begin transaction"}:
        problems.append(f"{CORE}: core installation must start with BEGIN")
    if not parts or parts[-1][2].strip().lower() != "commit":
        problems.append(f"{CORE}: core installation must end with COMMIT")
    for _, _, statement in parts[1:-1]:
        if matches(r"^\s*(?:begin|start\s+transaction|commit|end|rollback)\b", statement):
            problems.append(f"{CORE}: transaction boundaries cannot appear inside the installation")
    for table in sorted(CORE_TABLES - tables.keys()):
        problems.append(f"{CORE}: required core table public.{table} is missing")

    touched, rls = set(), set()
    table_revokes, function_revokes, functions = {}, {}, {}
    for start, end, statement in parts:
        touch = matches(
            r"^\s*create\s+trigger\s+\w+\s+before\s+update\s+on\s+public\.(\w+)\s+"
            r"for\s+each\s+row\s+execute\s+function\s+public\.touch_updated_at\s*\(\s*\)\s*$",
            statement,
        )
        if touch:
            touched.add(touch[1].lower())
        security = matches(RLS, statement)
        if security:
            if security[2].lower() == "enable":
                rls.add(security[1].lower())
            else:
                rls.discard(security[1].lower())
        revoke = matches(r"^\s*revoke\s+(all(?:\s+privileges)?|execute)\s+on\s+(table|function)\s+(.+?)\s+from\s+(.+?)\s*$", statement)
        if revoke:
            roles = {role.strip().lower() for role in revoke[4].split(",")}
            if revoke[2].lower() == "table" and revoke[1].lower().startswith("all"):
                for table in re.findall(r"public\.(\w+)", revoke[3], re.I):
                    table_revokes.setdefault(table.lower(), set()).update(roles)
            elif revoke[2].lower() == "function":
                for name, args in re.findall(r"public\.(\w+)\s*\(([^()]*)\)", revoke[3], re.I):
                    key = function_signature(name, args)
                    function_revokes.setdefault(key, set()).update(roles)
        if matches(r"^\s*grant\b.+\bto\s+.*\b(public|anon|authenticated)\b", statement):
            problems.append(f"{CORE}: API role grants belong in the later policy migration")
        function = matches(FUNCTION, statement)
        if function:
            key = function_signature(function[1], function[2], declaration=True)
            bodies = [body for body in scan.bodies if start <= body[0] < end]
            header_end = bodies[0][0] if bodies else end
            header = scan.clean[start:header_end]
            paths = list(re.finditer(r"\bset\s+search_path\s*(?:=|to)", header, re.I))
            fixed_path = False
            if len(paths) == 1:
                suffix = scan.comments_removed[start + paths[0].end():header_end]
                fixed_path = bool(matches(r"^\s*(?:''|pg_catalog)\s*(?=as\b|language\b|security\b|stable\b|volatile\b|immutable\b|$)", suffix))
            if not fixed_path:
                problems.append(f"{CORE}: public.{key} needs a fixed empty or pg_catalog search_path")
            if not bodies:
                problems.append(f"{CORE}: public.{key} needs a dollar-quoted function body for inspection")
            body = scan_sql(bodies[0][2]) if bodies else scan_sql("")
            for pos, issue in body.problems:
                problems.append(f"{CORE}: public.{key} body line {line_of(bodies[0][2], pos)}: {issue}")
            functions[function[1].lower()] = (statement, body)

    for table, definition in sorted(tables.items()):
        if table not in rls:
            problems.append(f"{CORE}: public.{table} must enable RLS in the core migration")
        missing_roles = API_ROLES - table_revokes.get(table, set())
        if missing_roles:
            problems.append(f"{CORE}: public.{table} must revoke ALL table privileges from {', '.join(sorted(missing_roles))}")
        columns = split_columns(definition)
        for column in ("created_at", "updated_at"):
            if not any(matches(rf"^{column}\s+timestamptz\s+not\s+null\s+default\s+(?:pg_catalog\.)?now\s*\(\s*\)", value) for value in columns):
                problems.append(f"{CORE}: public.{table}.{column} needs timestamptz NOT NULL DEFAULT now()")
        if table not in touched:
            problems.append(f"{CORE}: public.{table} needs a row BEFORE UPDATE touch_updated_at trigger")

    for _, _, statement in parts:
        function = matches(FUNCTION, statement)
        if function:
            key = function_signature(function[1], function[2], declaration=True)
            missing_roles = API_ROLES - function_revokes.get(key, set())
            if missing_roles:
                problems.append(f"{CORE}: public.{key} must revoke EXECUTE from {', '.join(sorted(missing_roles))}")

    profiles = split_columns(tables.get("profiles", ""))
    if not any(matches(r"^roles\s+text\s*\[\s*\]\s+not\s+null\b", column) for column in profiles):
        problems.append(f"{CORE}: profiles.roles must be a real non-null text[] column")
    players = split_columns(tables.get("players", ""))
    if not any(matches(r"^payer_account_id\s+uuid\s+generated\s+always\s+as\s*\(\s*coalesce\s*\(\s*account_id\s*,\s*guardian_account_id\s*\)\s*\)\s+stored\s*$", column) for column in players):
        problems.append(f"{CORE}: players.payer_account_id must store coalesce(account_id, guardian_account_id)")
    if not any(matches(r"^\s*create\s+unique\s+index\s+players_one_per_account\s+on\s+public\.players\s*\(\s*account_id\s*\)\s*(?:where\s+account_id\s+is\s+not\s+null\s*)?$", statement) for _, _, statement in parts):
        problems.append(f"{CORE}: players_one_per_account must be a unique index on players(account_id)")
    registrations = split_columns(tables.get("game_registrations", ""))
    if not any(matches(r"^(?:constraint\s+\w+\s+)?unique\s*\(\s*game_id\s*,\s*player_id\s*\)\s*$", column) for column in registrations):
        problems.append(f"{CORE}: game_registrations needs UNIQUE (game_id, player_id)")
    for name in ("enforce_game_capacity", "promote_from_waitlist"):
        body = functions.get(name, ("", scan_sql("")))[1]
        if not matches(r"\b(?:pg_catalog\.)?pg_advisory_xact_lock\s*\(", body.clean):
            problems.append(f"{CORE}: {name} must execute a per-game advisory lock")
    for name in ("handle_new_user", "sync_role_claim", "enforce_game_capacity", "promote_from_waitlist", "on_slot_freed"):
        declaration = functions.get(name, ("", None))[0]
        if not matches(r"\bsecurity\s+definer\b", declaration):
            problems.append(f"{CORE}: {name} must be SECURITY DEFINER for its trusted trigger work")


def check_migrations(migrations):
    """Return findings for a mapping of migration filenames to SQL strings."""
    problems = []
    if CORE not in migrations:
        problems.append(f"{CORE}: required core migration is missing")
    seen, all_rls = set(), set()
    for name, sql in sorted(migrations.items()):
        scan = scan_sql(sql)
        for pos, issue in scan.problems:
            problems.append(f"{name}:{line_of(sql, pos)}: {issue}")
        check_parens(name, scan.clean, problems)
        events, tables = [], {}
        for start, _, statement in statements(scan):
            table = matches(r"^\s*create\s+table\s+(?:if\s+not\s+exists\s+)?public\.(\w+)\s*\((.*)\)\s*$", statement)
            if table:
                table_name = table[1].lower()
                tables[table_name] = table[2]
                events.append((start + table.start(1), "create", table_name))
            policy = matches(r"^\s*create\s+policy\b", statement)
            if policy and matches(r"\b(?:from|join)\s+public\.profiles\b", statement):
                problems.append(f"{name}:{line_of(sql, start + policy.end() - len('policy'))}: policy queries profiles; use JWT role helpers to avoid recursion")
            for match in re.finditer(r"\breferences\s+public\.(\w+)", statement, re.I):
                events.append((start + match.start(), "ref", match[1].lower()))
            security = matches(RLS, statement)
            if security:
                if security[2].lower() == "enable":
                    all_rls.add(security[1].lower())
                else:
                    all_rls.discard(security[1].lower())
        for pos, kind, table in sorted(events):
            if kind == "create":
                if table in seen:
                    problems.append(f"{name}:{line_of(sql, pos)}: public.{table} created twice")
                seen.add(table)  # Self-referencing foreign keys are legal.
            elif table not in seen:
                problems.append(f"{name}:{line_of(sql, pos)}: references public.{table} before it is created")
        if name == CORE:
            core_checks(scan, tables, problems)
        if name == "0002_money.sql":
            for pattern, reason in (
                (r"create\s+unique\s+index\s+charges_auto_once\s+on\s+public\.charges\b", "charges_auto_once unique index"),
                (r"constraint\s+billing_periods_no_overlap\s+exclude\s+using\s+gist\b", "billing_periods_no_overlap exclusion constraint"),
                (r"create\s+trigger\s+charges_immutable\s+before\s+update\s+or\s+delete\s+on\s+public\.charges\b", "charge immutability trigger"),
            ):
                if not matches(pattern, scan.clean):
                    problems.append(f"{name}: missing {reason}")
    if "0003_rls.sql" in migrations:
        for table in sorted(seen - all_rls):
            problems.append(f"0003_rls.sql: public.{table} never has row-level security enabled")
    return problems


def main():
    if len(sys.argv) > 1:
        print("usage: python3 scripts/check_sql.py (generation drift: scripts/build_migrations.py --check)", file=sys.stderr)
        return 2
    files = sorted(MIG_DIR.glob("*.sql")) if MIG_DIR.exists() else []
    migrations = {path.name: path.read_text() for path in files}
    problems = check_migrations(migrations)
    if problems:
        print("check_sql: FAILED")
        for problem in problems:
            print(f"  - {problem}")
        return 1
    print(f"check_sql: ok ({len(files)} migration(s); structural checks only, scratch Supabase execution still required)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
