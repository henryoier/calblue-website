import { html, mount } from "../js/dom.js";
import { checkIn, finaliseGame } from "../js/registration.js";
import { getClient, isConfigured } from "../js/supabase.js";
import { renderLoading, renderError } from "../js/layout.js";

export async function checkInView(mainEl, { gameId }) {
  renderLoading(mainEl, "Loading squad for check-in…");
  try {
    let regs = [];
    if (isConfigured()) {
      const client = await getClient();
      if (client) {
        const { data } = await client.from("game_registrations").select("*, players(display_name)").eq("game_id", gameId).eq("status", "registered");
        regs = data || [];
      }
    } else {
      regs = [{ id:"s1", player_id:"p1", status:"registered", jersey_number:10, players:{display_name:"Seed One"} }];
    }
    mount(mainEl, html`
      <section>
        <h1>Check-in — game ${gameId}</h1>
        <p class="app-muted">Mobile-first at 360px. Toggle attended, adjust final #/position.</p>
        <ul>
          ${regs.map(r => html`
            <li style="padding:.6rem 0;border-bottom:1px solid #eee">
              <strong>#${r.jersey_number ?? "—"} ${r.players?.display_name || r.player_id}</strong>
              <button data-checkin="${r.id}" style="margin-left:1rem">Attended</button>
              <button data-noshow="${r.id}" style="margin-left:.4rem">No-show</button>
            </li>`)}
        </ul>
        <p><button id="finalise" class="app-link app-link-primary" style="border:none;padding:.6rem 1.2rem;cursor:pointer;margin-top:1rem">Finalise attendance & write charges</button></p>
      </section>
    `);
    mainEl.querySelectorAll("[data-checkin],[data-noshow]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const attended = btn.hasAttribute("data-checkin");
        const id = btn.getAttribute("data-checkin") || btn.getAttribute("data-noshow");
        const reg = regs.find(r=>r.id===id);
        try {
          const updated = checkIn({ registration: reg, attendance: attended, checkedBy: "captain" });
          if (isConfigured()) {
            const client = await getClient();
            await client.from("game_registrations").update({ attended: updated.attended, checked_in_at: updated.checked_in_at, checked_in_by: updated.checked_in_by, status: updated.status }).eq("id", id);
          }
          btn.textContent = attended ? "✓ Attended" : "No-show recorded";
        } catch (e) { renderError(mainEl, e.message); }
      });
    });
    mainEl.querySelector("#finalise").addEventListener("click", async () => {
      try {
        const result = finaliseGame({ game: { id: gameId, status: "completed" }, registrations: regs });
        if (isConfigured()) {
          const client = await getClient();
          // DB function finalise_game_attendance is idempotent via charges_auto_once index
          await client.rpc("finalise_game_attendance", { p_game_id: gameId });
        }
        alert(`Finalised. Charges queued: ${result.charges.length}. Idempotency key: ${result.idempotencyKey}`);
      } catch (e) { renderError(mainEl, e.message); }
    });
  } catch (e) { renderError(mainEl, e.message); }
}
