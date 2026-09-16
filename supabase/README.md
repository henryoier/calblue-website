# CalBlue database migrations

Issue #25 adds the **core schema file and its checks**, not a live database deployment or a
member-facing feature. Nothing in GitHub Actions applies SQL to Supabase. The public website
and `/app/` placeholder remain unchanged.

## What migration 0001 installs

| Area | Tables / behavior |
|---|---|
| Accounts and people | `profiles`, `players`; profile bootstrap on Auth signup, role metadata synchronization, at most one player identity per account, generated payer account, guest/guardian identities. |
| Fixtures and organizations | `venues`, `clubs`, `teams`, `competitions`, `games`; timezone-derived game date and update timestamps. |
| Participation | `role_grants`, `competition_registrations`, `game_registrations`; exactly one scope per role grant, unique season/match registration, separate registration status and attendance. |
| Internal slot handling | Serialized capacity checks, player/keeper-only counting, waitlist promotion when a counted slot is cancelled, deleted or changed to a nonplaying role. |

All ten tables have RLS enabled **without client policies**, and table privileges are revoked
from `PUBLIC`, `anon` and `authenticated`. Internal helper execution is also revoked from those
roles. The browser cannot read or write these tables just because migration 0001 was applied.
Owner/server access is still privileged; this is not a restriction on a database administrator.

No member/admin authorization policy, registration screen, eligibility check, signup deadline
workflow, attendance-finalization billing or money table is delivered here. Those remain separate
issues. Issue #27 must explicitly grant the minimum table/function privileges alongside its policies;
policies alone do not undo this migration's revocations. Do not re-grant all privileges to make a
later screen work.

## Source and generation

`docs/design/schema.sql` is the canonical source. Only sections 0–3 are emitted for issue #25.
Do not run the whole draft source as a migration; it also contains unimplemented later phases.

```bash
python3 scripts/build_migrations.py --target 0001_core.sql
python3 scripts/build_migrations.py --check
python3 scripts/check_sql.py
python3 -m unittest discover -s tests -v
```

Default generation/checking requires **only 0001**. Future files require explicit repeatable
`--target` selections; they are not silently created as part of this issue. `--check` never writes
files or creates directories and fails if a required file is missing or different.

Generation is reproducible; **SQL execution is not replay-idempotent**. Apply 0001 once using
migration tracking, or once manually on a fresh scratch project and record that application.
The generated file has `BEGIN`/`COMMIT` so an error does not commit half an installation. Do not
add blanket `IF NOT EXISTS`, drop existing tables, or repeatedly paste a partially applied file
to conceal a failure. A subsequent schema change after release must be a new migration.

## Explicit corrections to the draft

These corrections are in the canonical source as well as the generated file; none is a hidden
generated-only divergence:

- Add the players-to-clubs foreign key after `clubs` exists; the original ordering failed on a
  fresh database.
- Add missing `updated_at` columns/touch triggers for mutable teams and role grants, and the
  missing clubs touch trigger.
- Derive `game_date` on every game write, using the named venue's timezone when present. A
  venue-less game uses its own timezone. A caller cannot override the derived date directly.
- Enforce exactly one competition/game/team target per role grant.
- Keep registration identity/game/player immutable; moves require a distinct registration.
- Count occupied slots as a trusted internal function so future RLS visibility cannot cause
  undercounting. Serialize registration changes, allow same-player upserts, and count only
  registered players/keepers. Registration changes and promotion require the default
  `READ COMMITTED` transaction isolation so counts get fresh snapshots after lock waits;
  other isolation modes fail with `registration_requires_read_committed` (`0A000`).
  In particular, an advisory lock alone cannot refresh a stale `REPEATABLE READ` snapshot.
- Promote only waiting players/keepers in published or registration-closed games with waitlists
  enabled and finite capacity. Cancelled/completed/locked/draft games are not auto-promoted.
  Order eligible candidates by `registered_at, id`; skip rows locked by another transaction and
  recheck status. A concurrently locked candidate may be skipped or leave a vacancy for a later
  registration operation; this is not a claim of strict FIFO under concurrent edits.
- Install RLS/table/function restrictions in 0001 rather than exposing tables until a later PR.
  Definer helpers have fixed empty search paths and qualified application-object references.

The slot helpers do not implement the full future registration workflow. Game-capacity edits,
deadline/eligibility rules and retries under concurrent transactions require the later feature
tests; they must not be inferred from a passing structural check.

## Manual verification — still required

There is no local PostgreSQL/Docker environment. The Python linter checks a documented subset
of SQL structure and repository conventions; it cannot prove PostgreSQL execution, privileges,
trigger behavior, delivery of Auth emails or concurrency correctness.

1. Use a **fresh, disposable Supabase scratch project**, not a project containing member data.
   These files have not been applied to the configured CalBlue project. No database password is
   needed when using the dashboard SQL Editor as the project administrator.
2. Review the complete `migrations/0001_core.sql`, then run it once in the scratch SQL Editor.
   Confirm there are no SQL errors. If it fails, report the error; do not drop tables or loosen
   permissions to get past it.
3. Run `tests/0001_core_smoke.sql` in that same scratch project. It uses synthetic accounts and
   players inside a transaction, checks constraints/triggers and restricted access, then rolls
   its test changes back. The success result is emitted before rollback, so an aborted test
   cannot appear successful merely because rollback succeeded.
   Separately run `tests/0001_core_isolation_smoke.sql` to verify that a `REPEATABLE READ`
   transaction is rejected before a stale-snapshot capacity check can run. Both scripts must
   finish without errors; passing one does not compensate for failure in the other.
4. Record the scratch run outcome in PR #79. Confirm especially that a second player identity
   for the same account is rejected. Do not paste passwords, private keys or real member data
   into the PR.
5. Separately verify two-session races on the scratch project before enabling registration:
   two players competing for one remaining slot, simultaneous cancellation/promotion, and
   cancellation of a candidate selected for promotion. Verify no overbooking or resurrection
   of a cancelled registration. Use two independent transactions; sequential smoke tests do
   not prove these properties. Avoid assuming that separate SQL Editor runs retain a session.

Until the scratch application and smoke checks are confirmed, PR #79 **addresses** issue #25
rather than claiming it is fully verified. CI remains entirely offline with respect to Supabase.
