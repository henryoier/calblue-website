export function pickupLogicTests(pickup, t) {
  const team = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const venue = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const options = { can_override_fee: true, teams: [{ id: team, name: "CalBlue" }],
    venues: [{ id: venue, name: "Local field", timezone: "America/Los_Angeles", address: null, map_url: null }] };
  const form = (values = {}) => ({ team_id: team, venue_id: venue, title: "Pickup game",
    field_label: "", timezone: "America/Los_Angeles", gather_time: "2026-10-04T09:30",
    start_time: "2026-10-04T10:00", end_time: "2026-10-04T12:00", capacity: "22",
    registration_opens_at: "2026-10-01T08:00", registration_closes_at: "2026-10-04T09:00",
    kit_color: "Blue", notes: "", ...values });
  const validate = (values = {}, config = options) => pickup.validatePickupDetails(form(values), config);
  const errorFor = (value, zone) => {
    let error;
    try { pickup.pickupLocalToInstant(value, zone); } catch (caught) { error = caught; }
    t.equal(error?.code, "invalid_pickup");
    return error;
  };

  t.test("pickup immutable limits match bounded editor and pagination", () => {
    t.assert(Object.isFrozen(pickup.PICKUP_LIMITS));
    t.equal(pickup.PICKUP_LIMITS.page, 20);
    t.equal(pickup.PICKUP_LIMITS.capacity, 10000);
    t.equal(pickup.PICKUP_LIMITS.fee, 99999999.99);
    t.equal(pickup.PICKUP_LIMITS.reason, 2000);
  });

  t.test("pickup runtime Gregorian formatter provides distinguishable positive and negative eras", () => {
    const formatter = new Intl.DateTimeFormat("en-CA-u-nu-latn", { calendar: "gregory", timeZone: "UTC",
      era: "short", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
    const positive = formatter.formatToParts(new Date(0));
    const negative = formatter.formatToParts(new Date("0000-01-01T00:00:00Z"));
    const positiveEra = positive.find((part) => part.type === "era")?.value;
    const negativeEra = negative.find((part) => part.type === "era")?.value;
    const diagnostics = JSON.stringify({ calendar: formatter.resolvedOptions().calendar, positive, negative });
    t.equal(formatter.resolvedOptions().calendar, "gregory", diagnostics);
    t.assert(typeof positiveEra === "string" && typeof negativeEra === "string" && positiveEra !== negativeEra, diagnostics);
  });

  t.test("pickup explicitly selects Gregorian when ISO8601 formatters omit eras", () => {
    const nativeDateTimeFormat = Intl.DateTimeFormat;
    let selectedCalendar;
    try {
      Intl.DateTimeFormat = function (locale, settings) {
        if (settings.timeZone !== "America/Denver") return new nativeDateTimeFormat(locale, settings);
        selectedCalendar = settings.calendar;
        const formatter = new nativeDateTimeFormat("en-CA-u-nu-latn", { ...settings, calendar: "gregory" });
        return { formatToParts(value) {
          const parts = formatter.formatToParts(value);
          // Reproduce ICU's ISO8601 calendar omitting era despite era:'short'.
          return settings.calendar === "gregory" ? parts : parts.filter((part) => part.type !== "era");
        } };
      };
      t.equal(pickup.pickupLocalInput("2026-10-04T16:00:00Z", "America/Denver"), "2026-10-04T10:00");
      t.equal(pickup.pickupLocalToInstant("2026-10-04T10:00", "America/Denver"), "2026-10-04T16:00:00Z");
      t.equal(selectedCalendar, "gregory");
      let error;
      try { pickup.pickupLocalInput("0001-01-01T00:00:00Z", "America/Denver"); } catch (caught) { error = caught; }
      t.equal(error?.code, "invalid_pickup");
    } finally { Intl.DateTimeFormat = nativeDateTimeFormat; }
  });

  t.test("pickup compares era tokens from its formatter instead of assuming AD or BC labels", () => {
    const nativeDateTimeFormat = Intl.DateTimeFormat;
    const variants = [
      { zone: "America/Chicago", positive: "CE", negative: "BCE", instant: "2026-10-04T15:00:00Z" },
      { zone: "America/New_York", positive: "Common Era", negative: "Before Common Era", instant: "2026-10-04T14:00:00Z" },
    ];
    try {
      // These zones have not been requested earlier in this suite, so each
      // creates a formatter under the controlled labels, regardless of ICU's
      // actual AD/BC versus CE/BCE wording on this test runtime.
      Intl.DateTimeFormat = function (locale, settings) {
        const formatter = new nativeDateTimeFormat(locale, settings);
        const originalPositive = formatter.formatToParts(new Date(0)).find((part) => part.type === "era")?.value;
        const labels = variants.find((variant) => variant.zone === settings.timeZone);
        if (!labels) return formatter;
        return { formatToParts(value) {
          return formatter.formatToParts(value).map((part) => part.type === "era"
            ? { ...part, value: part.value === originalPositive ? labels.positive : labels.negative } : part);
        } };
      };
      for (const variant of variants) {
        t.equal(pickup.pickupLocalInput(variant.instant, variant.zone), "2026-10-04T10:00");
        t.equal(pickup.pickupLocalToInstant("2026-10-04T10:00", variant.zone), variant.instant);
        let error;
        try { pickup.pickupLocalInput("0001-01-01T00:00:00Z", variant.zone); } catch (caught) { error = caught; }
        t.equal(error?.code, "invalid_pickup");
      }
    } finally { Intl.DateTimeFormat = nativeDateTimeFormat; }
  });

  t.test("pickup times use the venue timezone rather than the host timezone", () => {
    t.equal(pickup.pickupLocalToInstant("2026-10-04T10:00", "America/Los_Angeles"), "2026-10-04T17:00:00Z");
    t.equal(pickup.pickupLocalToInstant("2026-01-04T10:00", "America/Los_Angeles"), "2026-01-04T18:00:00Z");
    t.equal(pickup.pickupLocalToInstant("2026-10-04T10:00", "UTC"), "2026-10-04T10:00:00Z");
    t.equal(pickup.pickupLocalInput("2026-10-05T01:00:00Z", "America/Los_Angeles"), "2026-10-04T18:00");
    t.equal(pickup.pickupLocalInput(null, "UTC"), "");
  });

  t.test("pickup timezone conversion handles quarter-hour offsets and non-hour DST", () => {
    t.equal(pickup.pickupLocalToInstant("2026-10-04T10:00", "Asia/Kathmandu"), "2026-10-04T04:15:00Z");
    t.equal(pickup.pickupLocalToInstant("2026-01-04T10:00", "Australia/Lord_Howe"), "2026-01-03T23:00:00Z");
    t.equal(pickup.pickupLocalToInstant("2026-07-04T10:00", "Australia/Lord_Howe"), "2026-07-03T23:30:00Z");
  });

  t.test("pickup accepts supported single-component IANA legacy identifiers", () => {
    t.equal(pickup.pickupLocalToInstant("2026-10-04T10:00", "CET"), "2026-10-04T08:00:00Z");
    t.equal(pickup.pickupLocalToInstant("2026-01-04T10:00", "CET"), "2026-01-04T09:00:00Z");
    t.equal(pickup.pickupLocalToInstant("2026-10-04T10:00", "GMT0"), "2026-10-04T10:00:00Z");
    t.equal(pickup.pickupLocalToInstant("2026-10-04T10:00", "PST8PDT"), "2026-10-04T17:00:00Z");
  });

  t.test("pickup rejects DST gaps and ambiguous folds instead of shifting them", () => {
    t.assert(errorFor("2026-03-08T02:30", "America/Los_Angeles").fields._form.includes("does not exist"));
    t.assert(errorFor("2026-11-01T01:30", "America/Los_Angeles").fields._form.includes("occurs twice"));
    t.assert(errorFor("2026-10-04T02:15", "Australia/Lord_Howe").fields._form.includes("does not exist"));
    t.assert(errorFor("2026-04-05T01:45", "Australia/Lord_Howe").fields._form.includes("occurs twice"));
    t.assert(errorFor("2011-12-30T12:00", "Pacific/Apia").fields._form.includes("does not exist"));
  });

  t.test("pickup accepts times adjacent to daylight-saving boundaries", () => {
    t.equal(pickup.pickupLocalToInstant("2026-03-08T01:59:59.999999", "America/Los_Angeles"), "2026-03-08T09:59:59.999999Z");
    t.equal(pickup.pickupLocalToInstant("2026-03-08T03:00", "America/Los_Angeles"), "2026-03-08T10:00:00Z");
    t.equal(pickup.pickupLocalToInstant("2026-11-01T02:00", "America/Los_Angeles"), "2026-11-01T10:00:00Z");
  });

  t.test("pickup preserves microseconds and early years without Date rounding", () => {
    t.equal(pickup.pickupLocalToInstant("0099-02-01T00:00:01.123456", "UTC"), "0099-02-01T00:00:01.123456Z");
    t.equal(pickup.pickupLocalToInstant("0001-01-01T00:00", "UTC"), "0001-01-01T00:00:00Z");
    t.equal(pickup.pickupLocalInput("2026-10-04T17:00:30.123456+00:00", "America/Los_Angeles"), "2026-10-04T10:00:30.123456");
    t.equal(pickup.pickupLocalInput("2026-10-04T17:00:00.000000Z", "America/Los_Angeles"), "2026-10-04T10:00");
  });

  t.test("pickup rejects local BC years and UTC instants outside the supported era", () => {
    for (const [timestamp, timezone] of [["0001-01-01T00:00:00Z", "America/Los_Angeles"],
      ["9999-12-31T23:00:00Z", "Pacific/Kiritimati"], ["0000-12-31T23:00:00Z", "UTC"]]) {
      let error;
      try { pickup.pickupLocalInput(timestamp, timezone); } catch (caught) { error = caught; }
      t.equal(error?.code, "invalid_pickup");
    }
    errorFor("0001-01-01T00:00", "Asia/Tokyo");
    errorFor("9999-12-31T23:00", "America/Los_Angeles");
  });

  t.test("pickup rejects unsupported or malformed timezone inputs without echoing them", () => {
    for (const zone of [undefined, null, {}, [], "", "PRIVATE", "+08:00", "-0800", "0800", "GMT+08:00", "2026-01-01",
      "/UTC", "UTC/", "America//Los_Angeles", "PRIVATE/SECRET", "America/Los_Angeles\n", "America/Los_Angeles".repeat(20)]) {
      const error = errorFor("2026-10-04T10:00", zone);
      t.assert(!JSON.stringify(error).includes("PRIVATE"));
    }
  });

  t.test("pickup local datetimes reject invalid calendar dates, zones and types", () => {
    for (const value of [null, undefined, {}, [], 0, "2026-10-04", "2026-10-04 10:00", "2026-10-04T10:00Z",
      "2026-02-29T10:00", "2024-04-31T10:00", "0000-01-01T00:00", "2026-10-04T24:00",
      "2026-10-04T10:60", "2026-10-04T10:00:60", "2026-10-04T10:00:00.1234567", "2026-10-04T10:00\n"]) {
      errorFor(value, "UTC");
    }
    t.equal(pickup.pickupLocalToInstant("2024-02-29T10:00", "UTC"), "2024-02-29T10:00:00Z");
  });

  t.test("pickup form validation trims fields, converts dates and strips unrelated input", () => {
    const result = validate({ title: "  Match  ", field_label: " Field 2 ", notes: "  First\nSecond\tline ", forged_roles: ["admin"], status: "published" });
    t.equal(Object.keys(result.errors).length, 0);
    t.equal(result.data.title, "Match");
    t.equal(result.data.field_label, "Field 2");
    t.equal(result.data.notes, "First\nSecond\tline");
    t.equal(result.data.start_time, "2026-10-04T17:00:00Z");
    t.equal(result.data.capacity, 22);
    t.assert(!Object.prototype.hasOwnProperty.call(result.data, "status"));
    t.assert(!Object.prototype.hasOwnProperty.call(result.data, "fee_override"));
    t.assert(!Object.prototype.hasOwnProperty.call(result.data, "forged_roles"));
  });

  t.test("pickup optional form values normalize to null and administrators may create teamless games", () => {
    const result = validate({ team_id: "", venue_id: "", field_label: " ", gather_time: "", end_time: "", capacity: "",
      registration_opens_at: "", registration_closes_at: "", kit_color: "", notes: "", fee_override: "" });
    t.equal(Object.keys(result.errors).length, 0);
    for (const field of ["team_id", "venue_id", "field_label", "gather_time", "end_time", "capacity", "registration_opens_at", "registration_closes_at", "kit_color", "notes", "fee_override"]) t.equal(result.data[field], null);
  });

  t.test("pickup organiser validation rejects teamless, unavailable teams and any fee key", () => {
    const config = { ...options, can_override_fee: false };
    t.equal(Object.keys(validate({}, config).errors).length, 0);
    t.assert(Boolean(validate({ team_id: "" }, config).errors.team_id));
    t.assert(Boolean(validate({ team_id: venue }, config).errors.team_id));
    for (const fee_override of [null, "", 0, "10.50"]) t.assert(Boolean(validate({ fee_override }, config).errors.fee_override));
  });

  t.test("pickup venue selection is authoritative and cannot silently reinterpret times", () => {
    t.assert(Boolean(validate({ timezone: "UTC" }).errors.timezone));
    t.assert(Boolean(validate({ venue_id: team }).errors.venue_id));
    t.equal(Object.keys(validate({ venue_id: null, timezone: "UTC" }).errors).length, 0);
    t.equal(validate({ venue_id: null, timezone: "UTC" }).data.start_time, "2026-10-04T10:00:00Z");
    for (const field of ["team_id", "venue_id"]) {
      for (const value of [0, {}, [], "bad,id.eq.1"]) t.assert(Boolean(validate({ [field]: value }).errors[field]));
    }
  });

  t.test("pickup text bounds and control characters fail with safe field messages", () => {
    for (const field of ["title", "field_label", "kit_color", "notes"]) {
      t.equal(Object.keys(validate({ [field]: "x".repeat(pickup.PICKUP_LIMITS[field]) }).errors).length, 0);
      for (const value of ["x".repeat(pickup.PICKUP_LIMITS[field] + 1), "PRIVATE\u0000", "PRIVATE\u007f", [], {}, 7, false]) {
        const result = validate({ [field]: value });
        t.assert(Boolean(result.errors[field]));
        t.assert(!JSON.stringify(result.errors).includes("PRIVATE"));
      }
    }
    t.assert(Boolean(validate({ title: " \t " }).errors.title));
    t.assert(Boolean(validate({ field_label: "First\nSecond" }).errors.field_label));
    t.assert(Boolean(pickup.validatePickupDetails(null, options).errors._form));
  });

  t.test("pickup text limits count Unicode codepoints like PostgreSQL char_length", () => {
    for (const field of ["title", "field_label", "kit_color", "notes"]) {
      const accepted = "😀".repeat(pickup.PICKUP_LIMITS[field]);
      t.equal(Object.keys(validate({ [field]: accepted }).errors).length, 0);
      t.equal(validate({ [field]: accepted }).data[field], accepted);
      t.assert(Boolean(validate({ [field]: accepted + "😀" }).errors[field]));
      for (const value of ["Name\ud800", "Name\udfff", "Name\u0085"]) {
        t.assert(Boolean(validate({ [field]: value }).errors[field]));
      }
    }
  });

  t.test("pickup capacities are finite integers and never coerce arrays or booleans", () => {
    for (const capacity of [1, 10000, "00022"]) t.equal(Object.keys(validate({ capacity }).errors).length, 0);
    for (const capacity of [0, -1, 10001, 1.5, NaN, Infinity, false, [], {}, "1e2", "0x20", "2.2", " "]) t.assert(Boolean(validate({ capacity }).errors.capacity));
  });

  t.test("pickup fees are exact bounded decimal inputs and reject nonfinite or excess precision", () => {
    for (const fee_override of [0, "0", "0.00", "12.50", 99999999.99, null, ""]) t.equal(Object.keys(validate({ fee_override }).errors).length, 0);
    t.equal(validate({ fee_override: "12.50" }).data.fee_override, 12.5);
    for (const fee_override of [-1, NaN, Infinity, 100000000, "1.001", "1e2", "0x10", {}, [], false]) t.assert(Boolean(validate({ fee_override }).errors.fee_override));
  });

  t.test("pickup validates gather, end, closing and opening order in actual instants", () => {
    t.assert(Boolean(validate({ gather_time: "2026-10-04T10:01" }).errors.gather_time));
    t.assert(Boolean(validate({ end_time: "2026-10-04T10:00" }).errors.end_time));
    t.assert(Boolean(validate({ registration_closes_at: "2026-10-04T10:01" }).errors.registration_closes_at));
    t.assert(Boolean(validate({ registration_opens_at: "2026-10-04T09:01" }).errors.registration_opens_at));
    t.assert(Boolean(validate({ registration_closes_at: null, registration_opens_at: "2026-10-04T10:01" }).errors.registration_opens_at));
    t.equal(Object.keys(validate({ gather_time: "2026-10-04T10:00", registration_closes_at: "2026-10-04T10:00", registration_opens_at: "2026-10-04T10:00" }).errors).length, 0);
  });

  t.test("pickup compares timestamp fractions at microsecond precision", () => {
    const result = validate({ gather_time: "2026-10-04T10:00:00.000002", start_time: "2026-10-04T10:00:00.000001", end_time: "2026-10-04T10:00:00.000003" });
    t.assert(Boolean(result.errors.gather_time));
    t.assert(!result.errors.end_time);
  });

  t.test("pickup form errors expose DST reasons on the relevant field", () => {
    const result = validate({ start_time: "2026-11-01T01:30", gather_time: null, end_time: null,
      registration_opens_at: null, registration_closes_at: null });
    t.assert(result.errors.start_time.includes("occurs twice"));
    t.assert(!Object.prototype.hasOwnProperty.call(result.data, "start_time"));
  });

  t.test("pickup unchanged edit fields preserve original offset and all microseconds", () => {
    const timestamp = "2026-10-04T17:00:30.123456+00:00";
    const originalRow = { timezone: "America/Los_Angeles", start_time: timestamp };
    const value = pickup.pickupLocalInput(timestamp, originalRow.timezone);
    const result = validate({ start_time: value }, { ...options, originalRow });
    t.equal(Object.keys(result.errors).length, 0);
    t.equal(result.data.start_time, timestamp);
    t.equal(originalRow.start_time, timestamp);
  });

  t.test("pickup can retain an existing known fold instant but cannot invent one", () => {
    const originalRow = { timezone: "America/Los_Angeles", start_time: "2026-11-01T09:30:00.000001Z" };
    const values = { start_time: "2026-11-01T01:30:00.000001", gather_time: null, end_time: null,
      registration_opens_at: null, registration_closes_at: null };
    const result = validate(values, { ...options, originalRow });
    t.equal(Object.keys(result.errors).length, 0);
    t.equal(result.data.start_time, originalRow.start_time);
    t.assert(Boolean(validate({ ...values, start_time: "2026-11-01T01:31" }, { ...options, originalRow }).errors.start_time));
  });
}
