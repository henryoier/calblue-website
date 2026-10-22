# Working on CalBlue

Before continuing member registration, billing, authentication, player privacy or
agent access work, read [the current handoff](docs/handoffs/2026-10-21-member-management.md).
It contains the approved requirements, tested changes, remaining work and deployment
boundaries. Preserve unrelated work and follow the existing no-build ES module
convention documented in docs/design/adr/0001-client-stack.md.

Latest user decisions:
- Keep the existing Supabase member system; players use Google sign-in and see
  their own data/bills. Human administrators see/manage all collected records.
- Henry AND his agent have the same club administrator permissions as Gary.
  The old read-only agent proposal is superseded; follow supabase/agent-access/README.md.
- Players should report payment with one button. A report is pending review and
  must not settle an invoice until an administrator verifies an actual receipt.
- Public player profiles may show birthdays and ordinary player portraits.
  Government-ID/document images remain private; administrators can access them.
- Zelle tag gocalblue1996; recipient CALBLUE CHINESE COMMUNITY. Venmo is not configured.

Track code completion separately from production deployment. Google enablement,
admin/agent credentials, bank access, email sending and the new one-click report
workflow must not be claimed live merely because a local test or preview passes.
Never commit private member data, operational backups, credentials or private keys.
