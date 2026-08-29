import { html, mount } from "../js/dom.js";

export function homeView(mainEl, { profile, roles }) {
  const signedIn = Boolean(profile);
  mount(mainEl, html`
    <section class="app-home">
      <h1>Members home</h1>
      <p>Welcome to the CalBlue members app. This is the shell from #29; individual screens land in their own issues, stacked on this PR.</p>
      ${signedIn
        ? html`<p>Signed in as <strong>${profile.displayName || profile.email}</strong>. Roles: ${roles.join(", ") || "none"}.</p>`
        : html`<p><a class="app-link app-link-primary" href="#/sign-in">Sign in with a magic link</a> — implemented in #30.</p>`}
      <ul class="app-home-links">
        <li><a href="#/games">Browse games</a> — #34</li>
        <li><a href="#/identity">My identity</a> — #31</li>
      </ul>
    </section>
  `);
}
