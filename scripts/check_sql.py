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
MONEY = "0002_money.sql"
POLICIES = "0003_rls.sql"
VERIFICATION = "0004_player_verification.sql"
PICKUP = "0005_pickup_games.sql"
LANDED_TARGETS = (CORE, MONEY, POLICIES, VERIFICATION, PICKUP)
CORE_TABLES = {
    "profiles", "players", "venues", "clubs", "teams", "competitions",
    "games", "role_grants", "competition_registrations", "game_registrations",
}
MONEY_TABLES = {
    "fee_schedules", "billing_periods", "charges", "payments",
    "period_player_summaries", "period_account_summaries", "audit_log",
}
MONEY_MUTABLE_TABLES = {"fee_schedules", "billing_periods", "charges", "payments"}
MONEY_VIEWS = {"v_account_balance", "v_account_ledger", "v_public_roster"}
API_ROLES = {"public", "anon", "authenticated"}
AUTH_FUNCTIONS = {
    "app_roles()", "has_role(text)", "is_admin()",
    "has_grant_on_competition(uuid,text[])", "owns_player(uuid)",
    "can_register_player(uuid)", "manages_game(uuid)",
    "can_register_for_game(uuid,uuid)", "read_game_emergency_contacts(uuid)",
    "finalise_game_attendance(uuid)", "close_billing_period(uuid)",
    "read_public_roster()",
}
ANON_FUNCTIONS = {"read_public_roster()"}
GUARD_FUNCTIONS = {
    "profiles": "guard_role_change",
    "players": "guard_verification",
    "game_registrations": "guard_attendance",
}
PUBLIC_COLUMNS = {
    "clubs": {"id", "name", "short_name", "crest_url", "city", "is_us", "created_at", "updated_at"},
    "venues": {"id", "name", "address", "map_url", "surface", "timezone", "created_at", "updated_at"},
}
ANON_GAME_COLUMNS = {
    "id", "competition_id", "team_id", "game_type", "title", "opponent", "home_away",
    "home_team_id", "away_team_id", "stage_label", "round_number", "venue_id", "field_label",
    "timezone", "gather_time", "start_time", "end_time", "game_date", "capacity", "min_players",
    "waitlist_enabled", "registration_opens_at", "registration_closes_at", "kit_color",
    "fee_override", "no_show_fee_override", "status", "cancellation_reason",
    "attendance_locked_at", "created_at", "updated_at",
}
CHARGE_INSERT_COLUMNS = {
    "id", "player_id", "account_id", "game_id", "competition_id", "billing_period_id",
    "kind", "description", "amount", "charge_date", "source",
}
ROSTER_COLUMNS = ("id", "display_name", "preferred_number", "default_positions", "photo_url")
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
    # The checked migrations use no arguments or simple named scalar arguments.
    # This does not attempt to parse every PostgreSQL argument mode/default/type.
    types = []
    for arg in args.split(","):
        if declaration:
            arg = re.split(r"\bdefault\b|=", arg, maxsplit=1, flags=re.I)[0]
        words = arg.lower().split()
        if words:
            types.append(words[-1] if declaration else " ".join(words))
    return name.lower() + "(" + ",".join(types) + ")"


FUNCTION = r"^\s*create\s+(?:or\s+replace\s+)?function\s+public\.(\w+)\s*\(([^()]*)\)"
RLS = r"^\s*alter\s+table\s+public\.(\w+)\s+(enable|disable)\s+row\s+level\s+security\s*$"
POLICY = r"^\s*create\s+policy\s+(\w+)\s+on\s+public\.(\w+)\b(.*)$"


def parse_grant(statement, revoke=False):
    """Parse the small explicit GRANT subset used by the policy migration.

    Unsupported forms (ALL objects, grant options, implicit schemas or roles)
    return None and are rejected. This intentionally is not a PostgreSQL parser.
    """
    action, connector = ("revoke", "from") if revoke else ("grant", "to")
    grant = matches(rf"^\s*{action}\s+(.+?)\s+on\s+(?:(table|function|sequence|schema)\s+)?(.+?)\s+{connector}\s+(.+?)\s*$", statement)
    if not grant:
        return None
    roles = [value.strip().lower() for value in grant[4].split(",")]
    if not roles or any(not re.fullmatch(r"[a-z_][a-z_0-9]*", role) for role in roles):
        return None
    privileges = []
    for value in split_columns(grant[1]):
        privilege = matches(r"^(select|insert|update|delete|usage|execute|all(?:\s+privileges)?)\s*(?:\(([^()]*)\))?\s*$", value)
        if not privilege:
            return None
        if privilege[1].lower().startswith("all") and not revoke:
            return None
        columns = tuple(column.strip().lower() for column in (privilege[2] or "").split(",") if column.strip())
        if any(not re.fullmatch(r"[a-z_][a-z_0-9]*", column) for column in columns):
            return None
        privileges.append(("all" if privilege[1].lower().startswith("all") else privilege[1].lower(), columns))
    kind = (grant[2] or "table").lower()
    targets = []
    for value in split_columns(grant[3]):
        if kind == "function":
            target = matches(r"^public\.(\w+)\s*\(([^()]*)\)\s*$", value)
            if not target:
                return None
            targets.append(function_signature(target[1], target[2]))
        elif kind == "schema":
            if value.strip().lower() != "public":
                return None
            targets.append("public")
        else:
            target = matches(r"^public\.(\w+)\s*$", value)
            if not target:
                return None
            targets.append(target[1].lower())
    return kind, roles, targets, privileges


