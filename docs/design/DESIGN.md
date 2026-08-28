# CalBlue — league, pickup and membership platform

**Data model and permissions design · draft v0.3 · for review**

Today calblue.com is a static site: hand-edited HTML for the roster, the galleries and the fixtures. This document proposes the authenticated system that sits behind it — accounts, player identities, leagues and tournaments, pickup games, per-game registration, attendance, and an end-of-quarter bill that the club does not have to add up by hand.

Nothing here has been built. The point of writing it down first is that the parts we get wrong on paper are cheap, and the parts we get wrong in a database that already holds two seasons of attendance are not. The accompanying `schema.sql` is the exact contract: once we agree on this document, that file becomes migration `0001`.

---

## 1. What the system has to do

1. **Accounts and members.** People sign up. Some of them play; some are parents, organisers or supporters who never will.
2. **Player identities.** A profile with a name, positions, a preferred number, jersey size and emergency contact — attached to an account, so that registering for a game is two taps rather than a form.
3. **Leagues and tournaments,** each made up of individual games.
4. **Pickup games** that belong to no competition and are open to whoever signs up first.
5. **Registration to play,** per game, with a capacity limit and a waitlist.
6. **Per-game information:** venue, field, gather time, kick-off time, opponent, kit colour, fee.
7. **Per-player-per-game information:** shirt number and position for that match.
8. **A quarterly attendance summary** that turns who-actually-played into who-owes-what.
9. **Three levels of access** — developer, admin, ordinary user — with the club's private data properly fenced off.
10. **Eventually, hosting our own tournaments** — the Kylin Cup run on this platform, with visiting clubs entering their own teams. Section 11 covers what that costs and what it needs.
11. **Eventually, a phone app** on the same backend, so registering and managing an account is a thing you do standing on a touchline. Section 12.

---

## 2. Recommended platform

| Layer | Recommendation | Why |
|---|---|---|
| Database | Postgres (via Supabase) | The domain is relational to its bones: competitions → games → registrations → attendance → charges. Trying to model this in a document store means re-implementing joins in application code. |
| Auth | Supabase Auth — email magic link, optionally Google | No password handling to own, and it plugs straight into row-level security. |
| Authorisation | Postgres row-level security | Permissions live next to the data. A bug in a screen cannot leak another member's phone number, because the database itself refuses to return the row. |
| App | A separate authenticated app at `app.calbluefc.com` | The public site stays a dependency-free static site. Nothing private is ever served from the same origin as the marketing pages. |
| Payments | Recorded, not processed | Money keeps moving by Venmo, Zelle or cash; an admin records what arrived. No card data, therefore no PCI obligations. A payment provider can be added later without touching the schema. |

Firebase or a hand-rolled API would both work. The schema in `schema.sql` is standard Postgres, so this is a reversible decision — but the row-level-security story is materially better here, and for a volunteer-run club "the database enforces it" is worth more than it would be at a company with a security review process.

---

## 3. Eight decisions that shape everything else

**1. An account is not a player.** `profiles` is a login. `players` is a person in the club. One account can hold several player identities — a parent registering two children — and a non-player account simply holds none. This is the difference between a system that can handle a family and one that can't.

**2. A player identity can exist without an account.** A drop-in guest at a pickup, or the thirty names on the existing Kylin Cup roster sheet, become `players` rows with `account_id = null`, and can be claimed later with a code. Requiring a login before a person can be recorded is how clubs end up keeping the real roster in a spreadsheet anyway.

**3. One `games` table for everything.** A league fixture, a cup tie, a friendly and a Saturday pickup are the same shape: a time, a place, a capacity, a list of people. `game_type` distinguishes them. The alternative — a separate `pickup_games` table — duplicates registration, attendance and billing three times over.

**4. A pickup is `game_type = 'pickup'`, not "has no competition".** A friendly can also have no competition. Deriving a game's nature from a null is the kind of shortcut that produces a wrong invoice eighteen months later.

**5. Season eligibility and match registration are different things.** Being approved onto a competition roster makes you *allowed* to play its games. A `game_registrations` row means you are *playing this one*. Number and position live on both: the season default, and the per-match override.

**6. Status and attendance are separate columns.** `status` is what the player intended — registered, waitlisted, cancelled. `attendance` is what happened — unknown, present, absent, excused. Collapsing them into one field is the single most common mistake in this kind of schema, and it makes "who was on the list but didn't turn up" unanswerable.

