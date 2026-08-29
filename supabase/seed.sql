-- =====================================================================
-- CalBlue — development seed data
--
-- Apply after migrations 0001–0003, as the service role (RLS is bypassed):
--     psql "$DATABASE_URL" -f supabase/seed.sql
--
-- Re-runnable: every insert is keyed on a fixed UUID with ON CONFLICT DO
-- NOTHING, so running it twice is a no-op rather than a pile of duplicates.
--
-- No real member data. Every name is invented and every address is example.com.
-- The point of this file is not volume — it is to cover the awkward cases that
-- the screens have to handle and that a happy-path fixture would miss:
--
--   * an identity with NO account          (a drop-in guest)
--   * a child with a guardian and no login (payer resolution)
--   * one person holding two roles at once (player + treasurer)
--   * an organiser with a scoped grant and no club-wide role
--   * a game that is full, with a waitlist behind it
--   * a game already finalised, so charges and a balance exist
--   * a member who owes money and a member who is square
-- =====================================================================

begin;

-- ---------------------------------------------------------------- accounts
-- profiles rows are created by the handle_new_user trigger on auth.users, so
-- the accounts go in first and then we fill in names and roles.
insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data,
                        created_at, updated_at, email_confirmed_at)
values
  ('11111111-0000-4000-a000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'ada@example.com',
   '{"display_name":"Ada Wong"}'::jsonb, now(), now(), now()),
  ('11111111-0000-4000-a000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'ben@example.com',
   '{"display_name":"Ben Okafor"}'::jsonb, now(), now(), now()),
  ('11111111-0000-4000-a000-000000000003', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'chen@example.com',
   '{"display_name":"Chen Wei"}'::jsonb, now(), now(), now()),
  ('11111111-0000-4000-a000-000000000004', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'dara@example.com',
   '{"display_name":"Dara Singh"}'::jsonb, now(), now(), now()),
  ('11111111-0000-4000-a000-000000000005', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'eve@example.com',
   '{"display_name":"Eve Martins"}'::jsonb, now(), now(), now()),
  ('11111111-0000-4000-a000-000000000006', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'finn@example.com',
   '{"display_name":"Finn Doyle"}'::jsonb, now(), now(), now())
on conflict (id) do nothing;

-- Roles are additive. Ada runs the club; Chen plays and keeps the books; Dara
-- organises one competition and holds no club-wide role at all.
update public.profiles set display_name = 'Ada Wong',   roles = '{player,admin}'
  where id = '11111111-0000-4000-a000-000000000001';
update public.profiles set display_name = 'Ben Okafor', roles = '{player}'
  where id = '11111111-0000-4000-a000-000000000002';
update public.profiles set display_name = 'Chen Wei',   roles = '{player,treasurer}'
  where id = '11111111-0000-4000-a000-000000000003';
update public.profiles set display_name = 'Dara Singh', roles = '{}'
  where id = '11111111-0000-4000-a000-000000000004';
update public.profiles set display_name = 'Eve Martins', roles = '{player,coach}'
  where id = '11111111-0000-4000-a000-000000000005';
update public.profiles set display_name = 'Finn Doyle', roles = '{player}'
  where id = '11111111-0000-4000-a000-000000000006';

-- ------------------------------------------------------------------ clubs
insert into public.clubs (id, name, short_name, city, is_us) values
  ('22222222-0000-4000-a000-000000000001', 'CalBlue Soccer Club', 'CalBlue', 'Bay Area', true),
  ('22222222-0000-4000-a000-000000000002', 'San Ramon FC', 'SRFC', 'San Ramon', false),
  ('22222222-0000-4000-a000-000000000003', 'Tiger FC', 'Tiger', 'Fremont', false)
on conflict (id) do nothing;

insert into public.teams (id, club_id, name, short_name, is_default) values
  ('33333333-0000-4000-a000-000000000001', '22222222-0000-4000-a000-000000000001',
   'CalBlue First Team', 'CalBlue', true),
  ('33333333-0000-4000-a000-000000000002', '22222222-0000-4000-a000-000000000002',
   'San Ramon FC First Team', 'SRFC', false)
on conflict (id) do nothing;

-- ----------------------------------------------------------------- venues
insert into public.venues (id, name, address, surface, timezone, notes) values
  ('44444444-0000-4000-a000-000000000001', 'Marina Green', '3500 Marina Blvd, Example City',
   'grass', 'America/Los_Angeles', 'Street parking fills up before 9am.'),
  ('44444444-0000-4000-a000-000000000002', 'Eastside Turf', '12 Example Way',
   'turf', 'America/Los_Angeles', 'Gate code 4417. Boots with studs not allowed.')
