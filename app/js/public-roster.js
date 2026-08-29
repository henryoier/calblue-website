// Public roster logic — opt-in verified only.
//
// v_public_roster enforces is_public AND verification_status='verified'.
// The page must NOT query players directly. Pure logic tested here.

export function filterPublicRoster(rows) {
  return (rows || []).filter((r) => r.is_public && r.verification_status === "verified");
}

export function sortRoster(rows) {
  return [...(rows || [])].sort((a, b) => String(a.display_name || "").localeCompare(String(b.display_name || "")));
}

export function rosterToCards(rows) {
  return sortRoster(filterPublicRoster(rows)).map((r) => ({
    name: r.display_name,
    photoUrl: r.photo_url || null,
    jerseyNumber: r.preferred_number ?? null,
    positions: r.default_positions || [],
  }));
}

export function gracefulDegradation({ dbReachable, rows, staticMarkup }) {
  if (!dbReachable) return { source: "static", cards: staticMarkup || [], message: "Database unreachable — showing last published roster." };
  const cards = rosterToCards(rows);
  return { source: "database", cards, message: cards.length ? null : "No public roster yet." };
}
