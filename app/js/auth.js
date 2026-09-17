// Explicit email PKCE flow for the pinned auth-js 2.65.0 client.
// IMPORTANT: that release auto-detects PKCE even with detectSessionInUrl:false.
// Construct this service (and scrub its callback) BEFORE constructing the SDK.
// No passwords, tokens, callback codes or email addresses are stored here.

const PENDING_KEY = "calblue.magic-link.v1";
const PROBE_KEY = "calblue.magic-link.storage-probe";
const RETURN_TTL = 60 * 60 * 1000;
const RESEND_DELAY = 60 * 1000;
const SAFE_ROUTES = new Set([
  "/", "/games", "/identity", "/admin/verify", "/admin/payments", "/admin/audit", "/admin/clubs",
]);
const MESSAGES = {
  invalid_email: "Enter a valid email address.",
  unsupported_origin: "Open the configured CalBlue app URL before requesting a sign-in link.",
  storage_unavailable: "Enable browser storage, then request a new link in this browser.",
  rate_limited: "Wait at least one minute before requesting another sign-in link.",
  auth_busy: "Another sign-in operation is in progress. Wait for it to finish before trying again.",
  request_failed: "The sign-in link could not be requested. Wait at least one minute and try again.",
  callback_invalid: "This sign-in link is not supported. Request a new email link from this page.",
  callback_failed: "This link could not sign you in. Open it in the same browser where you requested it, or request a new link here.",
  callback_scrub_failed: "The sign-in link could not be cleared safely. Close this tab and open the app again.",
};

function failure(code) {
  const error = new Error(MESSAGES[code]);
  error.code = code;
  return error;
}

export function safeReturnTo(input) {
  if (typeof input !== "string") return "#/";
  const path = input.startsWith("#") ? input.slice(1) : input;
  return SAFE_ROUTES.has(path) ? "#" + path : "#/";
}

export function allowedRedirectUrl(location) {
  const address = (location?.origin || "") + (location?.pathname || "");
  return ["https://app.calbluefc.com/", "http://localhost:8080/app/", "http://localhost:8091/app/"]
    .includes(address) ? address : null;
}

export function normalizeEmail(input) {
  if (typeof input !== "string") return null;
  const email = input.trim();
  if (email.length > 254 || !/^[\x21-\x7e]+$/.test(email)) return null;
  const parts = email.split("@");
  if (parts.length !== 2 || !parts[0] || parts[0].length > 64
      || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(parts[0])
      || parts[0].startsWith(".") || parts[0].endsWith(".") || parts[0].includes("..")) return null;
  const labels = parts[1].split(".");
  if (labels.length < 2 || labels.some((label) => !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))) return null;
  return parts[0] + "@" + parts[1].toLowerCase();
}

function parameters(input) {
  let valid = true;
  const pairs = [];
  for (const part of input.split("&")) {
    if (!part) continue;
    const equals = part.indexOf("=");
    const rawKey = equals < 0 ? part : part.slice(0, equals);
    const rawValue = equals < 0 ? "" : part.slice(equals + 1);
    try {
      pairs.push([decodeURIComponent(rawKey.replace(/\+/g, " ")),
        decodeURIComponent(rawValue.replace(/\+/g, " "))]);
    } catch (_) {
      valid = false;
      // Retain a decodable key so code=%broken is still scrubbed and rejected.
      let key = rawKey;
      try { key = decodeURIComponent(rawKey); } catch (_) { /* malformed key */ }
      pairs.push([key, ""]);
    }
  }
  return { valid, pairs };
}

