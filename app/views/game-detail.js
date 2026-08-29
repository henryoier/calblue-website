import { html, mount } from "../js/dom.js";
import { spotsLeft, formatGameDate, formatGameTime, ownRegistrationState, squadList } from "../js/games.js";
import { getClient, isConfigured } from "../js/supabase.js";
import { renderLoading, renderError } from "../js/layout.js";
import { SEED_GAMES } from "./games.js";

export async function gameDetailView(mainEl, { gameId, playerId } = {}) {
  renderLoading(mainEl, "Loading game…");
  try {
    let game = SEED_GAMES.find((g) => g.id === gameId) || SEED_GAMES[0];
    if (isConfigured()) {
      const client = await getClient();
      if (client) {
        const { data } = await client.from("games")
          .select("*, venues(name,address,map_url), game_registrations(id,player_id,status,jersey_number,positions,registered_at,participation, players(display_name,preferred_number,default_positions))")
          .eq("id", gameId).maybeSingle();
        if (data) game = { ...data, venue_name: data.venues?.name, registrations: data.game_registrations || [] };
      }
    }
    const regs = game.registrations || [];
    const spots = spotsLeft(game.capacity, regs);
    const state = ownRegistrationState(regs, playerId);
    const squad = squadList(regs);
    mount(mainEl, html`
      <section class="app-game-detail">
        <p><a href="#/games">← Back to games</a></p>
        <h1>${game.title}</h1>
        <div class="app-game-meta-large">
          <div><strong>When:</strong> ${formatGameDate(game.start_time)} — gather ${game.gather_time ? formatGameTime(game.gather_time) : "TBD"}, kick-off ${formatGameTime(game.start_time)}</div>
          <div><strong>Where:</strong> ${game.venue_name || game.venues?.name || "TBD"} ${game.field_label ? html`· ${game.field_label}` : ""}
            ${game.venues?.map_url || game.map_url ? html` · <a href="${game.venues?.map_url || game.map_url}" target="_blank" rel="noopener">Map ↗</a>` : ""}
          </div>
          ${game.venues?.address ? html`<div class="app-muted">${game.venues.address}</div>` : ""}
          <div><strong>Type:</strong> ${game.game_type}${game.opponent ? html` vs ${game.opponent}` : ""}</div>
          ${game.kit_color ? html`<div><strong>Kit:</strong> ${game.kit_color}</div>` : ""}
          ${spots !== null ? html`<div><strong>Spots left:</strong> ${spots}</div>` : ""}
        </div>
        ${game.notes ? html`<p class="app-notes">${game.notes}</p>` : ""}
        <div class="app-registration-state" role="status">
          ${state.state === "registered" ? html`<p class="app-badge app-badge-ok">You are registered${state.registration?.jersey_number ? html` — #${state.registration.jersey_number}` : ""}</p>`
            : state.state === "waitlisted" ? html`<p class="app-badge app-badge-wait">Waitlisted #${state.waitlistPosition}</p>`
            : html`<p class="app-badge">Not registered yet — <a href="#/games/${game.id}/register">Register</a> (#35)</p>`}
        </div>
        <h2>Squad (${squad.length})</h2>
        ${squad.length ? html`
          <ul class="app-squad-list">
            ${squad.map((p) => html`<li><span class="app-jersey">${p.jerseyNumber ?? "—"}</span> ${p.displayName} <span class="app-muted">${p.positions.join(", ")}</span></li>`)}
          </ul>` : html`<p class="app-muted">No registered players yet.</p>`}
      </section>
    `);
  } catch (err) {
    renderError(mainEl, err.message || String(err));
  }
}
