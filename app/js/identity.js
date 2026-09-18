// These are editor limits, not claims about additional database constraints.
// Optional edit fields are patches: omission preserves a value; blank clears it.
export const IDENTITY_LIMITS = Object.freeze({
  display_name: 100,
  legal_name: 200,
  jersey_size: 40,
  emergency_contact_name: 200,
  emergency_contact_phone: 80,
  medical_notes: 4000,
  position: 20,
  positions: 12,
});

const IDENTITY_SUMMARY_FIELDS = [
  "id", "account_id", "guardian_account_id", "display_name", "verification_status",
  "is_public", "default_positions", "preferred_number",
];
const IDENTITY_PRIVATE_FIELDS = [
  "legal_name", "date_of_birth", "jersey_size", "emergency_contact_name",
  "emergency_contact_phone", "medical_notes", "verification_note",
];
const IDENTITY_DETAIL_FIELDS = [...IDENTITY_SUMMARY_FIELDS, ...IDENTITY_PRIVATE_FIELDS];
const IDENTITY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const identityOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const identityInput = (object, key) => identityOwn(object, key) ? object[key] : undefined;

export function identityToday() {
  // DOB is a calendar date. Do not round-trip it through a local-time Date.
  return new Date().toISOString().slice(0, 10);
}

function identityDateParts(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year > 0 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]
    ? { year, month, day } : null;
}

function identityIsMinor(birth, today) {
  let age = today.year - birth.year;
  if (today.month < birth.month || (today.month === birth.month && today.day < birth.day)) age -= 1;
  return age < 18;
}

export function validateIdentity(values, { creating = false, kind = "self", today = identityToday() } = {}) {
  const source = values && typeof values === "object" && !Array.isArray(values) ? values : {};
  const data = {};
  const errors = {};
  if (source !== values || (creating && kind !== "self" && kind !== "child")) {
    errors._form = "Enter the player details and choose who this identity is for.";
  }

  for (const field of ["display_name", "legal_name", "jersey_size", "emergency_contact_name",
    "emergency_contact_phone", "medical_notes"]) {
    if (field !== "display_name" && !creating && !identityOwn(source, field)) continue;
    const value = identityInput(source, field);
    if (value != null && typeof value !== "string") {
      errors[field] = "Enter text for this field.";
      continue;
    }
    const text = typeof value === "string" ? value.trim() : "";
    const controls = field === "medical_notes" ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/;
    if (field === "display_name" && !text) errors[field] = "Enter a display name.";
    else if (text.length > IDENTITY_LIMITS[field]) errors[field] = `Use ${IDENTITY_LIMITS[field]} characters or fewer.`;
    else if (controls.test(text)) errors[field] = "Remove unsupported control characters.";
    else data[field] = text || null;
  }

  if (creating || identityOwn(source, "default_positions")) {
    const value = identityInput(source, "default_positions");
    let positions = value == null ? [] : typeof value === "string" ? value.split(",") : value;
    if (!Array.isArray(positions) || positions.some((position) => typeof position !== "string")) {
      errors.default_positions = "Enter positions separated by commas.";
    } else {
      positions = [...new Set(positions.map((position) => position.trim()).filter(Boolean))];
      if (positions.length > IDENTITY_LIMITS.positions) {
        errors.default_positions = `Choose ${IDENTITY_LIMITS.positions} positions or fewer.`;
      } else if (positions.some((position) => position.length > IDENTITY_LIMITS.position || /[\u0000-\u001f\u007f]/.test(position))) {
        errors.default_positions = `Use ${IDENTITY_LIMITS.position} characters or fewer for each position, without control characters.`;
      } else data.default_positions = positions;
    }
  }

  if (creating || identityOwn(source, "preferred_number")) {
    const value = identityInput(source, "preferred_number");
    const blank = value == null || (typeof value === "string" && value.trim() === "");
    const number = typeof value === "number" ? value
      : typeof value === "string" && /^\d{1,2}$/.test(value.trim()) ? Number(value.trim()) : NaN;
    if (blank) data.preferred_number = null;
    else if (!Number.isInteger(number) || number < 0 || number > 99) errors.preferred_number = "Enter a whole number from 0 to 99, or leave it blank.";
    else data.preferred_number = number;
  }

  if (creating || identityOwn(source, "is_public")) {
    if (!identityOwn(source, "is_public") && creating) data.is_public = false;
    else if (typeof source.is_public !== "boolean") errors.is_public = "Choose whether to opt in to the public roster.";
    else data.is_public = source.is_public;
  }

  if (!creating && identityOwn(source, "date_of_birth")) {
    errors.date_of_birth = "Date of birth is set when creating an identity. Contact a club administrator for corrections.";
  } else if (creating) {
    const value = identityInput(source, "date_of_birth");
    const date = typeof value === "string" ? value.trim() : value;
    if (date == null || date === "") data.date_of_birth = null;
    else {
      const birth = identityDateParts(date);
      const current = identityDateParts(today);
      if (!birth) errors.date_of_birth = "Enter a valid date of birth.";
      else if (!current) errors.date_of_birth = "The current date is unavailable. Try again.";
      else if (date > today) errors.date_of_birth = "Date of birth cannot be in the future.";
      else if (kind === "self" && identityIsMinor(birth, current)) {
        errors.date_of_birth = "A guardian must manage a minor's identity. Contact the club for help with an existing child login.";
      } else data.date_of_birth = date;
    }
  }
  return { data, errors };
}