**7. Attendance writes immutable line items.** When a game is finalised, every player who was present gets a `charges` row carrying the fee **as it was on that day**. The quarterly total is then a sum, not a recalculation. Change a fee schedule next season and last season's numbers do not move.

**8. Least privilege, and the developer is not an admin.** `admin` runs the club. `developer` runs the platform: migrations, secrets, deploys. A developer who needs to look at member data does so through an audited break-glass path, so that the audit log stays meaningful.

---

## 4. Roles, accessibility and permissions

Three global roles, and one scoped grant:

| Actor | How it is represented | What it is for |
|---|---|---|
| **Public** | not signed in | The published schedule, results, and the opt-in public roster. |
| **User** | `profiles.role = 'user'` | The default on sign-up. Manages their own account, their own player identities, their own registrations, and sees their own statement. May have no player identity at all. |
| **Player** | *not a role* — a capability | Anyone whose account owns a verified `players` row can register to play. Nothing to grant. |
| **Captain / organiser** | a row in `staff_assignments` | Scoped to one competition or one game: edit that game, run check-in, move the waitlist. Deliberately **not** a global role, so a captain for one tournament does not become a captain of everything. |
| **Admin** | `profiles.role = 'admin'` | Club operations: competitions, games, venues, fees, verification, attendance, payments, closing the quarter. |
| **Developer** | `profiles.role = 'developer'` | Schema, secrets, deploys, break-glass. No routine business writes — those go through an admin account so the audit trail means something. |

### Diagram 1 — permission matrix

*Who can read and write what. Every cell is enforced by a Postgres policy, not only by whether a button is visible. Full resolution: `docs/design/diagrams/02-permissions.png`*

Three details worth calling out:

- **Minors.** A player identity carries `guardian_account_id`. Only that guardian or an admin can register or cancel for them.
- **Medical and emergency fields.** Visible to the owner, the guardian, and to a captain of a game that player is registered for — not to the club at large.
- **The public roster is opt-in.** `v_public_roster` returns only players who are both `is_public` and `verified`. The current static roster page is already opt-in; this preserves that rather than quietly widening it.

---

## 5. The data model

### Diagram 2 — entity map

*The core tables, grouped by concern. Full resolution: `docs/design/diagrams/01-entity-map.png`*

### 5.1 Identity and access

| Table | Purpose | Notes worth reading |
|---|---|---|
| `profiles` | One row per login, keyed to `auth.users` | `role` is mirrored into the JWT by a trigger, so policies read the token rather than re-querying this table — otherwise the policy on `profiles` would recurse into itself. The cost: a promotion takes effect on the next token refresh. |
| `players` | A person in the club | `account_id` is **nullable** (guests, unclaimed imports). `guardian_account_id` handles minors. `verification_status` gates official games. `is_public` gates the roster page. |
| `staff_assignments` | Scoped captain / manager grants | Points at a competition *or* a game. This is how we avoid a fourth global role. |
| `audit_log` | Before/after JSON for sensitive writes | Triggered on charges, payments, role changes and period closes. |

### 5.2 Events and schedule

| Table | Purpose | Notes |
|---|---|---|
| `venues` | Reusable fields | Carries an IANA `timezone`, which is what makes "which quarter is this game in?" answerable without guessing. |
| `clubs` | An organisation | CalBlue is one row, flagged `is_us`; opponents are the others. Added in v1 purely so that section 11 is additive later. |
| `teams` | A squad belonging to a club | One default CalBlue row today. A B team, a veterans side, or a visiting club's team is a new row, not a migration. |
| `competitions` | A league, tournament or cup | `roster_approval` decides whether joining needs an admin. Holds the default per-game fee. |
| `games` | Every playable event | See the checklist below. |

**Everything a `games` row carries**, which was one of the explicit asks:

- *Identity* — title, `game_type`, competition (or none), opponent (free text) or `home_team_id`/`away_team_id` when both sides are modelled, home/away, and which of our squads.
- *Where* — `venue_id`, plus `field_label` for "Turf 2", plus the venue's address and map link.
- *When* — `gather_time`, `start_time`, `end_time`, the IANA `timezone`, and `game_date`, the local calendar date, maintained by a trigger and used for billing.
- *Logistics* — `capacity`, `min_players`, `waitlist_enabled`, `registration_opens_at`, `registration_closes_at`, `kit_color`, `notes` (parking, gate code, warm-up).
- *Money* — `fee_override` and `no_show_fee_override`; null means inherit.
- *State* — `status`, `cancellation_reason`, `attendance_locked_at`.