def policy_queries_profiles(statement):
    """Ignore the policy's target while rejecting direct profile lookups."""
    policy = matches(POLICY, statement)
    body = policy[3] if policy else statement
    return bool(matches(r"\bpublic\.profiles\b|\b(?:from|join)\s+profiles\b|,\s*profiles\b", body))


def required_policy_acl():
    """Reviewed client surface; rows still require the applicable RLS policy.

    Entries are (role, kind, object, privilege, column); empty column means a
    whole-object grant. Extending this matrix is a deliberate security change.
    """
    acl = set()

    def add(role, kind, targets, privileges, columns=("",)):
        acl.update((role, kind, target, privilege, column)
                   for target in targets for privilege in privileges for column in columns)

    add("authenticated", "function", AUTH_FUNCTIONS, ("execute",))
    add("anon", "function", ANON_FUNCTIONS, ("execute",))
    for role in ("anon", "authenticated"):
        add(role, "schema", ("public",), ("usage",))
    add("authenticated", "table", (CORE_TABLES | MONEY_TABLES | MONEY_VIEWS) - PUBLIC_COLUMNS.keys(), ("select",))
    add("anon", "table", {"competitions", "teams", "fee_schedules", "v_public_roster"}, ("select",))
    add("anon", "table", ("games",), ("select",), ANON_GAME_COLUMNS)
    for table, columns in PUBLIC_COLUMNS.items():
        for role in ("anon", "authenticated"):
            add(role, "table", (table,), ("select",), columns)
    add("authenticated", "table", {
        "players", "competitions", "games", "competition_registrations", "game_registrations",
        "clubs", "venues", "teams", "fee_schedules", "billing_periods",
    }, ("insert", "update"))
    add("authenticated", "table", ("profiles",), ("update",), ("display_name", "phone", "locale", "roles"))
    add("authenticated", "table", ("payments",), ("insert",))
    add("authenticated", "table", ("charges",), ("insert",), CHARGE_INSERT_COLUMNS)
    add("authenticated", "table", ("charges",), ("update",), ("voided_at", "void_reason"))
    add("authenticated", "table", ("role_grants",), ("insert", "delete"))
    return acl


def check_policy_acl(scan, problems):
    required = required_policy_acl()
    allowed = required
    granted = set()
    for _, _, statement in statements(scan):
        if matches(r"^\s*alter\s+default\s+privileges\b", statement):
            problems.append(f"{POLICIES}: default privilege changes are outside the explicit client allowlist")
            continue
        is_grant = bool(matches(r"^\s*grant\b", statement))
        is_revoke = bool(matches(r"^\s*revoke\b", statement))
        if not is_grant and not is_revoke:
            continue
        parsed = parse_grant(statement, revoke=is_revoke)
        if parsed is None:
            problems.append(f"{POLICIES}: unsupported or broad {'GRANT' if is_grant else 'REVOKE'}; use explicit reviewed objects, privileges and roles")
            continue
        kind, roles, targets, privileges = parsed
        for role in roles:
            for target in targets:
                for privilege, columns in privileges:
                    if is_revoke:
                        granted.difference_update({entry for entry in granted
                            if entry[:3] == (role, kind, target)
                            and (privilege == "all" or entry[3] == privilege)
                            and (not columns or entry[4] in columns)})
                        continue
                    for column in columns or ("",):
                        entry = (role, kind, target, privilege, column)
                        if entry not in allowed:
                            suffix = f"({column})" if column else ""
                            problems.append(f"{POLICIES}: unapproved client grant: {role} {privilege.upper()}{suffix} on {kind} public.{target}")
                        granted.add(entry)
    for role, kind, target, privilege, column in sorted(required - granted):
        suffix = f"({column})" if column else ""
        problems.append(f"{POLICIES}: missing explicit client grant: {role} {privilege.upper()}{suffix} on {kind} public.{target}")


