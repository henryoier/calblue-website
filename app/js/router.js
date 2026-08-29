// Hash router — no server rewrites needed, works on GitHub Pages.
//
// Routes are registered as { pattern, view, title, roles?, nav? }.
// Pattern syntax: "#/games/:id" — segments starting with ":" are params.
//
// Pure logic (parseHash, matchRoute, buildHash) is DOM-free and tested
// under JavaScriptCore via scripts/run_js_tests.py.

export function parseHash(hash) {
  const raw = (hash || "").replace(/^#/, "") || "/";
  const [path, queryString] = raw.split("?");
  const segments = path.split("/").filter(Boolean);
  const query = {};
  if (queryString) {
    for (const pair of queryString.split("&")) {
      const [k, v] = pair.split("=");
      if (k) query[decodeURIComponent(k)] = decodeURIComponent(v || "");
    }
  }
  return { path: "/" + segments.join("/"), segments, query };
}

export function matchRoute(routes, hash) {
  const { segments, query } = parseHash(hash);
  for (const route of routes) {
    const patternSegments = route.pattern.split("/").filter(Boolean);
    if (patternSegments.length !== segments.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < patternSegments.length; i++) {
      const pat = patternSegments[i];
      if (pat.startsWith(":")) {
        params[pat.slice(1)] = decodeURIComponent(segments[i]);
      } else if (pat !== segments[i]) {
        ok = false; break;
      }
    }
    if (ok) return { route, params, query };
  }
  return null;
}

export function buildHash(pattern, params = {}, query = {}) {
  let path = pattern;
  for (const [k, v] of Object.entries(params)) {
    path = path.replace(`:${k}`, encodeURIComponent(v));
  }
  const qs = Object.entries(query).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  return `#${path.startsWith("/") ? path : "/" + path}${qs ? "?" + qs : ""}`;
}

export function navigate(pattern, params, query) {
  window.location.hash = buildHash(pattern, params, query);
}

// --- Live router (browser) ---

export function createRouter({ routes, mountPoint, onRouteChange }) {
  const notFound = routes.find((r) => r.pattern === "*") || null;

  async function render() {
    const match = matchRoute(routes.filter((r) => r.pattern !== "*"), window.location.hash);
    const target = match || (notFound ? { route: notFound, params: {}, query: {} } : null);
    if (!target) {
      mountPoint.innerHTML = "<p>404 — no route matched and no not-found view is registered.</p>";
      return;
    }
    if (onRouteChange) onRouteChange(target);
    try {
      const result = await target.route.view(target.params, target.query);
      if (result && typeof result === "object" && "then" in result) await result;
    } catch (err) {
      console.error(err);
      mountPoint.innerHTML = "";
      const div = document.createElement("div");
      div.className = "app-error";
      div.textContent = `Something went wrong loading this screen: ${err.message || err}`;
      mountPoint.appendChild(div);
    }
  }

  window.addEventListener("hashchange", render);
  return { render, navigate };
}