### 5.3 Participation

`competition_registrations` is the season roster: competition, player, status, season number and positions. A partial unique index stops two approved players wearing the same number in the same competition.

`game_registrations` is the per-game slot, and it is the busiest table in the schema:

- `status` — registered, waitlisted, cancelled
- `participation` — player, keeper, coach, volunteer (only player and keeper consume a capacity slot or attract a fee)
- `jersey_number`, `positions[]` — **the per-match answer**, pre-filled from the season roster and then from the player's defaults
- `attendance` — unknown, present, absent, excused
- `checked_in_at` / `checked_in_by`, `registered_by`, `cancelled_at`, `late_cancel`

`unique (game_id, player_id)` means one slot per person per game; re-registering after a cancellation revives the existing row rather than creating a second one.

### 5.4 Money

| Table | Purpose |
|---|---|
| `fee_schedules` | Default amounts by game type or by competition, with effective dates. |
| `charges` | Immutable line items: a game fee, season dues, a no-show penalty, equipment, a manual adjustment, a credit. Negative amounts are credits. Corrections **void and re-issue**; they never edit. |
| `payments` | Money received, per account, recorded by an admin. Negative amounts are refunds. |
| `billing_periods` | A quarter, with a non-overlap constraint so two periods can never claim the same day. |
| `period_player_summaries` | Frozen at close: attendance counts and charges, per player. |
| `period_account_summaries` | Frozen at close: opening balance, charges, payments, closing balance, per paying account. |

Two summary tables rather than one, because attendance is a property of a *player* and money is a property of a *payer*. A parent paying for two children needs one bill and two attendance records.

---

## 6. Lifecycles

### Diagram 3 — state machines

*Every status column in the schema. Full resolution: `docs/design/diagrams/03-lifecycles.png`*

Two of these deserve a note.

**A game ends at `locked`, not `completed`.** `completed` means the match was played; `locked` means attendance has been finalised and the charges are written. The gap between them is the correction window, and it is where a captain fixes the two people they mis-tapped at the field.

**A closed billing period never reopens.** If an error surfaces in March about January, it becomes a credit dated into the current quarter. Reopening a closed period would silently change a number somebody has already been shown and, in some cases, already paid.

---

## 7. How it runs, end to end

### Diagram 4 — flow by actor

*Setup to quarter close. Full resolution: `docs/design/diagrams/04-flow.png`*

The important property of this picture is what is *not* in the human lanes. Eligibility checks, capacity, waitlist promotion, no-show marking, fee resolution and the quarterly roll-up are all database functions. Admins and captains approve, correct and record — they never total anything by hand, and there is no spreadsheet that can disagree with the app.

---

## 8. Registration, capacity and attendance

**Who may register for what**

| Game type | Requirement |
|---|---|
| `pickup`, `training` | Any player identity on a signed-in account. Verification not required — this is how new people try the club. |
| `friendly` | A verified player. |
| `league`, `tournament`, `cup` | A verified player **and** an approved `competition_registrations` row. |

**Capacity and the waitlist.** Capacity is enforced inside a per-game advisory lock, so two people tapping "register" on the last slot cannot both get it — one receives a `game_full` error and is offered the waitlist instead. When a slot frees, the longest-waiting person is promoted automatically, ordered by `registered_at`. There is no stored waitlist position to drift out of sync; position is derived from that ordering.

**Check-in.** On a phone at the field, a captain sees the registered list with numbers and positions and marks each person present or absent. Finalising the game turns everyone still `unknown` into `absent`, writes the charges, and locks the game.

**Edge cases and the policy each one needs**

| Case | Proposed handling |
|---|---|
| Registering after the deadline | Blocked; an admin can override. |
| Cancelling after the deadline | Allowed, flagged `late_cancel`. Whether it costs anything is a club decision — the schema supports a `late_cancel` charge either way. |
| No-show | `attendance = 'absent'`. Counted in the summary; a `no_show` fee is charged only if one is configured. |
| Game cancelled | Registrations are kept for the record. No attendance, no charges, ever. |
| Duplicate shirt number in one game | Warn, do not block. Two players sharing a number is a real problem in a league fixture and a non-problem in a pickup. |
| Minor | Only the guardian account or an admin may register or cancel. |

