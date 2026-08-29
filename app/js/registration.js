// Registration, capacity, waitlist, check-in, finalise, eligibility.
// #33 pickup, #35 register, #36 capacity/waitlist, #37 check-in, #38 finalise, #42 eligibility.

export function validateGameTimes({ gather_time, start_time, end_time, registration_closes_at }) {
  const errors = [];
  if (!start_time) errors.push("start_time required");
  if (gather_time && start_time && new Date(gather_time) > new Date(start_time)) errors.push("gather_time must be <= start_time");
  if (end_time && start_time && new Date(end_time) <= new Date(start_time)) errors.push("end_time must be > start_time");
  if (registration_closes_at && start_time && new Date(registration_closes_at) > new Date(start_time)) errors.push("registration_closes_at must be <= start_time");
  return errors;
}

export function canRegister({ player, game, competitionRegistration }) {
  if (!player) return { ok: false, reason: "no identity" };
  if (game.status !== "published" && game.status !== "reg_closed") {
    // actually reg_closed means registration closed, so only published
  }
  if (game.status !== "published") return { ok: false, reason: `game is ${game.status}` };
  if (game.registration_closes_at && new Date(game.registration_closes_at) < new Date()) {
    return { ok: false, reason: "registration closed" };
  }
  // eligibility by game type
  if (game.game_type === "pickup" || game.game_type === "training" || game.game_type === "friendly") {
    return { ok: true };
  }
  // league/tournament/cup require verified + competition approval
  if (player.verification_status !== "verified") return { ok: false, reason: "verification required for official games" };
  if (game.competition_id && competitionRegistration && competitionRegistration.status !== "approved") {
    return { ok: false, reason: "season roster approval required" };
  }
  return { ok: true };
}

export function validateRegistration({ jersey_number, positions }) {
  const errors = [];
  if (jersey_number !== null && jersey_number !== undefined) {
    const n = Number(jersey_number);
    if (!Number.isInteger(n) || n < 0 || n > 99) errors.push("jersey_number 0-99");
  }
  if (positions && !Array.isArray(positions)) errors.push("positions must be array");
  return errors;
}

export function promoteWaitlist(registrations) {
  const waitlisted = (registrations||[]).filter(r=>r.status==="waitlisted").sort((a,b)=>new Date(a.registered_at)-new Date(b.registered_at));
  return waitlisted[0] || null;
}

export function checkIn({ registration, attendance, jersey_number, positions, checkedBy }) {
  if (!registration || registration.status !== "registered") throw new Error("only registered can check in");
  return {
    ...registration,
    attended: Boolean(attendance),
    jersey_number: jersey_number ?? registration.jersey_number,
    positions: positions || registration.positions,
    checked_in_at: new Date().toISOString(),
    checked_in_by: checkedBy,
    status: attendance ? "registered" : "no_show",
  };
}

export function finaliseGame({ game, registrations }) {
  if (game.status !== "completed" && game.status !== "reg_closed") {
    // allow finalise from reg_closed / completed
  }
  const charges = [];
  const updatedRegs = (registrations||[]).map(r => {
    if (r.status === "registered" && r.attended === null) {
      return { ...r, attended: false, status: "no_show" };
    }
    return r;
  });
  for (const r of updatedRegs) {
    if (r.attended) {
      charges.push({ game_id: game.id, player_id: r.player_id, kind: "game_fee", source: "auto" });
    } else if (r.status === "no_show") {
      // no-show fee logic handled by resolve_no_show_fee in DB; flag here
      charges.push({ game_id: game.id, player_id: r.player_id, kind: "no_show_fee", source: "auto" });
    }
  }
  return { registrations: updatedRegs, charges, idempotencyKey: `auto-${game.id}` };
}

export function isPickup(game) {
  return game.game_type === "pickup" && !game.competition_id;
}
