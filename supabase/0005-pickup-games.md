# Migration 0005 — pickup game management

Issue #33 adds four checked RPCs, a team-scope helper, a private form parser, one
direct-write trigger and one SELECT policy. It assigns no roles, creates no users,
teams or venues, changes no billing/registration rows, and leaves released
migrations 0001–0004 byte-for-byte unchanged. Source: section 12 of
`docs/design/schema.sql`; generated output: [0005_pickup_games.sql](migrations/0005_pickup_games.sql).
Do not execute the entire draft schema (sections 9 and 10 remain future work).

## 1. Owner approval and read-only preflight

Applying a migration is a separate owner-authorized action. Confirm the target
project's dashboard URL, use its `postgres` owner session, and arrange appropriate
backup for any non-disposable deployment. The app's configured real-member project
must not be switched or modified implicitly. Never paste service keys, tokens or
real account details into test reports.

Run this metadata-only preflight with 0001–0004 already installed. All eight values
must be `true`; missing objects, unexpected owners, existing new objects or a
partial install require investigation, not dropping objects or replaying old SQL.

```sql
with expected(name) as (
  values ('profiles'),('players'),('venues'),('clubs'),('teams'),('competitions'),
    ('games'),('role_grants'),('competition_registrations'),('game_registrations'),
    ('fee_schedules'),('billing_periods'),('charges'),('payments'),
    ('period_player_summaries'),('period_account_summaries'),('audit_log')
), relations as (
  select e.name,c.oid,c.relkind,c.relowner,c.relrowsecurity
  from expected e left join pg_catalog.pg_namespace n on n.nspname='public'
  left join pg_catalog.pg_class c on c.relnamespace=n.oid and c.relname=e.name
)
select
  count(oid)=17 and bool_and(relkind='r') as tables_ready,
  count(oid)=17 and bool_and(relrowsecurity) as rls_ready,
  current_user='postgres' and count(oid)=17
    and bool_and(pg_catalog.pg_get_userbyid(relowner)=current_user) as owner_session,
  to_regprocedure('public.lock_billing()') is not null
    and to_regprocedure('public.guard_billed_game()') is not null
    and to_regprocedure('public.is_admin()') is not null
    and to_regprocedure('public.list_player_verifications(text,integer)') is not null
    and to_regprocedure('public.decide_player_verifications(uuid[],timestamptz[],text,text)') is not null
    as prior_helpers_ready,
  (select count(*)=5 from pg_catalog.pg_trigger t
    where t.tgrelid=to_regclass('public.games') and not t.tgisinternal and t.tgenabled='O'
      and t.tgname in ('games_auth_guard','games_set_date','games_touch',
                      'games_z_billing_guard','games_billing_lock')) as prior_game_triggers_ready,
  not exists(select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in ('can_manage_pickup_team','guard_pickup_game_write',
      'validate_pickup_game_details','pickup_game_options','list_pickup_games',
      'save_pickup_game','transition_pickup_game')) as new_functions_absent,
  not exists(select 1 from pg_catalog.pg_trigger where tgrelid=to_regclass('public.games')
    and tgname='games_u_pickup_guard') as new_trigger_absent,
  not exists(select 1 from pg_catalog.pg_policy where polrelid=to_regclass('public.games')
    and polname='games_pickup_staff_read') as new_policy_absent
from relations;
```

This is a staged metadata check, not proof of complete schema/policy equivalence.
After it passes, this separate count-only check identifies legacy pickup data
outside the client's bounded date/text/number contract. It returns no row values.
Expected: `pickup_rows_needing_review = 0`. A nonzero count needs explicit owner
review; 0005 deliberately does not silently repair, delete or backfill any data.

```sql
select count(*) as pickup_rows_needing_review
from public.games g
where g.game_type='pickup' and (
  exists(select 1 from unnest(array[g.created_at,g.updated_at,g.gather_time,g.start_time,
      g.end_time,g.registration_opens_at,g.registration_closes_at]) stamp
    where stamp is not null and (not isfinite(stamp)
      or stamp < timestamptz '0001-01-01 00:00:00+00'
      or stamp >= timestamptz '10000-01-01 00:00:00+00'))
  or not isfinite(g.game_date) or g.game_date < date '0001-01-01' or g.game_date >= date '10000-01-01'
  or char_length(g.title)>200 or char_length(g.field_label)>200 or char_length(g.kit_color)>100
  or char_length(g.notes)>4000 or char_length(g.cancellation_reason)>2000 or char_length(g.timezone)>100
  or (g.capacity is not null and g.capacity not between 1 and 10000)
  or g.fee_override='NaN'::numeric
  or not exists(select 1 from pg_catalog.pg_timezone_names z where z.name=g.timezone)
);
```