on conflict (id) do nothing;

-- --------------------------------------------------------------- identities
-- One account holds at most one identity. The remaining identities deliberately
-- have no login: Grace is a drop-in guest, Hugo is Eve's child and Eve pays for
-- him, and four fixture-only teammates exercise unclaimed roster records.
insert into public.players
  (id, account_id, guardian_account_id, display_name, date_of_birth,
   default_positions, preferred_number, verification_status, is_public, claim_code)
values
  ('55555555-0000-4000-a000-000000000001', '11111111-0000-4000-a000-000000000001', null,
   'Ada Wong',    '1991-03-04', '{CM,CDM}', 8,  'verified', true,  null),
  ('55555555-0000-4000-a000-000000000002', '11111111-0000-4000-a000-000000000002', null,
   'Ben Okafor',  '1988-11-21', '{ST}',     9,  'verified', true,  null),
  ('55555555-0000-4000-a000-000000000003', '11111111-0000-4000-a000-000000000003', null,
   'Chen Wei',    '1994-07-09', '{GK}',     1,  'verified', true,  null),
  ('55555555-0000-4000-a000-000000000004', '11111111-0000-4000-a000-000000000004', null,
   'Dara Singh',  '1985-01-30', '{CB}',     5,  'verified', false, null),
  ('55555555-0000-4000-a000-000000000005', '11111111-0000-4000-a000-000000000005', null,
   'Eve Martins', '1990-09-15', '{LW}',     11, 'verified', true,  null),
  ('55555555-0000-4000-a000-000000000006', '11111111-0000-4000-a000-000000000006', null,
   'Finn Doyle',  '1997-05-02', '{RB}',     2,  'pending',  false, null),
  -- no account at all: turned up to a pickup, was recorded, can claim later
  ('55555555-0000-4000-a000-000000000007', null, null,
   'Grace Hall',  null,         '{CM}',     14, 'pending',  false, 'GRACE-2026'),
  -- a child: no login of their own, Eve is the guardian and therefore the payer
  ('55555555-0000-4000-a000-000000000008', null, '11111111-0000-4000-a000-000000000005',
   'Hugo Martins', '2014-02-18', '{ST}',    7,  'verified', false, null),
  -- unclaimed teammates: enough depth for useful roster and fixture screens
  ('55555555-0000-4000-a000-000000000009', null, null,
   'Imani Cole',   null,         '{LB}',     4,  'verified', true,  'IMANI-2026'),
  ('55555555-0000-4000-a000-000000000010', null, null,
   'Jules Park',   null,         '{CB}',     6,  'verified', true,  'JULES-2026'),
  ('55555555-0000-4000-a000-000000000011', null, null,
   'Kai Rivera',   null,         '{RW}',    10,  'verified', true,  'KAI-2026'),
  ('55555555-0000-4000-a000-000000000012', null, null,
   'Noor Patel',   null,         '{CM}',    15,  'verified', true,  'NOOR-2026')
on conflict (id) do nothing;

-- ----------------------------------------------------------- competitions
insert into public.competitions
  (id, name, kind, season_label, organiser, start_date, end_date, status,
   roster_approval, default_fee_per_game, default_no_show_fee)
values
  ('77777777-0000-4000-a000-000000000001', 'Kylin Cup', 'cup', '2026', 'CalBlue',
   date_trunc('year', current_date)::date, (date_trunc('year', current_date) + interval '11 months')::date,
   'in_progress', true, 25.00, 0.00)
on conflict (id) do nothing;

-- ------------------------------------------------------------ scoped roles
-- Dara has no club-wide role but organises the Kylin Cup, and can do everything
-- inside it and nothing outside it. The competition is inserted first because
-- role_grants has an immediate foreign key to it.
insert into public.role_grants (id, account_id, role, competition_id, game_id, team_id)
values ('66666666-0000-4000-a000-000000000001', '11111111-0000-4000-a000-000000000004',
        'organiser', '77777777-0000-4000-a000-000000000001', null, null)
on conflict (id) do nothing;

-- ------------------------------------------------------------------ games
-- Dates are relative to the first seed run so a newly created dev database has
-- current-looking fixtures. Fixed IDs keep subsequent runs intentionally inert.
insert into public.games
  (id, competition_id, team_id, game_type, title, opponent, home_away, venue_id,
   field_label, timezone, gather_time, start_time, end_time, capacity,
   registration_closes_at, status, attendance_locked_at, fee_override, kit_color, notes)
