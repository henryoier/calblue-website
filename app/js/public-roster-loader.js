// Drive public roster.html from v_public_roster, with graceful degradation.
//
// - Only opt-in verified identities appear (view enforces it, we re-filter client-side).
// - If DB unreachable, static markup stays — page never shows broken.
// - Never query `players` directly; only the view.

import { getClient, isConfigured } from "./supabase.js";
import { rosterToCards, gracefulDegradation } from "./public-roster.js";

export async function loadPublicRoster({ gridEl, statusEl }) {
  const staticCards = gridEl ? [...gridEl.querySelectorAll(".player-card")].map((c) => ({ name: c.textContent.trim(), static: true })) : [];
  let rows = [];
  let dbReachable = false;
  if (isConfigured()) {
    try {
      const client = await getClient();
      if (client) {
        const { data, error } = await client.from("v_public_roster").select("*");
        if (!error) { rows = data || []; dbReachable = true; }
      }
    } catch { dbReachable = false; }
  }
  const result = gracefulDegradation({ dbReachable, rows, staticMarkup: staticCards });
  if (statusEl) {
    statusEl.textContent = result.message || (result.source === "database" ? `${result.cards.length} players` : "");
  }
  if (result.source === "database" && result.cards.length && gridEl) {
    gridEl.innerHTML = result.cards.map((c) => {
      const name = c.name.replace(/</g, "&lt;");
      const photo = c.photoUrl ? `<img src="${c.photoUrl.replace(/"/g, "&quot;")}" alt="${name}" loading="lazy">` : "";
      return `<article class="player-card">${photo}<h2>${name}</h2></article>`;
    }).join("");
  }
  // if static, leave existing markup untouched
  return result;
}
