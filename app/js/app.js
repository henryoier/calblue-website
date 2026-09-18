// App-shell composition. Dependencies can be injected for browser-only tests;
// production always uses the configured SDK and the single session store.
import { getClient, isConfigured } from "./supabase.js";
import { createAuthFlow, safeReturnTo } from "./auth.js";
import { createIdentityService } from "./identity.js";
import { createVerificationService } from "./verification.js";
import * as defaultSession from "./session.js";
import { createRouter, navigate, buildHash } from "./router.js";
import { renderLayout, renderLoading, renderError, renderAccessDenied, renderConnectionStatus } from "./layout.js";
import { homeView } from "../views/home.js";
import { notFoundView } from "../views/not-found.js";
import { signInView } from "../views/sign-in.js";
import { identityView } from "../views/identity.js";
import { verificationView } from "../views/verification.js";
import { placeholderView } from "../views/placeholder.js";

export function createApp({ root = document, session = defaultSession, loadClient = getClient,
  configured = isConfigured, authFlow = createAuthFlow(), createIdentity = createIdentityService,
  createVerification = createVerificationService } = {}) {
  // Creating the flow captures and removes callback credentials BEFORE getClient.
  // auth-js 2.65.0 can auto-exchange PKCE even with detectSessionInUrl: false.
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
  let callbackHandled = false;
  let callbackError = "";
  let refreshing = false;
  let refreshMessage = "";
  let refreshFailed = false;
  let accessGeneration = 0;
  let accessAccount = session.getSession()?.user?.id || null;
  let navigationGeneration = 0;
  let activeIdentity = null;
  let activeVerification = null;
  const recordNavigation = () => { navigationGeneration += 1; };
  window.addEventListener("hashchange", recordNavigation);

  const signInHref = () => buildHash("/sign-in", {}, { returnTo: safeReturnTo(window.location.hash) });

  const placeholder = (details) => () => placeholderView(mainEl, details);

  function identityIsCurrent() {
    return Boolean(activeIdentity && currentPath === "/identity"
      && activeIdentity.context.isCurrent() && activeIdentity.client === client
      && session.isAuthenticated()
      && activeIdentity.accountId === session.getSession()?.user?.id);
  }

  function renderIdentity(_params, _query, context) {
    const accountId = session.getSession()?.user?.id;
    const identityClient = client;
    activeIdentity = { accountId, client: identityClient, context };
    const service = createIdentity({ client: identityClient, accountId,
      isCurrent: () => context.isCurrent() && client === identityClient
        && session.isAuthenticated() && session.getSession()?.user?.id === accountId,
    });
    return identityView(mainEl, { service, context });
  }

  function verificationIsCurrent() {
    return Boolean(activeVerification && currentPath === "/admin/verify"
      && activeVerification.context.isCurrent());
  }

  function renderVerification(_params, _query, context) {
    const accountId = session.getSession()?.user?.id;
    const verificationClient = client;
    // Both view and service recheck admin access, including during a same-account
    // token refresh. An account switch or revoked role invalidates private work.
    const adminContext = { ...context, isCurrent: () => context.isCurrent()
      && client === verificationClient && session.isAuthenticated()
      && session.getSession()?.user?.id === accountId && session.getRoles().includes("admin") };
    activeVerification = { context: adminContext };
    const service = createVerification({ client: verificationClient, isCurrent: adminContext.isCurrent });
    return verificationView(mainEl, { service, context: adminContext });
  }

  const routes = [
    { pattern: "/", title: "Home", view: () => homeView(mainEl, {
      profile: session.getProfile(), roles: session.getRoles(),
      authenticated: session.isAuthenticated(), session: session.getSession(),
    }) },
    { pattern: "/sign-in", title: "Sign in", view: (_params, query, context) => signInView(mainEl, {
      authenticated: session.isAuthenticated(), signedOut: didSignOut && query.signedOut === "1",
      returnTo: safeReturnTo(query.returnTo), callbackError, context,
      available: Boolean(client) && !busy,
      requestLink: async (email) => {
        const result = await authFlow.requestLink(client, email, safeReturnTo(query.returnTo));
        callbackError = "";
        return result;
      },
    }) },
    { pattern: "/sign-out", title: "Sign out", auth: true, view: async (_params, _query, context) => {
      signingOut = true;
      try {
        // A session event may rerender this route while the request is pending.
        if (!signOutRequest) signOutRequest = session.signOut(client);
        await signOutRequest;
        if (!session.isAuthenticated()) authFlow.clearPending();
        if (context.isCurrent() && !session.isAuthenticated()) {
          didSignOut = true;
          navigate("/sign-in", {}, { signedOut: "1" });
        }
      } finally { signingOut = false; signOutRequest = null; }
    } },
    { pattern: "/games", title: "Games", view: placeholder({
      eyebrow: "Schedule", title: "Games", description: "Published fixtures and pickup sessions will live here.", issue: 34,
    }) },
    { pattern: "/identity", title: "My identity", auth: true, view: renderIdentity },
    { pattern: "/admin/verify", title: "Verify players", auth: true, roles: ["admin"], view: renderVerification },
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
      signInHref: signInHref(), refreshing, refreshMessage, refreshFailed,
      onRefreshAccess: () => { void refreshAccess(); },
    });
    renderConnectionStatus(statusEl, {
      error: startupError || session.getSessionError(), busy,
      onRetry: () => { void start(); },
    });
  }

  const router = createRouter({
    routes, mountPoint: mainEl,
    getAccess: () => ({ authenticated: session.isAuthenticated(), roles: session.getRoles() }),
    onRouteChange: ({ path }) => {
      currentPath = path;
      if (path !== "/identity") activeIdentity = null;
      if (path !== "/admin/verify") activeVerification = null;
      updateChrome();
    },
    onLoading: () => renderLoading(mainEl),
    onError: () => renderError(mainEl, "This screen could not load. Try another route or reload the page."),
    onUnauthorized: (_target, access) => renderAccessDenied(mainEl, { ...access, signInHref: signInHref() }),
  });

  const unsubscribe = session.onSessionChange(() => {
    if (destroyed) return;
    if (session.isAuthenticated()) didSignOut = false;
    const nextAccount = session.getSession()?.user?.id || null;
    if (!session.isAuthenticated() || nextAccount !== accessAccount) {
      accessGeneration += 1;
      refreshing = false;
      refreshMessage = "";
      refreshFailed = false;
    }
    accessAccount = nextAccount;
    updateChrome();
    if (!initialized) return; // Resolve the saved session before showing a guard.
    // A same-account token/profile refresh must not destroy an unfinished
    // identity form. This route needs authentication, not a particular role;
    // its personal queries stay explicitly scoped and RLS is authoritative.
    // Account changes/sign-out still invalidate the private view immediately.
    // Verification drafts survive refresh only while the admin claim remains.
    if (!identityIsCurrent() && !verificationIsCurrent()
        && !(signingOut && currentPath === "/sign-out" && !session.isAuthenticated())) {
      void router.render();
    }
  });
  const skipToContent = (event) => {
    event.preventDefault(); // #app is a DOM anchor, not an application route.
    mainEl.focus();
  };
  if (skipLink) skipLink.addEventListener("click", skipToContent);

  async function refreshAccess() {
    if (refreshing || busy || signingOut || !client || !session.isAuthenticated()) return;
    const accountId = session.getSession()?.user?.id;
    const generation = ++accessGeneration;
    refreshing = true;
    refreshMessage = "Refreshing your access…";
    refreshFailed = false;
    updateChrome();
    const isCurrent = () => !destroyed && generation === accessGeneration
      && session.isAuthenticated() && session.getSession()?.user?.id === accountId;
    try {
      await session.refreshAccess(client);
      if (!isCurrent()) return;
      if (session.getSessionError()) throw new Error("Session refresh did not complete.");
      refreshMessage = "Access refreshed. Your navigation now reflects your current roles.";
    } catch (_) {
      if (!isCurrent()) return;
      refreshFailed = true;
      refreshMessage = "Your access could not be refreshed. Check your connection and try again, or sign out and sign in again.";
    } finally {
      if (isCurrent()) {
        refreshing = false;
        updateChrome();
        if (!identityIsCurrent() && !verificationIsCurrent()) await router.render();
      }
    }
  }

  function start() {
    if (destroyed) return Promise.resolve();
    if (starting) return starting;
    busy = true;
    startupError = null;
    updateChrome();
    if (!initialized) renderLoading(mainEl, "Starting members app…");
    starting = (async () => {
      const requestedHash = window.location.hash;
      const requestedNavigation = navigationGeneration;
      try {
        authFlow.assertSafeToLoad();
        const loaded = await loadClient();
        if (destroyed) return;
        client = loaded;
        if (!callbackHandled) {
          const result = await authFlow.completeCallback(client);
          if (destroyed) return;
          if (result.handled) {
            callbackHandled = true;
            callbackError = result.error ? { code: result.code } : "";
            // A deliberate navigation while loading must not be overwritten.
            if (window.location.hash === requestedHash && navigationGeneration === requestedNavigation) {
              const returnTo = safeReturnTo(result.returnTo);
              const hash = result.error ? buildHash("/sign-in", {}, { returnTo }) : returnTo;
              window.history.replaceState(null, "", hash);
            }
          }
        }
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
    activeIdentity = null;
    activeVerification = null;
    unsubscribe();
    router.destroy();
    window.removeEventListener("hashchange", recordNavigation);
    session.disposeSession();
    if (skipLink) skipLink.removeEventListener("click", skipToContent);
  }

  return { start, destroy };
}
