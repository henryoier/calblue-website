import { html, mount } from "../js/dom.js";

export function placeholderView(mainEl, { eyebrow, title, description, issue }) {
  mount(mainEl, html`
    <section class="app-state">
      <p class="app-eyebrow">${eyebrow}</p>
      <h1>${title}</h1>
      <p>${description}</p>
      <p class="app-muted">Not available yet. This is a placeholder for issue #${issue}; it does not read or change these records.</p>
    </section>
  `);
}
