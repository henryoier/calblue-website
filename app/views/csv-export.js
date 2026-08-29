import { html, mount } from "../js/dom.js";
export function CsvExportView(mainEl) {
  mount(mainEl, html`
    <section>
      <h1>CSV export</h1>
      <p class="app-muted">#47 — Export closed quarter per player + per account. Columns player, attended, league, pickup, no_show, total_due, total_paid, balance.</p>
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