def installation_checks(name, scan, tables, required_tables, mutable_tables, problems):
    """Check one installation's transaction, table access and helper boundaries."""
    stage = "core" if name == CORE else "money" if name == MONEY else "RLS"
    parts = list(statements(scan))
    if not parts or parts[0][2].strip().lower() not in {"begin", "begin transaction"}:
        problems.append(f"{name}: {stage} installation must start with BEGIN")
    if not parts or parts[-1][2].strip().lower() != "commit":
        problems.append(f"{name}: {stage} installation must end with COMMIT")
    for _, _, statement in parts[1:-1]:
        if matches(r"^\s*(?:begin|start\s+transaction|commit|end|rollback)\b", statement):
            problems.append(f"{name}: transaction boundaries cannot appear inside the installation")
    for table in sorted(required_tables - tables.keys()):
        problems.append(f"{name}: required {stage} table public.{table} is missing")

    touched, rls = set(), set()
    table_revokes, function_revokes, sequence_revokes, functions = {}, {}, {}, {}
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
        revoke = matches(r"^\s*revoke\s+(all(?:\s+privileges)?|execute)\s+on\s+(table|function|sequence)\s+(.+?)\s+from\s+(.+?)\s*$", statement)
        if revoke:
            roles = {role.strip().lower() for role in revoke[4].split(",")}
            if revoke[2].lower() == "table" and revoke[1].lower().startswith("all"):
                for table in re.findall(r"public\.(\w+)", revoke[3], re.I):
                    table_revokes.setdefault(table.lower(), set()).update(roles)
            elif revoke[2].lower() == "sequence" and revoke[1].lower().startswith("all"):
                for sequence in re.findall(r"public\.(\w+)", revoke[3], re.I):
                    sequence_revokes.setdefault(sequence.lower(), set()).update(roles)
            elif revoke[2].lower() == "function":
                for function_name, args in re.findall(r"public\.(\w+)\s*\(([^()]*)\)", revoke[3], re.I):
                    key = function_signature(function_name, args)
                    function_revokes.setdefault(key, set()).update(roles)
        if name != POLICIES and matches(r"^\s*grant\b.+\bto\s+.*\b(public|anon|authenticated)\b", statement):
            problems.append(f"{name}: API role grants belong in the later policy migration")
        if name != POLICIES and matches(r"^\s*create\s+policy\b", statement):
            problems.append(f"{name}: access policies belong in the later policy migration")
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
                allowed_path = r"(?:''|pg_catalog)" if name == CORE else "''"
                fixed_path = bool(matches(rf"^\s*{allowed_path}\s*(?=as\b|language\b|security\b|stable\b|volatile\b|immutable\b|$)", suffix))
            if not fixed_path:
                description = "fixed empty or pg_catalog" if name == CORE else "fixed empty"
                problems.append(f"{name}: public.{key} needs a {description} search_path")
            if not bodies:
                problems.append(f"{name}: public.{key} needs a dollar-quoted function body for inspection")
            body = scan_sql(bodies[0][2]) if bodies else scan_sql("")
            for pos, issue in body.problems:
                problems.append(f"{name}: public.{key} body line {line_of(bodies[0][2], pos)}: {issue}")
            functions[function[1].lower()] = (statement, body)
        elif matches(r"^\s*create\s+(?:or\s+replace\s+)?function\b", statement):
            problems.append(f"{name}: function declaration is outside this checker's supported public-qualified DDL")

    for table, definition in sorted(tables.items()):
        if table not in rls:
            problems.append(f"{name}: public.{table} must enable RLS in the {stage} migration")
        missing_roles = API_ROLES - table_revokes.get(table, set())
        if missing_roles:
            problems.append(f"{name}: public.{table} must revoke ALL table privileges from {', '.join(sorted(missing_roles))}")
        columns = split_columns(definition)
        for column in (("created_at", "updated_at") if table in mutable_tables else ("created_at",)):
            if not any(matches(rf"^{column}\s+timestamptz\s+not\s+null\s+default\s+(?:pg_catalog\.)?now\s*\(\s*\)", value) for value in columns):
                problems.append(f"{name}: public.{table}.{column} needs timestamptz NOT NULL DEFAULT now()")
        if table in mutable_tables and table not in touched:
            problems.append(f"{name}: public.{table} needs a row BEFORE UPDATE touch_updated_at trigger")

    for _, _, statement in parts:
        function = matches(FUNCTION, statement)
        if function:
            key = function_signature(function[1], function[2], declaration=True)
            missing_roles = API_ROLES - function_revokes.get(key, set())
            if missing_roles:
                problems.append(f"{name}: public.{key} must revoke EXECUTE from {', '.join(sorted(missing_roles))}")
    return functions, table_revokes, sequence_revokes


def core_checks(scan, tables, problems):
    """Core must be safe independently of the later policy migration."""
    parts = list(statements(scan))
    functions, _, _ = installation_checks(CORE, scan, tables, CORE_TABLES, CORE_TABLES, problems)

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


