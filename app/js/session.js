// Session state is UI state, never an authorization boundary. Supabase verifies
// tokens and Postgres RLS enforces access. Read roles from the access token,
// because session.user metadata can change before that token is refreshed.

export function parseRoles(input) {
  // Match 0003 app_roles(): exact strings, and a malformed array fails closed.
  if (!Array.isArray(input) || input.some((role) => typeof role !== "string")) return [];
  return [...new Set(input)];
}

function tokenClaims(session) {
  try {
    const parts = session?.access_token?.split(".");
    if (parts?.length !== 3 || !parts[0] || !parts[2]) return null;
    const payload = parts[1];
    if (!/^[A-Za-z0-9_-]+$/.test(payload) || payload.length % 4 === 1) return null;
    // Small base64url decoder: also works in the no-build JavaScriptCore tests.
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let buffer = 0;
    let bits = 0;
    let encoded = "";
    for (const character of payload) {
      buffer = (buffer << 6) | alphabet.indexOf(character);
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        encoded += "%" + ((buffer >> bits) & 255).toString(16).padStart(2, "0");
      }
    }
    if (bits && (buffer & ((1 << bits) - 1))) return null;
    const claims = JSON.parse(decodeURIComponent(encoded));
    if (!claims || typeof claims !== "object" || Array.isArray(claims)) return null;
    if (typeof claims.sub !== "string" || !claims.sub || claims.sub !== session?.user?.id) return null;
    return claims;
  } catch (_) {
    return null;
  }
}

export function rolesFromSession(session) {
  return parseRoles(tokenClaims(session)?.app_metadata?.roles);
}

export function hasRole(roles, wanted) {
  return typeof wanted === "string" && parseRoles(roles).includes(wanted);
}

export function hasAnyRole(roles, wantedList) {
  return Array.isArray(wantedList) && wantedList.some((wanted) => hasRole(roles, wanted));
}

export function canAccess(roles, required) {
  if (required == null || (Array.isArray(required) && required.length === 0)) return true;
  return hasAnyRole(roles, required);
}

const textValue = (value) => typeof value === "string" ? value : "";

export function normalizeProfile(row) {
  if (!row) return null;
  const displayName = textValue(row.display_name).trim();
  return {
    id: textValue(row.id),
    email: textValue(row.email),
    displayName,
    phone: textValue(row.phone),
    isEmpty: !displayName,
  };
}

export function isAdmin(roles) { return hasRole(roles, "admin"); }
export function isDeveloper(roles) { return hasRole(roles, "developer"); }
export function isCoach(roles) { return hasRole(roles, "coach"); }
export function isTreasurer(roles) { return hasRole(roles, "treasurer"); }

