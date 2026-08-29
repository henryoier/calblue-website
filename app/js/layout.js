// Layout chrome — header, nav, footer — reflecting signed-in roles.
//
// Nav shows only what current roles permit; signed-out users see a
// sign-in prompt. Mobile-first at 360px (the check-in case).

import { html, raw, mount } from "./dom.js";
import { getRoles, hasAnyRole } from "./session.js";

export const NAV_ITEMS = [
  { href: "#/", label: "Home", roles: [] },
  { href: "#/games", label: "Games", roles: [] },
  { href: "#/identity", label: "My identity", roles: ["player", "coach", "admin", "treasurer", "developer"] },
  { href: "#/admin/verify", label: "Verify players", roles: ["admin"] },
  { href: "#/admin/payments", label: "Payments", roles: ["admin", "treasurer"] },
  { href: "#/admin/audit", label: "Audit log", roles: ["admin", "developer"] },
  { href: "#/admin/clubs", label: "Clubs & teams", roles: ["admin"] },
];

export function visibleNavItems(roles) {
  return NAV_ITEMS.filter((item) => !item.roles.length || hasAnyRole(roles, item.roles));
}

export function renderLayout({ headerEl, navEl, footerEl, roles, profile, supabaseConfigured }) {
  const items = visibleNavItems(roles || []);
  const signedIn = Boolean(profile || (roles && roles.length));
  const displayName = profile?.displayName || profile?.email || "";

  mount(headerEl, html`
    <div class="app-header-inner">
      <a class="app-brand" href="#/">CAL<span>BLUE</span> <small>members</small></a>
      <div class="app-session">
        ${signedIn
          ? html`<span class="app-user">${displayName}</span>
                 <a class="app-link" href="#/sign-out">Sign out</a>`
          : html`<a class="app-link app-link-primary" href="#/sign-in">Sign in</a>`}
      </div>
    </div>
    ${!supabaseConfigured ? raw(`<div class="app-banner" role="status">Database not configured yet — running in offline/demo mode. See <code>app/config.js</code> (#24).</div>`) : raw("")}
  `);

  mount(navEl, html`
    <ul class="app-nav-list">
      ${items.map((item) => html`<li><a href="${item.href}">${item.label}</a></li>`)}
    </ul>
    ${!signedIn ? raw(`<p class="app-nav-hint">Signed-out visitors can browse published games. <a href="#/sign-in">Sign in</a> to register.</p>`) : raw("")}
  `);

  mount(footerEl, html`
    <p>© CalBlue Soccer Club · <a href="../">Public site</a> · <a href="#/">Members home</a></p>
  `);
}

export function renderLoading(mainEl, message = "Loading…") {
  mount(mainEl, html`<div class="app-loading" role="status" aria-live="polite"><span class="app-spinner" aria-hidden="true"></span> ${message}</div>`);
}

export function renderError(mainEl, message) {
  mount(mainEl, html`<div class="app-error" role="alert"><strong>Something went wrong.</strong> ${message}</div>`);
}

export function renderNotFound(mainEl) {
  mount(mainEl, html`
    <section class="app-not-found">
      <h1>404 — not found</h1>
      <p>That route does not exist in the members app.</p>
      <p><a class="app-link app-link-primary" href="#/">Back to members home</a></p>
    </section>
  `);
}
