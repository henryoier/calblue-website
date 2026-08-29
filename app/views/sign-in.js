import { html, mount } from "../js/dom.js";

// Placeholder — the full magic-link form lands in #30 on this stable route.
export function signInView(mainEl, { authenticated = false, signedOut = false } = {}) {
  mount(mainEl, html`
    <section class="app-state">
      <p class="app-eyebrow">Account access</p>
      <h1>Sign in</h1>
      ${signedOut ? html`<p class="app-success" role="status">You have been signed out.</p>` : null}
      ${authenticated
        ? html`<p>You are already signed in. <a href="#/">Return to members home</a>.</p>`
        : html`<p>Magic-link sign-in lands in issue #30. This route is ready for that form.</p>`}
    </section>
  `);
}
