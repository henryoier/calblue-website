import { html, mount } from "../js/dom.js";

export function placeholderView(mainEl, { eyebrow, title, description, issue }) {
  mount(mainEl, html`
    <section class="app-state">
      <p class="app-eyebrow">${eyebrow}</p>
      <h1>${title}</h1>
      <p>${description}</p>
      <p class="app-muted">This route is reserved for issue #${issue} and can now land without changing the app shell.</p>
    </section>
  `);
}