values
  -- a pickup next Saturday, deliberately small so the waitlist is exercised
  ('88888888-0000-4000-a000-000000000001', null, '33333333-0000-4000-a000-000000000001',
   'pickup', 'Saturday morning pickup', null, 'home',
   '44444444-0000-4000-a000-000000000001', 'Pitch 2', 'America/Los_Angeles',
   (current_date + 7 + time '08:30') at time zone 'America/Los_Angeles',
   (current_date + 7 + time '09:00') at time zone 'America/Los_Angeles',
   (current_date + 7 + time '11:00') at time zone 'America/Los_Angeles',
   4, (current_date + 6 + time '20:00') at time zone 'America/Los_Angeles',
   'published', null, 10.00, 'blue', 'Bring both shirts.'),
  -- a cup fixture further out
  ('88888888-0000-4000-a000-000000000002', '77777777-0000-4000-a000-000000000001',
   '33333333-0000-4000-a000-000000000001',
   'cup', 'Kylin Cup — group stage', 'San Ramon FC', 'home',
   '44444444-0000-4000-a000-000000000002', 'Turf 1', 'America/Los_Angeles',
   (current_date + 14 + time '13:15') at time zone 'America/Los_Angeles',
   (current_date + 14 + time '14:00') at time zone 'America/Los_Angeles',
   (current_date + 14 + time '16:00') at time zone 'America/Los_Angeles',
   16, (current_date + 13 + time '20:00') at time zone 'America/Los_Angeles',
   'published', null, null, 'white', null),
  -- two more cup fixtures make the competition schedule useful on its own
  ('88888888-0000-4000-a000-000000000004', '77777777-0000-4000-a000-000000000001',
   '33333333-0000-4000-a000-000000000001',
   'cup', 'Kylin Cup — group stage 2', 'Tiger FC', 'away',
   '44444444-0000-4000-a000-000000000001', 'Pitch 1', 'America/Los_Angeles',
   (current_date + 21 + time '09:15') at time zone 'America/Los_Angeles',
   (current_date + 21 + time '10:00') at time zone 'America/Los_Angeles',
   (current_date + 21 + time '12:00') at time zone 'America/Los_Angeles',
   16, (current_date + 20 + time '20:00') at time zone 'America/Los_Angeles',
   'published', null, null, 'blue', 'Meet by the north entrance.'),
  ('88888888-0000-4000-a000-000000000005', '77777777-0000-4000-a000-000000000001',
   '33333333-0000-4000-a000-000000000001',
   'cup', 'Kylin Cup — group stage 3', 'San Ramon FC', 'neutral',
   '44444444-0000-4000-a000-000000000002', 'Turf 2', 'America/Los_Angeles',
   (current_date + 28 + time '15:15') at time zone 'America/Los_Angeles',
   (current_date + 28 + time '16:00') at time zone 'America/Los_Angeles',
   (current_date + 28 + time '18:00') at time zone 'America/Los_Angeles',
   16, (current_date + 27 + time '20:00') at time zone 'America/Los_Angeles',
   'published', null, null, 'white', null),
  -- a pickup that already happened and has been finalised, so charges exist
  ('88888888-0000-4000-a000-000000000003', null, '33333333-0000-4000-a000-000000000001',
   'pickup', 'Last week''s pickup', null, 'home',
   '44444444-0000-4000-a000-000000000001', 'Pitch 2', 'America/Los_Angeles',
   (current_date - 7 + time '08:30') at time zone 'America/Los_Angeles',
   (current_date - 7 + time '09:00') at time zone 'America/Los_Angeles',
   (current_date - 7 + time '11:00') at time zone 'America/Los_Angeles',
   12, (current_date - 8 + time '20:00') at time zone 'America/Los_Angeles',
   'locked', (current_date - 7 + time '12:00') at time zone 'America/Los_Angeles',
   10.00, 'blue', null)
on conflict (id) do nothing;

-- ------------------------------------------------------- season roster
insert into public.competition_registrations
  (id, competition_id, player_id, status, jersey_number, positions)
