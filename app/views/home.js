import { html, mount } from "../js/dom.js";

export function homeView(mainEl, { profile, roles, authenticated, session }) {
  const displayName = profile?.displayName || profile?.email || session?.user?.email || "Member";
  mount(mainEl, html`
    <section class="app-home">
      <p class="app-eyebrow">Team operations</p>
      <h1>Members home</h1>
      <p>One place for CalBlue identities, registrations, check-in, and billing.</p>
      ${authenticated
        ? html`<p>Signed in as <strong>${displayName}</strong>. Roles: ${roles.join(", ") || "none assigned"}.</p>`
        : html`<p><a class="app-link app-link-primary" href="#/sign-in">Sign in with a magic link</a></p>`}
      <ul class="app-home-links">
        <li><a href="#/games">Browse games</a> — #34</li>
        ${authenticated ? html`<li><a href="#/identity">Manage my identity</a> — #31</li>` : null}
      </ul>
    </section>
  `);
}
