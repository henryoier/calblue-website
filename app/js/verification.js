// These bounds mirror the verification RPCs. Authorization and atomic decisions
// remain in PostgreSQL; the client never writes players or audit rows directly.
export const VERIFICATION_LIMITS = Object.freeze({ page: 50, search: 100, note: 1000 });

const VERIFICATION_FIELDS = [
  "id", "display_name", "legal_name", "verification_status", "verification_note",
  "created_at", "updated_at", "decided_by", "decided_at",
];
const VERIFICATION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const verificationOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const verificationId = (value) => typeof value === "string" && VERIFICATION_UUID.test(value) ? value.toLowerCase() : null;

function verificationTimestamp(value) {
  // Validate the wire representation without Date: Date loses PostgreSQL's
  // microseconds and would invalidate the optimistic-concurrency token.
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , zoneHour, zoneMinute] = match;
  const [year, month, day, hour, minute, second] = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year > 0 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]
    && hour < 24 && minute < 60 && second < 60
    && (zoneHour === undefined || (Number(zoneHour) < 24 && Number(zoneMinute) < 60));
}

export function validateVerificationSearch(search = "") {
  const data = {};
  const errors = {};
  if (typeof search !== "string") errors.search = "Enter a name to search, or leave the search blank.";
  else {
    const value = search.trim();
    if (value.length > VERIFICATION_LIMITS.search) errors.search = "Use 100 characters or fewer.";
    else if (/[\u0000-\u001f\u007f]/.test(value)) errors.search = "Remove unsupported control characters.";
    else data.search = value;
  }
  return { data, errors };
}

export function validateVerificationDecision(rows, status, note = "") {
  const data = {};
  const errors = {};
  if (!["verified", "rejected"].includes(status)) errors.status = "Choose approve or reject.";
  else data.status = status;

  if (note !== null && typeof note !== "string") errors.note = "Enter a review note.";
  else {
    const value = note === null ? "" : note.trim();
    if (value.length > VERIFICATION_LIMITS.note) errors.note = "Use 1000 characters or fewer.";
    else if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) errors.note = "Remove unsupported control characters.";
    else if (status === "rejected" && !value) errors.note = "Enter a reason for rejecting this identity.";
    else data.note = value || null;
  }

  const seen = new Set();
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > VERIFICATION_LIMITS.page) {
    errors.rows = "Choose between 1 and 50 pending identities.";
  } else {
    data.rows = [];
    for (const row of rows) {
      const id = row && typeof row === "object" && !Array.isArray(row) && verificationOwn(row, "id")
        ? verificationId(row.id) : null;
      if (!id || seen.has(id) || !verificationOwn(row, "updated_at") || !verificationTimestamp(row.updated_at)
        || !verificationOwn(row, "verification_status") || row.verification_status !== "pending") {
        errors.rows = "Reload the list and choose pending identities that have not changed.";
        break;
      }
      seen.add(id);
      data.rows.push({ id, updated_at: row.updated_at });
    }
    if (errors.rows) delete data.rows;
  }
  return { data, errors };
}

function verificationError(code, fields) {
  const error = new Error(code);
  error.code = code;
  if (fields) error.fields = { ...fields };
  return error;
}

function cleanVerification(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)
    || VERIFICATION_FIELDS.some((field) => !verificationOwn(row, field))
    || !verificationId(row.id) || typeof row.display_name !== "string"
    || !(row.legal_name === null || typeof row.legal_name === "string")
    || !["pending", "verified", "rejected"].includes(row.verification_status)
    || !(row.verification_note === null || typeof row.verification_note === "string")
    || !verificationTimestamp(row.created_at) || !verificationTimestamp(row.updated_at)
    || !(row.decided_by === null || verificationId(row.decided_by))
    || !(row.decided_at === null || verificationTimestamp(row.decided_at))) return null;
  const result = {};
  for (const field of VERIFICATION_FIELDS) result[field] = row[field];
  result.id = verificationId(result.id);
  result.decided_by = verificationId(result.decided_by);
  return result;
}

