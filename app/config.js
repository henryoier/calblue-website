// Public Supabase browser configuration.
//
// Both values are intentionally public; database grants and RLS must still be configured.
// Keep the SUPABASE_ANON_KEY export name for the queued app client; its value is a
// publishable browser key, not a legacy JWT. Never put a service-role key, secret key,
// or database password here. Client initialization follows in issue #29.
export const SUPABASE_URL = "https://rmksoklavpoartewjvus.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_E6Nev6Kb2-8WF5YC0ZNJkA_2reaQUvU";

// Pin the only external browser dependency so upgrades are explicit and
// reviewable instead of changing underneath the no-build application.
export const SUPABASE_CLIENT_VERSION = "2.45.4";