function identityError(code, fields) {
  const error = new Error(code);
  error.code = code;
  if (fields) error.fields = { ...fields };
  return error;
}

function identityId(value) {
  return typeof value === "string" && IDENTITY_UUID.test(value) ? value.toLowerCase() : null;
}

export function createIdentityService({ client, accountId, isCurrent = () => true }) {
  const actor = identityId(accountId);
  if (!actor) throw identityError("identity_unavailable");
  if (!client || typeof client.from !== "function") throw identityError("load_failed");
  const ownerFilter = `account_id.eq.${actor},guardian_account_id.eq.${actor}`;
  let writing = false;

  function live(signal, dispatched = false) {
    let current = false;
    try { current = isCurrent() === true && !signal?.aborted; } catch { /* fail closed */ }
    if (!current) throw identityError(dispatched ? "save_unconfirmed" : "stale_request");
  }

  function withSignal(query, signal) {
    return signal && typeof query.abortSignal === "function" ? query.abortSignal(signal) : query;
  }

  async function read(build, signal) {
    live(signal);
    let query;
    try { query = withSignal(build(), signal); } catch { live(signal); throw identityError("load_failed"); }
    live(signal);
    let result;
    try { result = await query; } catch { live(signal); throw identityError("load_failed"); }
    live(signal);
    if (!result || result.error || !identityOwn(result, "data")) throw identityError("load_failed");
    return result.data;
  }

  function owned(row) {
    return row && typeof row === "object" && !Array.isArray(row)
      && (identityId(row.account_id) === actor || identityId(row.guardian_account_id) === actor);
  }

  function clean(row, detail = false) {
    if (!owned(row) || !identityId(row.id)
      || (detail ? IDENTITY_DETAIL_FIELDS : IDENTITY_SUMMARY_FIELDS).some((field) => !identityOwn(row, field))
      || !(row.account_id === null || identityId(row.account_id))
      || !(row.guardian_account_id === null || identityId(row.guardian_account_id))
      || typeof row.display_name !== "string" || typeof row.is_public !== "boolean"
      || !["pending", "verified", "rejected"].includes(row.verification_status)
      || !Array.isArray(row.default_positions) || row.default_positions.some((position) => typeof position !== "string")
      || !(row.preferred_number === null || (Number.isInteger(row.preferred_number) && row.preferred_number >= 0 && row.preferred_number <= 99))) {
      return null;
    }
    const result = {};
    for (const field of detail ? IDENTITY_DETAIL_FIELDS : IDENTITY_SUMMARY_FIELDS) {
      if (detail && IDENTITY_PRIVATE_FIELDS.includes(field)
        && !(row[field] === null || typeof row[field] === "string")) return null;
      result[field] = field === "default_positions" ? [...row[field]] : row[field];
    }
    if (detail && result.date_of_birth !== null && !identityDateParts(result.date_of_birth)) return null;
    result.id = identityId(result.id);
    result.account_id = identityId(result.account_id);
    result.guardian_account_id = identityId(result.guardian_account_id);
    return result;
  }

  async function write(build, signal, { expectedId, kind } = {}) {
    live(signal);
    let query;
    try { query = withSignal(build(), signal); } catch { live(signal); throw identityError("save_unconfirmed"); }
    live(signal);
    let result;
    // Once awaited, a write might have committed even if its response is lost.
    try { result = await query; } catch { throw identityError("save_unconfirmed"); }
    live(signal, true);
    if (!result) throw identityError("save_unconfirmed");
    if (result.error) {
      const code = result.error.code;
      if (code === "23505" && kind === "self") throw identityError("identity_exists");
      if (["42501", "23503", "PGRST116"].includes(code)) throw identityError("identity_unavailable");
      throw identityError("save_unconfirmed");
    }
    const row = clean(result.data, true);
    if (!row || (expectedId && row.id !== expectedId)
      || (kind === "self" && (row.account_id !== actor || row.guardian_account_id !== null))
      || (kind === "child" && (row.account_id !== null || row.guardian_account_id !== actor))) {
      throw identityError("identity_unavailable");
    }
    live(signal, true);
    return row;
  }

  async function mutate(operation, signal) {
    live(signal);
    if (writing) throw identityError("invalid_identity", { _form: "A save is already in progress. Wait for its result." });
    writing = true;
    try { return await operation(); } finally { writing = false; }
  }

  return {
    async list({ signal } = {}) {
      const rows = await read(() => client.from("players").select(IDENTITY_SUMMARY_FIELDS.join(","))
        .or(ownerFilter).order("display_name", { ascending: true }).order("id", { ascending: true }), signal);
      if (!Array.isArray(rows)) throw identityError("load_failed");
      let own = null;
      const children = [];
      const seen = new Set();
      for (const raw of rows) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)
          || !(raw.account_id === null || identityId(raw.account_id))
          || !(raw.guardian_account_id === null || identityId(raw.guardian_account_id))) {
          throw identityError("load_failed");
        }
        if (!owned(raw)) continue;
        const row = clean(raw);
        if (!row || seen.has(row.id)) throw identityError("load_failed");
        seen.add(row.id);
        if (row.account_id === actor) {
          if (own) throw identityError("load_failed");
          own = row;
        } else if (row.guardian_account_id === actor) children.push(row);
      }
      live(signal);
      return { own, children };
    },

    async load(playerId, { signal } = {}) {
      live(signal);
      const id = identityId(playerId);
      if (!id) throw identityError("identity_unavailable");
      const raw = await read(() => client.from("players").select(IDENTITY_DETAIL_FIELDS.join(","))
        .eq("id", id).or(ownerFilter).maybeSingle(), signal);
      const row = clean(raw, true);
      if (!row || row.id !== id) throw identityError("identity_unavailable");
      live(signal);
      return row;
    },

    async create(kind, values, { signal } = {}) {
      return mutate(async () => {
        const { data, errors } = validateIdentity(values, { creating: true, kind });
        if (Object.keys(errors).length) throw identityError("invalid_identity", errors);
        if (kind === "self") {
          const existing = await read(() => client.from("players").select("id,account_id")
            .eq("account_id", actor).maybeSingle(), signal);
          if (existing !== null) {
            if (!existing || !identityId(existing.id) || identityId(existing.account_id) !== actor) {
              throw identityError("identity_unavailable");
            }
            throw identityError("identity_exists");
          }
        }
        live(signal);
        const payload = { ...data, account_id: kind === "self" ? actor : null,
          guardian_account_id: kind === "child" ? actor : null };
        return write(() => client.from("players").insert(payload)
          .select(IDENTITY_DETAIL_FIELDS.join(",")).single(), signal, { kind });
      }, signal);
    },

    async update(playerId, values, { signal } = {}) {
      return mutate(async () => {
        const id = identityId(playerId);
        if (!id) throw identityError("identity_unavailable");
        const { data, errors } = validateIdentity(values);
        if (Object.keys(errors).length) throw identityError("invalid_identity", errors);
        return write(() => client.from("players").update(data).eq("id", id).or(ownerFilter)
          .select(IDENTITY_DETAIL_FIELDS.join(",")).single(), signal, { expectedId: id });
      }, signal);
    },
  };
}