export function createVerificationService({ client, isCurrent = () => true }) {
  if (!client || typeof client.rpc !== "function") throw verificationError("load_failed");
  let writing = false;
  let uncertain = false;
  let writeVersion = 0;

  function live(signal, dispatched = false) {
    let current = false;
    try { current = isCurrent() === true && !signal?.aborted; } catch { /* fail closed */ }
    if (!current) throw verificationError(dispatched ? "save_unconfirmed" : "stale_request");
  }

  function query(name, parameters, signal) {
    const request = client.rpc(name, parameters);
    return signal && typeof request?.abortSignal === "function" ? request.abortSignal(signal) : request;
  }

  function responseRows(raw, code) {
    if (!Array.isArray(raw)) throw verificationError(code);
    const seen = new Set();
    return raw.map((source) => {
      const row = cleanVerification(source);
      if (!row || seen.has(row.id)) throw verificationError(code);
      seen.add(row.id);
      return row;
    });
  }

  return {
    async list({ search = "", offset = 0, signal } = {}) {
      live(signal);
      const checked = validateVerificationSearch(search);
      if (!Number.isInteger(offset) || offset < 0 || offset > 2147483647) checked.errors.offset = "Reload the list from its first page.";
      if (Object.keys(checked.errors).length) throw verificationError("invalid_verification", checked.errors);
      // A read started before an uncertain write is not evidence of its outcome.
      const recovery = uncertain && !writing;
      const version = writeVersion;
      let request;
      try { request = query("list_player_verifications", { p_search: checked.data.search, p_offset: offset }, signal); }
      catch { live(signal); throw verificationError("load_failed"); }
      live(signal);
      let result;
      try { result = await request; } catch { live(signal); throw verificationError("load_failed"); }
      live(signal);
      if (result?.error?.code === "42501") throw verificationError("access_denied");
      if (!result || result.error || !verificationOwn(result, "data")) throw verificationError("load_failed");
      const rows = responseRows(result.data, "load_failed");
      if (rows.length > VERIFICATION_LIMITS.page + 1
        || (!checked.data.search && rows.some((row) => row.verification_status !== "pending"))) throw verificationError("load_failed");
      live(signal);
      if (recovery && version === writeVersion && !writing) uncertain = false;
      return { rows: rows.slice(0, VERIFICATION_LIMITS.page), hasMore: rows.length > VERIFICATION_LIMITS.page };
    },

    async decide(rows, status, note = "", { signal } = {}) {
      live(signal);
      if (writing) throw verificationError("invalid_verification", { _form: "A decision is already in progress. Wait for its result." });
      if (uncertain) throw verificationError("save_unconfirmed");
      const checked = validateVerificationDecision(rows, status, note);
      if (Object.keys(checked.errors).length) throw verificationError("invalid_verification", checked.errors);
      const data = checked.data;
      const ids = data.rows.map((row) => row.id);
      writing = true;
      writeVersion += 1;
      try {
        let request;
        try {
          request = query("decide_player_verifications", {
            p_player_ids: ids,
            p_expected_updated_at: data.rows.map((row) => row.updated_at),
            p_status: data.status,
            p_note: data.note,
          }, signal);
        } catch { live(signal); throw verificationError("save_unconfirmed"); }
        live(signal);
        let result;
        // From this point a committed transaction may outlive cancellation or a
        // lost response. Never retry automatically or report it as a failed save.
        try { result = await request; } catch { throw verificationError("save_unconfirmed"); }
        live(signal, true);
        if (result?.error?.code === "42501") throw verificationError("access_denied");
        if (result?.error?.code === "P0001" && result.error.message === "verification_conflict") throw verificationError("decision_conflict");
        if (!result || result.error || !verificationOwn(result, "data")) throw verificationError("save_unconfirmed");
        const updated = responseRows(result.data, "save_unconfirmed");
        const expected = new Set(ids);
        if (updated.length !== ids.length || updated.some((row) => !expected.has(row.id)
          || row.verification_status !== data.status || row.verification_note !== data.note
          || row.decided_by === null || row.decided_at === null)) throw verificationError("save_unconfirmed");
        live(signal, true);
        return updated;
      } catch (error) {
        if (error.code === "save_unconfirmed") uncertain = true;
        throw error;
      } finally { writing = false; }
    },
  };
}
