# Henry and his agent: administrator handoff

The latest user decision gives **Henry and his agent the same club administrator
permissions as Gary**. The previous read-only proposal is superseded.

Use the existing Supabase Auth `admin` role. Henry signs in with his own verified
email/Google account. His agent uses a separately identifiable Auth account granted
that same `admin` role; it does not need the project service-role/secret key or the
database owner's password. Business permissions include all player records,
private documents and medical information, billing administration and reviewed
receipt recording. Existing accounting validation, immutable-ledger corrections
and audit rules still apply. A player payment report alone is not proof of receipt.

## Owner setup

1. Confirm Henry's actual login email and the dedicated agent Auth account with
   Henry. Do not invent an email, hardcode an email bypass or reuse Gary's login.
   Create/verify those accounts through the project's normal Auth administration.
2. Run `grant-admin.sql` as the profiles table owner, first setting
   `calblue.target_account_id` to the exact verified Auth UUID. Run once for Henry
   and once for his dedicated agent account. The script preserves other roles,
   verifies the Auth/profile email pairing, and checks signed-claim synchronization.
3. Henry refreshes his login. Configure the agent's noninteractive credentials in
   its secret store. A dedicated email/password Auth login can obtain a short-lived
   access token and a refresh token through Supabase Auth; use the project's
   publishable key plus that signed user access token for data API requests. This
   is an administrator user session, not a permanently valid project API key.
4. Use an SDK/session manager for token refresh. Never commit passwords or tokens,
   print them in logs, or copy Henry's personal Google credentials into the agent.
5. Test the actual agent session: permitted reads and validated administrative
   writes work, audit records identify the agent, player-only sessions remain
   restricted, and invalid/duplicate financial actions still fail.

No live accounts or credentials were provisioned here. Google provider setup,
production session behavior and actual administrator access require owner execution
and verification. The same admin role does not automatically provide Google Cloud,
GitHub repository write access, SMTP sending credentials or Chase authorization.

## Removing access

`revoke-admin.sql` removes only the target account's `admin` role and keeps other
roles. Refresh/revoke its Auth sessions as part of the owner workflow. Existing
access JWTs may retain admin claims until expiry; this SQL alone does not promise
instant invalidation. For urgent removal use the project's Auth/session controls
and verify denial with an already-issued token. Rotate compromised credentials.

## Historical files

`provision.sql`, `revoke.sql`, `test.sql`, and `legacy-readonly.md` describe the
previous PostgreSQL read-only proposal. They were tested locally only, never
applied to production, and must not be used to implement this new admin requirement.
The public handoff in `docs/handoffs/2026-10-21-member-management.md` is the current
product brief and completion checklist.
