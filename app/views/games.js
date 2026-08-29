import { html, mount } from "../js/dom.js";
import { spotsLeft, sortGamesByStart, formatGameDate, formatGameTime, ownRegistrationState } from "../js/games.js";
import { getClient, isConfigured } from "../js/supabase.js";
import { renderLoading, renderError } from "../js/layout.js";

// Seed fallback so the screen has non-trivial content when DB is unreachable / unconfigured.
export const SEED_GAMES = [
  { id: "seed-pickup-1", title: "Saturday Pickup", game_type: "pickup", start_time: new Date(Date.now() + 86400000).toISOString(), gather_time: new Date(Date.now() + 86400000 - 1800000).toISOString(), venue_name: "Twin Creeks Turf 2", field_label: "Turf 2", capacity: 22, status: "published", kit_color: "Blue", notes: "Bring dark and light tops.", registrations: [] },
  { id: "seed-league-1", title: "CalBlue vs San Ramon FC", game_type: "league", opponent: "San Ramon FC", start_time: new Date(Date.now() + 3*86400000).toISOString(), gather_time: new Date(Date.now() + 3*86400000 - 3600000).toISOString(), venue_name: "San Ramon Central Park", field_label: "Field C", capacity: 18, status: "published", kit_color: "Blue / Gold", registrations: [] },
];

export async function gamesView(mainEl, { playerId } = {}) {
  renderLoading(mainEl, "Loading games…");
  try {
    let games = SEED_GAMES;
    let source = "seed";
    if (isConfigured()) {
      const client = await getClient();
      if (client) {
        const { data, error } = await client
          .from("games").select("id,title,game_type,opponent,start_time,gather_time,venue_id,field_label,capacity,status,kit_color,notes, venues(name,address,map_url)")
          .in("status", ["published", "reg_closed"])
          .order("start_time", { ascending: true });
        if (!error && data && data.length) { games = data; source = "database"; }
      }
    }
    games = sortGamesByStart(games);
    mount(mainEl, html`
      <section class="app-games">
        <h1>Games</h1>
        <p class="app-muted">${source === "seed" ? "Showing seed data — database not configured or empty. See #24 / #28." : "Live from database."}</p>
        <ul class="app-game-list">
          ${games.map((g) => {
            const spots = spotsLeft(g.capacity, g.registrations || []);
            const state = ownRegistrationState(g.registrations || [], playerId);
            return html`
              <li class="app-game-card">
                <a href="#/games/${g.id}" class="app-game-link">
                  <div class="app-game-date">${formatGameDate(g.start_time)} · ${formatGameTime(g.start_time)}</div>
                  <h2>${g.title}</h2>
                  <div class="app-game-meta">
                    <span>${g.venue_name || g.venues?.name || "Venue TBD"}</span>
                    ${g.field_label ? html`<span>· ${g.field_label}</span>` : ""}
                    ${spots !== null ? html`<span>· ${spots} spot${spots === 1 ? "" : "s"} left</span>` : ""}
                  </div>
                  <div class="app-game-type">${g.game_type}${g.opponent ? html` · vs ${g.opponent}` : ""}</div>
                  ${state.state !== "not_in" ? html`<div class="app-game-state app-game-state-${state.state}">${state.state}${state.waitlistPosition ? html` #${state.waitlistPosition}` : ""}</div>` : ""}
                </a>
              </li>`;
          })}
        </ul>
      </section>
    `);
  } catch (err) {
    renderError(mainEl, err.message || String(err));
  }
}