values
  ('99999999-0000-4000-a000-000000000001', '77777777-0000-4000-a000-000000000001',
   '55555555-0000-4000-a000-000000000001', 'approved', 8, '{CM}'),
  ('99999999-0000-4000-a000-000000000002', '77777777-0000-4000-a000-000000000001',
   '55555555-0000-4000-a000-000000000002', 'approved', 9, '{ST}'),
  ('99999999-0000-4000-a000-000000000003', '77777777-0000-4000-a000-000000000001',
   '55555555-0000-4000-a000-000000000003', 'approved', 1, '{GK}'),
  -- Finn is unverified, so his request is still pending: the verification queue has work
  ('99999999-0000-4000-a000-000000000004', '77777777-0000-4000-a000-000000000001',
   '55555555-0000-4000-a000-000000000006', 'pending', 2, '{RB}'),
  ('99999999-0000-4000-a000-000000000005', '77777777-0000-4000-a000-000000000001',
   '55555555-0000-4000-a000-000000000005', 'approved', 11, '{LW}'),
  ('99999999-0000-4000-a000-000000000006', '77777777-0000-4000-a000-000000000001',
   '55555555-0000-4000-a000-000000000007', 'approved', 14, '{CM}'),
  ('99999999-0000-4000-a000-000000000007', '77777777-0000-4000-a000-000000000001',
   '55555555-0000-4000-a000-000000000009', 'approved', 4, '{LB}'),
  ('99999999-0000-4000-a000-000000000008', '77777777-0000-4000-a000-000000000001',
   '55555555-0000-4000-a000-000000000010', 'approved', 6, '{CB}'),
  ('99999999-0000-4000-a000-000000000009', '77777777-0000-4000-a000-000000000001',
   '55555555-0000-4000-a000-000000000011', 'approved', 10, '{RW}'),
  ('99999999-0000-4000-a000-000000000010', '77777777-0000-4000-a000-000000000001',
   '55555555-0000-4000-a000-000000000012', 'approved', 15, '{CM}')
on conflict (id) do nothing;

-- --------------------------------------------------- game registrations
-- The upcoming pickup has capacity 4: four registered, two waiting.
insert into public.game_registrations
  (id, game_id, player_id, status, participation, jersey_number, positions,
   attendance, registered_at)