def money_checks(scan, tables, problems):
    """Check money's installation boundaries, not runtime billing semantics."""
    _, table_revokes, sequence_revokes = installation_checks(
        MONEY, scan, tables, MONEY_TABLES, MONEY_MUTABLE_TABLES, problems,
    )
    parts = list(statements(scan))
    views = {}
    for _, _, statement in parts:
        view = matches(r"^\s*create\s+(?:or\s+replace\s+)?view\s+public\.(\w+)\s*(?:with\s*\(([^()]*)\)\s*)?as\b", statement)
        if view:
            # A definer view could bypass the underlying tables' later RLS rules.
            options = split_columns(view[2] or "")
            views[view[1].lower()] = any(
                matches(r"^security_invoker\s*=\s*true\s*$", option) for option in options
            )
        elif matches(r"^\s*create\s+(?:or\s+replace\s+)?view\b", statement):
            problems.append(f"{MONEY}: view declaration is outside this checker's supported public-qualified DDL")
        altered_view = matches(r"^\s*alter\s+view\s+public\.(\w+)\s+(set|reset)\s*\(([^()]*)\)\s*$", statement)
        if altered_view and matches(r"\bsecurity_invoker\b", altered_view[3]):
            views[altered_view[1].lower()] = (
                altered_view[2].lower() == "set"
                and any(matches(r"^security_invoker\s*=\s*true\s*$", option)
                        for option in split_columns(altered_view[3]))
            )
    for view in sorted(MONEY_VIEWS - views.keys()):
        problems.append(f"{MONEY}: required view public.{view} is missing")
    for view, invoker in sorted(views.items()):
        if not invoker:
            problems.append(f"{MONEY}: public.{view} needs security_invoker = true")
        missing_roles = API_ROLES - table_revokes.get(view, set())
        if missing_roles:
            problems.append(f"{MONEY}: public.{view} must revoke ALL view privileges from {', '.join(sorted(missing_roles))}")
    missing_roles = API_ROLES - sequence_revokes.get("audit_log_id_seq", set())
    if missing_roles:
        problems.append(f"{MONEY}: public.audit_log_id_seq must revoke ALL sequence privileges from {', '.join(sorted(missing_roles))}")

    # Inspect full top-level statements with comments removed, retaining the SQL
    # literals that define the partial index and inclusive date range. Names in
    # comments, string expressions, or function bodies cannot satisfy these checks.
    raw_parts = [scan.comments_removed[start:end] for start, end, _ in parts]
    if not any(matches(
        r"^\s*create\s+unique\s+index\s+charges_auto_once\s+on\s+public\.charges\s*"
        r"\(\s*game_id\s*,\s*player_id\s*,\s*kind\s*\)\s+where\s+"
        r"source\s*=\s*(?-i:'auto')\s+and\s+voided_at\s+is\s+null\s+and\s+game_id\s+is\s+not\s+null\s*$",
        statement,
    ) for statement in raw_parts):
        problems.append(f"{MONEY}: missing charges_auto_once unique index on (game_id, player_id, kind) for active automatic game charges")
    if not any(matches(
        r"^\s*alter\s+table\s+public\.billing_periods\s+add\s+constraint\s+billing_periods_no_overlap\s+"
        r"exclude\s+using\s+gist\s*\(\s*(?:pg_catalog\.)?daterange\s*\(\s*start_date\s*,\s*end_date\s*,\s*'\[\]'\s*\)\s+with\s+&&\s*\)\s*$",
        statement,
    ) for statement in raw_parts):
        problems.append(f"{MONEY}: missing billing_periods_no_overlap exclusion constraint on the inclusive date range")
    if not any(matches(
        r"^\s*create\s+trigger\s+charges_immutable\s+before\s+(?:update\s+or\s+delete|delete\s+or\s+update)\s+"
        r"on\s+public\.charges\s+for\s+each\s+row\s+execute\s+function\s+public\.charges_are_immutable\s*\(\s*\)\s*$",
        statement,
    ) for _, _, statement in parts):
        problems.append(f"{MONEY}: missing row BEFORE UPDATE OR DELETE charge immutability trigger")


