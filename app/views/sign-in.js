import { html, mount } from "../js/dom.js";
import { validateEmail, redirectUrlFor, saveIntendedRoute, parseAuthCallback } from "../js/auth.js";
import { getClient, isConfigured } from "../js/supabase.js";
import { getProfile, getRoles, refreshAccess } from "../js/session.js";
import { renderError } from "../js/layout.js";

export function signInView(mainEl, { intendedRoute } = {}) {
  const callback = parseAuthCallback(window.location.hash);
  const profile = getProfile();
  if (profile) {
    mount(mainEl, html`
      <section>
        <h1>Signed in</h1>
        <p>As <strong>${profile.displayName || profile.email}</strong> — roles: ${getRoles().join(", ") || "none"}.</p>
        <p class="app-muted">Role changes by an admin take effect on the next token refresh. Use “Refresh my access” if you were just promoted.</p>
        <p>
          <button id="refresh-access" class="app-link app-link-primary">Refresh my access</button>
          <a href="#/sign-out" class="app-link">Sign out</a>
        </p>
      </section>
    `);
    const btn = mainEl.querySelector("#refresh-access");
    if (btn) btn.addEventListener("click", async () => {
      try {
        const client = await getClient();
        await refreshAccess(client);
        window.location.reload();
      } catch (e) { renderError(mainEl, e.message || String(e)); }
    });
    return;
  }

  mount(mainEl, html`
    <section class="app-signin">
      <h1>Sign in</h1>
      ${callback.error ? html`<div class="app-error" role="alert"><strong>That link did not work:</strong> ${callback.error} <br><br>Request a new link below.</div>` : ""}
      <p>Enter your email and we will send a magic link. No password needed.</p>
      ${!isConfigured() ? html`<div class="app-banner">Database not configured yet (#24) — sign-in will not send until <code>app/config.js</code> is filled in.</div>` : ""}
      <form id="signin-form" novalidate>
        <label>Email<br><input type="email" name="email" required autocomplete="email" style="width:100%;max-width:24rem;padding:.6rem;margin:.4rem 0"></label><br>
        <button type="submit" class="app-link app-link-primary" style="border:none;cursor:pointer;padding:.6rem 1.2rem">Send magic link</button>
        <span id="signin-status" role="status" aria-live="polite" style="margin-left:.8rem"></span>
      </form>
    </section>
  `);

  const form = mainEl.querySelector("#signin-form");
  const status = mainEl.querySelector("#signin-status");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = new FormData(form).get("email");
    if (!validateEmail(email)) { status.textContent = "Enter a valid email."; return; }
    saveIntendedRoute(window.sessionStorage, intendedRoute || window.location.hash.replace(/^#/, "") || "/");
    status.textContent = "Sending…";
    try {
      if (!isConfigured()) throw new Error("Database not configured — see app/config.js (#24)");
      const client = await getClient();
      const redirectTo = redirectUrlFor({ origin: window.location.origin, intendedRoute: intendedRoute || "/", basePath: "/app/" });
      const { error } = await client.auth.signInWithOtp({ email, options: { emailRedirectTo: redirectTo } });
      if (error) throw error;
      status.textContent = "Check your email — link sent.";
      form.reset();
    } catch (err) {
      status.textContent = "";
      renderError(mainEl, err.message || String(err));
    }
  });
}

export function signOutView(mainEl) {
  mount(mainEl, html`<p>Signing out…</p>`);
  (async () => {
    try {
      const client = await getClient();
      const { signOut } = await import("../js/session.js");
      await signOut(client);
    } finally {
      window.location.hash = "#/";
    }
  })();
}
