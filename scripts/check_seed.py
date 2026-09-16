#!/usr/bin/env python3
"""Check the disposable development seed without connecting to a database.

This inspects the repository's explicit VALUES fixtures and guarded DO block;
it is not a PostgreSQL/PLpgSQL parser or proof of authorization, transactions,
money calculations or replay behavior. Run the documented scratch tests too.
"""

from dataclasses import dataclass
import pathlib
import re
import sys
import json

if __package__:
    from . import check_sql
else:
    import check_sql


ROOT = pathlib.Path(__file__).resolve().parent.parent
SEED = ROOT / "supabase" / "seed.sql"
MIG_DIR = ROOT / "supabase" / "migrations"
REQUIRED_MIGRATIONS = ("0001_core.sql", "0002_money.sql", "0003_rls.sql")
APP_TABLES = check_sql.CORE_TABLES | check_sql.MONEY_TABLES
COUNTS = {
    "auth.users": 6, "public.players": 12, "public.clubs": 1,
    "public.teams": 1, "public.venues": 2, "public.competitions": 1,
    "public.games": 5, "public.competition_registrations": 10,
    "public.game_registrations": 29, "public.role_grants": 1,
    "public.fee_schedules": 2, "public.billing_periods": 1,
    "public.payments": 1,
}
UUID = r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
MUTATION = re.compile(r"\b(insert\s+into|update|delete\s+from|merge\s+into)\s+([\w.]+)\b", re.I)


@dataclass
class Insert:
    target: str
    position: int
    columns: tuple
    rows: list


@dataclass
class IfBlock:
    start: int
    condition_end: int
    body_start: int
    body_end: int
    end: int
    branched: bool


def match(pattern, source):
    return re.search(pattern, source, re.I | re.S)


def split_fields(clean, raw):
    """Keep literal text while splitting only outer commas, including arrays."""
    depth, start, fields = 0, 0, []
    for index, character in enumerate(clean):
        depth += (character in "([") - (character in ")]")
        if character == "," and depth == 0:
            fields.append(raw[start:index].strip())
            start = index + 1
    fields.append(raw[start:].strip())
    return fields


def closing_paren(clean, start):
    depth = 0
    for index in range(start, len(clean)):
        depth += (clean[index] == "(") - (clean[index] == ")")
        if depth == 0:
            return index
    return None


def parse_inserts(scan, problems):
    """Read explicit column/VALUES tuples; reject INSERT SELECT and hidden DML."""
    inserts = []
    for found in re.finditer(r"\binsert\s+into\s+([\w.]+)\b", scan.clean, re.I):
        target = found[1].lower()
        end = scan.clean.find(";", found.end())
        if end < 0:
            problems.append("INSERT must end with a semicolon")
            continue
        start_columns = re.match(r"\s*\(", scan.clean[found.end():end])
        if not start_columns:
            problems.append(f"{target}: INSERT needs explicit columns")
            continue
        opening = found.end() + start_columns.end() - 1
        closing = closing_paren(scan.clean, opening)
        if closing is None or closing > end:
            problems.append(f"{target}: malformed INSERT columns")
            continue
        columns = tuple(value.strip().lower() for value in scan.clean[opening + 1:closing].split(","))
        if not columns or any(not re.fullmatch(r"[a-z_][a-z_0-9]*", value) for value in columns):
            problems.append(f"{target}: INSERT columns must be unquoted identifiers")
            continue
        if len(set(columns)) != len(columns):
            problems.append(f"{target}: duplicate INSERT column")
        values = re.match(r"\s*values\b", scan.clean[closing + 1:end], re.I)
        if not values:
            problems.append(f"{target}: only explicit VALUES fixtures are supported")
            continue
        position, rows = closing + 1 + values.end(), []
        while position < end:
            while position < end and scan.clean[position].isspace():
                position += 1
            if position >= end or scan.clean[position] != "(":
                break
            finish = closing_paren(scan.clean, position)
            if finish is None or finish > end:
                problems.append(f"{target}: malformed VALUES tuple")
                break
            fields = split_fields(scan.clean[position + 1:finish], scan.comments_removed[position + 1:finish])
            if len(fields) != len(columns):
                problems.append(f"{target}: VALUES tuple has {len(fields)} fields for {len(columns)} columns")
            else:
                rows.append(dict(zip(columns, fields)))
            position = finish + 1
            while position < end and scan.clean[position].isspace():
                position += 1
            if position < end and scan.clean[position] == ",":
                position += 1
                continue
            break
        remainder = scan.clean[position:end].strip()
        if remainder and not match(r"^on\s+conflict\s*(?:\([^()]*\))?\s+do\s+nothing\s*$", remainder):
            problems.append(f"{target}: unexpected text after VALUES; seed may not overwrite conflicts")
        inserts.append(Insert(target, found.start(), columns, rows))
    return inserts


