-- SUPERSEDED DEFAULT: Henry and his agent now require club admin access.
-- See README.md and grant-admin.sql. This is the optional historical read-only proposal.
-- Owner-run. Disables new logins AND removes access for existing pooled sessions.
-- Keep this script out of an open transaction when running manually.
BEGIN;
ALTER ROLE calblue_henry_agent NOLOGIN PASSWORD NULL;
REVOKE ALL ON ALL TABLES IN SCHEMA calblue_agent FROM calblue_henry_agent;
REVOKE ALL ON SCHEMA calblue_agent FROM calblue_henry_agent;
COMMIT;

-- After the committed revocation, terminate active work/connections as well.
-- Owner needs permission to terminate this role's sessions. Pooler sessions may
-- remain, but cannot read the views after the grants above have been revoked.
SELECT pg_terminate_backend(pid)
  FROM pg_stat_activity
 WHERE usename = 'calblue_henry_agent' AND pid <> pg_backend_pid();
