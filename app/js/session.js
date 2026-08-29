// Session state — the single place where signed-in state is resolved.
//
// Authorization roles always come from the current JWT (user.app_metadata),
// because that is the same claim the RLS helpers evaluate. The profiles query
// supplies display-only identity fields and never grants UI access by itself.

export function parseRoles(input) {
  if (!input) return [];
  const raw = Array.isArray(input) ? input : (input.roles || input.app_metadata?.roles || []);
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const roles = [];
  for (const item of raw) {
    const role = String(item).trim().toLowerCase();
    if (role && !seen.has(role)) {
      seen.add(role);
      roles.push(role);
    }
  }
  return roles;
}

export function rolesFromSession(session) {
  return parseRoles(session?.user?.app_metadata?.roles);
}

export function hasRole(roles, wanted) {
  return parseRoles(roles).includes(String(wanted).toLowerCase());
}

export function hasAnyRole(roles, wantedList) {
  const available = new Set(parseRoles(roles));
  return wantedList.some((wanted) => available.has(String(wanted).toLowerCase()));
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
    isEmpty: !(row.display_name || "").trim(),
  };
}

export function isAdmin(roles) { return hasRole(roles, "admin"); }
export function isDeveloper(roles) { return hasRole(roles, "developer"); }
export function isCoach(roles) { return hasRole(roles, "coach"); }
export function isTreasurer(roles) { return hasRole(roles, "treasurer"); }

let currentSession = null;
let currentProfile = null;
let currentError = null;
let authUnsubscribe = null;
let syncSequence = 0;
const listeners = new Set();

export function onSessionChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot() {
  return {
    session: currentSession,
    profile: currentProfile,
    roles: rolesFromSession(currentSession),
    authenticated: Boolean(currentSession?.user),
    error: currentError,
  };
}

function emit() {
  const state = snapshot();
  for (const listener of listeners) {
    try {
      listener(state);
    } catch (error) {
      console.warn("session listener failed:", error);
    }
  }
}

function fallbackProfile(user) {
  return normalizeProfile({
    id: user?.id,
    email: user?.email,
    display_name: user?.user_metadata?.display_name || "",
    phone: user?.phone || "",
  });
}

async function synchronizeSession(supabaseClient, session) {
  const sequence = ++syncSequence;
  currentSession = session || null;
  currentProfile = currentSession?.user ? fallbackProfile(currentSession.user) : null;
  currentError = null;

  if (currentSession?.user && supabaseClient) {
    const { data, error } = await supabaseClient
      .from("profiles")
      .select("id,email,display_name,phone")
      .eq("id", currentSession.user.id)
      .maybeSingle();

    if (sequence !== syncSequence) return snapshot();
    if (error) {
      currentError = error;
    } else if (data) {
      currentProfile = normalizeProfile(data);
    }
  }

  if (sequence === syncSequence) emit();
  return snapshot();
}

export function getSession() { return currentSession; }
export function getProfile() { return currentProfile; }
export function getRoles() { return rolesFromSession(currentSession); }
export function getSessionError() { return currentError; }
export function isAuthenticated() { return Boolean(currentSession?.user); }

export async function initSession(supabaseClient) {
  if (authUnsubscribe) {
    authUnsubscribe();
    authUnsubscribe = null;
  }

  if (!supabaseClient) {
    await synchronizeSession(null, null);
    return null;
  }

  const { data, error } = await supabaseClient.auth.getSession();
  if (error) throw error;
  await synchronizeSession(supabaseClient, data?.session || null);

  const authListener = supabaseClient.auth.onAuthStateChange((_event, session) => {
    // Supabase recommends returning quickly from this callback. Deferring the
    // profile query also avoids deadlocking another client call.
    setTimeout(() => {
      synchronizeSession(supabaseClient, session).catch((syncError) => {
        currentError = syncError;
        emit();
      });
    }, 0);
  });
  authUnsubscribe = authListener?.data?.subscription?.unsubscribe
    ? () => authListener.data.subscription.unsubscribe()
    : null;

  return currentSession;
}

export async function refreshAccess(supabaseClient) {
  if (!supabaseClient) return null;
  const { data, error } = await supabaseClient.auth.refreshSession();
  if (error) throw error;
  await synchronizeSession(supabaseClient, data?.session || null);
  return currentSession;
}

export async function signOut(supabaseClient) {
  if (supabaseClient) {
    const { error } = await supabaseClient.auth.signOut();
    if (error) throw error;
  }
  await synchronizeSession(null, null);
}

export function _resetForTests() {
  syncSequence += 1;
  currentSession = null;
  currentProfile = null;
  currentError = null;
  if (authUnsubscribe) authUnsubscribe();
  authUnsubscribe = null;
  listeners.clear();
}