def literal(value):
    found = match(r"^'((?:[^']|'')*)'\s*(?:::\s*(?:uuid|text|date|jsonb))?\s*$", value)
    return found[1].replace("''", "'") if found else None


def literal_uuid(value):
    value = literal(value)
    return value.lower() if value and re.fullmatch(UUID, value) else None


def if_blocks(scan, problems):
    """Find the seed's simple IF/THEN blocks, preserving source offsets."""
    stack, blocks = [], []
    for token in re.finditer(r"\bend\s+if\b|\b(?:if|then|elsif|else)\b", scan.clean, re.I):
        keyword = token.group().lower()
        if keyword == "if":
            stack.append([token.start(), None, None, False])
        elif keyword == "then" and stack and stack[-1][1] is None:
            stack[-1][1:3] = [token.start(), token.end()]
        elif keyword in {"else", "elsif"} and stack:
            stack[-1][3] = True
        elif keyword.startswith("end"):
            if not stack or stack[-1][1] is None:
                problems.append("DO block has an unsupported or unbalanced IF structure")
                continue
            start, condition_end, body_start, branched = stack.pop()
            blocks.append(IfBlock(start, condition_end, body_start, token.start(), token.end(), branched))
    if stack:
        problems.append("DO block has unterminated IF blocks")
    return sorted(blocks, key=lambda block: block.start)


def update_checks(scan, fixtures, problems):
    """Only first-run demo roles/check-ins and the final marker may be updated."""
    updates = []
    for found in re.finditer(r"\bupdate\s+([\w.]+)\s+set\b", scan.clean, re.I):
        target = found[1].lower()
        end = scan.clean.find(";", found.end())
        statement = scan.clean[found.end():end]
        raw = scan.comments_removed[found.end():end]
        where = match(r"\bwhere\b", statement)
        if where is None:
            problems.append(f"{target}: seed UPDATE must target fixed fixture ids")
            continue
        assignments = split_fields(statement[:where.start()], raw[:where.start()])
        columns = {assignment.split("=", 1)[0].strip().lower() for assignment in assignments}
        allowed = {
            "public.profiles": {"display_name", "roles"},
            "public.game_registrations": {"checked_in_at", "checked_in_by"},
            "auth.users": {"raw_app_meta_data", "updated_at"},
        }
        if not columns or columns - allowed.get(target, set()):
            problems.append(f"{target}: unapproved seed UPDATE columns")
        clause = raw[where.end():].strip()
        equality = match(rf"^id\s*=\s*'({UUID})'(?:::\s*uuid)?(?:\s+and\s+roles\s+is\s+distinct\s+from\s+.+)?\s*$", clause)
        membership = match(r"^id\s+in\s*\(([^()]*)\)(?:\s+and\s+checked_in_at\s+is\s+null)?\s*$", clause)
        identities = []
        if equality:
            identities = [equality[1].lower()]
        elif membership and target == "public.game_registrations":
            identities = [literal_uuid(value.strip()) for value in membership[1].split(",")]
        fixture_table = "auth.users" if target == "public.profiles" else target
        known = {literal_uuid(row.get("id", "")) for row in fixtures.get(fixture_table, [])}
        if not identities or any(not identity or identity not in known for identity in identities):
            problems.append(f"{target}: UPDATE must be limited to earlier fixed fixture ids")
        updates.append((target, found.start(), end, identities, raw[:where.start()]))
    return updates