export function parseAuthCallback(location) {
  const query = parameters(typeof location?.search === "string" ? location.search.replace(/^\?/, "") : "");
  let hash = typeof location?.hash === "string" ? location.hash.replace(/^#/, "") : "";
  if (hash.startsWith("/") && hash.includes("?")) hash = hash.slice(hash.indexOf("?") + 1);
  // URLSearchParams (used by the pinned SDK) ignores one leading question mark.
  // Match that detection so #?code cannot escape scrubbing and auto-exchange.
  hash = hash.replace(/^\?/, "");
  const fragment = parameters(hash);
  const keys = new Set(["code", "error", "error_code", "error_description", "access_token", "refresh_token",
    "provider_token", "provider_refresh_token", "expires_in", "expires_at", "token_type", "type"]);
  const relevant = (pair) => keys.has(pair[0].toLowerCase());
  const top = query.pairs.filter(relevant);
  const embedded = fragment.pairs.filter(relevant);
  if (!top.length && !embedded.length) return { kind: "none" };
  if (!query.valid || !fragment.valid || embedded.length || top.length !== 1 || top[0][0] !== "code"
      || !/^[A-Za-z0-9._~-]{1,2048}$/.test(top[0][1])) return { kind: "error" };
  return { kind: "code", code: top[0][1] };
}

export function createAuthFlow({
  location = globalThis.location,
  history = globalThis.history,
  storage,
  now = () => Date.now(),
  locks = globalThis.navigator?.locks,
} = {}) {
  const page = { origin: location?.origin, pathname: location?.pathname,
    search: location?.search, hash: location?.hash };
  const redirectTo = allowedRedirectUrl(page);
  let captured = parseAuthCallback(page);
  let scrubFailed = false;
  let requestTask = null;
  let callbackTask = null;
  let callbackRunning = false;
  let generation = 0;
  if (storage === undefined) {
    try { storage = globalThis.localStorage; } catch (_) { storage = null; }
  }

  if (captured.kind !== "none") {
    try {
      const localPath = /^\/(?!\/)[^?#\\]*$/.test(page.pathname || "") ? page.pathname : "/";
      history.replaceState(null, "", (redirectTo || localPath) + "#/sign-in");
    } catch (_) {
      scrubFailed = true;
    }
  }

  function assertSafeToLoad() {
    if (scrubFailed) throw failure("callback_scrub_failed");
  }

  function readPending() {
    let raw;
    try { raw = storage?.getItem(PENDING_KEY); }
    catch (_) { throw failure("storage_unavailable"); }
    if (!storage) throw failure("storage_unavailable");
    try {
      const value = JSON.parse(raw);
      const age = now() - value?.createdAt;
      if (value?.version !== 1 || typeof value.createdAt !== "number" || !Number.isFinite(age)
          || age < 0 || age > RETURN_TTL || typeof value.returnTo !== "string"
          || safeReturnTo(value.returnTo) !== value.returnTo) return null;
      return { createdAt: value.createdAt, returnTo: value.returnTo, raw };
    } catch (_) { return null; }
  }

  function probeStorage() {
    try {
      storage.setItem(PROBE_KEY, "1");
      if (storage.getItem(PROBE_KEY) !== "1") throw new Error("storage did not persist");
      storage.removeItem(PROBE_KEY);
    } catch (_) { throw failure("storage_unavailable"); }
  }

  function writePending(returnTo) {
    const value = JSON.stringify({ version: 1, createdAt: now(), returnTo: safeReturnTo(returnTo) });
    try {
      storage.setItem(PENDING_KEY, value);
      if (storage.getItem(PENDING_KEY) !== value) throw new Error("storage did not persist");
    } catch (_) { throw failure("storage_unavailable"); }
  }

  function removePending() {
    try { storage?.removeItem(PENDING_KEY); } catch (_) { /* Metadata only; TTL still bounds it. */ }
  }

  function removeConsumedPending(raw) {
    if (raw === null) return;
    try {
      if (storage?.getItem(PENDING_KEY) === raw) storage.removeItem(PENDING_KEY);
    } catch (_) { /* Never erase a newer request or fail an established session. */ }
  }

  function exclusive(operation) {
    // Best-effort cross-tab coordination, not a security/rate-limit boundary.
    // Supabase remains responsible for rate limiting and PKCE validation.
    if (typeof locks?.request === "function") {
      return locks.request("calblue-magic-link", { mode: "exclusive", ifAvailable: true }, (lock) => {
        if (!lock) throw failure("auth_busy");
        return operation();
      });
    }
    return operation();
  }

  function requestLink(client, emailInput, returnTo = "#/") {
    if (requestTask || callbackRunning) return Promise.reject(failure("auth_busy"));
    const email = normalizeEmail(emailInput);
    if (!email) return Promise.reject(failure("invalid_email"));
    if (!redirectTo) return Promise.reject(failure("unsupported_origin"));
    if (!client?.auth?.signInWithOtp) return Promise.reject(failure("request_failed"));
    const epoch = generation;
    requestTask = Promise.resolve().then(() => exclusive(async () => {
      if (epoch !== generation) throw failure("auth_busy");
      assertSafeToLoad();
      probeStorage(); // The SDK must not silently fall back to in-memory PKCE storage.
      const previous = readPending();
      if (previous && now() - previous.createdAt < RESEND_DELAY) throw failure("rate_limited");
      writePending(returnTo); // Cool down attempts too; a network retry must not spam email.
      try {
        const { error } = await client.auth.signInWithOtp({
          email,
          options: { emailRedirectTo: redirectTo, shouldCreateUser: true },
        });
        if (error) throw failure(error.status === 429 ? "rate_limited" : "request_failed");
      } catch (error) {
        throw failure(error?.code === "rate_limited" ? "rate_limited" : "request_failed");
      }
      if (epoch !== generation) throw failure("auth_busy");
      return { sent: true };
    })).catch((error) => {
      // Only our finite message/code vocabulary leaves the service.
      throw failure(Object.prototype.hasOwnProperty.call(MESSAGES, error?.code) ? error.code : "request_failed");
    }).finally(() => { requestTask = null; });
    return requestTask;
  }

  function completeCallback(client) {
    assertSafeToLoad();
    if (callbackTask) return callbackTask;
    if (captured.kind === "none") return Promise.resolve({ handled: false });
    // The loader may be retried without losing the only in-memory copy of code.
    if (!client?.auth?.exchangeCodeForSession) return Promise.reject(failure("request_failed"));
    if (requestTask) return Promise.reject(failure("auth_busy"));
    const callback = captured;
    captured = { kind: "none" };
    const epoch = generation;
    let returnTo = "#/";
    let consumedPending = null;
    callbackRunning = true;
    callbackTask = Promise.resolve().then(() => exclusive(async () => {
      if (epoch !== generation) throw failure("callback_failed");
      const pending = readPending();
      if (pending) returnTo = safeReturnTo(pending.returnTo);
      if (!redirectTo) throw failure("unsupported_origin");
      if (callback.kind !== "code") throw failure("callback_invalid");
      if (!pending) throw failure("callback_failed");
      consumedPending = pending.raw;
      const { data, error } = await client.auth.exchangeCodeForSession(callback.code);
      if (epoch !== generation) throw failure("callback_failed");
      if (error || !data?.session?.user?.id || !data.session.access_token) throw failure("callback_failed");
      return { handled: true, returnTo };
    })).catch((error) => {
      const code = ["unsupported_origin", "storage_unavailable", "callback_invalid"].includes(error?.code)
        ? error.code : "callback_failed";
      return { handled: true, error: MESSAGES[code], code, returnTo };
    }).finally(() => {
      callbackRunning = false;
      callback.code = null;
      removeConsumedPending(consumedPending);
    });
    // Cache completion, including failure: a consumed code must never be replayed
    // by a render/retry. A failed exchange requires a newly requested email link.
    return callbackTask;
  }

  function clearPending() {
    generation += 1;
    captured = { kind: "none" };
    removePending();
  }

  return { assertSafeToLoad, requestLink, completeCallback, clearPending };
}