---

## 9. The quarterly bill

### Diagram 5 — how a quarter's bill is built

*Attendance in, invoice out. Full resolution: `docs/design/diagrams/05-billing.png`*

**Fee resolution**, in order, evaluated once per attended game and then frozen into the charge:

1. `games.fee_override`
2. `competitions.default_fee_per_game`
3. the matching `fee_schedules` row for that competition or game type, effective on the game's date
4. `0.00`

**Closing a quarter.** The admin generates a preview, checks it, records the payments that have arrived, and closes. Closing refuses to run if any game in the window still has unfinalised attendance, because that would quietly under-bill somebody. It then writes both snapshot tables and locks the period.

**Balances carry.** `balance = opening_balance + charges − payments`, and the live view `v_account_balance` is computed over all time. An unpaid quarter is still owed in the next one, rather than disappearing when the period closes — which is the thing hand-maintained spreadsheets almost always get wrong.

**Exports.** CSV per player and per paying account. Every row drills back to the line items that produced it, so "why do I owe $55?" has an answer that does not require an admin to reconstruct anything.

---

## 10. Security model

Defence in depth, in three layers:

1. **The UI** hides what you cannot do. This is courtesy, not security.
2. **Row-level security** decides what you can read and write. The role comes from a JWT claim mirrored from `profiles.role`; ownership comes from `owns_player()` and `manages_game()` helper functions. Three fields are additionally protected by triggers rather than policies, because they are column-level rules inside rows a user may otherwise edit: `profiles.role`, `players.verification_status`, and `game_registrations.attendance`. A player can change their own shirt number; they cannot mark themselves present.
3. **The audit log** records before/after JSON for every write to charges, payments, roles and period closes.

The Supabase service key bypasses row-level security entirely and must never reach a browser. Server-side jobs use it; the app does not.

---

## 11. Stretch goal — hosting our own tournaments

The ask: run something like the Kylin Cup *on* this platform. Other clubs enter their teams, manage their own information and registration, and the tournament's schedule, standings and entry fees are all handled here rather than in a group chat and a spreadsheet.

This is a bigger jump than it looks, because it changes who the system is for. Up to this point every row belongs to a CalBlue member. A hosted tournament introduces people who are not CalBlue members, must be able to do real work in the system, and must not be able to see anything of ours.

### Diagram 6 — hosting a tournament

*The six stages, and which tables each one writes. Full resolution: `docs/design/diagrams/06-hosting.png`*

### What it needs

**A `clubs` table, and teams that belong to one.** Today `games.opponent` is free text — fine when the opponent is somebody else's problem. When we are the organiser, "San Ramon FC" has to be a real row with a crest, a contact and a team that can be drawn into Group B. CalBlue becomes one club row among many, flagged `is_us`.

**Competitions that can be hosted, not just entered.** `competitions.hosting_mode` is `'participant'` (UPSL, NCCSF — we play in it) or `'host'` (we run it). Host mode unlocks an entry window, an entry fee, a team cap, published rules, and the points-per-win/draw the standings table uses.

**`tournament_entries`** — one club's team entering one tournament. It carries its own small lifecycle (`draft → submitted → approved | waitlisted | rejected`, and `withdrawn`), the seed and group we assign it, and the manager's contact details.

**`competition_groups`** for the group stage. Knockout rounds are handled by `games.stage_label` and `round_number` rather than a bracket engine — a club tournament does not need one, and "Semi-final 1" as a label is honest about what it is.

**`entry_roster`** — the squad a visiting club submits. This is where the decision to let `players.account_id` be nullable pays for itself twice over: a visiting player is an ordinary `players` row with no login, exactly like a drop-in guest at a pickup. No parallel "external player" table, and no visitor forced to create an account to be listed at number 9.

**`game_results` and `game_events`.** A score, an outcome (including forfeits), and a confirmation flag from each side. Events are goals, assists and cards — optional, but they are the whole of a top-scorer table, which is the thing people actually look at.

**Two views:** `v_standings` (played, won, drawn, lost, goals for and against, goal difference, points) and `v_scorers`. Both are derived, so there is no standings table to fall out of sync with the results.