export function createSessionManager() {
  let currentSession = null;
  let currentProfile = null;
  let currentError = null;
  let activeClient = null;
  let unsubscribe = null;
  let lifecycle = 0;
  let revision = 0;
  let latestWork = Promise.resolve();
  let signOutWork = null;
  let signedOut = false;
  const listeners = new Set();

  const isCurrent = (epoch, ticket) => epoch === lifecycle && ticket === revision;
  const snapshot = () => ({
    session: currentSession,
    profile: currentProfile,
    roles: rolesFromSession(currentSession),
    authenticated: Boolean(currentSession),
    error: currentError,
  });

  function emit() {
    const state = snapshot();
    const epoch = lifecycle;
    const ticket = revision;
    for (const listener of listeners) {
      if (!isCurrent(epoch, ticket)) break;
      try { listener(state); }
      catch (_) { console.warn("A session listener failed."); }
    }
  }

  function clearSubscription() {
    const remove = unsubscribe;
    unsubscribe = null;
    try { if (remove) remove(); }
    catch (_) { console.warn("The previous auth subscription could not be removed."); }
  }

  async function loadProfile(client, epoch, ticket) {
    if (!isCurrent(epoch, ticket)) return;
    emit(); // Clear old account details before any profile network request.
    if (!isCurrent(epoch, ticket) || !currentSession || !client) return;
    const userId = currentSession.user.id;
    try {
      const { data, error } = await client.from("profiles")
        .select("id,email,display_name,phone").eq("id", userId).maybeSingle();
      if (!isCurrent(epoch, ticket)) return;
      if (error) throw error;
      if (!data || data.id !== userId) throw new Error("Your member profile is unavailable. Please try again.");
      currentProfile = normalizeProfile(data);
    } catch (error) {
      if (!isCurrent(epoch, ticket)) return;
      currentError = error;
    }
    if (isCurrent(epoch, ticket)) emit();
  }

  function acceptSession(client, session, epoch, deferred = false) {
    const ticket = ++revision;
    currentSession = tokenClaims(session) ? session : null;
    const user = currentSession?.user;
    currentProfile = user ? normalizeProfile({
      id: user.id, email: user.email, phone: user.phone,
      display_name: user.user_metadata?.display_name,
    }) : null;
    currentError = session && !currentSession
      ? new Error("The saved session is invalid. Sign in again.") : null;
    // Auth callbacks must not await (or synchronously trigger) another SDK
    // operation: its internal auth lock is still held. Only local invalidation
    // happens inside the callback; profile reads and notifications are deferred.
    latestWork = deferred
      ? new Promise((resolve) => setTimeout(resolve, 0)).then(() => loadProfile(client, epoch, ticket))
      : loadProfile(client, epoch, ticket);
    return latestWork;
  }

  async function initSession(client) {
    const epoch = ++lifecycle;
    revision += 1;
    clearSubscription();
    activeClient = client || null;
    signOutWork = null;
    signedOut = false;
    await acceptSession(null, null, epoch);
    if (!client || epoch !== lifecycle) return currentSession;
    const initialTicket = revision;
    try {
      // Subscribe before getSession/profile I/O so no sign-out or token event
      // can be missed during initialization.
      const subscription = client.auth.onAuthStateChange((event, session) => {
        if (epoch !== lifecycle) return;
        if (event === "SIGNED_OUT") {
          signedOut = true;
          acceptSession(null, null, epoch, true);
        } else if (!signOutWork && (!signedOut || event === "SIGNED_IN")) {
          signedOut = false;
          acceptSession(client, session, epoch, true);
        }
      });
      unsubscribe = () => subscription?.data?.subscription?.unsubscribe();
      const { data, error } = await client.auth.getSession();
      if (!isCurrent(epoch, initialTicket)) {
        if (epoch === lifecycle) await latestWork;
        return currentSession;
      }
      if (error) throw error;
      await acceptSession(client, data?.session || null, epoch);
      return currentSession;
    } catch (error) {
      if (!isCurrent(epoch, initialTicket)) return currentSession;
      currentError = error;
      emit();
      throw error;
    }
  }

  async function refreshAccess(client) {
    if (!client || !currentSession || signOutWork) return currentSession;
    if (client !== activeClient) throw new Error("The session client is no longer active.");
    const epoch = lifecycle;
    const ticket = ++revision;
    try {
      const { data, error } = await client.auth.refreshSession();
      if (!isCurrent(epoch, ticket)) {
        if (epoch === lifecycle) await latestWork;
        return currentSession;
      }
      if (error) throw error;
      await acceptSession(client, data?.session || null, epoch);
      return currentSession;
    } catch (error) {
      if (!isCurrent(epoch, ticket)) return currentSession;
      currentError = error;
      emit();
      throw error;
    }
  }

  function signOut(client) {
    if (signOutWork) return signOutWork;
    if (client && client !== activeClient) return Promise.reject(new Error("The session client is no longer active."));
    const target = client || activeClient;
    const epoch = lifecycle;
    revision += 1; // Invalidate in-flight profile, initial-session and refresh work.
    const work = Promise.resolve().then(async () => {
      try {
        if (epoch !== lifecycle) return;
        if (target) {
          // This device only; signing out must not revoke another device's login.
          const { error } = await target.auth.signOut({ scope: "local" });
          if (error) throw error;
        }
        if (epoch !== lifecycle) return;
        signedOut = true;
        await acceptSession(null, null, epoch);
      } catch (error) {
        if (epoch !== lifecycle) return;
        currentError = error;
        emit();
        throw error; // Do not display a success redirect when remote sign-out failed.
      } finally {
        if (epoch === lifecycle) signOutWork = null;
      }
    });
    signOutWork = work;
    return work;
  }

  function disposeSession() {
    lifecycle += 1;
    revision += 1;
    clearSubscription();
    currentSession = currentProfile = currentError = activeClient = signOutWork = null;
    signedOut = false;
    latestWork = Promise.resolve();
    listeners.clear();
  }

  return {
    initSession, refreshAccess, signOut,
    disposeSession,
    getSession: () => currentSession,
    getProfile: () => currentProfile,
    getRoles: () => rolesFromSession(currentSession),
    getSessionError: () => currentError,
    isAuthenticated: () => Boolean(currentSession),
    onSessionChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    _resetForTests: disposeSession,
  };
}

const manager = createSessionManager();
export function onSessionChange(listener) { return manager.onSessionChange(listener); }
export function getSession() { return manager.getSession(); }
export function getProfile() { return manager.getProfile(); }
export function getRoles() { return manager.getRoles(); }
export function getSessionError() { return manager.getSessionError(); }
export function isAuthenticated() { return manager.isAuthenticated(); }
export function initSession(client) { return manager.initSession(client); }
export function refreshAccess(client) { return manager.refreshAccess(client); }
export function signOut(client) { return manager.signOut(client); }
export function disposeSession() { return manager.disposeSession(); }
export function _resetForTests() { return manager._resetForTests(); }