def policy_checks(scan, enabled_rls, problems):
    """Check policy installation shape; SQL role-matrix tests remain required."""
    functions, _, _ = installation_checks(POLICIES, scan, {}, set(), set(), problems)
    check_policy_acl(scan, problems)
    parts = list(statements(scan))
    declared = {function_signature(function[1], function[2], declaration=True)
                for _, _, statement in parts if (function := matches(FUNCTION, statement))}
    for helper in sorted(AUTH_FUNCTIONS - declared):
        problems.append(f"{POLICIES}: required client helper public.{helper} is missing")
    for helper, (_, body) in functions.items():
        for relation in re.finditer(r"\b(?:from|join)\s+(?:(\w+)\.)?pg_class\b", body.clean, re.I):
            if (relation[1] or "").lower() != "pg_catalog":
                problems.append(f"{POLICIES}: public.{helper}() must qualify pg_class as pg_catalog.pg_class; empty search_path still searches temporary relations")
    policies, triggers = {}, {}
    for _, _, statement in parts:
        altered_function = matches(r"^\s*alter\s+function\s+public\.(\w+)\s*\(([^()]*)\)\s+(.+)$", statement)
        if altered_function:
            signature = function_signature(altered_function[1], altered_function[2])
            rename = matches(r"^rename\s+to\s+(\w+)\s*$", altered_function[3])
            allowed_renames = {
                "finalise_game_attendance(uuid)": "finalise_game_attendance_internal",
                "close_billing_period(uuid)": "close_billing_period_internal",
            }
            if not rename or allowed_renames.get(signature) != rename[1].lower():
                problems.append(f"{POLICIES}: function alterations must not bypass checked search paths/privileges; only the two private billing renames are allowed")
        elif matches(r"^\s*alter\s+function\b", statement):
            problems.append(f"{POLICIES}: function alterations must not bypass checked search paths/privileges; public-qualified DDL is required")
        if matches(r"^\s*alter\s+policy\b", statement):
            problems.append(f"{POLICIES}: ALTER POLICY is outside the checked create-policy contract")
        if matches(r"^\s*(?:alter|drop)\s+view\b", statement):
            problems.append(f"{POLICIES}: view alterations/drops are outside the checked safe projection contract")
        changed_view = matches(r"^\s*create\s+(?:or\s+replace\s+)?view\s+public\.(\w+)\b", statement)
        if changed_view and changed_view[1].lower() != "v_public_roster":
            problems.append(f"{POLICIES}: only the public roster view may be replaced in this policy migration")
        elif not changed_view and matches(r"^\s*create\s+(?:or\s+replace\s+)?view\b", statement):
            problems.append(f"{POLICIES}: view declaration is outside this checker's supported public-qualified DDL")
        policy = matches(POLICY, statement)
        if policy:
            policy_name, table = policy[1].lower(), policy[2].lower()
            policies.setdefault(table, set()).add(policy_name)
            header = matches(r"^\s*(?:as\s+(?:permissive|restrictive)\s+)?for\s+(?:all|select|insert|update|delete)\s+to\s+(.+?)\s+(?=using\b|with\s+check\b)", policy[3])
            roles = {role.strip().lower() for role in header[1].split(",")} if header else set()
            if not roles or roles - {"anon", "authenticated"}:
                problems.append(f"{POLICIES}: policy {policy_name} must explicitly target anon/authenticated and supply a predicate")
        elif matches(r"^\s*create\s+policy\b", statement):
            problems.append(f"{POLICIES}: policy declaration is outside this checker's supported public-qualified DDL")
        dropped_policy = matches(r"^\s*drop\s+policy\s+(?:if\s+exists\s+)?(\w+)\s+on\s+public\.(\w+)\b", statement)
        if dropped_policy:
            policies.get(dropped_policy[2].lower(), set()).discard(dropped_policy[1].lower())
        trigger = matches(r"^\s*create\s+trigger\s+(\w+)\s+before\s+((?:insert|update)(?:\s+or\s+(?:insert|update))*)\s+on\s+public\.(\w+)\s+for\s+each\s+row\s+execute\s+function\s+public\.(\w+)\s*\(\s*\)\s*$", statement)
        if trigger:
            triggers[(trigger[3].lower(), trigger[1].lower())] = (
                trigger[4].lower(), set(re.split(r"\s+or\s+", trigger[2].lower())),
            )
        dropped_trigger = matches(r"^\s*drop\s+trigger\s+(?:if\s+exists\s+)?(\w+)\s+on\s+public\.(\w+)\b", statement)
        if dropped_trigger:
            triggers.pop((dropped_trigger[2].lower(), dropped_trigger[1].lower()), None)

    for table in sorted(CORE_TABLES | MONEY_TABLES):
        if table not in enabled_rls:
            problems.append(f"{POLICIES}: public.{table} must keep RLS enabled")
        if not policies.get(table):
            problems.append(f"{POLICIES}: public.{table} needs at least one real policy")
    for table, function in GUARD_FUNCTIONS.items():
        events = set().union(*(events for (target, _), (helper, events) in triggers.items()
                              if target == table and helper == function))
        if events != {"insert", "update"}:
            problems.append(f"{POLICIES}: public.{table} needs row BEFORE INSERT and UPDATE protection using {function}()")
        if function not in functions:
            problems.append(f"{POLICIES}: required guard public.{function}() is missing")
        elif matches(r"\bsecurity\s+definer\b", functions[function][0]):
            problems.append(f"{POLICIES}: public.{function}() must keep SECURITY INVOKER caller context")

    # The public roster intentionally has no base-table SELECT grant. Its only
    # definer projection is a small, fixed result, not an arbitrary player row.
    declaration, body = functions.get("read_public_roster", ("", scan_sql("")))
    returns = matches(r"\breturns\s+table\s*\(([^()]*)\)", declaration)
    columns = tuple(column.split()[0].lower() for column in split_columns(returns[1])) if returns else ()
    if columns != ROSTER_COLUMNS or not matches(r"\bsecurity\s+definer\b", declaration):
        problems.append(f"{POLICIES}: read_public_roster() must be a SECURITY DEFINER projection of the five safe roster columns")
    row_query = matches(r"^\s*select\s+(.+?)\s+from\s+public\.players\s+(?:as\s+)?(\w+)\s+where\s+(.+?)(?:\s+order\s+by\s+[\w\s,.]+)?\s*;?\s*$", body.comments_removed)
    safe_query = False
    if row_query:
        alias = row_query[2].lower()
        selected = tuple(re.sub(r"\s+", "", column).lower() for column in split_columns(row_query[1]))
        conditions = {re.sub(r"\s+", "", condition) for condition in re.split(r"\band\b", row_query[3], flags=re.I)}
        expected_filter = {alias + ".is_public", alias + ".verification_status='verified'"}
        safe_query = selected == tuple(alias + "." + column for column in ROSTER_COLUMNS) and conditions == expected_filter
    if not safe_query:
        problems.append(f"{POLICIES}: read_public_roster() must select only the five safe columns of opt-in verified players")
    view_pattern = (
        r"^\s*create\s+(?:or\s+replace\s+)?view\s+public\.v_public_roster\s+"
        r"with\s*\(\s*security_invoker\s*=\s*true\s*\)\s+as\s+select\s+"
        + r"\s*,\s*".join(ROSTER_COLUMNS)
        + r"\s+from\s+public\.read_public_roster\s*\(\s*\)\s*$"
    )
    if not any(matches(view_pattern, statement) for _, _, statement in parts):
        problems.append(f"{POLICIES}: v_public_roster must be an invoker view over only read_public_roster()'s five safe columns")
    for _, _, statement in parts:
        if matches(r"^\s*create\s+(?:or\s+replace\s+)?view\s+public\.v_public_roster\b", statement) and not matches(view_pattern, statement):
            problems.append(f"{POLICIES}: every v_public_roster replacement must preserve the checked safe invoker projection")


