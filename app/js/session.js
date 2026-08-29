// Session state — single place where signed-in state is resolved.
//
// Roles come from the JWT (app_metadata.roles), never from a query to
// profiles — that would recurse into RLS (see schema.sql §1 and #27).
// A role change only takes effect on the next token refresh; the UI must
// surface that caveat and offer "refresh my access" (#30).
//
// Pure logic (parseRoles, hasRole, canAccess, normalizeProfile) is kept
// free of DOM/Supabase so it runs under JavaScriptCore in scripts/run_js_tests.py.

export function parseRoles(input) {
  if (!input) return [];
  const raw = Array.isArray(input) ? input : (input.roles || input.app_metadata?.roles || []);
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const r of raw) {
    const role = String(r).trim().toLowerCase();
    if (role && !seen.has(role)) { seen.add(role); out.push(role); }
  }
  return out;
}

export function hasRole(roles, wanted) {
  return parseRoles(roles).includes(String(wanted).toLowerCase());
}

export function hasAnyRole(roles, wantedList) {
  const have = new Set(parseRoles(roles));
  return wantedList.some((w) => have.has(String(w).toLowerCase()));
}

export function canAccess(roles, required) {
  if (!required || required.length === 0) return true;
  return hasAnyRole(roles, required);
}

export function normalizeProfile(row) {
  if (!row) return null;
  return {
    id: row.id || "",
    email: row.email || "",
    displayName: (row.display_name || "").trim(),
    phone: row.phone || "",
    roles: parseRoles(row.roles),
    isEmpty: !(row.display_name || "").trim(),
  };
}

export function isAdmin(roles) { return hasRole(roles, "admin"); }
export function isDeveloper(roles) { return hasRole(roles, "developer"); }
export function isCoach(roles) { return hasRole(roles, "coach"); }
export function isTreasurer(roles) { return hasRole(roles, "treasurer"); }

// --- Live session (browser only, uses Supabase) ---

let currentSession = null;
let currentProfile = null;
const listeners = new Set();

export function onSessionChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  for (const fn of listeners) {
    try { fn({ session: currentSession, profile: currentProfile }); } catch (e) { console.warn(e); }
  }
}

export function getSession() { return currentSession; }
export function getProfile() { return currentProfile; }
export function getRoles() { return currentProfile ? currentProfile.roles : parseRoles(currentSession?.user?.app_metadata); }

export async function initSession(supabaseClient) {
  if (!supabaseClient) {
    currentSession = null;
    currentProfile = null;
    emit();
    return null;
  }
  const { data } = await supabaseClient.auth.getSession();
  currentSession = data?.session || null;
  if (currentSession?.user) {
    const { data: profileRow } = await supabaseClient
      .from("profiles").select("id,email,display_name,phone,roles").eq("id", currentSession.user.id).maybeSingle();
    currentProfile = normalizeProfile(profileRow || {
      id: currentSession.user.id,
      email: currentSession.user.email,
      display_name: "",
      roles: parseRoles(currentSession.user.app_metadata),
    });
  }
  emit();
  supabaseClient.auth.onAuthStateChange(async (_event, session) => {
    currentSession = session;
    emit();
  });
  return currentSession;
}

export async function refreshAccess(supabaseClient) {
  if (!supabaseClient) return null;
  const { data, error } = await supabaseClient.auth.refreshSession();
  if (error) throw error;
  currentSession = data.session;
  emit();
  return currentSession;
}

export async function signOut(supabaseClient) {
  if (supabaseClient) await supabaseClient.auth.signOut();
  currentSession = null;
  currentProfile = null;
  emit();
}