def guard_checks(scan, fixtures, problems):
    mutations = list(MUTATION.finditer(scan.clean))
    first_write = mutations[0].start() if mutations else len(scan.clean)
    prefix, raw_prefix = scan.clean[:first_write], scan.comments_removed[:first_write]
    counts = match(r"\bexpected_counts\s+jsonb\s*:=\s*'((?:[^']|'')*)'\s*::\s*jsonb\s*;", raw_prefix)
    expected_counts = {target.split(".")[1]: count for target, count in COUNTS.items()}
    expected_counts["accounts"] = expected_counts.pop("users")
    expected_counts["charges"] = 3
    try:
        marker_counts = json.loads(counts[1].replace("''", "'")) if counts else None
    except (ValueError, TypeError):
        marker_counts = None
    if marker_counts != expected_counts:
        problems.append("completion-marker expected_counts must describe this exact version-one fixture set")
    blocks = if_blocks(scan, problems)
    guards = [block for block in blocks if block.end < first_write and not block.branched
              and match(r"^\s*raise\s+exception\b", scan.clean[block.body_start:block.body_end])]
    confirmation = [block for block in guards if match(
        r"^\s*(?:pg_catalog\.)?current_setting\s*\(\s*'calblue.seed_confirmation'\s*,\s*true\s*\)\s+is\s+distinct\s+from\s+'disposable-demo-only'\s*$",
        scan.comments_removed[block.start + 2:block.condition_end],
    )]
    if not confirmation:
        problems.append("explicit disposable-demo-only confirmation must be rejected before any fixture write")
    owner_lookup = match(r"\bselect\s+relowner\s+into\s+(\w+)\s+from\s+pg_catalog\.pg_class\s+where\s+oid\s*=\s*pg_catalog\.to_regclass\s*\(\s*'public.profiles'\s*\)\s+and\s+relkind\s*=\s*'r'", raw_prefix)
    owner_guards = [block for block in guards if owner_lookup and match(
        r"^\s*current_user\s+(?:is\s+distinct\s+from|<>)\s+pg_catalog\.pg_get_userbyid\s*\(\s*" + re.escape(owner_lookup[1]) + r"\s*\)\s*$",
        scan.clean[block.start + 2:block.condition_end],
    )]
    if not owner_guards or not any(owner_lookup.end() < block.start < owner_guards[0].start
                                   and match(r"^\s*not\s+found\s*$", scan.clean[block.start + 2:block.condition_end]) for block in guards):
        problems.append("a catalog-backed owner guard must reject non-owners before fixture writes")
    if not any(match(r"^\s*(?:pg_catalog\.)?current_setting\s*\(\s*'transaction_isolation'\s*\)\s*(?:is\s+distinct\s+from|<>)\s*'read committed'\s*$",
                     scan.comments_removed[block.start + 2:block.condition_end]) for block in guards):
        problems.append("READ COMMITTED isolation must be checked inside the guarded DO block")

    empty_guards = []
    for block in guards:
        condition = scan.clean[block.start + 2:block.condition_end]
        pattern = r"exists\s*\(\s*select\s+1\s+from\s+((?:auth|public)\.\w+)\s*\)"
        tables = {found[1].lower() for found in re.finditer(pattern, condition, re.I)}
        remainder = re.sub(pattern, "", condition, flags=re.I).strip()
        if tables == {"auth.users"} | {"public." + table for table in APP_TABLES} and re.fullmatch(r"(?:\s*or\s*)*", remainder, re.I):
            empty_guards.append(block)
    if not empty_guards:
        problems.append("first run must reject ANY rows in auth.users or all 17 application tables")
    lock = match(r"\block\s+table\s+(.+?)\s+in\s+share\s+row\s+exclusive\s+mode\s*;", prefix)
    if not lock or {table.strip().lower() for table in lock[1].split(",")} != {"auth.users"} | {"public." + table for table in APP_TABLES}:
        problems.append("first-run emptiness check needs SHARE ROW EXCLUSIVE locks on Auth and all 17 application tables")
    elif empty_guards and lock.end() > empty_guards[0].start:
        problems.append("first-run table locks must precede the emptiness check")
    if not match(r"\bto_regclass\s*\(", prefix) or not match(r"\bpg_catalog\.pg_policy\b", prefix) or not match(r"\brelrowsecurity\b", prefix):
        problems.append("prerequisite guard must inspect installed relations, RLS and policies before writes")
    for helper in ("public.finalise_game_attendance_internal(uuid)", "public.read_public_roster()"):
        if not any(match(r"to_regprocedure\s*\(\s*'" + re.escape(helper) + r"'\s*\)\s+is\s+null",
                         scan.comments_removed[block.start + 2:block.condition_end]) for block in guards):
            problems.append(f"prerequisite guard must require {helper}")
    if not match(r"\bperform\s+public\.lock_billing\s*\(\s*\)", prefix) or not match(r"\bpg_advisory_xact_lock\s*\(", prefix):
        problems.append("seed needs billing and seed advisory locks before marker/fixture work")

    marker_read = match(r"select\s+raw_app_meta_data\s*->\s*'calblue_demo_seed'\s+into\s+(\w+)\s+from\s+auth\.users\s+where\s+id\s*=\s*'(" + UUID + r")'\s*;", raw_prefix)
    returns = [block for block in blocks if marker_read and marker_read.end() < block.start and block.end < first_write
               and not block.branched and match(r"^\s*found\s*$", scan.clean[block.start + 2:block.condition_end])
               and match(r"\breturn\s*;", scan.clean[block.body_start:block.body_end])]
    return_tokens = list(re.finditer(r"\breturn\s*;", scan.clean, re.I))
    valid_marker = False
    if len(returns) == 1 and len(return_tokens) == 1:
        outer = returns[0]
        marker = marker_read[1].lower()
        expected = {
            f"jsonb_typeof({marker})isdistinctfrom'object'",
            f"{marker}->'version'isdistinctfrom'1'::jsonb",
            f"{marker}->>'status'isdistinctfrom'complete'",
            f"{marker}->>'seed'isdistinctfrom'calblue-demo'",
            f"{marker}->'counts'isdistinctfromexpected_counts",
            f"jsonb_typeof({marker}->'anchor_date')isdistinctfrom'string'",
            f"jsonb_typeof({marker}->'installed_at')isdistinctfrom'string'",
        }
        for block in guards:
            if outer.body_start < block.start < block.end < return_tokens[0].start():
                clauses = {re.sub(r"\s+", "", clause).lower()
                           for clause in re.split(r"\bor\b", scan.comments_removed[block.start + 2:block.condition_end], flags=re.I)}
                if clauses == expected:
                    valid_marker = True
    if not valid_marker:
        problems.append("a verified completion-marker RETURN must precede all fixture DML")
    elif empty_guards and not any(block.end < empty_guards[0].start for block in returns):
        problems.append("completion-marker RETURN must run before the first-run emptiness guard")

    updates = update_checks(scan, fixtures, problems)
    markers = [update for update in updates if update[0] == "auth.users"]
    if len(markers) != 1 or not mutations or markers[0][1] != mutations[-1].start():
        problems.append("completion marker must be the single final auth.users UPDATE, after every fixture write")
    elif not match(r"calblue_demo_seed", markers[0][4]) or not match(r"'version'\s*,\s*1\b", markers[0][4]):
        problems.append("final auth.users marker must record calblue_demo_seed version 1")
    elif not marker_read or markers[0][3] != [marker_read[2].lower()]:
        problems.append("completion marker must update exactly the account read by the early-return guard")
    if markers and not match(r"raw_app_meta_data\s*=\s*coalesce\s*\(\s*raw_app_meta_data\s*,\s*'\{\}'::jsonb\s*\)\s*\|\|\s*jsonb_build_object", markers[0][4]):
        problems.append("completion marker must preserve existing Auth app metadata")

    past = [literal_uuid(row.get("id", "")) for row in fixtures.get("public.games", [])
            if literal(row.get("status", "")) == "completed"]
    finals = list(re.finditer(rf"\bperform\s+public\.finalise_game_attendance_internal\s*\(\s*'({UUID})'(?:\s*::\s*uuid)?\s*\)", scan.comments_removed, re.I))
    if len(finals) != 1 or finals[0][1].lower() not in past:
        problems.append("seed must finalize the completed fixture once through the private billing function")
    elif markers and finals[0].start() > markers[0][1]:
        problems.append("billing finalization must finish before the completion marker")
    elif finals[0].start() < first_write:
        problems.append("billing finalization must not run before the first-run fixture writes")
    if not match(r"\bperform\s+public\.assign_to_periods\s*\(\s*\)", scan.clean):
        problems.append("seed must assign generated charges and payment to the open billing period")

    for setting in re.finditer(r"\b(?:pg_catalog\.)?set_config\s*\((.*?)\)", scan.comments_removed, re.I | re.S):
        if not match(r"^\s*'request\.jwt\.(?:claims|claim\.sub|claim\.role)'\s*,\s*'(?:\{\})?'\s*,\s*true\s*$", setting[1]):
            problems.append("seed may only clear transaction-local JWT context, not forge claims or weaken settings")


