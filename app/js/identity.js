// Identity logic — #31 My identity, #32 verification queue.
// One account = one identity. Guardians create child identities.

export function validateIdentity(input) {
  const errors = [];
  if (!input.display_name || !String(input.display_name).trim()) errors.push("display_name required");
  if (input.preferred_number !== null && input.preferred_number !== undefined) {
    const n = Number(input.preferred_number);
    if (!Number.isInteger(n) || n < 0 || n > 99) errors.push("preferred_number must be 0-99");
  }
  if (input.date_of_birth) {
    const d = new Date(input.date_of_birth);
    if (isNaN(d.getTime())) errors.push("date_of_birth invalid");
    else if (d > new Date()) errors.push("date_of_birth cannot be in future");
  }
  return errors;
}

export function canCreateOwnIdentity({ accountId, existingIdentities }) {
  const own = (existingIdentities || []).filter((p) => p.account_id === accountId);
  return own.length === 0;
}

export function canEditVerification({ roles }) {
  return (roles || []).includes("admin");
}

export function filterPending(players) {
  return (players || []).filter((p) => p.verification_status === "pending")
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

export function applyVerificationDecision(player, { decision, note, decidedBy }) {
  if (!["verified", "rejected"].includes(decision)) throw new Error("decision must be verified|rejected");
  return {
    ...player,
    verification_status: decision,
    verification_note: note || null,
    decided_by: decidedBy,
    decided_at: new Date().toISOString(),
  };
}
