// Shared application chrome and state views.

import { html, raw, mount } from "./dom.js";

export const NAV_ITEMS = [
  { href: "#/", path: "/", label: "Home" },
  { href: "#/games", path: "/games", label: "Games" },
  { href: "#/identity", path: "/identity", label: "My identity", auth: true },
  { href: "#/admin/verify", path: "/admin/verify", label: "Verify players", roles: ["admin"] },
  { href: "#/admin/payments", path: "/admin/payments", label: "Payments", roles: ["admin", "treasurer"] },
  { href: "#/admin/audit", path: "/admin/audit", label: "Audit log", roles: ["admin", "developer"] },
  { href: "#/admin/clubs", path: "/admin/clubs", label: "Clubs & teams", roles: ["admin"] },
];

export function visibleNavItems({ authenticated = false, roles = [] } = {}) {
  const available = new Set(roles.map((role) => String(role).toLowerCase()));
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
          : html`<a class="app-link app-link-primary" href="#/sign-in">Sign in</a>`}
      </div>
    </div>
    ${!supabaseConfigured
      ? html`<div class="app-banner" role="status">
          Database not configured yet — running in offline/demo mode.
          <code>app/config.js</code> contains the setup placeholders.
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
          Signed-out visitors can browse published games.
          <a href="#/sign-in">Sign in</a> to register.
        </p>`
      : null}
  `);

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

export function renderAccessDenied(mainEl, { authenticated } = {}) {
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
        <a class="app-link app-link-primary" href="${authenticated ? "#/" : "#/sign-in"}">
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