values
  ('aaaaaaaa-0000-4000-a000-000000000001', '88888888-0000-4000-a000-000000000001',
   '55555555-0000-4000-a000-000000000001', 'registered', 'player', 8, '{CM}', 'unknown', now() - interval '3 days'),
  ('aaaaaaaa-0000-4000-a000-000000000002', '88888888-0000-4000-a000-000000000001',
   '55555555-0000-4000-a000-000000000002', 'registered', 'player', 9, '{ST}', 'unknown', now() - interval '3 days'),
  ('aaaaaaaa-0000-4000-a000-000000000003', '88888888-0000-4000-a000-000000000001',
   '55555555-0000-4000-a000-000000000003', 'registered', 'keeper', 1, '{GK}', 'unknown', now() - interval '2 days'),
  ('aaaaaaaa-0000-4000-a000-000000000004', '88888888-0000-4000-a000-000000000001',
   '55555555-0000-4000-a000-000000000005', 'registered', 'player', 11, '{LW}', 'unknown', now() - interval '2 days'),
  ('aaaaaaaa-0000-4000-a000-000000000005', '88888888-0000-4000-a000-000000000001',
   '55555555-0000-4000-a000-000000000004', 'waitlisted', 'player', 5, '{CB}', 'unknown', now() - interval '1 day'),
  ('aaaaaaaa-0000-4000-a000-000000000006', '88888888-0000-4000-a000-000000000001',
   '55555555-0000-4000-a000-000000000008', 'waitlisted', 'player', 7, '{ST}', 'unknown', now() - interval '4 hours'),

  -- all three Kylin Cup fixtures have selections to render
  ('aaaaaaaa-0000-4000-a000-000000000021', '88888888-0000-4000-a000-000000000002',
   '55555555-0000-4000-a000-000000000001', 'registered', 'player', 8, '{CM}', 'unknown', now() - interval '3 days'),
  ('aaaaaaaa-0000-4000-a000-000000000022', '88888888-0000-4000-a000-000000000002',
   '55555555-0000-4000-a000-000000000002', 'registered', 'player', 9, '{ST}', 'unknown', now() - interval '3 days'),
  ('aaaaaaaa-0000-4000-a000-000000000023', '88888888-0000-4000-a000-000000000002',
   '55555555-0000-4000-a000-000000000003', 'registered', 'keeper', 1, '{GK}', 'unknown', now() - interval '2 days'),
  ('aaaaaaaa-0000-4000-a000-000000000024', '88888888-0000-4000-a000-000000000002',
   '55555555-0000-4000-a000-000000000005', 'registered', 'player', 11, '{LW}', 'unknown', now() - interval '2 days'),
  ('aaaaaaaa-0000-4000-a000-000000000025', '88888888-0000-4000-a000-000000000002',
   '55555555-0000-4000-a000-000000000009', 'registered', 'player', 4, '{LB}', 'unknown', now() - interval '1 day'),
  ('aaaaaaaa-0000-4000-a000-000000000026', '88888888-0000-4000-a000-000000000002',
   '55555555-0000-4000-a000-000000000011', 'registered', 'player', 10, '{RW}', 'unknown', now() - interval '1 day'),

  ('aaaaaaaa-0000-4000-a000-000000000031', '88888888-0000-4000-a000-000000000004',
   '55555555-0000-4000-a000-000000000001', 'registered', 'player', 8, '{CM}', 'unknown', now() - interval '2 days'),
  ('aaaaaaaa-0000-4000-a000-000000000032', '88888888-0000-4000-a000-000000000004',
   '55555555-0000-4000-a000-000000000003', 'registered', 'keeper', 1, '{GK}', 'unknown', now() - interval '2 days'),
  ('aaaaaaaa-0000-4000-a000-000000000033', '88888888-0000-4000-a000-000000000004',
   '55555555-0000-4000-a000-000000000007', 'registered', 'player', 14, '{CM}', 'unknown', now() - interval '1 day'),
  ('aaaaaaaa-0000-4000-a000-000000000034', '88888888-0000-4000-a000-000000000004',
   '55555555-0000-4000-a000-000000000010', 'registered', 'player', 6, '{CB}', 'unknown', now() - interval '1 day'),
  ('aaaaaaaa-0000-4000-a000-000000000035', '88888888-0000-4000-a000-000000000004',
   '55555555-0000-4000-a000-000000000011', 'registered', 'player', 10, '{RW}', 'unknown', now() - interval '12 hours'),
  ('aaaaaaaa-0000-4000-a000-000000000036', '88888888-0000-4000-a000-000000000004',
   '55555555-0000-4000-a000-000000000012', 'registered', 'player', 15, '{CM}', 'unknown', now() - interval '12 hours'),

  ('aaaaaaaa-0000-4000-a000-000000000041', '88888888-0000-4000-a000-000000000005',
   '55555555-0000-4000-a000-000000000002', 'registered', 'player', 9, '{ST}', 'unknown', now() - interval '1 day'),
  ('aaaaaaaa-0000-4000-a000-000000000042', '88888888-0000-4000-a000-000000000005',
   '55555555-0000-4000-a000-000000000003', 'registered', 'keeper', 1, '{GK}', 'unknown', now() - interval '1 day'),
  ('aaaaaaaa-0000-4000-a000-000000000043', '88888888-0000-4000-a000-000000000005',
   '55555555-0000-4000-a000-000000000005', 'registered', 'player', 11, '{LW}', 'unknown', now() - interval '18 hours'),
  ('aaaaaaaa-0000-4000-a000-000000000044', '88888888-0000-4000-a000-000000000005',
   '55555555-0000-4000-a000-000000000009', 'registered', 'player', 4, '{LB}', 'unknown', now() - interval '18 hours'),
  ('aaaaaaaa-0000-4000-a000-000000000045', '88888888-0000-4000-a000-000000000005',
   '55555555-0000-4000-a000-000000000010', 'registered', 'player', 6, '{CB}', 'unknown', now() - interval '12 hours'),
  ('aaaaaaaa-0000-4000-a000-000000000046', '88888888-0000-4000-a000-000000000005',
   '55555555-0000-4000-a000-000000000012', 'registered', 'player', 15, '{CM}', 'unknown', now() - interval '12 hours'),

  -- last week's pickup, already played and marked
  ('aaaaaaaa-0000-4000-a000-000000000011', '88888888-0000-4000-a000-000000000003',
   '55555555-0000-4000-a000-000000000001', 'registered', 'player', 8, '{CM}', 'present', now() - interval '10 days'),
  ('aaaaaaaa-0000-4000-a000-000000000012', '88888888-0000-4000-a000-000000000003',
   '55555555-0000-4000-a000-000000000002', 'registered', 'player', 9, '{ST}', 'present', now() - interval '10 days'),
  ('aaaaaaaa-0000-4000-a000-000000000013', '88888888-0000-4000-a000-000000000003',
   '55555555-0000-4000-a000-000000000007', 'registered', 'player', 14, '{CM}', 'present', now() - interval '9 days'),
  -- registered and did not turn up
  ('aaaaaaaa-0000-4000-a000-000000000014', '88888888-0000-4000-a000-000000000003',
   '55555555-0000-4000-a000-000000000006', 'registered', 'player', 2, '{RB}', 'absent', now() - interval '9 days'),
  -- cancelled in time, so owes nothing
  ('aaaaaaaa-0000-4000-a000-000000000015', '88888888-0000-4000-a000-000000000003',
   '55555555-0000-4000-a000-000000000004', 'cancelled', 'player', 5, '{CB}', 'unknown', now() - interval '11 days')
