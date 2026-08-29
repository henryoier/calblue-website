// Supabase project configuration — public by design.
//
// The anon key is the identity that Row-Level Security evaluates against.
// It grants nothing on its own; RLS decides what a signed-in (or anonymous)
// account may read. See docs/design/DESIGN.md §4 and app/README.md.
//
// The service-role key bypasses RLS entirely and must NEVER appear here,
// in this directory, or in any deployed asset. It belongs only to
// server-side scheduled jobs. scripts/check_secrets.py enforces this.
//
// TODO(#24): replace these placeholders with the real project URL and
// anon key once the Supabase project is provisioned. Every downstream
// screen works against these placeholders — only this file changes.

export const SUPABASE_URL = "https://placeholder.supabase.co";
export const SUPABASE_ANON_KEY = "placeholder-anon-key-replace-in-24";
export const SUPABASE_CLIENT_VERSION = "2.45.4";
