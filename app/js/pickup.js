// Client-side checks improve the editor; the RPCs remain the authority for
// scope, lifecycle, fees and atomic compare-and-set writes. No direct tables.
export const PICKUP_LIMITS = Object.freeze({
  page: 20, title: 200, field_label: 200, kit_color: 100, notes: 4000,
  reason: 2000, capacity: 10000, fee: 99999999.99, options: 1000,
});

const PICKUP_EDIT_FIELDS = [
  "team_id", "venue_id", "title", "field_label", "timezone", "gather_time",
  "start_time", "end_time", "capacity", "registration_opens_at",
  "registration_closes_at", "kit_color", "notes",
];
const PICKUP_TIME_FIELDS = ["gather_time", "start_time", "end_time", "registration_opens_at", "registration_closes_at"];
const PICKUP_ROW_FIELDS = [
  "id", "team_id", "venue_id", "title", "field_label", "timezone", "gather_time",
  "start_time", "end_time", "game_date", "capacity", "registration_opens_at",
  "registration_closes_at", "kit_color", "notes", "fee_override", "status",
  "cancellation_reason", "updated_at", "created_at",
];
const PICKUP_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const pickupOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const pickupObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const pickupId = (value) => typeof value === "string" && PICKUP_UUID.test(value) ? value.toLowerCase() : null;
const pickupCharacters = (value) => [...value].length;
const pickupBadUnicode = (value) => [...value].some((character) => character.length === 1
  && character.charCodeAt(0) >= 0xd800 && character.charCodeAt(0) <= 0xdfff);
const pickupTextControls = (field) => ["notes", "reason"].includes(field)
  ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/ : /[\u0000-\u001f\u007f-\u009f]/;
const pickupFormatters = new Map();
const pickupPositiveEras = new WeakMap();

function pickupError(code, fields) {
  const error = new Error(code);
  error.code = code;
  if (fields) error.fields = { ...fields };
  return error;
}

function pickupCalendar(year, month, day, hour = 0, minute = 0, second = 0) {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1 && year <= 9999 && month >= 1 && month <= 12 && day >= 1
    && day <= days[month - 1] && hour >= 0 && hour < 24 && minute >= 0 && minute < 60 && second >= 0 && second < 60;
}

function pickupUtc(parts) {
  // Date.UTC interprets years 0..99 as 1900..1999. Explicit full-year assignment
  // avoids that quirk; only validated calendar values reach this function.
  const date = new Date(0);
  date.setUTCFullYear(parts[0], parts[1] - 1, parts[2]);
  date.setUTCHours(parts[3] || 0, parts[4] || 0, parts[5] || 0, 0);
  return date.getTime();
}

function pickupTimestamp(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return null;
  const parts = match.slice(1, 7).map(Number);
  if (!pickupCalendar(...parts) || Number(match[9] || 0) > 23 || Number(match[10] || 0) > 59) return null;
  const offset = (Number(match[9] || 0) * 60 + Number(match[10] || 0)) * (match[8] === "-" ? -1 : 1);
  const seconds = pickupUtc(parts) / 1000 - offset * 60;
  const micros = Number((match[7] || "").padEnd(6, "0"));
  const utcYear = new Date(seconds * 1000).getUTCFullYear();
  if (utcYear < 1 || utcYear > 9999) return null;
  return { seconds, micros, fraction: match[7] || "" };
}

function pickupCompare(left, right) {
  const a = pickupTimestamp(left);
  const b = pickupTimestamp(right);
  return a.seconds === b.seconds ? a.micros - b.micros : a.seconds - b.seconds;
}