def fixture_checks(inserts, problems):
    by_table, seen = {}, {}
    references = {
        "account_id": "auth.users", "guardian_account_id": "auth.users",
        "club_id": "public.clubs", "home_club_id": "public.clubs",
        "team_id": "public.teams", "venue_id": "public.venues",
        "competition_id": "public.competitions", "game_id": "public.games",
        "player_id": "public.players", "billing_period_id": "public.billing_periods",
        "recorded_by": "auth.users", "created_by": "auth.users",
        "checked_in_by": "auth.users",
    }
    for insert in inserts:
        if insert.target not in COUNTS:
            problems.append(f"{insert.target}: direct seed INSERT is not allowed")
        for row in insert.rows:
            identity = literal_uuid(row.get("id", ""))
            if not identity:
                problems.append(f"{insert.target}: every fixture needs a fixed literal UUID id")
            elif identity in seen.get(insert.target, set()):
                problems.append(f"{insert.target}: duplicate fixture id")
            for column, parent in references.items():
                value = row.get(column, "null")
                if value.lower() == "null":
                    continue
                reference = literal_uuid(value)
                if not reference or reference not in seen.get(parent, set()):
                    problems.append(f"{insert.target}.{column}: must reference an earlier {parent} fixture")
            if identity:
                seen.setdefault(insert.target, set()).add(identity)
        by_table.setdefault(insert.target, []).extend(insert.rows)
    for target, count in COUNTS.items():
        if len(by_table.get(target, [])) != count:
            problems.append(f"{target}: expected {count} explicit fixture rows")

    users = by_table.get("auth.users", [])
    emails = [literal(row.get("email", "")) for row in users]
    if len(set(emails)) != len(emails) or any(not email or not re.fullmatch(r"[A-Za-z0-9._%+-]+@example\.com", email) for email in emails):
        problems.append("auth.users: need distinct synthetic example.com email addresses")
    for row in users:
        if any(column in row for column in ("encrypted_password", "confirmation_token", "recovery_token")):
            problems.append("auth.users: demo seed must not provision passwords or login tokens")
    players = by_table.get("public.players", [])
    if players:
        accounts = [literal_uuid(row.get("account_id", "")) for row in players]
        if sum(value is not None for value in accounts) != 6 or len({value for value in accounts if value}) != 6:
            problems.append("public.players: need six distinct account identities and six identities without logins")
        if not any(row.get("account_id", "").lower() == "null" and literal_uuid(row.get("guardian_account_id", "")) for row in players):
            problems.append("public.players: need a guardian-linked child without its own login")
        if not any(row.get("account_id", "").lower() == "null" and row.get("guardian_account_id", "null").lower() == "null" for row in players):
            problems.append("public.players: need an unclaimed guest without a payer")

    games = {literal_uuid(row.get("id", "")): row for row in by_table.get("public.games", [])}
    registrations = by_table.get("public.game_registrations", [])
    if games:
        future_pickups = [identity for identity, row in games.items()
                          if literal(row.get("game_type", "")) == "pickup" and literal(row.get("status", "")) == "published"]
        past_games = [identity for identity, row in games.items() if literal(row.get("status", "")) == "completed"]
        if len(future_pickups) != 1 or games[future_pickups[0]].get("capacity", "").strip() != "4":
            problems.append("public.games: need one published capacity-four pickup")
        elif (sum(literal_uuid(row.get("game_id", "")) == future_pickups[0] and literal(row.get("status", "")) == "registered" for row in registrations),
              sum(literal_uuid(row.get("game_id", "")) == future_pickups[0] and literal(row.get("status", "")) == "waitlisted" for row in registrations)) != (4, 2):
            problems.append("public.game_registrations: upcoming pickup needs four registered and two waitlisted players")
        if len(past_games) != 1:
            problems.append("public.games: past game must start completed and be locked by the billing function")
        elif sum(literal_uuid(row.get("game_id", "")) == past_games[0] and literal(row.get("attendance", "")) == "present" for row in registrations) != 3:
            problems.append("public.game_registrations: completed pickup needs three present attendees")
        competition_games = [row for row in games.values() if literal_uuid(row.get("competition_id", ""))]
        if len(competition_games) != 3 or any(literal(row.get("status", "")) != "published" for row in competition_games):
            problems.append("public.games: need three published competition fixtures")
    return by_table


