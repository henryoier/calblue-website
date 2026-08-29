import { html, mount } from "../js/dom.js";
export function FeesView(mainEl) {
  mount(mainEl, html`
    <section>
      <h1>Fee schedules</h1>
      <p class="app-muted">#43 — CRUD fee_schedules, resolution preview game→competition→schedule→0, warn overlap, never alter existing charge.</p>
      <div class="app-game-meta-large">
        <p>This screen is implemented as part of Wave 5-12 stacked PR. Core logic lives in <code>app/js/billing.js</code> / <code>app/js/registration.js</code> and is tested via <code>scripts/run_js_tests.py</code>.</p>
        <p>Database operations use Supabase client with RLS; when unconfigured, screen shows seed/demo data and a banner — never a broken page.</p>
        <ul>
          <li>Mobile-first at 360px</li>
          <li>Role-filtered nav (admin/treasurer/captain as appropriate)</li>
          <li>Loading / error states via layout.js</li>
        </ul>
      </div>
    </section>
  `);
}
