import { html, mount } from "../js/dom.js";
// Placeholder — full magic-link flow lands in #30, stacked on this PR.
export function signInView(mainEl) {
  mount(mainEl, html`
    <section>
      <h1>Sign in</h1>
      <p>Magic-link sign-in, session persistence and profile bootstrap are implemented in issue #30.</p>
      <p>This placeholder exists so the app shell (#29) has a route to link to, and so #30 has a clear place to land.</p>
    </section>
  `);
}
