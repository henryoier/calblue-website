// Hash router — no server rewrites needed, so it works on GitHub Pages.
//
// Routes are registered as { pattern, view, title, auth?, roles? }.
// Pattern syntax: "/games/:id"; segments beginning with ":" are parameters.

export function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch (_) {
    return value;
  }
}

export function parseHash(hash) {
  const raw = String(hash || "").replace(/^#/, "") || "/";
  const queryStart = raw.indexOf("?");
  const rawPath = (queryStart === -1 ? raw : raw.slice(0, queryStart)) || "/";
  const queryString = queryStart === -1 ? "" : raw.slice(queryStart + 1);
  const segments = rawPath.split("/").filter(Boolean).map(safeDecode);
  const query = {};

  for (const pair of queryString.split("&")) {
    if (!pair) continue;
    const equals = pair.indexOf("=");
    const rawKey = equals === -1 ? pair : pair.slice(0, equals);
    const rawValue = equals === -1 ? "" : pair.slice(equals + 1);
    if (!rawKey) continue;
    const key = safeDecode(rawKey.replace(/\+/g, " "));
    query[key] = safeDecode(rawValue.replace(/\+/g, " "));
  }

  return { path: "/" + segments.join("/"), segments, query };
}

export function matchRoute(routes, hash) {
  const { segments, query } = parseHash(hash);
  for (const route of routes) {
    if (route.pattern === "*") continue;
    const patternSegments = route.pattern.split("/").filter(Boolean);
    if (patternSegments.length !== segments.length) continue;
    const params = {};
    let matches = true;

    for (let index = 0; index < patternSegments.length; index += 1) {
      const expected = patternSegments[index];
      if (expected.startsWith(":")) {
        params[expected.slice(1)] = segments[index];
      } else if (expected !== segments[index]) {
        matches = false;
        break;
      }
    }

    if (matches) return { route, params, query };
  }
  return null;
}

export function buildHash(pattern, params = {}, query = {}) {
  let path = pattern;
  for (const [key, value] of Object.entries(params)) {
    path = path.replace(`:${key}`, encodeURIComponent(value));
  }
  const queryString = Object.entries(query)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
  return `#${path.startsWith("/") ? path : "/" + path}${queryString ? "?" + queryString : ""}`;
}

export function routeAllowed(route, access = {}) {
  const authenticated = Boolean(access.authenticated);
  if (route.auth && !authenticated) return false;
  if (!route.roles || route.roles.length === 0) return true;
  if (!authenticated) return false;
  const roles = new Set((access.roles || []).map((role) => String(role).toLowerCase()));
  return route.roles.some((role) => roles.has(String(role).toLowerCase()));
}

export function navigate(pattern, params, query) {
  window.location.hash = buildHash(pattern, params, query);
}

export function createRouter({
  routes,
  mountPoint,
  getAccess = () => ({ authenticated: false, roles: [] }),
  onRouteChange,
  onLoading,
  onError,
  onUnauthorized,
}) {
  const notFound = routes.find((route) => route.pattern === "*") || null;
  let renderGeneration = 0;
  let activeController = null;

  async function render() {
    const generation = ++renderGeneration;
    if (activeController) activeController.abort();
    const controller = new AbortController();
    activeController = controller;
    const routeContext = {
      signal: controller.signal,
      isCurrent: () => generation === renderGeneration && !controller.signal.aborted,
    };
    const match = matchRoute(routes, window.location.hash);
    const target = match || (notFound ? { route: notFound, params: {}, query: {} } : null);

    if (!target) {
      const error = new Error("No route matched and no 404 route is registered.");
      if (onError) onError(error);
      else throw error;
      return;
    }

    try {
      const path = parseHash(window.location.hash).path;
      if (onRouteChange) onRouteChange({ ...target, path });
      if (target.route.title) document.title = `${target.route.title} — CalBlue members`;
      if (onLoading) onLoading(target);

      const access = getAccess() || {};
      if (!routeAllowed(target.route, access)) {
        if (onUnauthorized) {
          await onUnauthorized(target, access, routeContext);
          return;
        }
        throw new Error("You do not have access to this screen.");
      }
      await target.route.view(target.params, target.query, routeContext);
      if (!routeContext.isCurrent()) return;
      if (typeof mountPoint.focus === "function") mountPoint.focus({ preventScroll: true });
    } catch (error) {
      if (!routeContext.isCurrent() || error?.name === "AbortError") return;
      console.error(error);
      if (onError) onError(error);
      else throw error;
    }
  }

  window.addEventListener("hashchange", render);
  return {
    render,
    navigate,
    destroy() {
      renderGeneration += 1;
      if (activeController) activeController.abort();
      window.removeEventListener("hashchange", render);
    },
  };
}