### What it costs the model we are building now

Three columns, added now, so that none of the above becomes a migration of live data later:

1. `teams.club_id` → `clubs`
2. `games.home_team_id` / `away_team_id`, alongside the existing free-text `opponent`
3. `charges.entry_id`, and `charges.player_id` becomes nullable — because a tournament entry fee is owed by a club, not by a person

Everything else in section 11 is a self-contained set of new tables. It can land a year from now without touching a single row of attendance or billing.

### Permissions for people who are not us

A visiting club's manager signs up like anyone else: an ordinary `user` account. What makes them a manager is a scoped `staff_assignments` row pointing at their entry — the same mechanism as a captain, which is precisely why captain was built as a scoped grant rather than a fourth global role.

They **can**: create and edit their entry until the window closes, submit and amend their squad, see their own fixtures with times and pitch, confirm the score of their own matches, and see and pay their own entry-fee invoice.

They **cannot**: see another club's roster or contacts, see any CalBlue member's profile, see anybody's charges or balance but their own, change a fixture, change a score (they confirm it; the organiser records it), approve or seed their own entry, or reach anything outside that one tournament.

Two rules in the schema are worth knowing about because they are easy to get wrong:

- A manager may move their own entry to `submitted` or `withdrawn` and nothing else. Status, seed, group and fee are admin-only, enforced by a trigger rather than a policy because they are column-level rules inside a row the manager may otherwise edit.
- Entry fees are ordinary `charges` rows with `kind = 'entry_fee'`, billed to the manager's account. They flow through exactly the same ledger, statement and CSV export as a member's pickup fee. There is no second money system.

### Where it sits in the plan

After Milestone 4. Hosting a tournament for other clubs is only credible once our own members, attendance and billing are running smoothly — and the three forward-compatible columns mean waiting costs nothing. The one thing worth doing early is creating the `clubs` rows for the opponents we already play, so the fixture list starts accumulating real references instead of strings.

---

## 12. Stretch goal — a phone app on the same backend

The ask: an app that talks to the same system, so members can register for games and manage their accounts easily.

**The headline is that this needs nothing new from the data model.** Because permissions are enforced by row-level security inside Postgres rather than by whichever screen happens to be rendering, a second client cannot quietly become a second security model. The app signs in as the same member, carries the same token, and the same policies decide what comes back. That is the return on the decision in section 10 — it looked like extra work for the web app and it is what makes the app nearly free.

### Diagram 7 — one backend, three clients

*Member phone, captain phone, admin browser — one API and one set of policies. Full resolution: `docs/design/diagrams/07-clients.png`*

### What is actually worth building, in cost order

**1. Mobile-first web — free.** Build milestones 1–4 responsively and the phone case is already handled. This is not a compromise: check-in is *only* ever done on a phone, standing on grass, so that screen should be designed for a thumb from the first commit rather than retrofitted.

**2. A PWA — small.** A web app manifest and a service worker turn the same site into something installable on a home screen, with an offline shell and web push. iOS has supported push for installed web apps since 16.4. No app store, no review cycle, no second codebase, and members get an icon on their phone.

**3. Native, React Native or Expo — a real cost.** Worth it only when you need push you can absolutely rely on, an App Store listing people search for, or native camera and wallet integration. It is a second codebase and a release process forever.

My recommendation is that 1 and 2 are the plan, and 3 stays a decision you make later, once members are actually using the thing and can tell you whether the home-screen icon is enough. Going straight to native is the most common way a volunteer-run club ends up with a half-finished app and a website nobody updated.

### What it adds to the schema

Two tables, and both are wanted for email reminders whether or not an app ever ships:

| Table | Purpose |
|---|---|
| `devices` | `account_id`, platform, push token, `last_seen_at`, app version. One row per installed device, so a member with a phone and a tablet gets both. |
| `notifications` | An outbox: recipient, kind, payload, `scheduled_for`, `sent_at`, `read_at`. One row per thing we tell somebody, which makes "did the reminder actually go out?" a query rather than a guess. |

The obvious notifications to start with: registration confirmed, promoted off the waitlist, a reminder the evening before with the gather time and pitch, and the quarterly statement.

### Offline check-in, which is the one genuinely hard part

Fields have no signal. A captain marking twenty people present cannot depend on a network round-trip per tap, and must not lose the lot when they walk into a dead spot.

