# My identity — issue #31

The signed-in `#/identity` screen manages the person behind an account and identities for which
that account is the guardian. It uses the existing Supabase `players` table and released RLS.
An account with **no assigned roles** can use this screen. No migration, seed, account-role grant,
public-site change, profile backfill or production-hosting change is part of this feature.

## What is implemented

- Create your own identity only when your account has none. The database's unique account index
  remains authoritative if two tabs attempt creation concurrently. There is no second-self button,
  upsert or automatic replacement of an existing identity.
- Open and edit one person's display/legal name, positions, preferred number, jersey size,
  emergency contact, medical notes and public-roster preference.
- Add a child identity without a login: `account_id` is null and `guardian_account_id` is your
  signed-in account. Existing guardian-linked identities remain manageable even if an authorized
  later workflow has linked them to their own login.
- See verification status without controls to change it. New identities use the database's
  pending status. Creating a person does not grant the `player` role or change the sign-in
  account's display name, email or roles.
- Preserve an open draft during same-account session notifications and **Refresh my access**.
  Reloading, leaving the page, signing out or switching accounts discards the local draft; private
  form data is not persisted in browser storage, URLs or logs.

The page initially loads summaries only. You must open a specific person to load sensitive fields.
While an editor is open, finish saving or explicitly discard the local changes before switching
people. A failed save may have reached the server: reload the identities to check before retrying,
especially when creating a child. Aborting a browser request does not prove a database rollback.

## Date of birth and validation

Date of birth is optional when creating an identity. A supplied value must be a real calendar date
and cannot be in the future. A known under-18 player cannot create a self identity without a
guardian; a guardian must add them through their own account.

**Date of birth is read-only after creation, including when it was left blank.** Released migration
0003 deliberately prevents ordinary members and guardians from changing it, because age affects
registration eligibility. This screen preserves that protection and explains that a correction
requires an administrator. It does not provide an admin correction workflow or silently discard
a submitted DOB edit. This is a deliberate limitation relative to the issue's broader edit wording.

Preferred number accepts a whole number from **0 to 99**, or blank. Positions are comma-separated
(for example `CM, CF`). Required fields and field errors are checked before saving, and the data
service independently validates the submitted fields. Ownership, verification, claims and generated
billing fields never come from the form.

## Privacy and verification

Public-roster opt-in defaults off. When an identity is both **opted in and verified**, the existing
public roster projection exposes its ID, display name, preferred number, positions and photo URL.
An opt-in on a pending/rejected identity saves a preference but does not publish it. Editing those
public fields on a verified, opted-in identity changes the projection immediately. This PR does not
connect the existing public website's static Players directory to this projection.

Legal name, DOB, emergency contacts and medical notes are not in the public projection or identity
summary list. The selected detail is available to the person, their guardian and authorized admins;
relevant authorized match staff can access emergency/medical information through the existing
checked match-contact function. Do not describe medical data as visible only to the person.

Verification is one gate, not a registration entitlement. Official league/cup participation also
depends on the player role where applicable and competition approval; pickup/training does not
require verification. Registration and administrator verification UI are later issues.

Every personal read and update includes explicit account/guardian ownership filters, even when
the signed-in account is an admin. RLS is the actual authorization boundary. A forged identifier,
hidden button or client validation must never substitute for it.

## Local review

Use the existing no-build preview at `http://localhost:8091/app/#/identity` after switching its
server to this PR's worktree. Coordinate that switch before stopping an existing preview. The
approved callback origins remain unchanged; arbitrary ports cannot perform a real email round trip.

```sh
python3 -m http.server 8091 --bind 127.0.0.1
```

Do not rerun migrations or seed data. The owner already initialized the configured project during
sign-in testing. Use only owner-approved test accounts and invented non-sensitive test details.
The automated suites use doubles and make no Supabase requests or writes.

### Owner browser checks

1. Signed out, open `#/identity`: expect the sign-in guard. Sign in with an account you control.
   An account with no player identity should offer creation; no `player` role is required.
2. Create your own identity, including number **0**. Leave public opt-in off. Expect one own identity
   and pending verification. Open it, edit permitted fields, save, reload and reopen: values persist.
   There must be no option to add another identity for yourself or edit verification/DOB.
3. Try an empty display name, number `100`/`-1`/`1.5`, and a future DOB during creation. Expect a
   clear validation error and no write. Cancel the form when finished.
4. Add an invented child under your account. Confirm it is separate from your own identity, can
   be reopened/edited, and persists after reload. Open only one detail at a time. Summary lists
   must never display emergency contacts or medical notes.
5. Save public opt-in on a pending identity: the wording must not claim it is already public.
   Do not grant yourself verification/admin roles just to test publication.
6. Edit a field without saving, then click **Refresh my access**: the draft should remain. Sign out
   or switch to a different account: the prior person's form and private values must disappear.
   A late request must not restore the old screen. Never assume an interrupted save rolled back.
7. Check keyboard labels/focus, Enter submission, errors, loading and retry at desktop and 360px.
   Open `/app/tests/`: expect PASS with no failures. Browser tests use only synthetic doubles.

### Database isolation checks — owner-controlled test accounts only

These are separate from mocks and should use an approved disposable test project/account when
possible. Do not use real medical notes or paste tokens, request headers or login links into reports.

After creating your own identity through the UI, this browser-console check attempts a duplicate
for that **same signed-in account**. Run it only on the agreed test account, not an arbitrary member.
Expected: `duplicateRejected: true`, code `23505`, and still exactly one own identity.

```js
{
  const client = await (await import('/app/js/supabase.js')).getClient();
  const result = await client.auth.getUser();
  if (result.error || !result.data.user) throw new Error('Sign in to the test account first.');
  const own = await client.from('players').select('id')
    .eq('account_id', result.data.user.id).single();
  if (own.error || !own.data) throw new Error('Create the test account identity first.');
  const duplicate = await client.from('players').insert({
    account_id: result.data.user.id,
    display_name: 'Duplicate identity test'
  });
  console.log({ duplicateRejected: duplicate.error?.code === '23505', code: duplicate.error?.code });
}
```

For isolation, use a second approved non-admin account that is **not the first person's guardian**.
In that account's browser, replace the placeholder below with the first test identity's player UUID
(not its Auth user UUID). Expected: no error and `visibleRows: 0`. The snippet prints no medical data.

```js
{
  const client = await (await import('/app/js/supabase.js')).getClient();
  const result = await client.from('players').select('id,medical_notes')
    .eq('id', 'PASTE_FIRST_TEST_PLAYER_UUID_HERE');
  console.log({ code: result.error?.code || null, visibleRows: result.data?.length ?? null });
}
```

An anonymous request must likewise never read medical fields. A guardian/admin is deliberately
authorized, so using one as the second account would not test unrelated-member isolation.

## Offline checks and limits

```sh
python3 scripts/run_js_tests.py
python3 scripts/run_async_js_tests.py
python3 -m unittest discover -s tests -q
python3 scripts/check_site.py
python3 scripts/check_no_build.py
python3 scripts/check_secrets.py
python3 scripts/build_migrations.py --check
python3 scripts/check_sql.py
python3 scripts/check_seed.py
git diff --check
```

Use the existing macOS JavaScriptCore locally and CI's preinstalled runtime; no Node/npm/package
installation is required. Pure/async tests cover validation, payloads, scopes, errors and races.
They do not prove browser DOM behavior, actual RLS enforcement, database concurrency or hosting.
