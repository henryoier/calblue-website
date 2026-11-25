// Exact RPC doubles shared by browser and CLI. No network/Auth/database calls.
export function pickupDataTests(pickup, t) {
  const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const team = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const venue = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const timestamp = "2026-09-22T12:00:00.123456+00:00";
  const changed = "2026-09-22T12:01:00.654321+00:00";
  const details = (values = {}) => ({ team_id: team, venue_id: venue, title: "Sunday pickup",
    field_label: null, timezone: "America/Los_Angeles", gather_time: "2026-10-04T16:30:00Z",
    start_time: "2026-10-04T17:00:00Z", end_time: "2026-10-04T19:00:00Z", capacity: 22,
    registration_opens_at: "2026-10-01T15:00:00Z", registration_closes_at: "2026-10-04T16:00:00Z",
    kit_color: "Blue", notes: null, ...values });
  const row = (values = {}) => ({ id, ...details(), game_date: "2026-10-04", fee_override: null,
    status: "draft", cancellation_reason: null, updated_at: timestamp, created_at: timestamp, ...values });
  const opts = (values = {}) => ({ can_override_fee: true, teams: [{ id: team, name: "CalBlue" }],
    venues: [{ id: venue, name: "Park", timezone: "America/Los_Angeles", address: null, map_url: null }], ...values });
  const page = (count) => Array.from({ length: count }, (_, index) => row({ id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}` }));
  const result = (data) => ({ data, error: null });
  const failure = (code, message = "PROVIDER SECRET") => ({ data: null, error: { code, message, details: "PRIVATE VALUE", hint: "PROVIDER SECRET" } });

  function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  }
  async function settle() { for (let index = 0; index < 10; index += 1) await Promise.resolve(); }
  function database(...responses) {
    const queue = [...responses];
    const client = {
      calls: [], onRpc: null,
      from() { throw new Error("Pickup management must use RPCs, not tables."); },
      rpc(name, parameters) {
        if (client.onRpc) client.onRpc();
        const call = { name, parameters, sent: false, signal: null };
        client.calls.push(call);
        const builder = {
          abortSignal(signal) { call.signal = signal; return builder; },
          then(resolve, reject) {
            call.sent = true;
            const response = queue.shift();
            return Promise.resolve().then(() => {
              if (response instanceof Error) throw response;
              return typeof response === "function" ? response(call) : response;
            }).then(resolve, reject);
          },
        };
        return builder;
      },
    };
    return client;
  }
  const service = (client, values = {}) => pickup.createPickupService({ client, ...values });
  async function rejects(promise, code, a) {
    let error;
    try { await promise; } catch (caught) { error = caught; }
    a.equal(error?.code, code);
    if (error) {
      a.equal(error.message, code);
      a.equal(error.cause, undefined);
      a.assert(!JSON.stringify(error).includes("PROVIDER SECRET"));
      a.assert(!JSON.stringify(error).includes("PRIVATE VALUE"));
    }
    return error;
  }

  t.testAsync("[pickup] options use one RPC and strip every unrelated field", async (a) => {
    const input = opts();
    input.private_value = "PRIVATE VALUE";
    input.teams[0].roles = ["admin"];
    input.venues[0].notes = "PRIVATE VALUE";
    const client = database(result(input));
    const api = service(client);
    const actual = await api.options();
    a.equal(client.calls[0].name, "pickup_game_options");
    a.equal(JSON.stringify(client.calls[0].parameters), "{}");
    a.equal(JSON.stringify(actual), JSON.stringify(opts()));
    actual.teams[0].name = "Changed";
    a.equal(input.teams[0].name, "CalBlue");
  });

  t.testAsync("[pickup] bounded blank option names and supported legacy zones do not poison options", async (a) => {
    for (const name of ["", "   ", "  Existing name  "]) {
      const available = opts({ teams: [{ id: team, name }], venues: [{ ...opts().venues[0], name, timezone: "CET" }] });
      const actual = await service(database(result(available))).options();
      a.equal(actual.teams[0].name, name);
      a.equal(actual.venues[0].name, name);
      a.equal(actual.venues[0].timezone, "CET");
    }
    const available = opts({ venues: [{ ...opts().venues[0], timezone: "GMT0" }] });
    a.equal((await service(database(result(available))).options()).venues[0].timezone, "GMT0");
  });

  t.testAsync("[pickup] malformed, oversized, duplicate and inherited options fail closed", async (a) => {
    const invalid = [null, [], {}, Object.create(opts()), opts({ can_override_fee: "true" }), opts({ teams: {} }),
      opts({ venues: new Array(1001).fill(opts().venues[0]) }), opts({ teams: [opts().teams[0], opts().teams[0]] }),
      opts({ teams: [{ id: team, name: "x".repeat(1001) }] }), opts({ teams: [{ id: "bad", name: "Park" }] }),
      opts({ venues: [{ ...opts().venues[0], timezone: "PRIVATE/SECRET" }] }),
      opts({ venues: [{ ...opts().venues[0], address: {} }] }), opts({ venues: [{ ...opts().venues[0], map_url: false }] })];
    for (const data of invalid) await rejects(service(database(result(data))).options(), "load_failed", a);
    for (const key of ["id", "name", "timezone", "address", "map_url"]) {
      const data = opts();
      delete data.venues[0][key];
      await rejects(service(database(result(data))).options(), "load_failed", a);
    }
  });

  t.testAsync("[pickup] an options caller cannot mutate cached team scope or fee authority", async (a) => {
    const client = database(result(opts({ can_override_fee: false })), result([row()]));
    const api = service(client);
    const available = await api.options();
    available.can_override_fee = true;
    available.teams.push({ id: other, name: "Forged team" });
    await rejects(api.save(details({ fee_override: 0 })), "invalid_pickup", a);
    await rejects(api.save(details({ team_id: other })), "invalid_pickup", a);
    a.equal(client.calls.length, 1);
  });

  t.testAsync("[pickup] list uses bounded pagination and fixed safe row snapshots", async (a) => {
    const source = row({ id: id.toUpperCase(), private_value: "PRIVATE VALUE", created_by: other, game_type: "pickup" });
    const client = database(result([source]));
    const actual = await service(client).list({ offset: 20 });
    a.equal(client.calls[0].name, "list_pickup_games");
    a.equal(JSON.stringify(client.calls[0].parameters), JSON.stringify({ p_offset: 20 }));
    a.equal(actual.rows.length, 1);
    a.equal(actual.hasMore, false);
    a.equal(actual.rows[0].id, id);
    a.equal(Object.keys(actual.rows[0]).length, 20);
    a.equal(actual.rows[0].updated_at, timestamp);
    a.assert(!JSON.stringify(actual).includes("PRIVATE VALUE"));
    actual.rows[0].title = "Changed";
    a.equal(source.title, "Sunday pickup");
  });

  t.testAsync("[pickup] list accepts all lifecycle states including legacy noncancelled reasons", async (a) => {
    for (const status of ["draft", "published", "reg_closed", "completed", "locked", "cancelled"]) {
      const actual = await service(database(result([row({ status, cancellation_reason: "Earlier note" })]))).list();
      a.equal(actual.rows[0].status, status);
    }
  });

  t.testAsync("[pickup] legacy empty or untrimmed response text stays intact", async (a) => {
    for (const cancellation_reason of [null, "", "   ", "  Earlier reason\n  "]) {
      const existing = row({ title: "  Existing game  ", field_label: "", kit_color: "  Blue  ",
        notes: " \n Existing notes \t ", status: "cancelled", cancellation_reason });
      const actual = (await service(database(result([existing]))).list()).rows[0];
      for (const field of ["title", "field_label", "kit_color", "notes", "cancellation_reason"]) a.equal(actual[field], existing[field]);
    }
    const untitled = (await service(database(result([row({ title: "" })]))).list()).rows[0];
    a.equal(untitled.title, "");
    await rejects(service(database()).save(details({ title: "" }), { row: untitled }), "invalid_pickup", a);
  });

  t.testAsync("[pickup] valid Unicode wire rows and options use database character limits", async (a) => {
    const existing = row({ title: "😀".repeat(200), field_label: "😀".repeat(200), kit_color: "😀".repeat(100),
      notes: "😀".repeat(4000), cancellation_reason: "😀".repeat(2000) });
    const actual = (await service(database(result([existing]))).list()).rows[0];
    a.equal(actual.title, existing.title);
    a.equal(actual.notes, existing.notes);
    const available = opts({ teams: [{ id: team, name: "😀".repeat(1000) }],
      venues: [{ ...opts().venues[0], name: "😀".repeat(1000), address: "😀".repeat(4000), map_url: "😀".repeat(4000) }] });
    a.equal((await service(database(result(available))).options()).venues[0].address, available.venues[0].address);
    for (const field of ["title", "field_label", "kit_color", "notes", "cancellation_reason"]) {
      await rejects(service(database(result([row({ ...existing, [field]: existing[field] + "😀" })]))).list(), "load_failed", a);
    }
    await rejects(service(database(result([row({ title: "\ud800" })]))).list(), "load_failed", a);
  });

  t.testAsync("[pickup] list returns20 rows and validates its21st lookahead before slicing", async (a) => {
    for (const count of [0, 1, 20, 21]) {
      const actual = await service(database(result(page(count)))).list();
      a.equal(actual.rows.length, Math.min(count, 20));
      a.equal(actual.hasMore, count === 21);
    }
    for (const data of [page(22), [...page(20), row({ id: "bad" })], [row(), row({ id: id.toUpperCase() })]]) {
      await rejects(service(database(result(data))).list(), "load_failed", a);
    }
  });

  t.testAsync("[pickup] every required row field must be own and correctly typed", async (a) => {
    for (const field of Object.keys(row())) {
      const incomplete = row();
      delete incomplete[field];
      await rejects(service(database(result([incomplete]))).list(), "load_failed", a);
    }
    for (const data of [null, {}, [null], [[]], [Object.create(row())]]) await rejects(service(database(result(data))).list(), "load_failed", a);
    for (const values of [{ team_id: "bad" }, { venue_id: 8 }, { title: null }, { notes: {} }, { capacity: "22" },
      { capacity: Infinity }, { capacity: 10001 }, { fee_override: -1 }, { fee_override: "12.50" }, { fee_override: 1.001 },
      { status: "public" }, { cancellation_reason: 7 },
      { updated_at: "2026-02-30T10:00:00Z" }, { created_at: new Date(timestamp) },
      { start_time: "2026-10-04" }, { timezone: "PRIVATE" }, { game_date: "2026-02-29" }, { game_date: "2026-10-05" },
      { gather_time: "2026-10-04T18:00:00Z" }, { end_time: "2026-10-04T17:00:00Z" }]) {
      await rejects(service(database(result([row(values)]))).list(), "load_failed", a);
    }
  });

  t.testAsync("[pickup] invalid offsets and unavailable service clients dispatch nothing", async (a) => {
    const client = database();
    for (const offset of [-1, 1.5, NaN, Infinity, "20", 2147483648, null]) await rejects(service(client).list({ offset }), "invalid_pickup", a);
    a.equal(client.calls.length, 0);
    for (const input of [null, {}, { from() {} }]) {
      let error;
      try { service(input); } catch (caught) { error = caught; }
      a.equal(error?.code, "load_failed");
    }
  });

  t.testAsync("[pickup] read errors distinguish access refusal without leaking backend messages", async (a) => {
    for (const method of ["options", "list"]) {
      await rejects(service(database(failure("42501")))[method](), "access_denied", a);
      for (const response of [failure("P0001"), {}, { error: null }, null, new Error("PROVIDER SECRET")]) {
        await rejects(service(database(response))[method](), "load_failed", a);
      }
    }
  });

  t.testAsync("[pickup] create sends only editable fields and expects a single draft", async (a) => {
    const client = database(result([row()]));
    const actual = await service(client).save(details({ status: "published", created_by: other, game_type: "league" }));
    const call = client.calls[0];
    a.equal(call.name, "save_pickup_game");
    a.equal(call.parameters.p_game_id, null);
    a.equal(call.parameters.p_expected_updated_at, null);
    a.equal(JSON.stringify(call.parameters.p_details), JSON.stringify(pickup.validatePickupDetails({
      ...details(), gather_time: "2026-10-04T09:30", start_time: "2026-10-04T10:00", end_time: "2026-10-04T12:00",
      registration_opens_at: "2026-10-01T08:00", registration_closes_at: "2026-10-04T09:00",
    }, opts()).data));
    a.equal(actual.status, "draft");
    a.assert(!Object.prototype.hasOwnProperty.call(call.parameters.p_details, "fee_override"));
    a.assert(!Object.prototype.hasOwnProperty.call(call.parameters.p_details, "status"));
  });

  t.testAsync("[pickup] editing keeps the exact microsecond CAS and accepts equivalent response offsets", async (a) => {
    const input = row();
    const saved = row({ updated_at: changed, start_time: "2026-10-04T10:00:00-07:00" });
    const client = database(result([saved]));
    const actual = await service(client).save(details(), { row: input });
    a.equal(client.calls[0].parameters.p_game_id, id);
    a.equal(client.calls[0].parameters.p_expected_updated_at, timestamp);
    a.equal(actual.updated_at, changed);
    a.equal(input.updated_at, timestamp);
  });

  t.testAsync("[pickup] administrators can set or clear fees after loading trusted options", async (a) => {
    for (const fee_override of [null, 0, 12.5, 99999999.99]) {
      const client = database(result(opts()), result([row({ fee_override })]));
      const api = service(client);
      await api.options();
      const actual = await api.save(details({ fee_override }));
      a.equal(client.calls[1].parameters.p_details.fee_override, fee_override);
      a.equal(actual.fee_override, fee_override);
    }
  });

  t.testAsync("[pickup] missing fee authority, invalid payloads and terminal edits never dispatch", async (a) => {
    const client = database();
    const api = service(client);
    await rejects(api.save(details({ fee_override: 0 })), "invalid_pickup", a);
    for (const input of [null, {}, [], details({ capacity: 0 }), details({ start_time: "2026-10-04T10:00" }),
      details({ title: "" }), details({ end_time: "2026-10-04T16:00:00Z" })]) await rejects(api.save(input), "invalid_pickup", a);
    for (const status of ["completed", "locked", "cancelled"]) await rejects(api.save(details(), { row: row({ status, cancellation_reason: status === "cancelled" ? "Closed" : null }) }), "invalid_pickup", a);
    for (const input of [{ id, updated_at: timestamp }, Object.create(row()), row({ updated_at: "infinity" })]) await rejects(api.save(details(), { row: input }), "invalid_pickup", a);
    a.equal(client.calls.length, 0);
  });

  t.testAsync("[pickup] omitted edit fees preserve an existing override", async (a) => {
    const client = database(result(opts({ can_override_fee: false })), result([row({ updated_at: changed, fee_override: 15 })]));
    const api = service(client);
    await api.options();
    const actual = await api.save(details(), { row: row({ fee_override: 15 }) });
    a.equal(actual.fee_override, 15);
    a.assert(!Object.prototype.hasOwnProperty.call(client.calls[1].parameters.p_details, "fee_override"));
  });

  t.testAsync("[pickup] success cannot change omitted fees, creation time or cancellation history", async (a) => {
    for (const values of [{ fee_override: 20 }, { created_at: changed }, { cancellation_reason: "Unexpected" },
      { updated_at: "2026-09-22T12:00:00.123456Z" }, { updated_at: "2026-09-22T12:00:00.123455Z" }]) {
      await rejects(service(database(result([row({ updated_at: changed, ...values })])))
        .save(details(), { row: row() }), "save_unconfirmed", a);
    }
    await rejects(service(database(result([row({ fee_override: 20 })]))).save(details()), "save_unconfirmed", a);
  });

  t.testAsync("[pickup] publish, close and cancel send exact actions and versions", async (a) => {
    for (const [action, before, after] of [["publish", "draft", "published"], ["close", "published", "reg_closed"], ["cancel", "reg_closed", "cancelled"]]) {
      const reason = action === "cancel" ? "  Field unavailable\nPlease check the next game.  " : null;
      const expectedReason = reason?.trim() || null;
      const client = database(result([row({ status: after, cancellation_reason: expectedReason, updated_at: changed })]));
      const actual = await service(client).transition(row({ status: before }), action, reason);
      a.equal(client.calls[0].name, "transition_pickup_game");
      a.equal(JSON.stringify(client.calls[0].parameters), JSON.stringify({ p_game_id: id, p_expected_updated_at: timestamp, p_action: action, p_reason: expectedReason }));
      a.equal(actual.status, after);
    }
  });

  t.testAsync("[pickup] transitions retain raw legacy text and accept Unicode cancellation bounds", async (a) => {
    const existing = row({ title: "  Existing game ", field_label: "", notes: "  Note\n  ", kit_color: "", cancellation_reason: "  Prior reason  ", status: "published" });
    const saved = { ...existing, status: "reg_closed", updated_at: changed };
    a.equal((await service(database(result([saved]))).transition(existing, "close")).notes, existing.notes);
    const reason = "😀".repeat(2000);
    const cancelled = row({ status: "cancelled", cancellation_reason: reason, updated_at: changed });
    a.equal((await service(database(result([cancelled]))).transition(row(), "cancel", reason)).cancellation_reason, reason);
    await rejects(service(database()).transition(row(), "cancel", reason + "😀"), "invalid_pickup", a);
  });

  t.testAsync("[pickup] cancellation requires a bounded safe reason and lifecycle-valid action", async (a) => {
    const client = database();
    const api = service(client);
    for (const reason of [null, "", " \t\n ", [], {}, 4, "x".repeat(2001), "PRIVATE VALUE\u0000"]) await rejects(api.transition(row(), "cancel", reason), "invalid_pickup", a);
    for (const [status, action] of [["draft", "close"], ["published", "publish"], ["reg_closed", "close"], ["completed", "cancel"], ["locked", "publish"], ["draft", "toString"], ["draft", "delete"]]) {
      await rejects(api.transition(row({ status }), action, "Reason"), "invalid_pickup", a);
    }
    await rejects(api.transition(row(), "publish", "Unexpected reason"), "invalid_pickup", a);
    a.equal(client.calls.length, 0);
  });

  t.testAsync("[pickup] known rejected writes are safe errors without an uncertain retry lock", async (a) => {
    for (const [code, message, expected] of [["42501", "PROVIDER SECRET", "access_denied"], ["22023", "PROVIDER SECRET", "invalid_pickup"],
      ["23514", "PROVIDER SECRET", "invalid_pickup"], ["P0001", "pickup_conflict", "pickup_conflict"]]) {
      const client = database(failure(code, message), result([row()]));
      const api = service(client);
      await rejects(api.save(details()), expected, a);
      a.equal((await api.save(details())).id, id);
      a.equal(client.calls.length, 2);
    }
  });

  t.testAsync("[pickup] malformed or mismatched write responses are unconfirmed, never reported as failed", async (a) => {
    for (const response of [null, {}, result(null), result([]), result([row(), row({ id: other })]),
      result([row({ title: "Different game" })]), result([row({ status: "published" })]), failure("P0001", "PROVIDER SECRET"),
      new Error("PROVIDER SECRET")]) {
      const api = service(database(response));
      await rejects(api.save(details()), "save_unconfirmed", a);
      await rejects(api.save(details()), "save_unconfirmed", a);
    }
    for (const saved of [row({ id: other, updated_at: changed }), row(), row({ updated_at: changed, status: "published" })]) {
      await rejects(service(database(result([saved]))).save(details(), { row: row() }), "save_unconfirmed", a);
    }
  });

  t.testAsync("[pickup] transition response must match status, reason, version and unchanged details", async (a) => {
    for (const values of [{ status: "draft" }, { id: other }, { updated_at: timestamp }, { title: "Wrong game" }, { fee_override: 10 }, { cancellation_reason: "Forged" }]) {
      const saved = row({ status: "published", updated_at: changed, ...values });
      await rejects(service(database(result([saved]))).transition(row(), "publish"), "save_unconfirmed", a);
    }
  });

  t.testAsync("[pickup] transition accepts only a previously read authoritative venue-zone change", async (a) => {
    const existing = row({ timezone: "UTC", start_time: "2026-10-04T04:00:00Z", gather_time: null, end_time: null,
      registration_closes_at: null, status: "published" });
    const saved = { ...existing, timezone: "America/Los_Angeles", game_date: "2026-10-03", status: "cancelled",
      cancellation_reason: "Field unavailable", updated_at: changed };
    const client = database(result(opts()), result([saved]));
    const api = service(client);
    await api.options();
    const actual = await api.transition(existing, "cancel", "Field unavailable");
    a.equal(actual.timezone, "America/Los_Angeles");
    a.equal(actual.game_date, "2026-10-03");
    a.equal(actual.start_time, existing.start_time);
    a.equal(existing.timezone, "UTC");
    await rejects(service(database(result([saved]))).transition(existing, "cancel", "Field unavailable"), "save_unconfirmed", a);
    for (const values of [{ timezone: "Pacific/Honolulu" }, { start_time: "2026-10-04T05:00:00Z" }, { game_date: "2026-10-04" }]) {
      const invalid = service(database(result(opts()), result([{ ...saved, ...values }])));
      await invalid.options();
      await rejects(invalid.transition(existing, "cancel", "Field unavailable"), "save_unconfirmed", a);
    }
  });

  t.testAsync("[pickup] an uncertain write blocks both write methods until a successful new list read", async (a) => {
    const client = database(new Error("PROVIDER SECRET"), result(opts()), failure("XX000"), result([row()]), result([row({ status: "published", updated_at: changed })]));
    const api = service(client);
    await rejects(api.save(details()), "save_unconfirmed", a);
    await rejects(api.transition(row(), "publish"), "save_unconfirmed", a);
    await api.options();
    await rejects(api.save(details()), "save_unconfirmed", a);
    await rejects(api.list(), "load_failed", a);
    await rejects(api.save(details()), "save_unconfirmed", a);
    await api.list();
    a.equal((await api.transition(row(), "publish")).status, "published");
    a.equal(client.calls.length, 5);
  });

  t.testAsync("[pickup] malformed recovery reads do not re-enable writes", async (a) => {
    const client = database(new Error("PROVIDER SECRET"), result([row({ id: "bad" })]));
    const api = service(client);
    await rejects(api.save(details()), "save_unconfirmed", a);
    await rejects(api.list(), "load_failed", a);
    await rejects(api.save(details()), "save_unconfirmed", a);
    a.equal(client.calls.length, 2);
  });

  t.testAsync("[pickup] duplicate save and transition submissions share one in-flight write guard", async (a) => {
    const pending = deferred();
    const client = database(pending.promise);
    const api = service(client);
    const first = api.save(details());
    await settle();
    await rejects(api.save(details()), "invalid_pickup", a);
    await rejects(api.transition(row(), "publish"), "invalid_pickup", a);
    a.equal(client.calls.length, 1);
    pending.resolve(result([row()]));
    a.equal((await first).id, id);
  });

  t.testAsync("[pickup] a read begun before an uncertain write cannot clear its retry lock", async (a) => {
    const pending = deferred();
    const client = database(pending.promise, new Error("PROVIDER SECRET"));
    const api = service(client);
    const oldRead = api.list();
    await settle();
    await rejects(api.save(details()), "save_unconfirmed", a);
    pending.resolve(result([row()]));
    await rejects(oldRead, "stale_request", a);
    await rejects(api.save(details()), "save_unconfirmed", a);
    a.equal(client.calls.length, 2);
  });

  t.testAsync("[pickup] a list begun during an unresolved write cannot recover that write", async (a) => {
    const pendingWrite = deferred();
    const pendingRead = deferred();
    const client = database(pendingWrite.promise, pendingRead.promise);
    const api = service(client);
    const write = api.save(details());
    await settle();
    const read = api.list();
    await settle();
    pendingWrite.reject(new Error("PROVIDER SECRET"));
    await rejects(write, "save_unconfirmed", a);
    pendingRead.resolve(result([row()]));
    await read;
    await rejects(api.save(details()), "save_unconfirmed", a);
  });

  t.testAsync("[pickup] pre-dispatch abort and stale accounts dispatch no read or write", async (a) => {
    const client = database();
    for (const current of [false, undefined, "true"]) {
      const api = service(client, { isCurrent: () => current });
      await rejects(api.options(), "stale_request", a);
      await rejects(api.list(), "stale_request", a);
      await rejects(api.save(details()), "stale_request", a);
      await rejects(api.transition(row(), "publish"), "stale_request", a);
    }
    const signal = { aborted: true };
    await rejects(service(client).list({ signal }), "stale_request", a);
    await rejects(service(client).save(details(), { signal }), "stale_request", a);
    await rejects(service(client, { isCurrent: () => { throw new Error("PRIVATE VALUE"); } }).list(), "stale_request", a);
    a.equal(client.calls.length, 0);
  });

  t.testAsync("[pickup] aborted in-flight reads discard the result and propagate the signal", async (a) => {
    for (const method of ["options", "list"]) {
      const pending = deferred();
      const client = database(pending.promise);
      const signal = { aborted: false };
      const read = service(client)[method]({ signal });
      await settle();
      a.equal(client.calls[0].signal, signal);
      signal.aborted = true;
      pending.resolve(result(method === "options" ? opts() : [row()]));
      await rejects(read, "stale_request", a);
    }
  });

  t.testAsync("[pickup] account switch or abort after dispatch makes successful writes unconfirmed", async (a) => {
    for (const mode of ["switch", "abort"]) {
      const pending = deferred();
      const client = database(pending.promise);
      const signal = { aborted: false };
      let current = true;
      const api = service(client, { isCurrent: () => current });
      const write = api.save(details(), { signal });
      await settle();
      a.equal(client.calls[0].signal, signal);
      if (mode === "switch") current = false;
      else signal.aborted = true;
      pending.resolve(result([row()]));
      await rejects(write, "save_unconfirmed", a);
      current = true;
      signal.aborted = false;
      await rejects(api.save(details()), "save_unconfirmed", a);
      a.equal(client.calls.length, 1);
    }
  });

  t.testAsync("[pickup] RPC construction failure never leaks details or auto-retries a write", async (a) => {
    const client = database();
    client.onRpc = () => { throw new Error("PROVIDER SECRET"); };
    const api = service(client);
    await rejects(api.options(), "load_failed", a);
    await rejects(api.save(details()), "save_unconfirmed", a);
    client.onRpc = null;
    await rejects(api.save(details()), "save_unconfirmed", a);
    a.equal(client.calls.length, 0);
  });

  t.testAsync("[pickup] caller mutations after dispatch cannot rewrite request snapshots", async (a) => {
    const pending = deferred();
    const client = database(pending.promise);
    const api = service(client);
    const input = details();
    const original = row();
    const write = api.save(input, { row: original });
    await settle();
    input.title = "Changed";
    original.updated_at = "Changed";
    a.equal(client.calls[0].parameters.p_details.title, "Sunday pickup");
    a.equal(client.calls[0].parameters.p_expected_updated_at, timestamp);
    pending.resolve(result([row({ updated_at: changed })]));
    a.equal((await write).title, "Sunday pickup");
  });
}
