"""Issue definitions for milestones 3 to 6."""

P = "> Part of the CalBlue platform build. Design: `docs/design/DESIGN.md` (draft v0.4) and `docs/design/schema.sql`.\n"

ISSUES = [
# ----------------------------------------------------------------- M3
("competitions-crud", "M3 — Competitions", ["area:admin", "area:ui"],
 "Competitions: create, publish and manage a league or cup", f"""{P}
## Why
M2 proved the path with pickups, which have no competition. This adds the grouping that league and
tournament fixtures hang off.

## Scope
- [ ] Create and edit: name, kind (league/tournament/cup/friendly_series), season label, organiser
      (UPSL, NCCSF), external URL, start and end dates, description
- [ ] `roster_approval` toggle — does joining need an admin, or is it open
- [ ] Default per-game fee and default no-show fee
- [ ] Lifecycle: draft → published → in_progress → completed → archived, and cancel from any
      pre-completed state
- [ ] Grant somebody the `organiser` role on this competition from within the screen

## Points that must not be lost
- `hosting_mode` stays `'participant'` here. Host mode is M6 and unlocks a different set of fields.
- Deleting is not offered. Competitions are archived; `games.competition_id` is `on delete restrict`
  precisely so a delete cannot silently orphan a season of fixtures.

## Acceptance criteria
- [ ] Draft competitions are invisible to members
- [ ] An organiser grant lets that person manage this competition and nothing else
- [ ] Archiving hides it from default lists but keeps it reachable

## Test plan
- [ ] Manual lifecycle walk through every state including cancel
- [ ] Manual: as the organiser of competition A, confirm no access to competition B
"""),

("season-roster", "M3 — Competitions", ["area:ui"],
 "Season roster: request a place, and approve or reject it", f"""{P}
## Why
Being on a season roster is what makes somebody *eligible* for that competition's fixtures. It is
deliberately separate from registering for an individual match.

## Scope
- [ ] Member: request a place in a competition, proposing a season shirt number and positions
- [ ] Admin/organiser: approve, reject with a reason, or withdraw someone
- [ ] Roster view showing approved squad with numbers
- [ ] When `roster_approval` is false, requests are auto-approved

## Points that must not be lost
- `unique (competition_id, player_id)` — one request per person per competition; re-requesting after
  rejection updates the existing row.
- A partial unique index prevents two **approved** players sharing a shirt number in one competition.
  Surface that as a friendly "number 9 is taken" rather than a constraint violation.

## Acceptance criteria
- [ ] Requesting twice updates rather than duplicating
- [ ] Two approvals with the same number are rejected with a clear message
- [ ] Rejection reason is visible to the member

## Test plan
- [ ] Manual: request, reject, re-request, approve
- [ ] Manual: approve two people on number 9, confirm the second is refused cleanly
"""),

("fixtures", "M3 — Competitions", ["area:admin", "area:ui"],
 "Fixtures: schedule games inside a competition", f"""{P}
## Why
Reuses the `games` table from M2 with `competition_id` set — the payoff of having one table for
every playable event.

## Scope
- [ ] Create a fixture under a competition: opponent, home/away, venue, field, gather and kick-off
      times, capacity, fee override
- [ ] Bulk-create a run of fixtures (a season is entered in one sitting, not one form at a time)
- [ ] Fixture list for the competition, and the same game detail screen from M2
- [ ] `stage_label` and `round_number` for cups

## Points that must not be lost
- The DB CHECK requires `competition_id is not null` for league/tournament/cup types. The form must
  set `game_type` from the competition's kind rather than letting the two disagree.
- Everything M2 built — registration, capacity, waitlist, check-in, finalisation — must work on these
  fixtures with no changes. If it does not, the M2 code was written too narrowly; fix that rather
  than forking a second path.

## Acceptance criteria
- [ ] A fixture supports the entire M2 flow unchanged
- [ ] Bulk create produces correct `game_date` values across a daylight-saving boundary

## Test plan
- [ ] Manual: create a fixture, register, check in, finalise — same code path as pickup
- [ ] Manual: bulk-create fixtures spanning the November DST change, verify `game_date`
"""),

("eligibility", "M3 — Competitions", ["area:schema", "area:ui"],
 "Eligibility rules: who may register for which game type", f"""{P}
## Why
The rules table in `DESIGN.md` §8 exists but nothing enforces it yet. Until it does, an unverified
person can register for a league fixture.

## Scope
- [ ] Enforce in the database, as a trigger on `game_registrations` insert:
      - `pickup`/`training`: any identity on a signed-in account
      - `friendly`: verified identity
      - `league`/`tournament`/`cup`: verified **and** an approved `competition_registrations` row
- [ ] Client-side: explain *why* somebody cannot register, with the fix ("your identity is awaiting
      verification", "you are not on this season's roster") rather than a generic refusal
- [ ] Admin override: an admin may add anyone to any game, and that override is recorded

## Acceptance criteria
- [ ] Each rule is enforced server-side; the client cannot bypass it
- [ ] The reason surfaced to the member is specific and actionable
- [ ] Admin override works and writes `registered_by`

## Test plan
- [ ] Manual: unverified identity attempts a league fixture, confirm refusal and message
- [ ] Manual: verified but not on the roster, confirm the different message
- [ ] Manual: same person on a pickup, confirm success
"""),

# ----------------------------------------------------------------- M4
("fee-schedules", "M4 — Money", ["area:billing", "area:admin"],
 "Fee schedules: define what things cost, and when", f"""{P}
## Why
`resolve_game_fee` already implements the fallback chain. This is the screen that populates it.

## Scope
- [ ] CRUD for `fee_schedules`: scope (game type or a specific competition), amount, effective dates
- [ ] Show the resolved fee for a sample game so an admin can see the chain working
- [ ] Warn on overlapping schedules for the same scope

## Points that must not be lost
- Resolution order is `games.fee_override` → `competitions.default_fee_per_game` → matching
  `fee_schedules` → `0.00`. The screen should make that order visible, because "why was I charged
  £10 not £5" is the most common billing question a club gets.
- Changing a schedule must never alter an existing charge. Say so in the UI.

## Acceptance criteria
- [ ] A new schedule affects only games finalised after it takes effect
- [ ] The resolution preview matches what `resolve_game_fee` returns

## Test plan
- [ ] Manual: set a schedule, finalise a game, change the schedule, confirm the charge is unmoved
- [ ] Manual: compare the preview against a direct call to `resolve_game_fee`
"""),

("charges-payments-admin", "M4 — Money", ["area:billing", "area:admin"],
 "Admin: record payments, issue credits, void mistakes", f"""{P}
## Why
Money arrives by Venmo, Zelle and cash. Somebody has to tell the system it turned up.

## Scope
- [ ] Record a payment against an account: amount, method, date, external reference, note
- [ ] Optionally allocate a payment to a specific person within that account
- [ ] Issue a manual charge (equipment, season dues) or a credit (negative amount)
- [ ] Void a charge with a reason — never edit, never delete
- [ ] Per-account ledger view backed by `v_account_ledger`

## Points that must not be lost
- `charges` are immutable by trigger. The UI must offer "void and re-issue", not "edit".
- A refund is a negative payment; the schema allows `amount <> 0` rather than `> 0` for this reason.
- Every write here is audited. Do not add a path that bypasses `audit_row`.

## Acceptance criteria
- [ ] Voiding leaves the original row and excludes it from balances
- [ ] The ledger reconciles: sum of charges minus sum of payments equals `v_account_balance`

## Test plan
- [ ] Manual: record a payment, confirm the balance moves by exactly that amount
- [ ] Manual: void a charge, confirm the balance moves and the row is still present
- [ ] Manual: attempt to edit a charge amount via the API, confirm the trigger raises
"""),

("period-close", "M4 — Money", ["area:billing", "area:admin"],
 "Quarterly close: preview, reconcile, lock", f"""{P}
## Why
The end-to-end payoff, and the thing the club actually asked for: turn a quarter of attendance into
what each person owes, without anybody adding up a spreadsheet.

## Scope
- [ ] Create and manage `billing_periods`
- [ ] Preview screen: per-player attendance counts and charges, per-account money
- [ ] Blockers panel listing any game in the window that is not yet finalised, with links to fix them
- [ ] Close action calling `close_billing_period`, with an unambiguous warning that it is final
- [ ] Closed-period view rendering the frozen snapshots

## Points that must not be lost
- Closing **refuses** while any game in the window is unfinalised. Surface that as a to-do list, not
  an error — it is the single most useful thing this screen can do.
- Balances carry: `closing_balance = opening_balance + charges − payments`. An unpaid quarter is
  still owed in the next one. Do not present the quarter as if it settles itself.
- Corrections after close are credits in the next period. The UI must not offer a reopen.

## Acceptance criteria
- [ ] Close is blocked and explains exactly which games are outstanding
- [ ] After close, both summary tables are populated and the period is read-only
- [ ] Opening balance of period N+1 equals closing balance of period N

## Test plan
- [ ] Manual: attempt close with one unfinalised game, confirm the blocker list
- [ ] Manual: finalise it, close, confirm snapshots
- [ ] Manual: create the next period and verify the carried balance
"""),

("member-statement", "M4 — Money", ["area:ui"],
 "Member statement: what I owe and exactly why", f"""{P}
## Why
"Why do I owe $55?" should be answerable by the member, not by an admin reconstructing it.

## Scope
- [ ] Running balance from `v_account_balance`
- [ ] Line-by-line ledger from `v_account_ledger`, newest first, every charge naming the game
- [ ] Attendance summary per quarter
- [ ] Guardians see their children's charges rolled into their own account, itemised by person

## Acceptance criteria
- [ ] A member sees only their own account, enforced by RLS not by the query
- [ ] Every charge line links to the game that produced it
- [ ] The total matches the admin view exactly

## Test plan
- [ ] Manual: compare a member's statement against the admin ledger for the same account
- [ ] Manual: as member A, attempt to read member B's statement and confirm RLS refuses
- [ ] Manual: guardian with two children sees three sets of charges on one balance
"""),

("csv-export", "M4 — Money", ["area:billing", "area:admin"],
 "CSV export of a closed quarter", f"""{P}
## Why
The club will want this in a spreadsheet for the treasurer and for the annual summary, whatever the
app can show on screen.

## Scope
- [ ] Per-player CSV: name, attendance counts by game type, no-shows, charges, payments, balance
- [ ] Per-account CSV: payer email, opening, charges, payments, closing
- [ ] Generated client-side from the frozen snapshots — no server round trip, no new endpoint
- [ ] Filename includes the period label

## Acceptance criteria
- [ ] Columns match the example in `DESIGN.md` §9
- [ ] Values are identical to the on-screen summary
- [ ] Correct escaping for names containing commas or quotes

## Test plan
- [ ] Manual: export, open in a spreadsheet, reconcile totals against the UI
- [ ] Manual: seed a name with a comma and an apostrophe, confirm the CSV parses
"""),

# ----------------------------------------------------------------- M5
("notifications", "M5 — Polish and the installable app", ["area:pwa"],
 "Notifications: the outbox, and the four messages worth sending", f"""{P}
## Why
Registration confirmed, promoted off the waitlist, a reminder the night before, statement ready.
These are the messages a club actually needs; everything else is noise.

## Scope
- [ ] `devices` and `notifications` tables (schema.sql §10) as migration 0004
- [ ] Enqueue on: registration confirmed, waitlist promotion, 24h-before reminder, statement ready
- [ ] A scheduled job that drains the outbox and sends email
- [ ] Per-member preferences, and an unsubscribe that actually works
- [ ] In-app notification list with read state

## Points that must not be lost
- The outbox is a table, not fire-and-forget, so "did the reminder go out?" is a query.
- The reminder must carry the **gather time** and the pitch, not just kick-off. That is the
  information people actually need on the morning of a match.

## Acceptance criteria
- [ ] Every notification is a row with `sent_at` set on success
- [ ] A failed send is retried and does not block the rest of the queue
- [ ] Unsubscribing stops email but keeps in-app

## Test plan
- [ ] Manual: trigger each of the four, confirm rows and delivery
- [ ] Manual: break the mail credential, confirm retry and no queue stall
"""),

("pwa-offline", "M5 — Polish and the installable app", ["area:pwa", "area:ui"],
 "Installable app and offline check-in", f"""{P}
## Why
Fields have no signal, and a captain marking twenty people cannot depend on the network. This is the
one genuinely hard piece of client work in the project.

## Scope
- [ ] Web app manifest, icons, `theme-color`; installable to a home screen on iOS and Android
- [ ] Service worker caching the app shell and today's squad lists
- [ ] Offline queue for attendance marks, persisted in IndexedDB with the device's timestamp
- [ ] Sync on reconnect via `sync_attendance(game, player, attendance, marked_at)`
- [ ] Visible state: offline, N marks queued, syncing, synced
- [ ] Web push for the M5 notifications, on installed PWAs

## Points that must not be lost
- Safety comes from two existing decisions: `unique (game_id, player_id)` makes sync an upsert on a
  natural key, and attendance being a state rather than an event stream makes last-write-wins correct.
- `sync_attendance` refuses a mark older than the stored `checked_in_at`, so a phone offline for an
  hour cannot clobber a newer admin correction. Test that explicitly.
- The M2 check-in screen was written against a single `syncAttendance()` call site. Make that
  queue-aware rather than rewriting the screen.

## Acceptance criteria
- [ ] Marks made with the network disabled survive a full page reload
- [ ] Reconnecting syncs them with no duplicates
- [ ] A stale queued mark does not overwrite a newer correction
- [ ] Lighthouse installability check passes

## Test plan
- [ ] Manual: DevTools offline, mark 10 people, reload, reconnect, verify all 10 and no duplicates
- [ ] Manual: mark offline, have an admin correct the same row, reconnect, confirm the admin wins
- [ ] Manual: install on an actual phone and run a check-in in airplane mode
"""),

("public-roster", "M5 — Polish and the installable app", ["area:ui"],
 "Drive the public roster and fixture list from the database", f"""{P}
## Why
`roster.html` is hand-edited HTML today. Once identities are in the database, maintaining a second
copy by hand is how the two drift apart.

## Scope
- [ ] Public roster reads `v_public_roster` — opt-in and verified only
- [ ] Public fixture list reads published games
- [ ] Keep the pages statically renderable: fetch at load with a sensible empty state, so the site
      never shows a broken page if the database is unreachable
- [ ] Retire the hand-maintained markup once parity is confirmed

## Points that must not be lost
- The current roster page is already opt-in. Do not widen that by accident: the view enforces
  `is_public and verification_status = 'verified'` and the page must not query `players` directly.

## Acceptance criteria
- [ ] Only opt-in verified identities appear
- [ ] With the database unreachable the page degrades gracefully
- [ ] Parity with the current hand-written roster before the old markup is deleted

## Test plan
- [ ] Manual: toggle `is_public` off, confirm the person disappears
- [ ] Manual: block the Supabase domain in DevTools, confirm graceful degradation
"""),

("audit-viewer", "M5 — Polish and the installable app", ["area:admin"],
 "Audit log viewer", f"""{P}
## Why
`audit_log` is written from M1 onward. Without a viewer it is a table nobody ever looks at, which
defeats the point of having it.

## Scope
- [ ] Filter by table, actor, date range
- [ ] Before/after diff rendering for a row
- [ ] Admin-only

## Acceptance criteria
- [ ] Every role change, charge, payment and period close appears
- [ ] Non-admins cannot reach it, enforced by RLS

## Test plan
- [ ] Manual: perform one of each audited action and confirm it appears with correct before/after
"""),

# ----------------------------------------------------------------- M6
("clubs-teams", "M6 — Hosted tournaments", ["area:tournament", "area:admin"],
 "Clubs and teams administration", f"""{P}
## Why
`clubs` and `teams` go in during M1 as forward-compatible columns. This is where they gain a UI, and
where the opponents we already play become real rows instead of free text.

## Scope
- [ ] CRUD for clubs: name, short name, crest, city, contact details
- [ ] CRUD for teams within a club, including our own squads
- [ ] Backfill: turn existing `games.opponent` strings into club and team rows where they match
- [ ] Game form offers `home_team_id`/`away_team_id` where both sides are modelled, falling back to
      free-text `opponent` where they are not

## Acceptance criteria
- [ ] Exactly one club has `is_us`
- [ ] Existing fixtures keep working whether or not their opponent has been modelled

## Test plan
- [ ] Manual: create a club and team, attach to a fixture, confirm it renders
- [ ] Manual: confirm a legacy free-text opponent still displays correctly
"""),

("tournament-entries", "M6 — Hosted tournaments", ["area:tournament"],
 "Tournament entries: visiting clubs enter their teams", f"""{P}
## Why
The heart of the hosting stretch goal. This is the first time people who are not CalBlue members do
real work in the system.

## Scope
- [ ] Migration 0005 for schema.sql §9: `tournament_entries`, `competition_groups`, `entry_roster`,
      `game_results`, `game_events`, plus the `role_grants` and `charges` alterations
- [ ] `hosting_mode = 'host'` unlocks the entry window, entry fee, team cap and rules URL
- [ ] Public entry form: a club manager signs up, creates their club and team, submits an entry
- [ ] Admin: accept, waitlist, reject, seed into groups
- [ ] Entry fee raised as a `charges` row with `kind = 'entry_fee'` against the manager's account

## Points that must not be lost
- A manager may move their own entry to `submitted` or `withdrawn` and **nothing else**. Status,
  seed, group and fee are admin-only, enforced by the `guard_entry_decision` trigger.
- A visiting manager must not see another club's entry, any CalBlue member, or anybody's balance.
  This is the highest-risk permissions surface in the project — test it adversarially.

## Acceptance criteria
- [ ] A manager can complete an entry without an admin touching anything
- [ ] A manager cannot approve, seed or price their own entry
- [ ] Entry fees appear on the same ledger as member charges

## Test plan
- [ ] Manual: full entry journey as an outside account
- [ ] Adversarial: as manager A, attempt to read club B's entry and roster, a member profile, and a
      balance — all must be refused by the database
"""),

("groups-fixtures-rosters", "M6 — Hosted tournaments", ["area:tournament"],
 "Groups, fixtures and visiting-team rosters", f"""{P}
## Why
Once teams are accepted somebody has to draw the groups, publish the schedule, and collect squad lists.

## Scope
- [ ] Create groups and assign entries, with seeding
- [ ] Generate group fixtures (round robin) and add knockout ties via `stage_label`/`round_number`
- [ ] Roster submission by the visiting manager, reusing `players` with `account_id = null`
- [ ] Roster approval and an eligibility check (squad size, duplicate numbers)
- [ ] `roster_public` controls whether squads are visible to everyone

## Points that must not be lost
- Visiting players are ordinary `players` rows with no account. This is why `account_id` is nullable
  — do not introduce a parallel "external player" table.
- The widened `players` policies let a manager create and read only the people on their own roster.

## Acceptance criteria
- [ ] Round-robin generation produces the right number of fixtures with no team playing itself
- [ ] A manager sees only their own squad unless `roster_public` is on
- [ ] Duplicate shirt numbers within one entry are rejected

## Test plan
- [ ] Manual: 6 teams in 2 groups, generate, count fixtures
- [ ] Adversarial: manager A attempts to read club B's roster with `roster_public` off
"""),

("results-standings", "M6 — Hosted tournaments", ["area:tournament"],
 "Results, standings and top scorers", f"""{P}
## Why
The pages people actually refresh during a tournament weekend.

## Scope
- [ ] Organiser records a score; each side confirms it
- [ ] Forfeits and abandonments via `game_results.outcome`
- [ ] Goals, assists and cards through `game_events`
- [ ] Public standings from `v_standings` and scorers from `v_scorers`
- [ ] Tie-break ordering: points, goal difference, goals for, then head-to-head

## Points that must not be lost
- A team manager may flip **their own confirmation flag** and nothing else. The
  `guard_result_confirmation` trigger enforces it; the UI must match.
- Standings and scorers are views, so there is no table to fall out of sync. Do not add one.

## Acceptance criteria
- [ ] Points respect the competition's `points_win`/`points_draw`
- [ ] A forfeit is reflected correctly in the table
- [ ] A manager cannot change a score, only confirm it

## Test plan
- [ ] Manual: play out a 4-team group, verify the table by hand against the view
- [ ] Manual: as a team manager, attempt to change a score and confirm the trigger refuses
- [ ] Manual: record a forfeit and check the standings
"""),
]
