// Shared application chrome and state views.

import { html, raw, mount } from "./dom.js";

export const NAV_ITEMS = [
  { href: "#/", path: "/", label: "Home" },
  { href: "#/games", path: "/games", label: "Games" },
  { href: "#/identity", path: "/identity", label: "My identity", auth: true },
  { href: "#/admin/verify", path: "/admin/verify", label: "Verify players", roles: ["admin"] },
  { href: "#/admin/payments", path: "/admin/payments", label: "Payments", roles: ["admin"] },
  { href: "#/admin/audit", path: "/admin/audit", label: "Audit log", roles: ["admin"] },
  { href: "#/admin/clubs", path: "/admin/clubs", label: "Clubs & teams", roles: ["admin"] },
];

export function visibleNavItems({ authenticated = false, roles = [] } = {}) {
  // Match the exact, typed JWT role array accepted by migration 0003.
  const available = new Set(Array.isArray(roles) && roles.every((role) => typeof role === "string") ? roles : []);
  return NAV_ITEMS.filter((item) => {
    if (item.auth && !authenticated) return false;
    if (!item.roles || item.roles.length === 0) return true;
    return authenticated && item.roles.some((role) => available.has(role));
  });
}

export function renderLayout({
  headerEl,
  navEl,
  footerEl,
  authenticated,
  roles,
  profile,
  session,
  currentPath = "/",
  supabaseConfigured,
  signInHref = "#/sign-in",
  refreshing = false,
  refreshMessage = "",
  refreshFailed = false,
  onRefreshAccess,
}) {
  const items = visibleNavItems({ authenticated, roles });
  const displayName = profile?.displayName
    || profile?.email
    || session?.user?.email
    || "Member";

  mount(headerEl, html`
    <div class="app-header-inner">
      <a class="app-brand" href="#/">CAL<span>BLUE</span> <small>members</small></a>
      <div class="app-session">
        ${authenticated
          ? html`<span class="app-user" title="${displayName}">${displayName}</span>
                 <a class="app-link app-link-action" href="#/sign-out">Sign out</a>`
          : html`<a class="app-link app-link-primary" href="${signInHref}">Sign in</a>`}
      </div>
    </div>
    ${!supabaseConfigured
      ? html`<div class="app-banner" role="status">
          Account services are not configured. Public app routes remain available;
          no demo login or private data is provided.
        </div>`
      : null}
  `);

  mount(navEl, html`
    <ul class="app-nav-list">
      ${items.map((item) => html`
        <li>
          <a href="${item.href}"${item.path === currentPath ? raw(' aria-current="page"') : null}>
            ${item.label}
          </a>
        </li>
      `)}
    </ul>
    ${!authenticated
      ? html`<p class="app-nav-hint">
          You are signed out. <a href="${signInHref}">Sign in with an email link</a>.
          Games and registration currently have placeholder screens.
        </p>`
      : html`<div class="app-nav-hint">
          <p>Role changes take effect when your access token refreshes. If an administrator changed your roles, refresh here.</p>
          <button class="app-button" type="button" data-refresh-access>Refresh my access</button>
          <p data-access-status role="${refreshFailed ? "alert" : "status"}" aria-live="polite">${refreshMessage}</p>
        </div>`}
  `);
  const refreshButton = navEl.querySelector("[data-refresh-access]");
  if (refreshButton) {
    refreshButton.disabled = refreshing;
    refreshButton.textContent = refreshing ? "Refreshing access…" : "Refresh my access";
    if (onRefreshAccess) refreshButton.addEventListener("click", onRefreshAccess);
  }

  mount(footerEl, html`
    <p>© CalBlue Soccer Club · <a href="../">Public site</a> · <a href="#/">Members home</a></p>
  `);
}

export function renderLoading(mainEl, message = "Loading…") {
  mount(mainEl, html`
    <div class="app-loading" role="status" aria-live="polite">
      <span class="app-spinner" aria-hidden="true"></span> ${message}
    </div>
  `);
}

export function renderError(mainEl, message) {
  mount(mainEl, html`
    <div class="app-error" role="alert">
      <strong>Something went wrong.</strong> ${message || "Please try again."}
    </div>
  `);
}

export function renderConnectionStatus(statusEl, { error, busy = false, onRetry } = {}) {
  if (!error && !busy) {
    statusEl.replaceChildren();
    statusEl.hidden = true;
    return;
  }
  statusEl.hidden = false;
  mount(statusEl, error ? html`
    <div class="app-error" role="alert">
      <p>Account services could not be loaded completely. Public app routes are still available.</p>
      <button class="app-button" type="button">Retry connection</button>
    </div>
  ` : html`<p class="app-muted" role="status">Checking your session…</p>`);
  const retry = statusEl.querySelector("button");
  if (retry && onRetry) retry.addEventListener("click", onRetry);
}

export function renderAccessDenied(mainEl, { authenticated, signInHref = "#/sign-in" } = {}) {
  mount(mainEl, html`
    <section class="app-state">
      <p class="app-eyebrow">Access</p>
      <h1>${authenticated ? "You do not have access" : "Sign in required"}</h1>
      <p>
        ${authenticated
          ? "Your current role does not permit this screen."
          : "Sign in to open this members-only screen."}
      </p>
      <p>
        <a class="app-link app-link-primary" href="${authenticated ? "#/" : signInHref}">
          ${authenticated ? "Back to members home" : "Go to sign in"}
        </a>
      </p>
    </section>
  `);
}

export function renderNotFound(mainEl) {
  mount(mainEl, html`
    <section class="app-state">
      <p class="app-eyebrow">404</p>
      <h1>Page not found</h1>
      <p>That route does not exist in the members app.</p>
      <p><a class="app-link app-link-primary" href="#/">Back to members home</a></p>
    </section>
  `);
}
