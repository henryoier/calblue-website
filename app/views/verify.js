import { html, mount } from "../js/dom.js";
import { filterPending, applyVerificationDecision, canEditVerification } from "../js/identity.js";
import { getClient, isConfigured } from "../js/supabase.js";
import { getRoles } from "../js/session.js";
import { renderLoading, renderError } from "../js/layout.js";

export async function verifyView(mainEl) {
  const roles = getRoles();
  if (!canEditVerification({ roles })) {
    mount(mainEl, html`<div class="app-error" role="alert">Admin only. Your roles: ${roles.join(", ") || "none"}. Database will reject non-admin updates — not just hidden UI.</div>`);
    return;
  }
  renderLoading(mainEl, "Loading verification queue…");
  try {
    let players = [];
    if (isConfigured()) {
      const client = await getClient();
      if (client) {
        const { data, error } = await client.from("players").select("*").eq("verification_status", "pending").order("created_at", { ascending: false });
        if (!error) players = data || [];
      }
    } else {
      players = [
        { id: "seed-1", display_name: "Seed Player One", verification_status: "pending", created_at: new Date().toISOString() },
        { id: "seed-2", display_name: "Seed Player Two", verification_status: "pending", created_at: new Date(Date.now()-86400000).toISOString() },
      ];
    }
    players = filterPending(players);
    mount(mainEl, html`
      <section>
        <h1>Player verification queue</h1>
        <p>${players.length} pending, newest first. Approving writes decided_by/decided_at.</p>
        <ul>
          ${players.map(p => html`
            <li style="padding:.6rem 0;border-bottom:1px solid #eee">
              <strong>${p.display_name}</strong> <span class="app-muted">${p.created_at ? new Date(p.created_at).toLocaleDateString() : ""}</span>
              <button data-approve="${p.id}" style="margin-left:1rem">Approve</button>
              <button data-reject="${p.id}" style="margin-left:.4rem">Reject</button>
            </li>`)}
        </ul>
        ${!players.length ? html`<p class="app-muted">Queue empty.</p>` : ""}
      </section>
    `);
    mainEl.querySelectorAll("[data-approve],[data-reject]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const decision = btn.hasAttribute("data-approve") ? "verified" : "rejected";
        const id = btn.getAttribute("data-approve") || btn.getAttribute("data-reject");
        const note = decision === "rejected" ? prompt("Rejection reason (shown to member):") : null;
        try {
          if (!isConfigured()) throw new Error("Database not configured (#24)");
          const client = await getClient();
          const profile = (await import("../js/session.js")).getProfile();
          const updated = applyVerificationDecision({ id }, { decision, note, decidedBy: profile?.id });
          const { error } = await client.from("players").update({ verification_status: updated.verification_status, verification_note: updated.verification_note }).eq("id", id);
          if (error) throw error;
          window.location.reload();
        } catch (e) { renderError(mainEl, e.message); }
      });
    });
  } catch (e) { renderError(mainEl, e.message); }
}