Options also reject more than 1,000 available teams/venues, names over 1,000
characters, addresses/map URLs over 4,000, or timezone names over 100; they do not
silently truncate. Legacy empty/whitespace text can be displayed, but editing
requires the current form rules.

## 2. Apply once, then inspect metadata

After explicit owner approval and a passing preflight, execute the **whole**
unchanged generated `0005_pickup_games.sql` once through the established migration
workflow. Record its application. Its BEGIN/COMMIT wrapper makes installation
atomic, not replay-idempotent. Do not rerun 0001–0004, seed, or skip failed SQL.

Expected: no SQL error. This read-only installed check should return five `true`
values. It checks only the new objects' metadata, not runtime authorization.

```sql
with expected(signature,is_definer,client_callable) as (
  values ('public.can_manage_pickup_team(uuid)',true,true),
    ('public.guard_pickup_game_write()',false,false),
    ('public.validate_pickup_game_details(jsonb)',true,false),
    ('public.pickup_game_options()',true,true),
    ('public.list_pickup_games(integer)',true,true),
    ('public.save_pickup_game(uuid,timestamptz,jsonb)',true,true),
    ('public.transition_pickup_game(uuid,timestamptz,text,text)',true,true)
), routines as (
  select e.*,p.oid,p.prosecdef,p.proowner,p.proconfig,p.proacl
  from expected e left join pg_catalog.pg_proc p on p.oid=to_regprocedure(e.signature)
)
select
  count(oid)=7 and bool_and(prosecdef=is_definer
    and pg_catalog.pg_get_userbyid(proowner)=current_user) as functions_ready,
  count(oid)=7 and bool_and(coalesce(proconfig @> array['search_path=""'],false)) as paths_fixed,
  count(oid)=7 and bool_and(coalesce(
    not has_function_privilege('anon',oid,'EXECUTE')
    and has_function_privilege('authenticated',oid,'EXECUTE')=client_callable
    and not exists(select 1 from aclexplode(coalesce(proacl,acldefault('f',proowner))) a
      where a.grantee=0 and a.privilege_type='EXECUTE'),false)) as execution_acl_ready,
  exists(select 1 from pg_catalog.pg_trigger where tgrelid=to_regclass('public.games')
    and tgname='games_u_pickup_guard' and not tgisinternal and tgenabled='O' and tgtype=31
    and tgfoid=to_regprocedure('public.guard_pickup_game_write()')) as direct_guard_ready,
  exists(select 1 from pg_catalog.pg_policy where polrelid=to_regclass('public.games')
    and polname='games_pickup_staff_read' and polcmd='r'
    and polroles=array[(select oid from pg_catalog.pg_roles where rolname='authenticated')]) as staff_policy_ready
from routines;
```

## 3. Runtime verification — disposable empty or bootstrap-only scratch

Both scripts are manual owner-run artifacts; offline checks do **not** execute
them. Use an idle **disposable project** with all five migrations, no seed and no
member/identity/business data, concurrent sign-ups or app activity. The main script
accepts only one of these narrowly checked starting states:

- All 17 application tables and `auth.users` are empty.
- Exactly one confirmed test-login Auth account and its matching profile exist,
  with roles exactly `['admin']` in both profile and Auth metadata. All 15 other
  non-audit application tables are empty. Existing audit rows must be only that
  profile's updates, attributed to it or to owner maintenance (`actor_id IS NULL`).

The existing account is never used as a synthetic actor or granted/reset roles.
Fixed synthetic IDs/emails are collision-checked before insertion. Owner-only
temporary fingerprints check the original profile/roles, selected Auth bootstrap
fields (not passwords/tokens), and all preexisting audit rows again before rollback;
no account values or fingerprints are printed. Any other nonempty state fails
closed. Do not delete/reset anything to force eligibility. This accommodation is
for a separate disposable test login, not permission to run on a member project.

1. Run the complete [0005_pickup_games_smoke.sql](tests/0005_pickup_games_smoke.sql)
   through its final `ROLLBACK`. Expected notice:
   `0005 pickup games smoke passed; rolling back.`
2. Run the complete [0005_pickup_games_isolation_smoke.sql](tests/0005_pickup_games_isolation_smoke.sql)
   through its final `ROLLBACK`. Expected notice:
   `0005 pickup games isolation smoke passed; rolling back.`