def verification_checks(scan, problems):
    """Bounded issue32 shape/security checks, not a proof of function semantics."""
    parts = list(statements(scan))
    plain = [statement.strip().lower() for _, _, statement in parts]
    if not plain or plain[0] != "begin" or plain[-1] != "commit":
        problems.append(f"{VERIFICATION}: verification installation needs one BEGIN/COMMIT transaction")
    if any(matches(r"^(begin|commit|rollback|start\s+transaction)\b", text) for text in plain[1:-1]):
        problems.append(f"{VERIFICATION}: transaction boundaries cannot appear inside installation")
    expected = {
        "guard_player_verification_decision()": "invoker",
        "list_player_verifications(text,integer)": "invoker",
        "decide_player_verifications(uuid[],timestamptz[],text,text)": "definer",
    }
    public_rpc = set(expected) - {"guard_player_verification_decision()"}
    projection = ("id", "display_name", "legal_name", "verification_status", "verification_note",
                  "created_at", "updated_at", "decided_by", "decided_at")
    functions, revoked, granted = {}, {}, set()
    for start, end, statement in parts:
        function = matches(FUNCTION, statement)
        if function:
            signature = function_signature(function[1], function[2], declaration=True)
            bodies = [(pos, body) for pos, _, body in scan.bodies if start <= pos < end]
            if len(bodies) != 1 or signature not in expected:
                problems.append(f"{VERIFICATION}: only the three checked verification functions are allowed")
                continue
            position, source = bodies[0]
            declaration = scan.comments_removed[start:position]
            body = scan_sql(source)
            functions[signature] = body
            if not matches(r"\bsecurity\s+" + expected[signature] + r"\b", declaration):
                problems.append(f"{VERIFICATION}: {signature} must keep SECURITY {expected[signature].upper()}")
            if not matches(r"\bset\s+search_path\s*=\s*''", declaration):
                problems.append(f"{VERIFICATION}: {signature} needs fixed empty search_path")
            if signature in public_rpc:
                returned = matches(r"\breturns\s+table\s*\(([^()]*)\)", declaration)
                names = tuple(column.split()[0].lower() for column in split_columns(returned[1])) if returned else ()
                if names != projection:
                    problems.append(f"{VERIFICATION}: {signature} must return only the nine safe verification columns")
                if not matches(r"\bif\s+(?:auth\.uid\(\)|actor)\s+is\s+null\s+or\s+public\.is_admin\(\)\s+is\s+not\s+true\s+then", body.clean):
                    problems.append(f"{VERIFICATION}: {signature} needs explicit fail-closed JWT admin authorization")
                if matches(r"\bcurrent_user\b", body.clean):
                    problems.append(f"{VERIFICATION}: public RPCs must not authorize their SECURITY DEFINER owner")
            continue
        if matches(r"^\s*(grant|revoke)\b", statement):
            is_revoke = bool(matches(r"^\s*revoke\b", statement))
            parsed = parse_grant(statement, revoke=is_revoke)
            if not parsed:
                problems.append(f"{VERIFICATION}: unsupported privilege change")
                continue
            kind, roles, targets, privileges = parsed
            allowed = (kind == "function" and set(targets) <= set(expected)
                       and set(roles) <= API_ROLES and privileges == [("all", ())]) if is_revoke else (
                kind == "function" and set(targets) <= public_rpc
                and roles == ["authenticated"] and privileges == [("execute", ())])
            if not allowed:
                problems.append(f"{VERIFICATION}: privileges may expose only the two authenticated verification RPCs")
            elif is_revoke:
                for target in targets:
                    revoked.setdefault(target, set()).update(roles)
            else:
                granted.update(targets)
            continue
        if not (matches(r"^\s*(?:begin|commit)\s*$", statement)
                or matches(r"^\s*alter\s+table\s+public\.players\s+add\s+column\b", statement)
                or matches(r"^\s*create\s+index\s+players_pending_verification\s+on\s+public\.players\b", statement)
                or matches(r"^\s*create\s+trigger\s+players_verification_decision_guard\s+before\s+insert\s+or\s+update\s+on\s+public\.players\s+for\s+each\s+row\s+execute\s+function\s+public\.guard_player_verification_decision\(\)\s*$", statement)):
            problems.append(f"{VERIFICATION}: statement is outside the additive verification contract")

    for signature in expected:
        if signature not in functions:
            problems.append(f"{VERIFICATION}: missing verification helper {signature}")
        if revoked.get(signature, set()) != API_ROLES:
            problems.append(f"{VERIFICATION}: {signature} must revoke PUBLIC/anon/authenticated before narrow grants")
    if granted != public_rpc:
        problems.append(f"{VERIFICATION}: authenticated execution grants are incomplete")
    for pattern, label in [
        (r"\badd\s+column\s+decided_by\s+uuid\s+references\s+public\.profiles\s*\(id\)", "reviewer foreign key"),
        (r"\badd\s+column\s+decided_at\s+timestamptz\b", "decision timestamp"),
        (r"\badd\s+constraint\s+players_verification_decision_pair\b", "paired decision metadata constraint"),
        (r"\badd\s+constraint\s+players_pending_without_decision\b", "pending metadata constraint"),
        (r"\bcreate\s+trigger\s+players_verification_decision_guard\b", "direct-write decision guard"),
        (r"\bcreate\s+index\s+players_pending_verification\b", "pending queue index"),
    ]:
        if not matches(pattern, scan.clean):
            problems.append(f"{VERIFICATION}: missing {label}")
    guard = functions.get("guard_player_verification_decision()", scan_sql(""))
    for pattern, label in [
        (r"actor\s+is\s+null\s+and\s+current_user\s*=\s*pg_catalog\.pg_get_userbyid", "NULL-actor-only owner maintenance"),
        (r"\bfrom\s+pg_catalog\.pg_class\b", "qualified owner catalog"),
        (r"new\.decided_by\s*:=\s*actor", "trusted reviewer stamp"),
        (r"new\.decided_at\s*:=\s*statement_timestamp\(\)", "trusted decision timestamp"),
        (r"new\.updated_at\s*:=\s*statement_timestamp\(\)", "insert version normalization"),
        (r"\(new\.decided_by,\s*new\.decided_at\)\s+is\s+distinct\s+from\s*\(old\.decided_by,\s*old\.decided_at\)", "metadata tampering protection"),
    ]:
        if not matches(pattern, guard.clean):
            problems.append(f"{VERIFICATION}: guard needs {label}")
    queue = functions.get("list_player_verifications(text,integer)", scan_sql(""))
    if not matches(r"order\s+by\s+p\.created_at\s+desc,\s*p\.id\s+desc\s+limit\s+51\s+offset\s+p_offset", queue.clean):
        problems.append(f"{VERIFICATION}: queue needs stable newest-first 51-row pagination")
    if not matches(r"strpos\s*\(\s*lower\(p\.display_name\)", queue.clean) or matches(r"\bilike\b|\bexecute\b", queue.clean):
        problems.append(f"{VERIFICATION}: search must stay literal, not dynamic SQL or wildcard matching")
    decision = functions.get("decide_player_verifications(uuid[],timestamptz[],text,text)", scan_sql(""))
    lock = matches(r"perform\s+public\.lock_billing\(\)", decision.clean)
    rows = matches(r"\bfrom\s+public\.players\b", decision.clean)
    if not lock or not rows or lock.start() > rows.start() or not matches(r"\bfor\s+update\b", decision.clean):
        problems.append(f"{VERIFICATION}: billing lock must precede player reads/row locks")
    for pattern, label in [
        (r"requested\s+not\s+between\s+1\s+and\s+50", "bounded batch size"),
        (r"array_ndims\(p_player_ids\)\s+is\s+distinct\s+from\s+1", "one-dimensional arrays"),
        (r"count\(distinct\s+target\)", "unique player ids"),
        (r"p\.updated_at\s*=\s*wanted\.expected_at", "optimistic version comparison"),
        (r"get\s+diagnostics\s+affected\s*=\s*row_count", "affected-row assertion"),
        (r"if\s+affected\s*<>\s*requested\s+then", "all-or-nothing result check"),
    ]:
        if not matches(pattern, decision.clean):
            problems.append(f"{VERIFICATION}: decision RPC needs {label}")


