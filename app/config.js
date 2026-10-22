// Public Supabase browser configuration.
//
// Both values are intentionally public; database grants and RLS must still be configured.
// Keep the SUPABASE_ANON_KEY export name for the queued app client; its value is a
// publishable browser key, not a legacy JWT. Never put a service-role key, secret key,
// or database password here. The app-shell loader uses only these public values.
export const SUPABASE_URL = "https://rmksoklavpoartewjvus.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_E6Nev6Kb2-8WF5YC0ZNJkA_2reaQUvU";

// Pin the only external browser dependency so upgrades are explicit and
// reviewable instead of changing underneath the no-build application.
export const SUPABASE_CLIENT_VERSION = "2.45.4";

// Enable only after the Google provider and exact callback URLs are configured.
// Public Auth settings checked 2026-10-21: email=true, google=false.
export const GOOGLE_AUTH_ENABLED = false;
