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
  const rawSegments = rawPath === "/" ? [] : rawPath.replace(/\/$/, "").slice(1).split("/");
  let valid = rawPath.startsWith("/") && !rawPath.includes("\\");
  const decode = (value) => {
    try {
      return decodeURIComponent(value);
    } catch (_) {
      valid = false;
      return value;
    }
  };
  const segments = rawSegments.map(decode);
  if (segments.some((segment) => !segment || segment === "." || segment === ".."
      || /[\u0000-\u001f\u007f\\]/.test(segment))) valid = false;
  const query = Object.create(null);

  for (const pair of queryString.split("&")) {
    if (!pair) continue;
    const equals = pair.indexOf("=");
    const rawKey = equals === -1 ? pair : pair.slice(0, equals);
    const rawValue = equals === -1 ? "" : pair.slice(equals + 1);
    if (!rawKey) continue;
    const key = decode(rawKey.replace(/\+/g, " "));
    query[key] = decode(rawValue.replace(/\+/g, " "));
  }

  let path = rawPath;
  try {
    // An encoded slash remains one parameter, not a second path segment.
    path = "/" + segments.map((segment) => encodeURIComponent(segment)).join("/");
  } catch (_) {
    valid = false;
  }
  return { path, segments, query, valid };
}

export function matchRoute(routes, hash) {
  const { segments, query, valid } = parseHash(hash);
  if (!valid || !Array.isArray(routes)) return null;
  for (const route of routes) {
    if (!route || typeof route.pattern !== "string" || route.pattern === "*") continue;
    const patternSegments = route.pattern.split("/").filter(Boolean);
    if (patternSegments.length !== segments.length) continue;
    const params = Object.create(null);
    let matches = true;

    for (let index = 0; index < patternSegments.length; index += 1) {
      const expected = patternSegments[index];
      if (expected.startsWith(":")) {
        if (!/^:[A-Za-z_][A-Za-z0-9_]*$/.test(expected)) {
          matches = false;
          break;
        }
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
  if (typeof pattern !== "string" || /[?#\\\u0000-\u001f\u007f]/.test(pattern)) {
    throw new TypeError("Route patterns must be paths without query strings or fragments.");
  }
  const parts = pattern.replace(/^\//, "").replace(/\/$/, "");
  const path = "/" + (parts ? parts.split("/").map((segment) => {
    if (!segment || segment === "." || segment === "..") throw new TypeError("Invalid route path segment.");
    if (!segment.startsWith(":")) return encodeURIComponent(segment);
    const name = segment.slice(1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
        || params == null || !Object.prototype.hasOwnProperty.call(params, name)
        || params[name] == null || String(params[name]) === "") {
      throw new TypeError(`Missing or invalid route parameter: ${name}`);
    }
    const value = String(params[name]);
    if (value === "." || value === ".." || /[\u0000-\u001f\u007f\\]/.test(value)) {
      throw new TypeError(`Invalid route parameter: ${name}`);
    }
    return encodeURIComponent(value);
  }).join("/") : "");
  const queryString = Object.entries(query)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
  return `#${path}${queryString ? "?" + queryString : ""}`;
}

export function routeAllowed(route, access = {}) {
  if (!route || typeof route !== "object") return false;
  const authenticated = access?.authenticated === true;
  if (route.auth && !authenticated) return false;
  if (route.roles == null) return true;
  if (!Array.isArray(route.roles) || route.roles.some((role) => typeof role !== "string" || !role)) return false;
  if (route.roles.length === 0) return true;
  if (!authenticated) return false;
  const roles = new Set(Array.isArray(access.roles)
    && access.roles.every((role) => typeof role === "string") ? access.roles : []);
  return route.roles.some((role) => roles.has(role));
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
} = {}) {
  if (!Array.isArray(routes)) throw new TypeError("Router routes must be an array.");
  const notFound = routes.find((route) => route?.pattern === "*") || null;
  let renderGeneration = 0;
  let activeController = null;
  let activeCleanup = null;
  let destroyed = false;

  function dispose(cleanup) {
    if (typeof cleanup !== "function") return;
    try {
      // Cleanup releases this view's listeners/resources, not another view's DOM.
      Promise.resolve(cleanup()).catch((error) => console.error(error));
    } catch (error) {
      console.error(error);
    }
  }

  function deactivate() {
    const controller = activeController;
    const cleanup = activeCleanup;
    activeController = null;
    activeCleanup = null;
    if (controller) controller.abort();
    dispose(cleanup);
  }

  function setBusy(value) {
    if (typeof mountPoint?.setAttribute === "function") mountPoint.setAttribute("aria-busy", String(value));
  }

  function keepCleanup(cleanup, context) {
    if (typeof cleanup !== "function") return;
    if (context.isCurrent()) activeCleanup = cleanup;
    else dispose(cleanup);
  }

  async function render() {
    if (destroyed) return;
    const generation = ++renderGeneration;
    deactivate();
    if (destroyed || generation !== renderGeneration) return;
    const controller = new AbortController();
    activeController = controller;
    const hash = window.location.hash;
    const routeContext = {
      signal: controller.signal,
      isCurrent: () => !destroyed && generation === renderGeneration
        && !controller.signal.aborted && window.location.hash === hash,
    };
    const parsed = parseHash(hash);
    const matched = matchRoute(routes, hash);
    const target = matched || (notFound ? { route: notFound, params: Object.create(null), query: parsed.query } : null);
    let settled = false;

    try {
      if (!target) throw new Error("No route matched and no 404 route is registered.");
      if (onRouteChange) onRouteChange({ ...target, path: parsed.path }, routeContext);
      if (!routeContext.isCurrent()) return;
      if (target.route.title) document.title = `${target.route.title} — CalBlue members`;
      setBusy(true);
      if (onLoading) onLoading(target, routeContext);
      if (!routeContext.isCurrent()) return;

      const access = getAccess() || {};
      if (!routeAllowed(target.route, access)) {
        if (onUnauthorized) {
          keepCleanup(await onUnauthorized(target, access, routeContext), routeContext);
          settled = true;
        } else {
          throw new Error("You do not have access to this screen.");
        }
      } else {
        if (!routeContext.isCurrent()) return;
        keepCleanup(await target.route.view(target.params, target.query, routeContext), routeContext);
        settled = true;
      }
    } catch (error) {
      // Only cancellation of this route is silent. An unrelated AbortError from
      // the current view still needs a visible error state instead of a spinner.
      if (!routeContext.isCurrent()) return;
      console.error(error);
      if (onError) {
        keepCleanup(await onError(error, routeContext), routeContext);
        settled = true;
      }
      else throw error;
    } finally {
      if (routeContext.isCurrent()) {
        setBusy(false);
        if (settled && typeof mountPoint?.focus === "function" && mountPoint.isConnected !== false) {
          mountPoint.focus({ preventScroll: true });
        }
      }
    }
  }

  // DOM event dispatch does not observe an async listener's rejected promise.
  const onHashChange = () => { render().catch((error) => console.error(error)); };
  window.addEventListener("hashchange", onHashChange);
  return {
    render,
    navigate(...args) {
      if (!destroyed) navigate(...args);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      renderGeneration += 1;
      deactivate();
      setBusy(false);
      window.removeEventListener("hashchange", onHashChange);
    },
  };
}