def pickup_checks(scan, problems):
    """Bounded issue33 DDL/ACL checks, not runtime scope or transition proof."""
    parts = list(statements(scan))
    plain = [statement.strip().lower() for _, _, statement in parts]
    if not plain or plain[0] != "begin" or plain[-1] != "commit":
        problems.append(f"{PICKUP}: pickup installation needs one BEGIN/COMMIT transaction")
    if any(matches(r"^(begin|commit|rollback|start\s+transaction)\b", text) for text in plain[1:-1]):
        problems.append(f"{PICKUP}: transaction boundaries cannot appear inside installation")
    expected = {
        "can_manage_pickup_team(uuid)": "definer",
        "validate_pickup_game_details(jsonb)": "definer",
        "guard_pickup_game_write()": "invoker",
        "pickup_game_options()": "definer",
        "list_pickup_games(integer)": "definer",
        "save_pickup_game(uuid,timestamptz,jsonb)": "definer",
        "transition_pickup_game(uuid,timestamptz,text,text)": "definer",
    }
    private = {"validate_pickup_game_details(jsonb)", "guard_pickup_game_write()"}
    callable_helpers = set(expected) - private
    functions, revoked, granted = set(), {}, set()
    policy_count, trigger_count = 0, 0
    policy_pattern = (
        r"^\s*create\s+policy\s+games_pickup_staff_read\s+on\s+public\.games\s+"
        r"for\s+select\s+to\s+authenticated\s+using\s*\(\s*game_type\s*=\s*(?-i:'pickup')\s+"
        r"and\s+public\.can_manage_pickup_team\s*\(\s*team_id\s*\)\s*\)\s*$"
    )
    trigger_pattern = (
        r"^\s*create\s+trigger\s+games_u_pickup_guard\s+before\s+"
        r"((?:insert|update|delete)(?:\s+or\s+(?:insert|update|delete))*)\s+on\s+public\.games\s+"
        r"for\s+each\s+row\s+execute\s+function\s+public\.guard_pickup_game_write\s*\(\s*\)\s*$"
    )
    for start, end, statement in parts:
        function = matches(FUNCTION, statement)
        if function:
            signature = function_signature(function[1], function[2], declaration=True)
            bodies = [(pos, body) for pos, _, body in scan.bodies if start <= pos < end]
            if len(bodies) != 1 or signature not in expected or signature in functions:
                problems.append(f"{PICKUP}: declare each of the seven checked pickup functions exactly once")
                continue
            functions.add(signature)
            position, source = bodies[0]
            declaration = scan.clean[start:position]
            modes = re.findall(r"\bsecurity\s+(definer|invoker)\b", declaration, re.I)
            if [mode.lower() for mode in modes] != [expected[signature]]:
                problems.append(f"{PICKUP}: {signature} must keep SECURITY {expected[signature].upper()}")
            paths = list(re.finditer(r"\bset\s+search_path\s*(?:=|to)", declaration, re.I))
            fixed_path = len(paths) == 1 and bool(matches(
                r"^\s*''\s*(?=as\b|language\b|security\b|stable\b|volatile\b|immutable\b|$)",
                scan.comments_removed[start + paths[0].end():position],
            ))
            if not fixed_path:
                problems.append(f"{PICKUP}: {signature} needs fixed empty search_path")
            body = scan_sql(source)
            for pos, issue in body.problems:
                problems.append(f"{PICKUP}: {signature} body line {line_of(source, pos)}: {issue}")
            check_parens(f"{PICKUP}: {signature} body", body.clean, problems)
            if signature in callable_helpers and matches(r"\bcurrent_user\b", body.clean):
                problems.append(f"{PICKUP}: callable helpers must not authorize their SECURITY DEFINER owner")
            continue
        if matches(r"^\s*(grant|revoke)\b", statement):
            is_revoke = bool(matches(r"^\s*revoke\b", statement))
            parsed = parse_grant(statement, revoke=is_revoke)
            if not parsed:
                problems.append(f"{PICKUP}: unsupported privilege change")
                continue
            kind, roles, targets, privileges = parsed
            allowed = (kind == "function" and set(targets) <= set(expected)
                       and set(roles) <= API_ROLES and privileges == [("all", ())]) if is_revoke else (
                kind == "function" and set(targets) <= callable_helpers
                and roles == ["authenticated"] and privileges == [("execute", ())])
            if not allowed:
                problems.append(f"{PICKUP}: privileges may expose only the authenticated scope helper and four pickup RPCs")
            elif is_revoke:
                for target in targets:
                    revoked.setdefault(target, set()).update(roles)
                    if "authenticated" in roles:
                        granted.discard(target)
            else:
                for target in targets:
                    if revoked.get(target, set()) != API_ROLES:
                        problems.append(f"{PICKUP}: {target} must revoke PUBLIC/anon/authenticated before its grant")
                granted.update(targets)
            continue
        if matches(r"^\s*create\s+policy\b", statement):
            if not matches(policy_pattern, scan.comments_removed[start:end]):
                problems.append(f"{PICKUP}: only the authenticated pickup-team SELECT policy is allowed")
            else:
                policy_count += 1
            continue
        if matches(r"^\s*create\s+trigger\b", statement):
            trigger = matches(trigger_pattern, statement)
            events = re.split(r"\s+or\s+", trigger[1].lower()) if trigger else []
            if len(events) != 3 or set(events) != {"insert", "update", "delete"}:
                problems.append(f"{PICKUP}: pickup guard must run BEFORE INSERT/UPDATE/DELETE for each games row")
            else:
                trigger_count += 1
            continue
        if not matches(r"^\s*(?:begin|commit)\s*$", statement):
            problems.append(f"{PICKUP}: statement is outside the additive pickup contract")
    for signature in expected:
        if signature not in functions:
            problems.append(f"{PICKUP}: missing pickup helper {signature}")
        if revoked.get(signature, set()) != API_ROLES:
            problems.append(f"{PICKUP}: {signature} must revoke PUBLIC/anon/authenticated")
    if granted != callable_helpers:
        problems.append(f"{PICKUP}: authenticated execution grants are incomplete")
    if policy_count != 1:
        problems.append(f"{PICKUP}: exactly one scoped pickup SELECT policy is required")
    if trigger_count != 1:
        problems.append(f"{PICKUP}: exactly one pickup row guard is required")


