export function identityLogicTests(identity, t) {
  const validate = (values, options = {}) => identity.validateIdentity(values, { today: "2026-09-17", ...options });
  const creation = (values = {}, options = {}) => validate({ display_name: "Member", ...values }, { creating: true, ...options });

  t.test("identity date helper returns a UTC calendar date", () => {
    t.equal(identity.identityToday(), new Date().toISOString().slice(0, 10));
    t.assert(/^\d{4}-\d{2}-\d{2}$/.test(identity.identityToday()));
  });

  t.test("identity creation supplies conservative defaults and trims names", () => {
    const result = creation({ display_name: "  Member 中文  ", legal_name: "  Legal name  " });
    t.equal(Object.keys(result.errors).length, 0);
    t.equal(result.data.display_name, "Member 中文");
    t.equal(result.data.legal_name, "Legal name");
    t.equal(result.data.is_public, false);
    t.equal(result.data.preferred_number, null);
    t.equal(result.data.date_of_birth, null);
    t.equal(result.data.medical_notes, null);
    t.equal(result.data.default_positions.length, 0);
  });

  t.test("identity display names are required text with a documented length bound", () => {
    for (const display_name of [undefined, null, "", "  ", 0, {}, "x".repeat(101), "A\nB"]) {
      t.assert(Boolean(creation({ display_name }).errors.display_name));
    }
    t.equal(Object.keys(creation({ display_name: "x".repeat(100) }).errors).length, 0);
    t.equal(identity.IDENTITY_LIMITS.display_name, 100);
  });

  t.test("identity optional text clears to null but omitted edit fields are preserved", () => {
    const result = validate({ display_name: "Member", legal_name: " ", medical_notes: null });
    t.equal(result.data.legal_name, null);
    t.equal(result.data.medical_notes, null);
    for (const field of ["jersey_size", "emergency_contact_name", "emergency_contact_phone",
      "date_of_birth", "default_positions", "preferred_number", "is_public"]) {
      t.assert(!Object.prototype.hasOwnProperty.call(result.data, field));
    }
  });

  t.test("identity text limits and multiline medical notes are validated without echoing input", () => {
    for (const field of ["legal_name", "jersey_size", "emergency_contact_name", "emergency_contact_phone", "medical_notes"]) {
      const value = "SENSITIVE".repeat(identity.IDENTITY_LIMITS[field]);
      const result = creation({ [field]: value });
      t.assert(Boolean(result.errors[field]));
      t.assert(!JSON.stringify(result.errors).includes("SENSITIVE"));
      t.assert(Boolean(creation({ [field]: {} }).errors[field]));
      t.assert(Boolean(creation({ [field]: "a\u0000b" }).errors[field]));
    }
    t.equal(creation({ medical_notes: "First line\nSecond\tline" }).data.medical_notes, "First line\nSecond\tline");
  });

  t.test("identity preferred number preserves zero, accepts 99 and clears blanks", () => {
    for (const preferred_number of [0, "0", "00", " 0 "]) t.equal(creation({ preferred_number }).data.preferred_number, 0);
    for (const preferred_number of [99, "99"]) t.equal(creation({ preferred_number }).data.preferred_number, 99);
    for (const preferred_number of [null, undefined, "", "  "]) t.equal(creation({ preferred_number }).data.preferred_number, null);
  });

  t.test("identity preferred number rejects fractions, coercion and out-of-range values", () => {
    for (const preferred_number of [-1, 100, 1.5, NaN, Infinity, "1.5", "99.0", "1e1", "0x10", "+1", "-1", "100", true, []]) {
      t.assert(Boolean(creation({ preferred_number }).errors.preferred_number), "invalid preferred number accepted");
    }
  });

  t.test("identity positions accept comma input or strings and trim/deduplicate without guessing vocabulary", () => {
    const array = [" CM ", "GK", "CM", "", "Custom position"];
    const result = creation({ default_positions: array });
    t.equal(JSON.stringify(result.data.default_positions), JSON.stringify(["CM", "GK", "Custom position"]));
    t.equal(array[0], " CM ");
    t.equal(JSON.stringify(creation({ default_positions: " CM, GK, , CM " }).data.default_positions), '["CM","GK"]');
    t.equal(creation({ default_positions: " , " }).data.default_positions.length, 0);
  });

  t.test("identity positions reject mixed types, excessive counts and overlong entries", () => {
    for (const default_positions of [true, {}, ["CM", 1], [null], ["x".repeat(21)], ["C\nM"],
      Array.from({ length: 13 }, (_, index) => "P" + index)]) {
      t.assert(Boolean(creation({ default_positions }).errors.default_positions));
    }
  });

  t.test("identity public opt-in accepts only literal booleans", () => {
    t.equal(creation({ is_public: true }).data.is_public, true);
    t.equal(creation({ is_public: false }).data.is_public, false);
    for (const is_public of ["true", "false", 1, 0, null, undefined, [], {}]) {
      t.assert(Boolean(creation({ is_public }).errors.is_public));
    }
  });

  t.test("identity dates reject invalid calendars, invalid year zero and future days", () => {
    for (const date_of_birth of ["2026-02-29", "2026-04-31", "2026-13-01", "2026-00-01", "2026-01-00",
      "0000-01-01", "2026-9-17", "2026-09-18", "2026-09-17T00:00:00Z", {}, 20000101]) {
      t.assert(Boolean(creation({ date_of_birth }, { kind: "child" }).errors.date_of_birth));
    }
    t.equal(creation({ date_of_birth: "2024-02-29" }, { kind: "child" }).data.date_of_birth, "2024-02-29");
    t.equal(creation({ date_of_birth: "2026-09-17" }, { kind: "child" }).data.date_of_birth, "2026-09-17");
    t.assert(Boolean(creation({ date_of_birth: "2000-01-01" }, { today: "invalid" }).errors.date_of_birth));
  });

  t.test("identity known minors cannot self-create but guardians can create their identity", () => {
    t.assert(Boolean(creation({ date_of_birth: "2008-09-18" }).errors.date_of_birth));
    t.equal(creation({ date_of_birth: "2008-09-17" }).data.date_of_birth, "2008-09-17");
    t.equal(creation({ date_of_birth: "2016-09-17" }, { kind: "child" }).data.date_of_birth, "2016-09-17");
    t.equal(creation({ date_of_birth: "2000-01-01" }, { kind: "child" }).data.date_of_birth, "2000-01-01");
  });

  t.test("identity leap-day adulthood matches calendar cutoff rather than Date rollover", () => {
    t.assert(Boolean(creation({ date_of_birth: "2008-02-29" }, { today: "2026-02-28" }).errors.date_of_birth));
    t.equal(creation({ date_of_birth: "2008-02-29" }, { today: "2026-03-01" }).data.date_of_birth, "2008-02-29");
    t.equal(creation({ date_of_birth: "2006-02-28" }, { today: "2024-02-29" }).data.date_of_birth, "2006-02-28");
  });

  t.test("identity DOB is create-only, including attempts to fill a previously blank date", () => {
    for (const date_of_birth of [null, "", "2000-01-01"]) {
      const result = validate({ display_name: "Member", date_of_birth });
      t.assert(Boolean(result.errors.date_of_birth));
      t.assert(!Object.prototype.hasOwnProperty.call(result.data, "date_of_birth"));
    }
  });

  t.test("identity validation whitelists writes and ignores inherited optional input", () => {
    const result = creation({ account_id: "forged", guardian_account_id: "forged", id: "forged",
      roles: ["admin"], verification_status: "verified", verification_note: "forged", claim_code: "SECRET",
      payer_account_id: "forged", created_at: "forged", photo_url: "https://example.invalid/photo", home_club_id: "forged" });
    for (const field of ["account_id", "guardian_account_id", "id", "roles", "verification_status", "verification_note",
      "claim_code", "payer_account_id", "created_at", "photo_url", "home_club_id"]) {
      t.assert(!Object.prototype.hasOwnProperty.call(result.data, field));
    }
    const inherited = Object.create({ is_public: true, medical_notes: "INHERITED", date_of_birth: "2026-09-17" });
    inherited.display_name = "Member";
    const safe = validate(inherited, { creating: true });
    t.equal(safe.data.is_public, false);
    t.equal(safe.data.medical_notes, null);
    t.equal(safe.data.date_of_birth, null);
  });

  t.test("identity validation rejects malformed forms and unknown creation modes", () => {
    for (const value of [null, undefined, [], "Member", 12]) t.assert(Boolean(validate(value).errors._form));
    t.assert(Boolean(creation({}, { kind: "admin" }).errors._form));
  });
}
