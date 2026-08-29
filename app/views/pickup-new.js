import { html, mount } from "../js/dom.js";
import { validateGameTimes, isPickup } from "../js/registration.js";
import { getClient, isConfigured } from "../js/supabase.js";
import { renderError } from "../js/layout.js";

export function pickupNewView(mainEl) {
  mount(mainEl, html`
    <section>
      <h1>Create pickup game</h1>
      <p class="app-muted">Pickup = game_type='pickup', competition_id=null. Organiser (scoped grant) can create without club admin.</p>
      <form id="pickup-form">
        <label>Title<br><input name="title" required style="width:100%;max-width:24rem;padding:.5rem"></label><br><br>
        <label>Venue<br><input name="venue_name" style="width:100%;max-width:24rem;padding:.5rem"></label><br><br>
        <label>Field label<br><input name="field_label" style="width:12rem;padding:.5rem"></label><br><br>
        <label>Gather time<br><input name="gather_time" type="datetime-local" required></label><br><br>
        <label>Kick-off<br><input name="start_time" type="datetime-local" required></label><br><br>
        <label>End time<br><input name="end_time" type="datetime-local"></label><br><br>
        <label>Capacity<br><input name="capacity" type="number" min="1" value="22" style="width:6rem;padding:.5rem"></label><br><br>
        <label>Kit colour<br><input name="kit_color" style="width:12rem;padding:.5rem"></label><br><br>
        <label>Notes<br><textarea name="notes" style="width:100%;max-width:24rem;padding:.5rem"></textarea></label><br><br>
        <button type="submit" class="app-link app-link-primary" style="border:none;padding:.6rem 1.2rem;cursor:pointer">Create draft</button>
        <span id="pickup-status" role="status" style="margin-left:.8rem"></span>
      </form>
    </section>
  `);
  const form = mainEl.querySelector("#pickup-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const input = {
      title: fd.get("title"),
      venue_name: fd.get("venue_name"),
      field_label: fd.get("field_label"),
      gather_time: fd.get("gather_time"),
      start_time: fd.get("start_time"),
      end_time: fd.get("end_time") || null,
      capacity: fd.get("capacity") ? Number(fd.get("capacity")) : null,
      kit_color: fd.get("kit_color"),
      notes: fd.get("notes"),
      game_type: "pickup",
      competition_id: null,
      status: "draft",
    };
    const errors = validateGameTimes(input);
    const status = mainEl.querySelector("#pickup-status");
    if (errors.length) { status.textContent = errors.join("; "); return; }
    if (!isPickup(input)) { status.textContent = "Pickup must have no competition"; return; }
    status.textContent = "Saving…";
    try {
      if (!isConfigured()) throw new Error("Database not configured (#24)");
      const client = await getClient();
      const { error } = await client.from("games").insert({
        title: input.title,
        game_type: "pickup",
        start_time: new Date(input.start_time).toISOString(),
        gather_time: input.gather_time ? new Date(input.gather_time).toISOString() : null,
        end_time: input.end_time ? new Date(input.end_time).toISOString() : null,
        capacity: input.capacity,
        kit_color: input.kit_color,
        notes: input.notes,
        status: "draft",
      });
      if (error) throw error;
      status.textContent = "Created draft — publish from game list.";
    } catch (err) { status.textContent = ""; renderError(mainEl, err.message); }
  });
}
