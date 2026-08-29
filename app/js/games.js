// Game list / detail logic — pure, tested under JavaScriptCore.
//
// Spots-left and waitlist position are derived, never stored.
// See #34, #35, #36.

export function spotsLeft(capacity, registrations) {
  if (!capacity) return null; // unlimited
  const active = (registrations || []).filter(
    (r) => r.status === "registered" && ["player", "keeper"].includes(r.participation || "player")
  ).length;
  return Math.max(0, capacity - active);
}

export function waitlistPosition(registrations, playerId) {
  const waitlisted = (registrations || [])
    .filter((r) => r.status === "waitlisted")
    .sort((a, b) => new Date(a.registered_at) - new Date(b.registered_at));
  const idx = waitlisted.findIndex((r) => r.player_id === playerId || r.player_profile_id === playerId);
  return idx === -1 ? null : idx + 1;
}

export function ownRegistrationState(registrations, playerId) {
  if (!playerId) return { state: "not_in", registration: null, waitlistPosition: null };
  const reg = (registrations || []).find(
    (r) => (r.player_id === playerId || r.player_profile_id === playerId) && r.status !== "cancelled"
  );
  if (!reg) return { state: "not_in", registration: null, waitlistPosition: null };
  if (reg.status === "waitlisted") {
    return { state: "waitlisted", registration: reg, waitlistPosition: waitlistPosition(registrations, playerId) };
  }
  if (reg.status === "registered") {
    return { state: "registered", registration: reg, waitlistPosition: null };
  }
  return { state: reg.status, registration: reg, waitlistPosition: null };
}

export function sortGamesByStart(games) {
  return [...(games || [])].sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
}

export function formatGameDate(startTime, timezone = "America/Los_Angeles") {
  if (!startTime) return "";
  try {
    return new Date(startTime).toLocaleDateString("en-US", { timeZone: timezone, weekday: "short", month: "short", day: "numeric" });
  } catch { return new Date(startTime).toLocaleDateString(); }
}

export function formatGameTime(startTime, timezone = "America/Los_Angeles") {
  if (!startTime) return "";
  try {
    return new Date(startTime).toLocaleTimeString("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit" });
  } catch { return new Date(startTime).toLocaleTimeString(); }
}

export function isGatherBeforeKickoff(gather, kickoff) {
  if (!gather || !kickoff) return true;
  return new Date(gather) <= new Date(kickoff);
}

export function squadList(registrations) {
  return (registrations || [])
    .filter((r) => r.status === "registered")
    .sort((a, b) => (a.jersey_number ?? 999) - (b.jersey_number ?? 999))
    .map((r) => ({
      playerId: r.player_id || r.player_profile_id,
      displayName: r.display_name || r.player_name || "Player",
      jerseyNumber: r.jersey_number ?? r.preferred_number ?? null,
      positions: r.positions || r.default_positions || [],
      participation: r.participation || "player",
    }));
}
