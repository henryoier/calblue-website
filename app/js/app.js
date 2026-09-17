// App-shell composition. Dependencies can be injected for browser-only tests;
// production always uses the configured SDK and the single session store.
import { getClient, isConfigured } from "./supabase.js";
import * as defaultSession from "./session.js";
import { createRouter, navigate } from "./router.js";
import { renderLayout, renderLoading, renderError, renderAccessDenied, renderConnectionStatus } from "./layout.js";
import { homeView } from "../views/home.js";
import { notFoundView } from "../views/not-found.js";
import { signInView } from "../views/sign-in.js";
import { placeholderView } from "../views/placeholder.js";

export function createApp({ root = document, session = defaultSession, loadClient = getClient, configured = isConfigured } = {}) {
  const headerEl = root.querySelector("#app-header");
  const navEl = root.querySelector("#app-nav");
  const mainEl = root.querySelector("#app");
  const footerEl = root.querySelector("#app-footer");
  const statusEl = root.querySelector("#app-status");
  const skipLink = root.querySelector("#app-skip");
  if (![headerEl, navEl, mainEl, footerEl, statusEl].every(Boolean)) {
    throw new Error("Missing app-shell landmarks.");
  }

  let client = null;
  let currentPath = "/";
  let destroyed = false;
  let initialized = false;
  let busy = false;
  let startupError = null;
  let starting = null;
  let signingOut = false;
  let signOutRequest = null;
  let didSignOut = false;

  const placeholder = (details) => () => placeholderView(mainEl, details);
  const routes = [
    { pattern: "/", title: "Home", view: () => homeView(mainEl, {
      profile: session.getProfile(), roles: session.getRoles(),
      authenticated: session.isAuthenticated(), session: session.getSession(),
    }) },
    { pattern: "/sign-in", title: "Sign in", view: (_params, query) => signInView(mainEl, {
      authenticated: session.isAuthenticated(), signedOut: didSignOut && query.signedOut === "1",
    }) },
    { pattern: "/sign-out", title: "Sign out", auth: true, view: async (_params, _query, context) => {
      signingOut = true;
      try {
        // A session event may rerender this route while the request is pending.
        if (!signOutRequest) signOutRequest = session.signOut(client);
        await signOutRequest;
        if (context.isCurrent() && !session.isAuthenticated()) {
          didSignOut = true;
          navigate("/sign-in", {}, { signedOut: "1" });
        }
      } finally { signingOut = false; signOutRequest = null; }
    } },
    { pattern: "/games", title: "Games", view: placeholder({
      eyebrow: "Schedule", title: "Games", description: "Published fixtures and pickup sessions will live here.", issue: 34,
    }) },
    { pattern: "/identity", title: "My identity", auth: true, view: placeholder({
      eyebrow: "Member profile", title: "My identity", description: "Player details, verification, and guardian relationships will live here.", issue: 31,
    }) },
    { pattern: "/admin/verify", title: "Verify players", auth: true, roles: ["admin"], view: placeholder({
      eyebrow: "Administration", title: "Verify players", description: "Identity review will live here.", issue: 32,
    }) },
    // These operational routes follow released RLS, not aspirational role names.
    // Treasurer/developer roles alone do not grant club-wide finances or audit.
    { pattern: "/admin/payments", title: "Payments", auth: true, roles: ["admin"], view: placeholder({
      eyebrow: "Finance", title: "Payments", description: "Payment recording and reconciliation will live here.", issue: 44,
    }) },
    { pattern: "/admin/audit", title: "Audit log", auth: true, roles: ["admin"], view: placeholder({
      eyebrow: "Administration", title: "Audit log", description: "Review of sensitive member-platform changes will live here.", issue: 51,
    }) },
    { pattern: "/admin/clubs", title: "Clubs and teams", auth: true, roles: ["admin"], view: placeholder({
      eyebrow: "Administration", title: "Clubs & teams", description: "Club, team, and venue management will live here.", issue: 52,
    }) },
    { pattern: "*", title: "Not found", view: () => notFoundView(mainEl) },
  ];

  function updateChrome() {
    if (destroyed) return;
    renderLayout({ headerEl, navEl, footerEl, currentPath,
      authenticated: session.isAuthenticated(), roles: session.getRoles(),
      profile: session.getProfile(), session: session.getSession(), supabaseConfigured: configured(),
    });
    renderConnectionStatus(statusEl, {
      error: startupError || session.getSessionError(), busy,
      onRetry: () => { void start(); },
    });
  }

  const router = createRouter({
    routes, mountPoint: mainEl,
    getAccess: () => ({ authenticated: session.isAuthenticated(), roles: session.getRoles() }),
    onRouteChange: ({ path }) => { currentPath = path; updateChrome(); },
    onLoading: () => renderLoading(mainEl),
    onError: () => renderError(mainEl, "This screen could not load. Try another route or reload the page."),
    onUnauthorized: (_target, access) => renderAccessDenied(mainEl, access),
  });

  const unsubscribe = session.onSessionChange(() => {
    if (destroyed) return;
    if (session.isAuthenticated()) didSignOut = false;
    updateChrome();
    if (!initialized) return; // Resolve the saved session before showing a guard.
    // Let the in-flight sign-out view finish its own redirect. Every other
    // screen rechecks access immediately, even when profile loading fails.
    if (!(signingOut && currentPath === "/sign-out" && !session.isAuthenticated())) {
      void router.render();
    }
  });
  const skipToContent = (event) => {
    event.preventDefault(); // #app is a DOM anchor, not an application route.
    mainEl.focus();
  };
  if (skipLink) skipLink.addEventListener("click", skipToContent);

  function start() {
    if (destroyed) return Promise.resolve();
    if (starting) return starting;
    busy = true;
    startupError = null;
    updateChrome();
    if (!initialized) renderLoading(mainEl, "Starting members app…");
    starting = (async () => {
      try {
        const loaded = await loadClient();
        if (destroyed) return;
        client = loaded;
        await session.initSession(client);
      } catch (error) {
        if (destroyed) return;
        startupError = error;
        client = null;
        await session.initSession(null);
      } finally {
        if (!destroyed) {
          initialized = true;
          busy = false;
          updateChrome();
          await router.render();
        }
        starting = null;
      }
    })();
    return starting;
  }

  function destroy() {
    destroyed = true;
    unsubscribe();
    router.destroy();
    session.disposeSession();
    if (skipLink) skipLink.removeEventListener("click", skipToContent);
  }

  return { start, destroy };
}
