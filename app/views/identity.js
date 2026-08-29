import { html, mount } from "../js/dom.js";
import { validateIdentity, canCreateOwnIdentity } from "../js/identity.js";
import { getClient, isConfigured } from "../js/supabase.js";
import { getProfile } from "../js/session.js";
import { renderLoading, renderError } from "../js/layout.js";

export async function identityView(mainEl) {
  renderLoading(mainEl, "Loading your identity…");
  try {
    const profile = getProfile();
    if (!profile) {
      mount(mainEl, html`<p>Sign in to manage your identity. <a href="#/sign-in">Sign in</a></p>`);
      return;
    }
    let player = null;
    if (isConfigured()) {
      const client = await getClient();
      if (client) {
        const { data } = await client.from("players").select("*").eq("account_id", profile.id).maybeSingle();
        player = data;
      }
    }
    mount(mainEl, html`
      <section>
        <h1>My identity</h1>
        <p class="app-muted">One account = one identity. You can also create child identities as guardian.</p>
        ${player ? html`
          <div class="app-game-meta-large">
            <div><strong>Display name:</strong> ${player.display_name}</div>
            <div><strong>Verification:</strong> ${player.verification_status} ${player.verification_note ? html`— ${player.verification_note}` : ""}</div>
            <div><strong>Preferred #:</strong> ${player.preferred_number ?? "—"}</div>
            <div><strong>Positions:</strong> ${(player.default_positions||[]).join(", ") || "—"}</div>
            <div><strong>Public roster opt-in:</strong> ${player.is_public ? "Yes" : "No"}</div>
          </div>
          <p class="app-muted">Medical notes are sensitive — only shown here, never in lists.</p>
        ` : html`<p>No identity yet for this account. Create exactly one below.</p>`}
        <form id="identity-form">
          <label>Display name<br><input name="display_name" value="${player?.display_name||""}" required style="width:100%;max-width:24rem;padding:.5rem"></label><br><br>
          <label>Preferred jersey # (0-99)<br><input name="preferred_number" type="number" min="0" max="99" value="${player?.preferred_number??""}" style="width:6rem;padding:.5rem"></label><br><br>
          <label>Default positions (comma)<br><input name="default_positions" value="${(player?.default_positions||[]).join(",")}" style="width:100%;max-width:24rem;padding:.5rem"></label><br><br>
          <label><input type="checkbox" name="is_public" ${player?.is_public ? "checked" : ""}> Opt in to public roster (name & photo become public, verified only)</label><br><br>
          <button type="submit" class="app-link app-link-primary" style="border:none;padding:.6rem 1.2rem;cursor:pointer">${player ? "Save" : "Create identity"}</button>
          <span id="identity-status" role="status" style="margin-left:.8rem"></span>
        </form>
      </section>
    `);
    const form = mainEl.querySelector("#identity-form");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const input = {
        display_name: fd.get("display_name"),
        preferred_number: fd.get("preferred_number") ? Number(fd.get("preferred_number")) : null,
        default_positions: String(fd.get("default_positions")||"").split(",").map(s=>s.trim()).filter(Boolean),
        is_public: Boolean(fd.get("is_public")),
      };
      const errors = validateIdentity(input);
      const status = mainEl.querySelector("#identity-status");
      if (errors.length) { status.textContent = errors.join("; "); return; }
      status.textContent = "Saving…";
      try {
        if (!isConfigured()) throw new Error("Database not configured (#24)");
        const client = await getClient();
        if (player) {
          const { error } = await client.from("players").update(input).eq("id", player.id);
          if (error) throw error;
        } else {
          const { error } = await client.from("players").insert({ ...input, account_id: profile.id });
          if (error) throw error;
        }
        status.textContent = "Saved.";
      } catch (err) { status.textContent = ""; renderError(mainEl, err.message); }
    });
  } catch (err) { renderError(mainEl, err.message); }
}
