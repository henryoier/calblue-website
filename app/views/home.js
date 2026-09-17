import { html, mount } from "../js/dom.js";

export function homeView(mainEl, { profile, roles, authenticated, session }) {
  const displayName = profile?.displayName || profile?.email || session?.user?.email || "Member";
  mount(mainEl, html`
    <section class="app-home">
      <p class="app-eyebrow">Team operations</p>
      <h1>Members home</h1>
      <p>The foundation for CalBlue identities, registrations, check-in, and billing.</p>
      <p>Email sign-in and session-aware access are ready. The member workflows below are not available yet.</p>
      ${authenticated
        ? html`<p>Signed in as <strong>${displayName}</strong>. Roles: ${roles.join(", ") || "none assigned"}.</p>`
        : html`<p><a class="app-link app-link-primary" href="#/sign-in">Sign in with an email link</a> — no password needed.</p>`}
      ${authenticated && profile?.isEmpty
        ? html`<p>Your account is ready. It does not have a display name yet, so we use your email for now.
            Editing your player details will be available in My identity (issue #31).</p>` : null}
      <ul class="app-home-links">
        <li><a href="#/games">Games</a> — placeholder for issue #34</li>
        ${authenticated ? html`<li><a href="#/identity">My identity</a> — placeholder for issue #31</li>` : null}
      </ul>
    </section>
  `);
}
