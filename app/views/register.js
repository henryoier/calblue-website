import { html, mount } from "../js/dom.js";
import { canRegister, validateRegistration } from "../js/registration.js";
import { getClient, isConfigured } from "../js/supabase.js";
import { getProfile } from "../js/session.js";
import { renderError } from "../js/layout.js";

export function registerView(mainEl, { gameId }) {
  mount(mainEl, html`
    <section>
      <h1>Register to play</h1>
      <p>Game: ${gameId}</p>
      <form id="reg-form">
        <label>Jersey # (0-99)<br><input name="jersey_number" type="number" min="0" max="99" style="width:6rem;padding:.5rem"></label><br><br>
        <label>Positions (comma)<br><input name="positions" style="width:100%;max-width:24rem;padding:.5rem"></label><br><br>
        <button type="submit" class="app-link app-link-primary" style="border:none;padding:.6rem 1.2rem;cursor:pointer">Register</button>
        <span id="reg-status" role="status" style="margin-left:.8rem"></span>
      </form>
      <p><button id="cancel-reg" style="margin-top:1rem">Cancel my registration</button></p>
    </section>
  `);
  const form = mainEl.querySelector("#reg-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const input = {
      jersey_number: fd.get("jersey_number") ? Number(fd.get("jersey_number")) : null,
      positions: String(fd.get("positions")||"").split(",").map(s=>s.trim()).filter(Boolean),
    };
    const errors = validateRegistration(input);
    const status = mainEl.querySelector("#reg-status");
    if (errors.length) { status.textContent = errors.join("; "); return; }
    // eligibility check would fetch player + game + competitionRegistration here
    status.textContent = "Registering…";
    try {
      if (!isConfigured()) throw new Error("Database not configured (#24)");
      const client = await getClient();
      const profile = getProfile();
      if (!profile) throw new Error("Sign in required");
      const { data: player } = await client.from("players").select("*").eq("account_id", profile.id).maybeSingle();
      const { data: game } = await client.from("games").select("*").eq("id", gameId).maybeSingle();
      const check = canRegister({ player, game, competitionRegistration: null });
      if (!check.ok) throw new Error(check.reason);
      const { error } = await client.from("game_registrations").insert({
        game_id: gameId,
        player_id: player.id,
        jersey_number: input.jersey_number,
        positions: input.positions,
        status: "registered",
      });
      if (error) {
        if (String(error.message||"").includes("game_full") || String(error.code||"") === "check_violation") {
          // offer waitlist
          const { error: wlErr } = await client.from("game_registrations").insert({
            game_id: gameId, player_id: player.id, jersey_number: input.jersey_number, positions: input.positions, status: "waitlisted",
          });
          if (wlErr) throw wlErr;
          status.textContent = "Game full — you are waitlisted.";
          return;
        }
        throw error;
      }
      status.textContent = "Registered.";
    } catch (err) { status.textContent = ""; renderError(mainEl, err.message); }
  });
  mainEl.querySelector("#cancel-reg").addEventListener("click", async () => {
    try {
      if (!isConfigured()) throw new Error("Database not configured (#24)");
      const client = await getClient();
      const profile = getProfile();
      const { data: player } = await client.from("players").select("id").eq("account_id", profile.id).maybeSingle();
      await client.from("game_registrations").update({ status: "cancelled", cancelled_at: new Date().toISOString() })
        .eq("game_id", gameId).eq("player_id", player.id);
      window.location.hash = `#/games/${gameId}`;
    } catch (e) { renderError(mainEl, e.message); }
  });
}
