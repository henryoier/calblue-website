# Superseded read-only proposal

The user explicitly replaced this proposal with administrator access for Henry and his agent. Do not provision a read-only account as the requested default. The old SQL remains only as an optional reference. No such account was created in production.

# Henry's read-only agent connection

This optional extension gives Henry's agent a separate PostgreSQL credential.
It is not a Supabase project secret key, a member Google account, an admin role,
or an HTTP API token. PostgreSQL clients (including psql and database-capable
agents) can use it. An agent which accepts only HTTP/MCP needs a separate adapter;
none is deployed by these scripts.

The three views expose roster names/player UUIDs, account names/contact emails,
account balances, and dated ledger amounts. DOB, photos, phone numbers, emergency
contacts, medical notes, claim codes, role assignments, bank references and free
text notes are excluded. IDs here are the existing online database UUIDs; the
offline `CB-year-sequence` IDs and offline records are not imported automatically.
These views cover the whole existing club database, not a multi-club tenant.

## Owner setup

1. Apply existing migrations 0001-0004 in a reviewed deployment. Run
   `provision.sql` once as the database owner. It atomically creates a NOLOGIN
   role and the three views. If broad PUBLIC permissions are detected, setup
   fails; investigate them instead of bypassing the guard. No application tables,
   RLS policies or member roles are changed. Do not expose `calblue_agent` as a
   Supabase Data API schema. The view owner must retain permission to read the
   underlying tables; these are deliberately owner-rights views.
2. In an interactive owner `psql` session, run `SET password_encryption =
   'scram-sha-256';` and then `\password calblue_henry_agent`. Use a new random
   password from a password manager. The hidden prompt avoids putting plaintext
   in shell history or this repository. Do not use the project database owner's
   password, a service-role key, or a secret API key.
3. Set an explicit future expiry and enable the role, for example by replacing
   the date in `ALTER ROLE calblue_henry_agent LOGIN VALID UNTIL
   'YYYY-MM-DD 00:00:00+00';`. A password alone does not enable the NOLOGIN role.
4. Copy the actual **session pooler** host and port from the project's Connect
   dialog. Its username is `calblue_henry_agent.PROJECT_REF`. With a direct
   connection use username `calblue_henry_agent` instead. Do not guess the region
   or pooler host. Require TLS certificate/hostname validation (`sslmode=verify-full`
   and the appropriate CA certificate). Test with these actual restricted
   credentials, not an owner's connection with a frontend read-only toggle.
5. Give Henry the host, port, database, username, expiry, this README, and a
   separately shared password. Store the password in the agent's secret store
   or a permission-0600 libpq password file outside the repository; do not paste
   it into chat, a URL in a command, a prompt, or a committed config file.

Example queries once connected:

```sql
SELECT * FROM calblue_agent.accounts WHERE balance > 0 ORDER BY balance DESC;
SELECT * FROM calblue_agent.roster ORDER BY display_name;
SELECT * FROM calblue_agent.ledger ORDER BY entry_date DESC, source_id;
```

The agent can prepare reports, compare externally supplied bank transactions and
draft reminders. It cannot create/update/settle bills, send email, or access Chase
using this credential. The ledger represents club-recorded receipts, not an
independent live-bank confirmation. Add write actions only through separately
authorized, validated operations in a later change.

## Revocation and limits

Run `revoke.sql` as owner to disable new logins, remove view access, clear the
password and terminate active database sessions. This cannot retract data already
downloaded. To rotate an active credential, use `\password` again and terminate
its existing sessions; password expiry alone does not end existing sessions.
Re-enabling a revoked role also requires restoring the explicit view/schema grants
after review. Provisioning deliberately fails if its role or schema already exists.

SQL permissions enforce read-only; `default_transaction_read_only` is merely a
convenience setting the client can change. Do not grant role membership, base-table
access, schema CREATE, or broad default privileges later. Review PUBLIC grants
when deploying extensions/migrations. PostgreSQL system metadata remains visible;
this is restricted club-data access, not a hidden database catalog.

The distinct database username identifies the connection. Per-query read auditing
and query retention require separately configured database logging; the existing
application write audit does not log these SELECTs. This package does not claim
to install that audit system.

`test.sql` uses a local disposable PostgreSQL superuser and synthetic data after
the four migrations and provisioning script. It changes session authorization to
exercise the real role boundary (SET ROLE alone from a superuser session would
not test escalation correctly). Do not run it in production. Production password,
TLS/pooler connectivity and hosted Supabase permissions still need owner setup
and verification. No live credential has been issued.

References: [Supabase database connections](https://supabase.com/docs/guides/database/connecting-to-postgres),
[API key privileges](https://supabase.com/docs/guides/getting-started/api-keys).