No SQL errors are expected. The dashboard may display a `set_config` result or
“Success. No rows returned”; confirm that the entire script, including all DO
blocks and the final rollback, was executed. There is intentionally no generic
success SELECT after rollback that could conceal an earlier abort. On error,
stop and report the error and step without private values; do not skip assertions.

Rows, temporary helpers and grants roll back. PostgreSQL identity sequences do
not: synthetic audit writes can advance the audit sequence even after rollback.
Do not reset it. Neither script is safe for the configured real-member project.

The main smoke covers anonymous/member/developer/captain/competition-organiser
refusal, member/anonymous draft-versus-published visibility through safe columns,
exact team-organiser scope, empty-project admin creation, other-team
denial, unchanged competition fixtures/contact scope, venue-local dates, fee
controls, validation/tampering, stale-version rejection, direct conversion/write
denial, capacity limits, publication/closure/cancellation, preserved registrations,
and compatibility with trusted billing finalization. The isolation smoke requires
both write RPCs to fail closed outside READ COMMITTED. These remain synthetic
single-session claims tests, not live Auth/PostgREST or concurrent-session proof.

## API and boundaries

- `pickup_game_options()` returns one JSON object with `can_override_fee`,
  CalBlue `teams[{id,name}]`, and `venues[{id,name,timezone,address,map_url}]`.
- `list_pickup_games(p_offset=0)` returns at most 21 safe game rows, ordered by
  `created_at DESC,id DESC`; show 20 and use the last as a next-page indicator.
- `save_pickup_game(id,expected_updated_at,details)` creates draft-only when both
  ID/version are null; otherwise edits draft/published/reg_closed only. Supply
  all 13 editable keys: team/venue IDs, title, field_label, timezone, gather/start/end
  times, capacity, registration open/close times, kit_color and notes. Optional
  `fee_override` is admin-only: absent preserves the old value, null clears it.
  Other keys, including status, game_date, game_type and no-show fees, are rejected.
- `transition_pickup_game(id,expected_updated_at,action,reason=null)` permits
  draft→published (future start and canonical validated form), published→reg_closed, or draft/published/reg_closed
  →cancelled (nonblank reason, maximum 2,000 characters). No reopen, complete,
  attendance-finalize or delete action is added.

Publishing a legacy draft with invalid/noncanonical details or stale venue-derived
timezone/date requires an explicit edit/save first. Publication does not silently
normalize its details; eligible close/cancel paths can still handle legacy rows.

Both write RPCs return exactly one of the same 20 game-only fields and require
the exact returned timestamp as the CAS token, preserving microseconds. Error
`42501` denies access; `22023` rejects input; `P0001 / pickup_conflict` means stale,
missing or no-longer-editable state. Unknown/network write errors may have
completed: reload/check before an explicit retry; never automatically retry writes.

Team-scoped authority requires an existing `role_grants` row with exactly
`role='organiser'` and a `team_id` belonging to the club whose `is_us` flag is true.
Admins may create teamless pickups; organizers must select an authorized team and
cannot reparent another team's game. Competition/game-scoped grants, captain,
coach, treasurer, developer or a global organizer label confer no new authority.
No new `manages_game`/player/contact access is granted. Admin JWT changes still
require the existing explicit access refresh; team grants are read from the DB.

Venue timezone is authoritative; otherwise the supplied registered timezone is
used. `game_date` is derived locally from `start_time`. Timestamps require explicit
offsets and finite UTC/local years 0001–9999. Optional times may be null; gather
and registration bounds must not exceed start, end must follow start, and open
must not follow close. Capacity is null (unlimited) or 1–10,000 and cannot shrink
below registered players/keepers. Increasing it does not auto-promote waiters.
Title/field/kit/notes limits are 200/200/100/4,000 characters; blank optional text
becomes null. Fee values are nonnegative, at most two decimal places, up to
99,999,999.99. Existing fee schedules remain unchanged.

Games with any charge or attendance lock cannot be edited/cancelled through these
RPCs. Cancellation preserves registrations and creates no charges; existing
closed-period/billing guards still apply. Direct authenticated pickup writes and
game-type conversion in either direction are refused, including for admins.
Actual table-owner maintenance and checked billing internals remain trusted.
Published operational notes were already visible to authenticated members under
0003: do not put medical/contact/private player information in them.

Remaining manual checks include actual two-session races (edit/edit, edit/cancel,
capacity change/registration), real organizer/admin/nonadmin HTTP sessions,
timezone/DST round trips, and cancellation/recovery/mobile UX. Record these as
pending until actually observed; source checks and injected doubles are not proof.
