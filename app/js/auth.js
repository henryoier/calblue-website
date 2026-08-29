// Magic-link auth logic — pure, tested.
//
// See #30: sign-in screen email→magic link, callback, session persisted,
// sign-out, profile bootstrap, JWT refresh caveat.

export function validateEmail(email) {
  const e = String(email || "").trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

export function redirectUrlFor({ origin, intendedRoute, basePath = "/app/" }) {
  const route = intendedRoute && intendedRoute.startsWith("/") ? intendedRoute : "/";
  const hash = route === "/" ? "" : `#${route}`;
  return `${origin}${basePath}${hash}`;
}

export function parseAuthCallback(hash) {
  const h = String(hash || "");
  const params = {};
  const fragment = h.startsWith("#") ? h.slice(1) : h;
  // Supabase returns #access_token=...&type=magiclink etc, or ?error=...
  const queryPart = fragment.includes("?") ? fragment.split("?")[1] : fragment;
  for (const pair of queryPart.split("&")) {
    const [k, v] = pair.split("=");
    if (k) params[decodeURIComponent(k)] = decodeURIComponent(v || "");
  }
  if (params.error || params.error_description) {
    return { ok: false, error: params.error_description || params.error, params };
  }
  if (params.access_token) {
    return { ok: true, accessToken: params.access_token, params };
  }
  return { ok: false, error: null, params };
}

export function intendedRouteFromStorage(storage) {
  try {
    return storage.getItem("calblue_intended_route") || "/";
  } catch { return "/"; }
}

export function saveIntendedRoute(storage, route) {
  try { storage.setItem("calblue_intended_route", route || "/"); } catch {}
  return route || "/";
}

export function clearIntendedRoute(storage) {
  try { storage.removeItem("calblue_intended_route"); } catch {}
}