def check_seed(source, available_migrations=REQUIRED_MIGRATIONS):
    problems = []
    for name in REQUIRED_MIGRATIONS:
        if name not in available_migrations:
            problems.append(f"required prerequisite migration is missing: {name}")
    scan = check_sql.scan_sql(source)
    problems.extend(f"line {check_sql.line_of(source, pos)}: {message}" for pos, message in scan.problems)
    check_sql.check_parens("seed.sql", scan.clean, problems)
    parts = list(check_sql.statements(scan))
    if not parts or len(parts) != 5 or not match(r"^\s*begin\s+isolation\s+level\s+read\s+committed\s*$", parts[0][2]):
        problems.append("seed must be one BEGIN ISOLATION LEVEL READ COMMITTED / settings / DO / COMMIT transaction")
        return problems
    raw_parts = [scan.comments_removed[start:end] for start, end, _ in parts]
    if not match(r"^\s*set\s+local\s+search_path\s*=\s*''\s*$", raw_parts[1]):
        problems.append("seed must set a transaction-local empty search_path")
    if not match(r"^\s*set\s+local\s+calblue\.seed_confirmation\s*=\s*''\s*$", raw_parts[2]):
        problems.append("checked-in seed confirmation must default OFF (an empty transaction-local setting)")
    if not match(r"^\s*do\s*$", parts[3][2]) or parts[4][2].strip().lower() != "commit" or len(scan.bodies) != 1:
        problems.append("seed requires exactly one dollar-quoted DO block followed by COMMIT")
        return problems
    body = check_sql.scan_sql(scan.bodies[0][2])
    problems.extend(f"DO body line {check_sql.line_of(scan.bodies[0][2], pos)}: {message}" for pos, message in body.problems)
    check_sql.check_parens("seed DO body", body.clean, problems)
    if body.bodies:
        problems.append("nested dollar bodies are outside the explicit seed contract")
    for forbidden in re.finditer(r"\b(?:drop|truncate|alter|grant|revoke|create|delete|merge|copy|execute|call|reset)\b", body.clean, re.I):
        problems.append(f"seed may not use {forbidden.group().upper()} or weaken schema/privileges")
    if match(r"\bset\s+(?:local|session|role|constraints|transaction|search_path)\b", body.clean):
        problems.append("DO block may not change session, role, trigger or constraint settings")
    if match(r"\b(?:commit|rollback)\b", body.clean):
        problems.append("DO block may not contain transaction boundaries")
    if match(r"\bexception\s+when\b", body.clean):
        problems.append("seed must not swallow failed guards or fixture writes")
    for email in re.finditer(r"[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})", source):
        if email[1].lower() != "example.com":
            problems.append("seed contains a non-example.com email address")
    if re.search("sb_" + r"secret_[A-Za-z0-9_-]{8,}", source) or re.search(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", source):
        problems.append("seed contains a credential-shaped secret; use synthetic fixtures only")
    inserts = parse_inserts(body, problems)
    fixtures = fixture_checks(inserts, problems)
    guard_checks(body, fixtures, problems)
    return problems


def main(argv=None):
    if argv is None:
        argv = sys.argv[1:]
    if argv:
        print("usage: python3 scripts/check_seed.py", file=sys.stderr)
        return 2
    try:
        source = SEED.read_text(encoding="utf-8-sig")
    except (OSError, UnicodeError) as error:
        print(f"check_seed: FAILED — required supabase/seed.sql cannot be read: {error}", file=sys.stderr)
        return 1
    available = {name for name in REQUIRED_MIGRATIONS if (MIG_DIR / name).is_file()}
    problems = check_seed(source, available)
    if problems:
        print("check_seed: FAILED")
        for problem in problems:
            print(f"  - {problem}")
        return 1
    print("check_seed: ok (guard/fixture structure only; scratch Supabase execution and rerun tests still required)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