on conflict (id) do nothing;

-- Check-in history for the three attendees of the locked pickup. This update is
-- idempotent and leaves any later manual check-in correction untouched.
update public.game_registrations
set checked_in_at = (current_date - 7 + time '08:50') at time zone 'America/Los_Angeles',
    checked_in_by = '11111111-0000-4000-a000-000000000001'
where id in (
  'aaaaaaaa-0000-4000-a000-000000000011',
  'aaaaaaaa-0000-4000-a000-000000000012',
  'aaaaaaaa-0000-4000-a000-000000000013'
)
and checked_in_at is null;

-- ------------------------------------------------------------------- money
insert into public.fee_schedules (id, name, game_type, amount, effective_from) values
  ('bbbbbbbb-0000-4000-a000-000000000001', 'Pickup, standard', 'pickup', 10.00,
   (current_date - interval '1 year')::date),
  ('bbbbbbbb-0000-4000-a000-000000000002', 'Cup fixture, standard', 'cup', 25.00,
   (current_date - interval '1 year')::date)
on conflict (id) do nothing;

insert into public.billing_periods (id, label, start_date, end_date, status) values
  ('cccccccc-0000-4000-a000-000000000001',
   to_char(current_date, 'YYYY') || '-Q' || to_char(current_date, 'Q'),
   date_trunc('quarter', current_date)::date,
   (date_trunc('quarter', current_date) + interval '3 months' - interval '1 day')::date,
   'open')
on conflict (id) do nothing;

-- Charges as finalise_game_attendance would have written them for last week's
-- pickup: one per player who was actually present, at the fee that applied then.
insert into public.charges
  (id, player_id, account_id, game_id, kind, description, amount, charge_date, source)
values
  ('dddddddd-0000-4000-a000-000000000001', '55555555-0000-4000-a000-000000000001',
   '11111111-0000-4000-a000-000000000001', '88888888-0000-4000-a000-000000000003',
   'game_fee', 'Last week''s pickup', 10.00, current_date - 7, 'auto'),
  ('dddddddd-0000-4000-a000-000000000002', '55555555-0000-4000-a000-000000000002',
   '11111111-0000-4000-a000-000000000002', '88888888-0000-4000-a000-000000000003',
   'game_fee', 'Last week''s pickup', 10.00, current_date - 7, 'auto'),
  -- Grace has no account, so the charge has a player but no payer yet
  ('dddddddd-0000-4000-a000-000000000003', '55555555-0000-4000-a000-000000000007',
   null, '88888888-0000-4000-a000-000000000003',
   'game_fee', 'Last week''s pickup', 10.00, current_date - 7, 'auto')
on conflict (id) do nothing;

-- Ada has paid, Ben has not: one member square, one owing.
insert into public.payments
  (id, account_id, amount, method, payment_date, external_ref, note)
values
  ('eeeeeeee-0000-4000-a000-000000000001', '11111111-0000-4000-a000-000000000001',
   10.00, 'venmo', current_date - 5, 'VNM-EXAMPLE-001', 'Pickup fee')
on conflict (id) do nothing;

commit;

-- Expected state after this file:
--   * 6 accounts, 12 identities (6 without a login)
--   * a Kylin Cup roster and three published fixtures with selections
--   * upcoming pickup full at 4 with 2 waitlisted
--   * last week's pickup finalised: 3 present, 1 no-show, 1 cancelled
--   * Ada owes 10.00 and has paid 10.00  -> balance 0.00
--   * Ben owes 10.00 and has paid nothing -> balance 10.00
--   * Eve is the payer for Hugo, her child
--   * Finn is unverified with a pending roster request, so the queue is non-empty
--   * Dara can administer the Kylin Cup and nothing else