def check_migrations(migrations, required_targets=LANDED_TARGETS):
    """Return findings; focused fixtures may explicitly require only core."""
    problems = []
    for target in required_targets:
        if target not in migrations:
            stage = ("core" if target == CORE else "money" if target == MONEY
                     else "RLS" if target == POLICIES else "pickup" if target == PICKUP else target)
            problems.append(f"{target}: required {stage} migration is missing")
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
            if policy and policy_queries_profiles(statement):
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
        if name == MONEY:
            money_checks(scan, tables, problems)
        if name == POLICIES:
            policy_checks(scan, all_rls, problems)
        if name == VERIFICATION:
            verification_checks(scan, problems)
        if name == PICKUP:
            pickup_checks(scan, problems)
    if POLICIES in migrations:
        for table in sorted(seen - all_rls):
            problems.append(f"{POLICIES}: public.{table} never has row-level security enabled")
    return problems


def main():
    if len(sys.argv) > 1:
        print("usage: python3 scripts/check_sql.py (generation drift: scripts/build_migrations.py --check)", file=sys.stderr)
        return 2
    files = sorted(MIG_DIR.glob("*.sql")) if MIG_DIR.exists() else []
    try:
        migrations = {path.name: path.read_text(encoding="utf-8-sig") for path in files}
    except (OSError, UnicodeError) as error:
        print(f"check_sql: FAILED — {error}", file=sys.stderr)
        return 1
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
