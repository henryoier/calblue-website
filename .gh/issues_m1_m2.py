"""Issue definitions for milestones 1 and 2. Re-runnable: skips titles that already exist."""

PREAMBLE = """
> Part of the CalBlue platform build. Design: `docs/design/DESIGN.md` (draft v0.4) and `docs/design/schema.sql`.
"""

CONSTRAINTS = """
### Environment constraints (apply to every issue)
The development machine has **no node/npm, no Postgres, and no Docker**. Consequences:
- The client is plain ES modules with no build step, matching the existing dependency-free site.
- SQL cannot be executed locally. Migrations are reviewed by eye and applied against a Supabase
  project by a human; every migration must therefore be idempotent-safe to re-read and land in one file.
- Automated checks are Python (`scripts/`), extending the existing `scripts/check_site.py`.
"""

ISSUES = [
# ----------------------------------------------------------------- M1
("adr-stack", "M1 — Foundations", ["area:ui", "type:foundation"],
 "ADR: client stack, repo layout, and why there is no build step", f"""{PREAMBLE}
## Why
Before any screen is written we need one decision recorded, because it constrains every later PR:
what the authenticated app is built with, and where it lives relative to the existing static site.

## Decision to record
Build the app as **plain ES modules served statically**, with the Supabase client imported from a CDN,
and **no bundler, transpiler or package manager**.

Rationale:
- The repo is already a deliberately dependency-free static site (see `README.md`). Introducing a
  toolchain would fork the project's character and its deploy story for no capability we need.
- It keeps GitHub Pages / Netlify deployment exactly as it is today: publish the directory.
- It removes an entire class of supply-chain risk for a volunteer-run club that will not be auditing
  a `node_modules` tree.
- The machine this is developed on has no node, so a build step could not be run or tested here anyway.

Cost, stated honestly: no TypeScript, no JSX, no tree-shaking, and hand-rolled reactivity. Accepted
because the app is roughly a dozen screens of forms and lists.

## Scope
- [ ] `docs/design/adr/0001-client-stack.md` recording the decision, alternatives (Vite+React, SvelteKit,
      HTMX) and the trigger that would make us revisit it
- [ ] Repo layout for the app under `/app/`, kept separate from public pages
- [ ] Document the module import convention and the pinned Supabase client version

## Acceptance criteria
- [ ] ADR committed and linked from `docs/design/DESIGN.md` §2
- [ ] `/app/` skeleton directory exists with a README explaining the no-build rule
- [ ] No `package.json` anywhere in the repo

## Test plan
- `python3 scripts/check_site.py` passes
- Grep confirms no `package.json`, no `node_modules`, no bundler config
"""),

("supabase-project", "M1 — Foundations", ["area:schema", "area:auth", "type:foundation"],
 "Provision the Supabase project and establish config/secrets conventions", f"""{PREAMBLE}
## Why
Everything downstream needs a project URL, an anon key, and a rule about what may be committed.

## Scope
- [ ] Create the Supabase project (human step — needs a login)
- [ ] `app/config.js` holding **only** the project URL and the anon key
- [ ] `.env.example` documenting the service-role key for server-side jobs, never committed
- [ ] Document in `app/README.md` which key goes where and why

## Critical rule
The **anon key is safe in the client** — it is the public identity that RLS evaluates against.
The **service-role key bypasses RLS entirely** and must never appear in the repo, in `app/`, or in
any deployed asset. It is only for scheduled jobs.

## Acceptance criteria
- [ ] Project provisioned; URL and anon key recorded
- [ ] `app/config.js` committed with real anon key, service key absent
- [ ] `scripts/check_secrets.py` fails the build if a `service_role` JWT or `sb_secret_` string appears
      anywhere in tracked files
- [ ] Auth settings: magic link enabled, email confirmations on, site URL and redirect allow-list set

## Blocked on
Needs a human with a Supabase login. **Unblocking approach:** commit `app/config.js` with clearly
marked placeholders and make every downstream PR work against those placeholders, so only a
one-line change is required once the project exists.

## Test plan
- `python3 scripts/check_secrets.py` passes on a clean tree and fails when a fake service key is added
"""),

("migration-core", "M1 — Foundations", ["area:schema", "type:foundation"],
 "Migration 0001: identity, events and participation tables", f"""{PREAMBLE}
{CONSTRAINTS}
## Why
The spine of the model. Sections 1–3 of `docs/design/schema.sql`, split out so it can be applied
and reviewed independently of money and RLS.

## Scope
Tables: `profiles`, `players`, `venues`, `clubs`, `teams`, `competitions`, `games`, `role_grants`,
`competition_registrations`, `game_registrations`.
Functions and triggers: `touch_updated_at`, `handle_new_user`, `sync_role_claim`, `set_game_date`,
`enforce_game_capacity`, `promote_from_waitlist`, `on_slot_freed`.

## Points that must not be lost in translation
- `players.account_id` is **UNIQUE and nullable** — at most one identity per account, and identities
  may exist with none (guests, children, imported roster names).
- `players.payer_account_id` is a **stored generated column**, `coalesce(account_id, guardian_account_id)`.
- `profiles.roles` is `text[]`, not a scalar, and is mirrored into the JWT by trigger.
- `games` has both `start_time timestamptz` and `game_date date`; `game_date` is set by trigger from
  the venue timezone and is what billing buckets on.
- Capacity is enforced under `pg_advisory_xact_lock` so two people cannot take the last slot.
- `game_registrations` carries `status` and `attendance` as **separate** columns.

## Acceptance criteria
- [ ] `supabase/migrations/0001_core.sql` created, ordered so no table references one defined later
- [ ] Every table has `created_at`/`updated_at` and a `touch_updated_at` trigger where mutable
- [ ] `unique (game_id, player_id)` on `game_registrations`
- [ ] File is a faithful extraction of `schema.sql` §1–3 with no silent divergence

## Test plan
- [ ] `python3 scripts/check_sql.py` — a new linter asserting: balanced `$$` blocks, no table
      referenced before creation, every `create table` has a matching RLS enablement in 0003,
      no `role text` scalar remnants
- [ ] Manual: apply to a scratch Supabase project, confirm it runs clean in one pass
- [ ] Manual: insert two identities for one account and confirm the unique index rejects the second
"""),

("migration-money", "M1 — Foundations", ["area:schema", "area:billing"],
 "Migration 0002: money, billing periods and the four functions", f"""{PREAMBLE}
{CONSTRAINTS}
## Why
Sections 4–6 of `schema.sql`. Separated from 0001 so a schema review can consider the money model
on its own — it is where the subtle correctness lives.

## Scope
Tables: `fee_schedules`, `billing_periods`, `charges`, `payments`, `period_player_summaries`,
`period_account_summaries`, `audit_log`.
Functions: `resolve_game_fee`, `resolve_no_show_fee`, `finalise_game_attendance`,
`assign_to_periods`, `close_billing_period`, `audit_row`.
Views: `v_account_balance`, `v_account_ledger`, `v_public_roster`.

## Points that must not be lost
- `charges` are **immutable**: a trigger blocks UPDATE of the money-bearing columns and blocks DELETE
  outright. Corrections void and re-issue.
- The partial unique index `charges_auto_once (game_id, player_id, kind) where source='auto'` is what
  makes `finalise_game_attendance` safe to run twice.
- `charges.player_id` is nullable and `charges.entry_id` exists, because a tournament entry fee is
  owed by a club, not a person. A CHECK requires one or the other.
- `billing_periods` has an `EXCLUDE USING gist` constraint so two periods cannot claim the same day.
- `close_billing_period` **refuses** if any game in the window is not finalised or cancelled.
- Attendance counts in `period_player_summaries` must be scoped to the period. An earlier draft
  joined registrations without the date filter and counted a player's whole history — do not
  reintroduce that.

## Acceptance criteria
- [ ] `supabase/migrations/0002_money.sql` created
- [ ] Charge immutability trigger present and covering DELETE
- [ ] `close_billing_period` writes both summary grains and flips status to `closed`

## Test plan
- [ ] `scripts/check_sql.py` passes
- [ ] Manual on a scratch project: finalise the same game twice, assert exactly one charge per player
- [ ] Manual: attempt `update charges set amount = ...`, assert it raises
- [ ] Manual: two overlapping billing periods, assert the exclusion constraint rejects the second
"""),

("migration-rls", "M1 — Foundations", ["area:schema", "area:auth", "type:foundation"],
 "Migration 0003: row-level security policies and role helpers", f"""{PREAMBLE}
{CONSTRAINTS}
## Why
This is the security boundary. Section 7 of `schema.sql`. It has to land as its own migration so it
can be reviewed as a unit and so a reviewer can see every policy in one file.

## Scope
- Helpers: `app_roles()`, `has_role()`, `is_admin()`, `owns_player()`, `manages_game()`,
  `has_grant_on_competition()`
- `enable row level security` on every table
- Policies per the matrix in `DESIGN.md` §4
- Column-level guards that policies cannot express, as triggers: `guard_role_change`,
  `guard_verification`, `guard_attendance`

## Points that must not be lost
- Roles are read from the **JWT** (`app_metadata.roles`), never by querying `profiles` inside a
  policy — that recurses. The trigger in 0001 keeps the claim in sync; a role change takes effect on
  the next token refresh, which must be documented in the UI.
- A player may change their own shirt number but **not** their own attendance. That is a
  column-level rule inside a row they may otherwise edit, hence a trigger not a policy.
- Multiple permissive policies are OR-ed. Later migrations widen access by adding policies rather
  than rewriting existing ones.

## Acceptance criteria
- [ ] `supabase/migrations/0003_rls.sql` created
- [ ] Every table created in 0001 and 0002 has RLS enabled and at least one policy
- [ ] No policy body contains `from public.profiles`

## Test plan
- [ ] `scripts/check_sql.py` asserts RLS coverage and the no-profiles-in-policy rule
- [ ] Manual matrix test on a scratch project with three accounts (member, organiser, admin):
      for each row of the DESIGN.md §4 matrix, attempt the read and the write and record the result
- [ ] Specifically assert a member **cannot** read another member's phone number or charges
"""),

("seed-dev", "M1 — Foundations", ["area:schema"],
 "Seed and fixture data for local development and demos", f"""{PREAMBLE}
## Why
Every screen after this needs something to render, and the RLS matrix test needs known accounts.

## Scope
- [ ] `supabase/seed.sql`: one club (CalBlue, `is_us`), one default team, two venues, a pickup game,
      a competition with three fixtures, and ~12 identities
- [ ] Identities deliberately spanning the awkward cases: one with no account (guest), one child with
      a guardian, one person holding `{{player, treasurer}}`, one organiser with a scoped grant only
- [ ] A fee schedule and an open billing period
- [ ] Seed is safe to re-run (`on conflict do nothing` or truncate-and-load behind a guard)

## Acceptance criteria
- [ ] Seed produces a database where every screen in M2 has non-trivial content
- [ ] No real member PII — invented names, example.com addresses

## Test plan
- [ ] Manual: apply 0001–0003 then seed, confirm clean run
- [ ] Re-run seed, confirm no duplicate-key errors
"""),

("app-shell", "M1 — Foundations", ["area:ui", "type:foundation"],
 "App shell: routing, layout, and reuse of the existing design system", f"""{PREAMBLE}
{CONSTRAINTS}
## Why
Somewhere for every later screen to live, and a single place where session state is resolved.

## Scope
- [ ] `app/index.html` as a single entry point with a hash router (no server rewrites needed, so it
      works unchanged on GitHub Pages)
- [ ] `app/js/router.js`, `app/js/supabase.js` (client singleton), `app/js/session.js`
- [ ] Layout chrome: header, nav that reflects the signed-in person's roles, footer
- [ ] Reuse `styles.css` custom properties (`--navy`, `--blue`, `--ink`) so the app looks like the site
- [ ] A loading and an error state that are used consistently, not reinvented per screen

## Acceptance criteria
- [ ] Navigating to an unknown route renders a 404 view, not a blank page
- [ ] Nav shows only what the current roles permit; signed-out users see a sign-in prompt
- [ ] Mobile-first: usable at 360px wide, which is the check-in case

## Test plan
- [ ] `python3 -m http.server` then load `/app/` and walk every route
- [ ] `scripts/check_site.py` extended to validate `/app/` pages too
- [ ] Manual: 360px viewport, confirm no horizontal scroll
"""),

("auth-magic-link", "M1 — Foundations", ["area:auth"],
 "Magic-link sign-in, session persistence, and profile bootstrap", f"""{PREAMBLE}
## Why
The front door. Every other authenticated screen depends on a resolved session.

## Scope
- [ ] Sign-in screen: email → magic link
- [ ] Callback handling, session persisted, silent refresh
- [ ] Sign-out
- [ ] On first sign-in the `handle_new_user` trigger has already created `profiles`; the app must
      handle the brief window where the row exists but `display_name` is empty
- [ ] Surface the JWT-refresh caveat: after an admin changes someone's roles, the change lands on
      the next refresh. Provide an explicit "refresh my access" action rather than leaving people confused.

## Acceptance criteria
- [ ] Signing in from a cold browser lands on the intended route, not the home page
- [ ] Refreshing the page keeps the session
- [ ] Signing out clears the session and any cached profile
- [ ] An expired link shows a clear message and an obvious way to request another

## Test plan
- [ ] Manual: full round trip against the Supabase project
- [ ] Manual: open the magic link in a different browser and confirm behaviour is sane
- [ ] Manual: revoke a role, confirm the UI updates after "refresh my access"
"""),

("identity-screen", "M1 — Foundations", ["area:ui"],
 "My identity: create and edit the person behind the account", f"""{PREAMBLE}
## Why
An account with no identity cannot register for anything. This is the second screen anybody sees.

## Scope
- [ ] View and edit own `players` row: display name, legal name, date of birth, default positions,
      preferred number, jersey size, emergency contact, medical notes
- [ ] Create the identity if the account has none — **and only if it has none**, since the model is 1:1
- [ ] Show verification status plainly, including what it gates
- [ ] Guardians: create and manage a child identity (no login, `guardian_account_id` set to me)
- [ ] Opt-in toggle for the public roster, with honest wording about what becomes public

## Points that must not be lost
- The UI must never offer "add another identity for myself". One account, one identity.
- `verification_status` is not editable here; the trigger will reject it and the UI should not try.
- Medical notes are sensitive. Do not render them in any list view, only on the person's own screen.

## Acceptance criteria
- [ ] A new account can create exactly one identity and is then offered child identities instead
- [ ] Editing verification status is impossible from the UI
- [ ] Form validates jersey number 0–99 and rejects a future date of birth

## Test plan
- [ ] Manual: create identity, edit it, reload, confirm persistence
- [ ] Manual: attempt a second identity via the API directly and confirm the DB rejects it
- [ ] Manual: as another member, confirm the medical notes are not readable
"""),

("admin-verification", "M1 — Foundations", ["area:admin", "area:ui"],
 "Admin: player verification queue", f"""{PREAMBLE}
## Why
Verification gates official games. Without a screen for it, nobody can play a league fixture.

## Scope
- [ ] List of identities with `verification_status = 'pending'`, newest first
- [ ] Approve / reject with a note; rejection reason is shown to the person
- [ ] Search across all identities by name
- [ ] Bulk approve, because the initial roster import will produce ~30 at once

## Acceptance criteria
- [ ] Only an account holding `admin` can reach the screen or perform the action
- [ ] A non-admin hitting the route directly gets a refusal from the database, not just a hidden button
- [ ] Approving writes `decided_by` and `decided_at`

## Test plan
- [ ] Manual: approve and reject, confirm status changes and the note is visible to the member
- [ ] Manual: as a non-admin, call the update directly and confirm the trigger rejects it
"""),

# ----------------------------------------------------------------- M2
("game-crud", "M2 — Pickup end to end", ["area:admin", "area:ui"],
 "Create, publish, edit and cancel a pickup game", f"""{PREAMBLE}
## Why
M2 does one game type end to end. Pickup first because it has the fewest rules: no competition,
no roster approval, no verification gate.

## Scope
- [ ] Create form: title, venue, field label, gather time, start time, end time, capacity,
      registration window, kit colour, notes, fee override
- [ ] `game_type = 'pickup'` and `competition_id = null`, enforced by the DB CHECK
- [ ] Publish (draft → published), close registration, cancel with a reason
- [ ] Timezone handling: the admin picks a local time; the app stores `timestamptz` and lets the
      trigger derive `game_date`

## Points that must not be lost
- A cancelled game keeps its registrations for the record and must never produce charges.
- `gather_time <= start_time` and `registration_closes_at <= start_time` are DB CHECKs; the form
  should prevent violating them rather than surfacing a raw constraint error.

## Acceptance criteria
- [ ] An organiser (scoped grant) can create a pickup without being a club admin
- [ ] Draft games are invisible to members
- [ ] Cancelling asks for a reason and shows it on the game

## Test plan
- [ ] Manual: create, publish, verify visibility as a member, cancel, verify the reason renders
- [ ] Manual: submit a gather time after kick-off and confirm the form blocks it
"""),

("game-list-detail", "M2 — Pickup end to end", ["area:ui"],
 "Game list and game detail", f"""{PREAMBLE}
## Why
The screen members will open most often: what am I playing, when, and where.

## Scope
- [ ] Upcoming list, soonest first, with date, time, venue, spots left
- [ ] Detail view: everything on the game plus the venue address and map link, gather time called out
      separately from kick-off, kit colour, notes
- [ ] Current squad list with shirt numbers, respecting what the viewer may see
- [ ] Own registration state shown unambiguously: registered, waitlisted at position N, or not in

## Acceptance criteria
- [ ] Spots-left reflects only `registered` rows with `participation in ('player','keeper')`
- [ ] Waitlist position is derived from `registered_at` ordering, not stored
- [ ] Renders correctly at 360px

## Test plan
- [ ] Manual against seed data with a full game and a waitlist
- [ ] Manual: confirm a signed-out visitor sees the published game but not the squad's contact details
"""),

("register-cancel", "M2 — Pickup end to end", ["area:ui"],
 "Register and cancel, with shirt number and position", f"""{PREAMBLE}
## Why
The core member action, and one of the two explicit asks in the original brief.

## Scope
- [ ] Register: pre-fill shirt number and positions from the identity's defaults, allow override
      for this match only
- [ ] Cancel own registration; after the deadline it still succeeds but sets `late_cancel = true`
- [ ] Re-registering after cancelling revives the existing row (there is a unique constraint —
      do not insert a second)
- [ ] Guardians register their children from the same screen

## Points that must not be lost
- Number and position on `game_registrations` are the per-match answer and override the identity
  defaults. Do not write back to the identity.
- Duplicate shirt numbers within one game are a **warning, not a block** — irrelevant in a pickup.

## Acceptance criteria
- [ ] Registering twice is impossible; the second attempt updates the first row
- [ ] Cancelling after the deadline sets `late_cancel`
- [ ] A guardian can register a child; a member cannot register somebody else

## Test plan
- [ ] Manual: register, cancel, re-register, confirm one row throughout
- [ ] Manual: attempt to register another member's identity and confirm RLS refuses
"""),

("capacity-waitlist", "M2 — Pickup end to end", ["area:ui", "area:schema"],
 "Capacity enforcement and automatic waitlist promotion", f"""{PREAMBLE}
## Why
The behaviour most likely to be got subtly wrong, and the one that annoys people most when it is.

## Scope
- [ ] Client catches the `game_full` exception and offers the waitlist instead of showing an error
- [ ] Automatic promotion when a slot frees, ordered by `registered_at`
- [ ] The promoted person is told (email in M5; for now, visible state change)
- [ ] Waitlist position shown to the person waiting

## Points that must not be lost
- Capacity is enforced in the database under an advisory lock. The client must **not** pre-check
  "spots left" and decide — that is a race. It attempts the insert and handles the failure.
- Promotion is triggered by the DB, not the client. A client that cancels must not also try to promote.

## Acceptance criteria
- [ ] Two simultaneous registrations for the last slot produce exactly one `registered`
- [ ] Cancelling from a full game promotes exactly one person
- [ ] Promotion does not overshoot capacity when several cancel at once

## Test plan
- [ ] Manual concurrency test: two browser sessions submit for the final slot at the same moment
- [ ] Manual: fill a game, add three to the waitlist, cancel two, confirm exactly two promotions
- [ ] `scripts/check_sql.py` asserts the advisory lock is present in the capacity function
"""),

("checkin", "M2 — Pickup end to end", ["area:ui"],
 "Mobile check-in screen for captains", f"""{PREAMBLE}
## Why
Used one-handed, outdoors, on a phone, possibly in the rain. It deserves to be designed for that
rather than being an admin table that happens to be responsive.

## Scope
- [ ] List of `registered` players with shirt number and position, large tap targets
- [ ] Toggle present / absent / excused per person, writing `checked_in_at` and `checked_in_by`
- [ ] Adjust a shirt number at the field
- [ ] Running count of present vs expected
- [ ] Only reachable by an admin or someone with a `captain`/`organiser` grant on that game

## Points that must not be lost
- Attendance is guarded by a trigger: a player cannot mark themselves. The screen must be captain-only.
- Offline support is **out of scope here** and lands in M5 — but do not build anything that would have
  to be torn out: write through a single `syncAttendance()` call site that M5 can make queue-aware.

## Acceptance criteria
- [ ] Every control is at least 44px tall
- [ ] Marking is idempotent — double-tap does not toggle back accidentally
- [ ] A member who is not a captain cannot load the screen or write attendance

## Test plan
- [ ] Manual at 360px with a 20-person squad
- [ ] Manual: as a plain member, attempt the attendance write directly and confirm the trigger refuses
"""),

("finalise-charges", "M2 — Pickup end to end", ["area:billing"],
 "Finalise attendance and write the charges", f"""{PREAMBLE}
## Why
The join between "who played" and "who owes what", and the point where the money model first runs.

## Scope
- [ ] Finalise action on a completed game, calling `finalise_game_attendance(game_id)`
- [ ] Preview before committing: who will be charged, how much, and why
- [ ] Everyone still `unknown` becomes `absent`
- [ ] Game moves to `locked` and `attendance_locked_at` is set
- [ ] Clear messaging that this is the point of no return, and that corrections after it are credits

## Points that must not be lost
- The function is idempotent by construction. The UI should still prevent double-submission, but a
  second call must not double-charge — assert this in the test plan rather than assuming it.
- A cancelled game must produce no charges. Verify explicitly.

## Acceptance criteria
- [ ] Finalising writes exactly one `game_fee` charge per present player
- [ ] Running it twice changes nothing
- [ ] The charge amount matches `resolve_game_fee` at that date, frozen thereafter

## Test plan
- [ ] Manual: finalise, inspect `charges`, finalise again, confirm no duplicates
- [ ] Manual: change the fee schedule afterwards, confirm the existing charge does not move
- [ ] Manual: cancel a game with registrations, finalise, confirm zero charges
"""),
]
