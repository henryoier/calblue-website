export function verificationLogicTests(verification, t) {
  const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const timestamp = "2026-09-18T10:20:30.123456+00:00";
  const pending = (values = {}) => ({ id, updated_at: timestamp, verification_status: "pending", ...values });
  const decide = (rows = [pending()], status = "verified", note = "") => verification.validateVerificationDecision(rows, status, note);

  t.test("verification limits are explicit and immutable", () => {
    t.equal(verification.VERIFICATION_LIMITS.page, 50);
    t.equal(verification.VERIFICATION_LIMITS.search, 100);
    t.equal(verification.VERIFICATION_LIMITS.note, 1000);
    t.assert(Object.isFrozen(verification.VERIFICATION_LIMITS));
  });

  t.test("verification search trims without interpreting SQL wildcard or punctuation characters", () => {
    t.equal(verification.validateVerificationSearch().data.search, "");
    t.equal(verification.validateVerificationSearch(" \t ").data.search, "");
    t.equal(verification.validateVerificationSearch("  中文 %_ O'Name  ").data.search, "中文 %_ O'Name");
    t.equal(Object.keys(verification.validateVerificationSearch("x".repeat(100)).errors).length, 0);
  });

  t.test("verification search rejects malformed, overlong and control-bearing input", () => {
    for (const value of [null, 1, [], {}, true, "x".repeat(101), "A\nB", "A\u0000B", "A\u007fB"]) {
      const result = verification.validateVerificationSearch(value);
      t.assert(Boolean(result.errors.search));
      t.assert(!Object.prototype.hasOwnProperty.call(result.data, "search"));
    }
  });

  t.test("verification approval normalizes blank notes and only emits decision tokens", () => {
    const source = pending({ id: id.toUpperCase(), account_id: "FORGED", verification_note: "FORGED", roles: ["admin"], decided_by: "FORGED" });
    const result = decide([source]);
    t.equal(Object.keys(result.errors).length, 0);
    t.equal(result.data.status, "verified");
    t.equal(result.data.note, null);
    t.equal(JSON.stringify(result.data.rows), JSON.stringify([{ id, updated_at: timestamp }]));
    t.equal(source.id, id.toUpperCase());
    t.equal(decide(undefined, undefined, null).data.note, null);
  });

  t.test("verification rejection requires a trimmed reason, with bounded multiline notes", () => {
    for (const note of ["", " \t\n ", null]) t.assert(Boolean(decide(undefined, "rejected", note).errors.note));
    const result = decide(undefined, "rejected", "  Please correct\nthe name.  ");
    t.equal(result.data.note, "Please correct\nthe name.");
    t.equal(result.data.status, "rejected");
    t.equal(Object.keys(result.errors).length, 0);
    t.equal(Object.keys(decide(undefined, undefined, "x".repeat(1000)).errors).length, 0);
  });

  t.test("verification notes never coerce values or echo invalid input in error messages", () => {
    for (const note of [[], {}, 0, true, "PRIVATE".repeat(1000), "PRIVATE\u0000", "PRIVATE\u007f"]) {
      const result = decide(undefined, undefined, note);
      t.assert(Boolean(result.errors.note));
      t.assert(!JSON.stringify(result.errors).includes("PRIVATE"));
    }
    t.equal(Object.keys(decide(undefined, undefined, "First\nSecond\tline").errors).length, 0);
  });

  t.test("verification decisions accept only exact approve/reject statuses", () => {
    for (const status of ["pending", "VERIFIED", "approve", "admin", null, {}, []]) {
      t.assert(Boolean(decide(undefined, status).errors.status));
    }
  });

  t.test("verification decisions require 1 to 50 pending rows and reject duplicate UUIDs", () => {
    for (const rows of [null, undefined, {}, [], [null], [7], [[]], [{}], [pending(), pending({ id: id.toUpperCase() })]]) {
      t.assert(Boolean(verification.validateVerificationDecision(rows, "verified", "").errors.rows));
    }
    const rows = Array.from({ length: 50 }, (_, index) => pending({ id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}` }));
    t.equal(Object.keys(decide(rows).errors).length, 0);
    t.assert(Boolean(decide([...rows, pending()]).errors.rows));
  });

  t.test("verification decisions reject nonpending rows, malformed IDs and inherited tokens", () => {
    for (const row of [pending({ verification_status: "verified" }), pending({ verification_status: "rejected" }),
      pending({ id: id + ",id.neq.null" }), pending({ id: null }), Object.create(pending()),
      { id, updated_at: timestamp }, { id, verification_status: "pending" }]) {
      t.assert(Boolean(decide([row]).errors.rows));
    }
  });

  t.test("verification timestamps preserve all six microseconds and their original zone", () => {
    for (const updated_at of [timestamp, "2024-02-29T23:59:59.000001Z", "2026-09-18T10:20:30Z",
      "2026-09-18T10:20:30.1-07:00", "2026-09-18T10:20:30.123+05:30"]) {
      const result = decide([pending({ updated_at })]);
      t.equal(Object.keys(result.errors).length, 0);
      t.equal(result.data.rows[0].updated_at, updated_at);
    }
  });

  t.test("verification timestamps reject invalid calendars, truncated zones and rounded token types", () => {
    for (const updated_at of [null, 0, new Date(timestamp), "infinity", "2026-09-18", "2026-09-18T10:20:30",
      "2026-09-18 10:20:30+00", "2026-09-18T10:20:30.1234567Z", "2026-02-29T10:20:30Z",
      "2026-04-31T10:20:30Z", "0000-01-01T00:00:00Z", "2026-13-01T00:00:00Z",
      "2026-09-18T24:00:00Z", "2026-09-18T10:60:00Z", "2026-09-18T10:20:60Z",
      "2026-09-18T10:20:30+24:00", "2026-09-18T10:20:30+00:60"]) {
      t.assert(Boolean(decide([pending({ updated_at })]).errors.rows), "invalid timestamp accepted");
    }
  });

  t.test("verification validators return independent snapshots instead of mutating selected rows", () => {
    const rows = [pending()];
    const result = decide(rows, "verified", "  reviewed  ");
    rows[0].id = "MUTATED";
    rows[0].updated_at = "MUTATED";
    rows.push(pending());
    t.equal(result.data.rows.length, 1);
    t.equal(result.data.rows[0].id, id);
    t.equal(result.data.rows[0].updated_at, timestamp);
    t.equal(result.data.note, "reviewed");
  });
}