The approach: the device queues each mark locally with its own timestamp, and syncs when it reconnects. Two properties make this safe, and both come from decisions already in the schema:

- `game_registrations` already has `unique (game_id, player_id)`, so a sync is an **upsert on a natural key**, not an insert that might duplicate. Replaying the same queue twice changes nothing.
- Attendance is a **state, not an event** — `present`, `absent`, `excused`. Last write wins on `checked_in_at` is a correct and comprehensible rule, and no count is derived from a sequence of deltas that could arrive out of order.

The client sends the phone's clock in `checked_in_at`; the server keeps the latest per row. A captain's phone that has been offline for an hour cannot overwrite a correction an admin made five minutes ago, so the sync compares timestamps rather than blindly taking the client's word.

### Two things not to get wrong

**The service key never goes in the app bundle.** An app binary is fully inspectable — anyone can unpack it. The app authenticates as the member and gets the member's permissions; anything needing more runs server-side. This is the same rule as the web app, but the consequences of breaking it are worse because you cannot revoke a shipped binary.

**Sign-in has to survive the app store.** Magic links need deep-link handling so tapping the email opens the app rather than a browser tab that knows nothing. Budget for it — it is the single most common place a club app frustrates people on day one.

---

## 13. Deliberately not in v1

Scheduled quarter-end generation, online payment links, waivers and consent, disciplinary records and suspensions, and multi-club tenancy. Each is additive — none of them changes the tables above. The payment link is the one most likely to be wanted early, and it is a new table plus a job, not a reshaping.

---

## 14. Decisions I need from you

These change the data, not the schema, so they are not blocking — but they change what the first screens look like.

1. **Fees.** Flat per game? Different for league, tournament and pickup? Is there a season subscription in addition to per-game, or instead of it?
2. **No-shows and late cancellations.** Charged, or just tracked? (The schema supports both; the question is what the club wants.)
3. **Quarters.** Calendar quarters, or the club's own season boundaries?
4. **Who pays.** Per player, or per account — should one parent get one bill covering two children?
5. **Pickup eligibility.** Any signed-in person, or verified players only?
6. **Captains in v1,** or admin-only to start with?
7. **Sign-in.** Magic link only, or Google as well?
8. **Emergency and medical fields** — stored in the system, or deliberately kept offline?
9. **The existing 30-name Kylin Cup roster** — import it as unclaimed player identities, or start clean?
10. **Hosted tournaments** — is this a real plan for a specific event, or a someday? If there is a date, the three forward-compatible columns become non-negotiable and the `clubs` table should go in with Milestone 1.
11. **The app** — is an installable web app (home-screen icon, push, no app store) enough, or do you specifically want to be in the App Store? This is the difference between a few days and a second codebase forever.

My default assumptions, if I hear nothing: per-game fees differing by game type, no-shows tracked but not charged, calendar quarters, per-account billing, pickup open to any signed-in player, admin-only at first, magic link, emergency fields stored, and the roster imported as unclaimed identities.

---

## 15. Build order

**Milestone 1 — the spine.** Apply the schema. Sign-up, player identities, admin verification. Venues, competitions and games in an admin screen. This is the point at which the fixture list on the public site can start coming from the database instead of hand-edited HTML.

**Milestone 2 — pickup end to end.** Registration, capacity, waitlist, check-in, finalisation. Pickup first because it exercises the whole path with the fewest rules — no roster approval, no verification gate.

**Milestone 3 — competitions.** Season rosters, approval, league and tournament fixtures.

**Milestone 4 — money.** Fee schedules, charges, payments, the quarterly close, CSV export, the member-facing statement.

**Milestone 5 — polish and the installable app.** Notifications, the PWA manifest and service worker, offline check-in, the database-driven public roster, the captain role in the UI, an audit log viewer. Everything up to here is built mobile-first, so this milestone makes it installable rather than rebuilding it.

**Milestone 6 — hosting (stretch goal).** Clubs, entries, groups, rosters, results and standings, per section 11.

**Milestone 7 — native app, only if wanted (stretch goal).** React Native against the same API, per section 12. Deliberately last: it adds no capability the installable web app lacks, only reach.

Each milestone is independently useful. If the club only ever gets through Milestone 2, it still replaces the WeChat group and the sign-up spreadsheet, which is most of the day-to-day pain.