function pickupFormatter(timezone) {
  // IANA also contains legacy single-component names such as CET and GMT0.
  // Keep identifier syntax narrow, reject raw offsets, then ask Intl whether
  // the identifier is supported. The database independently validates its name.
  if (typeof timezone !== "string" || timezone.length > 100
    || !/^[A-Za-z_][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/.test(timezone)) {
    throw pickupError("invalid_pickup", { _form: "Choose a valid IANA timezone, such as America/Los_Angeles." });
  }
  if (pickupFormatters.has(timezone)) return pickupFormatters.get(timezone);
  try {
    const formatter = new Intl.DateTimeFormat("en-CA-u-ca-iso8601-nu-latn", {
      timeZone: timezone, era: "short", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    });
    // ICU versions/locales differ in era wording (AD, CE, etc.). Compare the
    // era against a known positive-year instant using this exact formatter,
    // rather than treating any particular translated label as a protocol.
    const positiveEra = formatter.formatToParts(new Date(0)).find((part) => part.type === "era")?.value;
    if (typeof positiveEra !== "string" || !positiveEra) throw new Error("Era unavailable");
    pickupPositiveEras.set(formatter, positiveEra);
    if (pickupFormatters.size >= 32) pickupFormatters.delete(pickupFormatters.keys().next().value);
    pickupFormatters.set(timezone, formatter);
    return formatter;
  } catch {
    throw pickupError("invalid_pickup", { _form: "This timezone is unavailable. Choose a valid IANA timezone." });
  }
}

function pickupZonedParts(instant, formatter) {
  const found = {};
  for (const part of formatter.formatToParts(new Date(instant))) {
    if (part.type === "era") found.era = part.value;
    if (["year", "month", "day", "hour", "minute", "second"].includes(part.type)) found[part.type] = Number(part.value);
  }
  const parts = [found.year, found.month, found.day, found.hour, found.minute, found.second];
  if (!pickupPositiveEras.has(formatter) || found.era !== pickupPositiveEras.get(formatter)
    || !pickupCalendar(...parts)) throw pickupError("invalid_pickup", { _form: "Choose a date from year 0001 through 9999." });
  return parts;
}

function pickupLocalString(parts, fraction = "") {
  const [year, month, day, hour, minute, second] = parts.map((part, index) => String(part).padStart(index === 0 ? 4 : 2, "0"));
  const trimmed = fraction.replace(/0+$/, "");
  return `${year}-${month}-${day}T${hour}:${minute}` + (second !== "00" || trimmed ? `:${second}${trimmed ? "." + trimmed : ""}` : "");
}

export function pickupLocalInput(timestamp, timezone) {
  if (timestamp === null || timestamp === "") return "";
  const parsed = pickupTimestamp(timestamp);
  if (!parsed) throw pickupError("invalid_pickup", { _form: "Reload the game before editing its times." });
  return pickupLocalString(pickupZonedParts(parsed.seconds * 1000, pickupFormatter(timezone)), parsed.fraction);
}

export function pickupLocalToInstant(value, timezone) {
  const formatter = pickupFormatter(timezone);
  const match = typeof value === "string" && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?$/.exec(value);
  if (!match) throw pickupError("invalid_pickup", { _form: "Enter a valid local date and time." });
  const parts = match.slice(1, 7).map((part) => Number(part || 0));
  if (!pickupCalendar(...parts)) throw pickupError("invalid_pickup", { _form: "Enter a valid local date and time." });
  const naive = pickupUtc(parts);
  const offsets = new Set();
  // Sampling both sides of the requested date discovers transition offsets,
  // including non-hour DST changes and skipped whole days. A round-trip below
  // admits only exact instants: zero matches is a gap, two matches is a fold.
  for (let hours = -48; hours <= 48; hours += 1) {
    const sample = naive + hours * 3600000;
    const year = new Date(sample).getUTCFullYear();
    if (year < 1 || year > 9999) continue;
    try { offsets.add(pickupUtc(pickupZonedParts(sample, formatter)) - sample); } catch { /* outside supported year */ }
  }
  const matches = [];
  for (const offset of offsets) {
    const candidate = naive - offset;
    try {
      if (pickupZonedParts(candidate, formatter).every((part, index) => part === parts[index])) matches.push(candidate);
    } catch { /* outside supported year */ }
  }
  if (!matches.length) throw pickupError("invalid_pickup", { _form: "This local time does not exist in the chosen timezone. Choose another time." });
  if (matches.length !== 1) throw pickupError("invalid_pickup", { _form: "This local time occurs twice during a clock change. Choose an unambiguous time." });
  const instant = new Date(matches[0]).toISOString().slice(0, 19) + (match[7] ? "." + match[7] : "") + "Z";
  if (!pickupTimestamp(instant)) throw pickupError("invalid_pickup", { _form: "Choose a date from year 0001 through 9999." });
  return instant;
}

function pickupValidatedText(value, field, errors, required = false) {
  if (value !== null && value !== undefined && typeof value !== "string") {
    errors[field] = "Enter text for this field.";
    return undefined;
  }
  const text = typeof value === "string" ? value.trim() : "";
  if (required && !text) errors[field] = field === "reason" ? "Enter a reason for cancelling this game." : "Enter a game title.";
  else if (pickupCharacters(text) > PICKUP_LIMITS[field]) errors[field] = `Use ${PICKUP_LIMITS[field]} characters or fewer.`;
  else if (pickupTextControls(field).test(text) || pickupBadUnicode(text)) errors[field] = "Remove unsupported control characters.";
  else return text || null;
  return undefined;
}

function pickupExistingText(value, field, nullable = true) {
  // Existing rows predate this editor's trimming rules. Reading must not turn
  // empty/space-bearing stored values into a different snapshot or poison the
  // whole page. Writes still normalize newly submitted form values above.
  return (nullable && value === null) || (typeof value === "string"
    && pickupCharacters(value) <= PICKUP_LIMITS[field]
    && !pickupTextControls(field).test(value) && !pickupBadUnicode(value));
}

function pickupMoney(value) {
  if (value === null || value === "") return null;
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  const text = typeof value === "string" ? value.trim() : String(value);
  if (!/^\d{1,8}(?:\.\d{1,2})?$/.test(text)) return undefined;
  const result = Number(text);
  return Number.isFinite(result) && result >= 0 && result <= PICKUP_LIMITS.fee ? result : undefined;
}

function pickupDetails(values, { local = false, options = null, originalRow = null, decoding = false } = {}) {
  const source = pickupObject(values) ? values : {};
  const data = {};
  const errors = {};
  if (source !== values) errors._form = "Enter the game details.";
  for (const field of ["title", "field_label", "kit_color", "notes"]) {
    if (decoding) {
      if (pickupExistingText(source[field], field, field !== "title")) data[field] = source[field];
      else errors[field] = "Reload the game details.";
    } else data[field] = pickupValidatedText(source[field], field, errors, field === "title");
  }
  for (const field of ["team_id", "venue_id"]) {
    const value = source[field];
    if (value === null || value === "" || (local && value === undefined)) data[field] = null;
    else if (pickupId(value)) data[field] = pickupId(value);
    else errors[field] = "Choose an available option.";
  }
  let timezone = source.timezone;
  if (typeof timezone === "string") timezone = timezone.trim();
  if (options) {
    if (data.team_id !== null && !options.teams?.some((team) => team.id === data.team_id)) errors.team_id = "Choose a team you can manage.";
    if (!options.can_override_fee && data.team_id === null) errors.team_id = "Choose a team you can manage.";
    if (data.venue_id) {
      const venue = options.venues?.find((item) => item.id === data.venue_id);
      if (!venue) errors.venue_id = "Choose an available venue.";
      else if (timezone !== venue.timezone) errors.timezone = "Use the selected venue's timezone.";
    }
  }
  try { pickupFormatter(timezone); data.timezone = timezone; }
  catch { errors.timezone = "Choose a valid IANA timezone, such as America/Los_Angeles."; }
  for (const field of PICKUP_TIME_FIELDS) {
    const value = source[field];
    if (value === "" || value === null || (local && value === undefined)) {
      if (field === "start_time") errors[field] = "Enter a start time.";
      else data[field] = null;
    } else if (!local) {
      if (pickupTimestamp(value)) data[field] = value;
      else errors[field] = "Enter a valid date and time with a timezone.";
    } else if (!errors.timezone) {
      try {
        // Preserve a known instant, including microseconds or a fall-back fold,
        // when its local form value was not edited in the same timezone.
        if (pickupObject(originalRow) && originalRow.timezone === timezone && pickupTimestamp(originalRow[field])
          && pickupLocalInput(originalRow[field], timezone) === value) data[field] = originalRow[field];
        else data[field] = pickupLocalToInstant(value, timezone);
      } catch (error) { errors[field] = error.fields?._form || "Enter a valid local date and time."; }
    }
  }
  const capacity = source.capacity;
  if (capacity === "" || capacity === null || (local && capacity === undefined)) data.capacity = null;
  else {
    const number = typeof capacity === "number" ? capacity : typeof capacity === "string" && /^\d+$/.test(capacity.trim()) ? Number(capacity.trim()) : NaN;
    if (!Number.isInteger(number) || number < 1 || number > PICKUP_LIMITS.capacity) errors.capacity = "Enter a whole number from 1 to 10000, or leave it blank.";
    else data.capacity = number;
  }
  if (pickupOwn(source, "fee_override")) {
    const fee = pickupMoney(source.fee_override);
    if (options && !options.can_override_fee) errors.fee_override = "Only an administrator can change the fee override.";
    else if (fee === undefined) errors.fee_override = "Enter an amount from 0 to 99999999.99 with at most two decimal places, or leave it blank.";
    else data.fee_override = fee;
  }
  if (data.start_time) {
    if (data.gather_time && pickupCompare(data.gather_time, data.start_time) > 0) errors.gather_time = "Gather time must be at or before the start.";
    if (data.end_time && pickupCompare(data.end_time, data.start_time) <= 0) errors.end_time = "End time must be after the start.";
    if (data.registration_closes_at && pickupCompare(data.registration_closes_at, data.start_time) > 0) errors.registration_closes_at = "Registration must close at or before the start.";
    const limit = data.registration_closes_at || data.start_time;
    if (data.registration_opens_at && pickupCompare(data.registration_opens_at, limit) > 0) errors.registration_opens_at = "Registration must open at or before closing and the game start.";
  }
  if (!local && PICKUP_EDIT_FIELDS.some((field) => !pickupOwn(source, field))) errors._form = "Complete every game field before saving.";
  return { data, errors };
}

// Form values are datetime-local values in the selected venue's timezone, never
// the browser timezone. Pass {...options, originalRow: row} while editing.
export function validatePickupDetails(form, options = {}) {
  return pickupDetails(form, { local: true, options, originalRow: options.originalRow || null });
}

function pickupCleanRow(source) {
  if (!pickupObject(source) || PICKUP_ROW_FIELDS.some((field) => !pickupOwn(source, field))
    || !pickupId(source.id) || !pickupTimestamp(source.updated_at) || !pickupTimestamp(source.created_at)
    || !["draft", "published", "reg_closed", "completed", "locked", "cancelled"].includes(source.status)
    || typeof source.game_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(source.game_date)
    || !pickupCalendar(...source.game_date.split("-").map(Number))) return null;
  const checked = pickupDetails(source, { decoding: true });
  if (Object.keys(checked.errors).length || PICKUP_EDIT_FIELDS.some((field) => {
    if (["team_id", "venue_id"].includes(field)) return source[field] !== null && !pickupId(source[field]);
    return checked.data[field] !== source[field];
  }) || pickupMoney(source.fee_override) === undefined
    || !(source.fee_override === null || typeof source.fee_override === "number")
    || !(source.cancellation_reason === null || typeof source.cancellation_reason === "string")) return null;
  if (!pickupExistingText(source.cancellation_reason, "reason")) return null;
  try { if (pickupLocalInput(source.start_time, source.timezone).slice(0, 10) !== source.game_date) return null; } catch { return null; }
  const row = {};
  for (const field of PICKUP_ROW_FIELDS) row[field] = source[field];
  for (const field of ["id", "team_id", "venue_id"]) row[field] = pickupId(row[field]);
  row.fee_override = pickupMoney(row.fee_override);
  return row;
}

function pickupCleanOptions(source) {
  if (!pickupObject(source) || ["can_override_fee", "teams", "venues"].some((field) => !pickupOwn(source, field))
    || typeof source.can_override_fee !== "boolean"
    || !Array.isArray(source.teams) || !Array.isArray(source.venues)
    || source.teams.length > PICKUP_LIMITS.options || source.venues.length > PICKUP_LIMITS.options) return null;
  const result = { can_override_fee: source.can_override_fee, teams: [], venues: [] };
  for (const field of ["teams", "venues"]) {
    const seen = new Set();
    for (const item of source[field]) {
      if (!pickupObject(item) || !pickupOwn(item, "id") || !pickupOwn(item, "name") || !pickupId(item.id)
        || seen.has(pickupId(item.id)) || typeof item.name !== "string"
        || pickupCharacters(item.name) > 1000 || /[\u0000-\u001f\u007f-\u009f]/.test(item.name) || pickupBadUnicode(item.name)) return null;
      const clean = { id: pickupId(item.id), name: item.name };
      seen.add(clean.id);
      if (field === "venues") {
        if (["timezone", "address", "map_url"].some((key) => !pickupOwn(item, key))
          || !(item.address === null || (typeof item.address === "string" && pickupCharacters(item.address) <= 4000 && !pickupBadUnicode(item.address)))
          || !(item.map_url === null || (typeof item.map_url === "string" && pickupCharacters(item.map_url) <= 4000 && !pickupBadUnicode(item.map_url)))) return null;
        try { pickupFormatter(item.timezone); } catch { return null; }
        clean.timezone = item.timezone;
        clean.address = item.address;
        // The editor does not navigate this field. If rendered as a link later,
        // the DOM URL allowlist must still validate its scheme and destination.
        clean.map_url = item.map_url;
      }
      result[field].push(clean);
    }
  }
  return result;
}

export function createPickupService({ client, isCurrent = () => true }) {
  if (!client || typeof client.rpc !== "function") throw pickupError("load_failed");
  let writing = false;
  let uncertain = false;
  let writeVersion = 0;
  let available = null;

  function live(signal, dispatched = false) {
    let current = false;
    try { current = isCurrent() === true && !signal?.aborted; } catch { /* fail closed */ }
    if (!current) throw pickupError(dispatched ? "save_unconfirmed" : "stale_request");
  }

  function query(name, parameters, signal) {
    const request = client.rpc(name, parameters);
    return signal && typeof request?.abortSignal === "function" ? request.abortSignal(signal) : request;
  }

  function cleanRows(data, code, maximum) {
    if (!Array.isArray(data) || data.length > maximum) throw pickupError(code);
    const seen = new Set();
    return data.map((source) => {
      const row = pickupCleanRow(source);
      if (!row || seen.has(row.id)) throw pickupError(code);
      seen.add(row.id);
      return row;
    });
  }

  async function read(name, parameters, signal) {
    live(signal);
    let request;
    try { request = query(name, parameters, signal); } catch { live(signal); throw pickupError("load_failed"); }
    live(signal);
    let response;
    try { response = await request; } catch { live(signal); throw pickupError("load_failed"); }
    live(signal);
    if (response?.error?.code === "42501") throw pickupError("access_denied");
    if (!response || response.error || !pickupOwn(response, "data")) throw pickupError("load_failed");
    return response.data;
  }

  function ready(signal) {
    live(signal);
    if (writing) throw pickupError("invalid_pickup", { _form: "A change is already in progress. Wait for its result." });
    if (uncertain) throw pickupError("save_unconfirmed");
  }

  async function write(name, parameters, validate, signal) {
    ready(signal);
    writing = true;
    writeVersion += 1;
    try {
      let request;
      try { request = query(name, parameters, signal); } catch { throw pickupError("save_unconfirmed"); }
      live(signal, true);
      let response;
      // Network failure, abort or malformed success may hide a committed write.
      // Only an explicit new list read can re-enable user-initiated retries.
      try { response = await request; } catch { throw pickupError("save_unconfirmed"); }
      live(signal, true);
      if (response?.error?.code === "42501") throw pickupError("access_denied");
      if (response?.error?.code === "P0001" && response.error.message === "pickup_conflict") throw pickupError("pickup_conflict");
      if (["22023", "22007", "22008", "23514", "23503"].includes(response?.error?.code)) {
        throw pickupError("invalid_pickup", { _form: "The game could not be changed. Reload its options and check the details." });
      }
      if (!response || response.error || !pickupOwn(response, "data")) throw pickupError("save_unconfirmed");
      const rows = cleanRows(response.data, "save_unconfirmed", 1);
      if (rows.length !== 1 || !validate(rows[0])) throw pickupError("save_unconfirmed");
      live(signal, true);
      return rows[0];
    } catch (error) {
      if (error.code === "save_unconfirmed") uncertain = true;
      throw error;
    } finally { writing = false; }
  }

  return {
    async options({ signal } = {}) {
      const raw = await read("pickup_game_options", {}, signal);
      const clean = pickupCleanOptions(raw);
      if (!clean) throw pickupError("load_failed");
      live(signal);
      available = clean;
      // Callers must not mutate the authorization/options snapshot used below.
      return { can_override_fee: clean.can_override_fee,
        teams: clean.teams.map((team) => ({ ...team })), venues: clean.venues.map((venue) => ({ ...venue })) };
    },

    async list({ offset = 0, signal } = {}) {
      live(signal);
      if (!Number.isInteger(offset) || offset < 0 || offset > 2147483647) {
        throw pickupError("invalid_pickup", { offset: "Reload the list from its first page." });
      }
      const recovery = uncertain && !writing;
      const version = writeVersion;
      const raw = await read("list_pickup_games", { p_offset: offset }, signal);
      if (version !== writeVersion) throw pickupError("stale_request");
      const rows = cleanRows(raw, "load_failed", PICKUP_LIMITS.page + 1);
      live(signal);
      if (recovery && version === writeVersion && !writing) uncertain = false;
      return { rows: rows.slice(0, PICKUP_LIMITS.page), hasMore: rows.length > PICKUP_LIMITS.page };
    },

    async save(details, { row = null, signal } = {}) {
      ready(signal);
      const checked = pickupDetails(details, { options: available });
      const original = row === null ? null : pickupCleanRow(row);
      if (row !== null && (!original || !["draft", "published", "reg_closed"].includes(original.status))) {
        checked.errors._form = "Reload the list and choose an editable game.";
      }
      if (pickupOwn(details || {}, "fee_override") && !available?.can_override_fee) {
        checked.errors.fee_override = "Reload your access before changing a fee override.";
      }
      if (Object.keys(checked.errors).length) throw pickupError("invalid_pickup", checked.errors);
      const data = checked.data;
      const parameters = { p_game_id: original?.id || null, p_expected_updated_at: original?.updated_at || null, p_details: data };
      return write("save_pickup_game", parameters, (saved) => {
        if (original && (saved.id !== original.id || saved.status !== original.status || pickupCompare(saved.updated_at, original.updated_at) <= 0
          || pickupCompare(saved.created_at, original.created_at) !== 0 || saved.cancellation_reason !== original.cancellation_reason)) return false;
        if (!original && saved.status !== "draft") return false;
        if (!pickupOwn(data, "fee_override") && saved.fee_override !== (original?.fee_override ?? null)) return false;
        for (const [field, value] of Object.entries(data)) {
          if (PICKUP_TIME_FIELDS.includes(field)) {
            if (value === null ? saved[field] !== null : !saved[field] || pickupCompare(saved[field], value) !== 0) return false;
          } else if (saved[field] !== value) return false;
        }
        return true;
      }, signal);
    },

    async transition(row, action, reason = null, { signal } = {}) {
      ready(signal);
      const original = pickupCleanRow(row);
      const errors = {};
      const allowed = { publish: ["draft"], close: ["published"], cancel: ["draft", "published", "reg_closed"] };
      if (!pickupOwn(allowed, action) || !original || !allowed[action]?.includes(original.status)) {
        errors._form = "Reload the game and choose an available action.";
      }
      const checkedReason = action === "cancel" ? pickupValidatedText(reason, "reason", errors, true) : null;
      if (action !== "cancel" && reason !== null && reason !== "") errors.reason = "Only cancellation accepts a reason.";
      if (Object.keys(errors).length) throw pickupError("invalid_pickup", errors);
      const expected = { publish: "published", close: "reg_closed", cancel: "cancelled" }[action];
      // The released game-date trigger reapplies a saved venue's current zone
      // on every update, including closure/cancellation. Accept only the exact
      // zone we have already read in validated options, never an arbitrary or
      // racing zone from a success response. All actual instants stay fixed.
      const expectedTimezone = available?.venues.find((venue) => venue.id === original.venue_id)?.timezone || original.timezone;
      return write("transition_pickup_game", {
        p_game_id: original.id, p_expected_updated_at: original.updated_at,
        p_action: action, p_reason: checkedReason,
      }, (saved) => saved.id === original.id && saved.status === expected
        && saved.cancellation_reason === (action === "cancel" ? checkedReason : original.cancellation_reason)
        && pickupCompare(saved.updated_at, original.updated_at) > 0
        && saved.timezone === expectedTimezone
        && [...PICKUP_EDIT_FIELDS.filter((field) => field !== "timezone"), "fee_override", "created_at"].every((field) => {
          const before = original[field];
          return [...PICKUP_TIME_FIELDS, "created_at"].includes(field) && before !== null
            ? saved[field] !== null && pickupCompare(before, saved[field]) === 0 : before === saved[field];
        }), signal);
    },
  };
}
