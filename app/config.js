// Public Supabase browser configuration.
//
// Replace the two placeholders after the project is provisioned. The anon key
// is intentionally public and receives only the access allowed by RLS. Never
// put a service-role or secret key in this file.
export const SUPABASE_URL = "https://YOUR_PROJECT_REF.supabase.co";
export const SUPABASE_ANON_KEY = "YOUR_SUPABASE_ANON_KEY";

// Pin the only external browser dependency so upgrades are explicit and
// reviewable instead of changing underneath the no-build application.
export const SUPABASE_CLIENT_VERSION = "2.45.4";
