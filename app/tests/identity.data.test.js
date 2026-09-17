// Mock-only, no Auth or database calls. Both browser and CLI harnesses register
// this suite explicitly; importing it never starts work.
export function identityDataTests(identity, t) {
  const accountA = "11111111-1111-4111-8111-111111111111";
  const accountB = "22222222-2222-4222-8222-222222222222";
  const playerA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const playerB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const playerC = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const ownerFilter = `account_id.eq.${accountA},guardian_account_id.eq.${accountA}`;
  const form = { display_name: "Member", date_of_birth: "1990-01-01", is_public: false };

  function row(overrides = {}) {
    return { id: playerA, account_id: accountA, guardian_account_id: null, display_name: "Member",
      verification_status: "pending", is_public: false, default_positions: ["CM"], preferred_number: 0,
      legal_name: "PRIVATE LEGAL", date_of_birth: "1990-01-01", jersey_size: "M",
      emergency_contact_name: "PRIVATE CONTACT", emergency_contact_phone: "PRIVATE PHONE",
      medical_notes: "PRIVATE MEDICAL", ...overrides };
  }

  function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  }

  async function settle() {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  }

  function database(...results) {
    const calls = [];
    const queue = [...results];
    const client = {
      calls,
      onFrom: null,
      from(table) {
        if (client.onFrom) client.onFrom();
        const call = { table, steps: [], sent: false };
        calls.push(call);
        const builder = {};
        for (const method of ["select", "eq", "or", "order", "maybeSingle", "single", "insert", "update", "abortSignal"]) {
          builder[method] = (...args) => { call.steps.push({ method, args }); return builder; };
        }
        builder.then = (resolve, reject) => {
          call.sent = true;
          const result = queue.shift();
          return Promise.resolve().then(() => {
            if (result instanceof Error) throw result;
            return typeof result === "function" ? result(call) : result;
          }).then(resolve, reject);
        };
        return builder;
      },
    };
    return client;
  }

  function service(client, options = {}) {
    return identity.createIdentityService({ client, accountId: accountA, ...options });
  }

  function step(call, method) {
    return call.steps.find((entry) => entry.method === method)?.args;
  }

  async function rejectCode(promise, code, assertions) {
    let error;
    try { await promise; } catch (caught) { error = caught; }
    assertions.equal(error?.code, code);
    if (error) {
      assertions.equal(error.message, code);
      assertions.equal(error.cause, undefined);
      assertions.assert(!JSON.stringify(error).includes("PROVIDER SECRET"));
      assertions.assert(!JSON.stringify(error).includes("PRIVATE MEDICAL"));
    }
    return error;
  }

  t.testAsync("[identity] list queries only summaries, explicitly scopes ownership and strips injected private fields", async (a) => {
    const own = row({ claim_code: "PROVIDER SECRET", roles: ["admin"] });
    const child = row({ id: playerB, account_id: null, guardian_account_id: accountA, display_name: "Child" });
    const foreign = row({ id: playerC, account_id: accountB, display_name: "Someone else" });
    const client = database({ data: [own, child, foreign], error: null });
    const result = await service(client).list();
    a.equal(result.own.id, playerA);
    a.equal(result.children.length, 1);
    a.equal(result.children[0].id, playerB);
    a.equal(step(client.calls[0], "or")[0], ownerFilter);
    const projection = step(client.calls[0], "select")[0];
    for (const privateField of ["medical_notes", "emergency_contact_name", "emergency_contact_phone", "legal_name", "date_of_birth", "claim_code"]) {
      a.assert(!projection.includes(privateField));
      a.assert(!Object.prototype.hasOwnProperty.call(result.own, privateField));
      a.assert(!Object.prototype.hasOwnProperty.call(result.children[0], privateField));
    }
    a.assert(!JSON.stringify(result).includes("PRIVATE"));
    a.assert(!JSON.stringify(result).includes("PROVIDER SECRET"));
    a.equal(client.calls[0].table, "players");
    result.own.default_positions.push("GK");
    a.equal(own.default_positions.length, 1);
  });

  t.testAsync("[identity] guardian lists include children with their own login and deduplicate an own/guardian identity", async (a) => {
    const client = database({ data: [row({ guardian_account_id: accountA }),
      row({ id: playerB, account_id: accountB, guardian_account_id: accountA })], error: null });
    const result = await service(client).list();
    a.equal(result.own.id, playerA);
    a.equal(result.children.length, 1);
    a.equal(result.children[0].account_id, accountB);
    a.assert(!client.calls[0].steps.some((entry) => entry.method === "eq" && entry.args[0] === "account_id"));
  });

  t.testAsync("[identity] empty list is distinct from malformed or duplicate identity results", async (a) => {
    const empty = await service(database({ data: [], error: null })).list();
    a.equal(empty.own, null);
    a.equal(empty.children.length, 0);
    for (const data of [null, {}, [null], [{}], [row({ account_id: undefined })],
      [row(), row()], [row(), row({ id: playerB })], [row({ default_positions: [7] })]]) {
      await rejectCode(service(database({ data, error: null })).list(), "load_failed", a);
    }
  });

  t.testAsync("[identity] detail reads one id AND current ownership, with a strict response whitelist", async (a) => {
    const source = row({ verification_note: "PRIVATE ADMIN NOTE", claim_code: "PROVIDER SECRET", payer_account_id: accountA });
    const client = database({ data: source, error: null });
    const detail = await service(client).load(playerA);
    a.equal(detail.medical_notes, "PRIVATE MEDICAL");
    a.equal(step(client.calls[0], "eq").join("|"), "id|" + playerA);
    a.equal(step(client.calls[0], "or")[0], ownerFilter);
    a.assert(Boolean(step(client.calls[0], "maybeSingle")));
    for (const field of ["verification_note", "claim_code", "payer_account_id", "created_at", "photo_url", "home_club_id"]) {
      a.assert(!Object.prototype.hasOwnProperty.call(detail, field));
      a.assert(!step(client.calls[0], "select")[0].split(",").includes(field));
    }
    a.assert(!step(client.calls[0], "select")[0].includes("*"));
  });

  t.testAsync("[identity] detail allows either owner of a dual-linked child", async (a) => {
    const child = row({ id: playerB, account_id: accountB, guardian_account_id: accountA });
    a.equal((await service(database({ data: child, error: null })).load(playerB)).id, playerB);
    a.equal((await service(database({ data: child, error: null }), { accountId: accountB }).load(playerB)).id, playerB);
  });

  t.testAsync("[identity] missing, foreign, mismatched and malformed detail results fail closed", async (a) => {
    for (const data of [null, [], row({ id: playerB }), row({ account_id: accountB }),
      row({ preferred_number: "0" }), row({ is_public: "false" }), row({ date_of_birth: "2026-02-31" }),
      row({ verification_status: "admin" }), row({ medical_notes: undefined })]) {
      await rejectCode(service(database({ data, error: null })).load(playerA), "identity_unavailable", a);
    }
  });

  t.testAsync("[identity] invalid account/player ids cannot alter query filters", async (a) => {
    const client = database();
    let error;
    try { service(client, { accountId: accountA + ",id.neq.null" }); } catch (caught) { error = caught; }
    a.equal(error?.code, "identity_unavailable");
    await rejectCode(service(client).load(playerA + ",account_id.neq.null"), "identity_unavailable", a);
    await rejectCode(service(client).update("not-a-uuid", { display_name: "Member" }), "identity_unavailable", a);
    a.equal(client.calls.length, 0);
  });

  t.testAsync("[identity] create validates before any query and ignores forged schema fields", async (a) => {
    const invalid = database();
    const error = await rejectCode(service(invalid).create("self", { display_name: "", preferred_number: 100 }), "invalid_identity", a);
    a.assert(Boolean(error.fields.display_name));
    a.assert(Boolean(error.fields.preferred_number));
    a.equal(invalid.calls.length, 0);
    const client = database({ data: null, error: null }, { data: row(), error: null });
    await service(client).create("self", { ...form, account_id: accountB, guardian_account_id: accountB,
      roles: ["admin"], verification_status: "verified", claim_code: "PROVIDER SECRET", id: playerB,
      payer_account_id: accountB, photo_url: "https://example.invalid/photo" });
    const payload = step(client.calls[1], "insert")[0];
    a.equal(payload.account_id, accountA);
    a.equal(payload.guardian_account_id, null);
    for (const field of ["roles", "verification_status", "claim_code", "id", "payer_account_id", "photo_url"]) {
      a.assert(!Object.prototype.hasOwnProperty.call(payload, field));
    }
    a.equal(client.calls.length, 2);
    a.equal(step(client.calls[0], "select")[0], "id,account_id");
    a.equal(step(client.calls[0], "eq").join("|"), "account_id|" + accountA);
  });

  t.testAsync("[identity] existing self identity prevents insertion without overwriting it", async (a) => {
    const client = database({ data: { id: playerA, account_id: accountA }, error: null });
    await rejectCode(service(client).create("self", form), "identity_exists", a);
    a.equal(client.calls.length, 1);
    a.assert(!client.calls[0].steps.some((entry) => entry.method === "insert" || entry.method === "update"));
  });

  t.testAsync("[identity] a forged self precheck result cannot authorize insertion", async (a) => {
    for (const data of [{ id: playerB, account_id: accountB }, {}, []]) {
      const client = database({ data, error: null });
      await rejectCode(service(client).create("self", form), "identity_unavailable", a);
      a.equal(client.calls.length, 1);
    }
  });

  t.testAsync("[identity] unique-index race on self creation is mapped to identity_exists", async (a) => {
    const client = database({ data: null, error: null },
      { data: null, error: { code: "23505", message: "PROVIDER SECRET", details: "PRIVATE MEDICAL" } });
    await rejectCode(service(client).create("self", form), "identity_exists", a);
    a.equal(client.calls.length, 2);
  });

  t.testAsync("[identity] a guardian without an own player may create a child without a self precheck", async (a) => {
    const child = row({ id: playerB, account_id: null, guardian_account_id: accountA, date_of_birth: "2016-01-01" });
    const client = database({ data: child, error: null });
    const result = await service(client).create("child", { ...form, date_of_birth: "2016-01-01" });
    a.equal(result.id, playerB);
    a.equal(client.calls.length, 1);
    a.equal(step(client.calls[0], "insert")[0].account_id, null);
    a.equal(step(client.calls[0], "insert")[0].guardian_account_id, accountA);
    a.equal(step(client.calls[0], "insert")[0].date_of_birth, "2016-01-01");
    a.assert(Boolean(step(client.calls[0], "single")));
  });

  t.testAsync("[identity] unknown creation modes and known minor self-creation dispatch nothing", async (a) => {
    const client = database();
    await rejectCode(service(client).create("admin", form), "invalid_identity", a);
    await rejectCode(service(client).create("self", { ...form, date_of_birth: identity.identityToday() }), "invalid_identity", a);
    a.equal(client.calls.length, 0);
  });

  t.testAsync("[identity] update uses both scopes and preserves omitted private fields", async (a) => {
    const client = database({ data: row({ display_name: "Updated", preferred_number: 0 }), error: null });
    await service(client).update(playerA, { display_name: " Updated ", preferred_number: "0",
      account_id: accountB, guardian_account_id: accountB, verification_status: "verified", claim_code: "PROVIDER SECRET" });
    const call = client.calls[0];
    const payload = step(call, "update")[0];
    a.equal(JSON.stringify(payload), JSON.stringify({ display_name: "Updated", preferred_number: 0 }));
    a.equal(step(call, "eq").join("|"), "id|" + playerA);
    a.equal(step(call, "or")[0], ownerFilter);
    a.assert(Boolean(step(call, "single")));
  });

  t.testAsync("[identity] update cannot send DOB even when blank or unchanged", async (a) => {
    const client = database();
    for (const date_of_birth of [null, "", "1990-01-01"]) {
      const error = await rejectCode(service(client).update(playerA, { display_name: "Member", date_of_birth }), "invalid_identity", a);
      a.assert(Boolean(error.fields.date_of_birth));
    }
    a.equal(client.calls.length, 0);
  });

  t.testAsync("[identity] explicit opt-in remains a preference and cannot self-verify", async (a) => {
    const client = database({ data: row({ is_public: true }), error: null });
    const result = await service(client).update(playerA, { display_name: "Member", is_public: true, verification_status: "verified" });
    a.equal(step(client.calls[0], "update")[0].is_public, true);
    a.assert(!Object.prototype.hasOwnProperty.call(step(client.calls[0], "update")[0], "verification_status"));
    a.equal(result.verification_status, "pending");
    a.equal(result.is_public, true);
  });

  t.testAsync("[identity] zero-row, wrong-id and foreign write results never claim success", async (a) => {
    for (const result of [{ data: null, error: null }, { data: [], error: null },
      { data: row({ id: playerB }), error: null }, { data: row({ account_id: accountB }), error: null },
      { data: null, error: { code: "PGRST116", message: "PROVIDER SECRET" } }]) {
      await rejectCode(service(database(result)).update(playerA, { display_name: "Member" }), "identity_unavailable", a);
    }
  });

  t.testAsync("[identity] create responses must match the requested self/guardian ownership mode", async (a) => {
    await rejectCode(service(database({ data: row(), error: null })).create("child", form), "identity_unavailable", a);
    const client = database({ data: null, error: null }, { data: row({ guardian_account_id: accountA }), error: null });
    await rejectCode(service(client).create("self", form), "identity_unavailable", a);
  });

  t.testAsync("[identity] provider errors and thrown details are sanitized for reads", async (a) => {
    for (const result of [{ error: { code: "PGRST205", message: "PROVIDER SECRET", details: "PRIVATE MEDICAL" } },
      new Error("PROVIDER SECRET"), undefined]) {
      await rejectCode(service(database(result)).list(), "load_failed", a);
    }
    const client = database();
    client.onFrom = () => { throw new Error("PROVIDER SECRET"); };
    await rejectCode(service(client).load(playerA), "load_failed", a);
  });

  t.testAsync("[identity] write permission failures are unavailable and unknown outcomes are unconfirmed", async (a) => {
    for (const code of ["42501", "23503"]) {
      await rejectCode(service(database({ data: null, error: { code, message: "PROVIDER SECRET" } }))
        .update(playerA, { display_name: "Member" }), "identity_unavailable", a);
    }
    for (const result of [new Error("PROVIDER SECRET"), undefined,
      { data: null, error: { code: "500", message: "PROVIDER SECRET" } }]) {
      const client = database(result);
      await rejectCode(service(client).update(playerA, { display_name: "Member" }), "save_unconfirmed", a);
      a.equal(client.calls.length, 1);
    }
  });

  t.testAsync("[identity] overlapping writes dispatch only once rather than duplicating children", async (a) => {
    const wait = deferred();
    const child = row({ id: playerB, account_id: null, guardian_account_id: accountA });
    const client = database(wait.promise);
    const api = service(client);
    const first = api.create("child", form);
    const second = await rejectCode(api.create("child", form), "invalid_identity", a);
    a.assert(Boolean(second.fields._form));
    wait.resolve({ data: child, error: null });
    await first;
    a.equal(client.calls.length, 1);
  });

  t.testAsync("[identity] aborted or stale work before dispatch never contacts the provider", async (a) => {
    for (const options of [{ isCurrent: () => false }, { isCurrent: () => 1 }, { isCurrent: () => { throw new Error("PRIVATE"); } }]) {
      const client = database();
      const api = service(client, options);
      await rejectCode(api.list(), "stale_request", a);
      await rejectCode(api.load(playerA), "stale_request", a);
      await rejectCode(api.create("child", form), "stale_request", a);
      await rejectCode(api.update(playerA, { display_name: "Member" }), "stale_request", a);
      a.equal(client.calls.length, 0);
    }
    const client = database();
    await rejectCode(service(client).list({ signal: { aborted: true } }), "stale_request", a);
    a.equal(client.calls.length, 0);
  });

  t.testAsync("[identity] signal is forwarded and late read results cannot expose private details", async (a) => {
    const wait = deferred();
    const signal = { aborted: false };
    const client = database(wait.promise);
    const result = service(client).load(playerA, { signal });
    await settle();
    a.equal(step(client.calls[0], "abortSignal")[0], signal);
    signal.aborted = true;
    wait.resolve({ data: row(), error: null });
    await rejectCode(result, "stale_request", a);
  });

  t.testAsync("[identity] account changes fence pending reads and self-create prechecks before writes", async (a) => {
    for (const method of ["list", "load", "create"]) {
      const wait = deferred();
      let current = true;
      const client = database(wait.promise);
      const api = service(client, { isCurrent: () => current });
      const result = method === "list" ? api.list() : method === "load" ? api.load(playerA) : api.create("self", form);
      await settle();
      current = false;
      wait.resolve({ data: method === "list" ? [row()] : method === "load" ? row() : null, error: null });
      await rejectCode(result, "stale_request", a);
      a.equal(client.calls.length, 1);
      a.assert(!client.calls[0].steps.some((entry) => entry.method === "insert"));
    }
  });

  t.testAsync("[identity] stale context reached while building a query prevents its dispatch", async (a) => {
    let current = true;
    const client = database({ data: row(), error: null });
    client.onFrom = () => { current = false; };
    await rejectCode(service(client, { isCurrent: () => current }).update(playerA, { display_name: "Member" }), "stale_request", a);
    a.equal(client.calls.length, 1);
    a.equal(client.calls[0].sent, false);
  });

  t.testAsync("[identity] abort during a dispatched write is unconfirmed even after a success response", async (a) => {
    const wait = deferred();
    const signal = { aborted: false };
    const client = database(wait.promise);
    const result = service(client).update(playerA, { display_name: "Member" }, { signal });
    await settle();
    a.equal(client.calls[0].sent, true);
    a.equal(step(client.calls[0], "abortSignal")[0], signal);
    signal.aborted = true;
    wait.resolve({ data: row(), error: null });
    await rejectCode(result, "save_unconfirmed", a);
    a.equal(client.calls.length, 1);
  });

  t.testAsync("[identity] account changes during a dispatched write never return stale private data", async (a) => {
    const wait = deferred();
    let current = true;
    const client = database(wait.promise);
    const result = service(client, { isCurrent: () => current }).create("child", form);
    await settle();
    current = false;
    wait.resolve({ data: row({ id: playerB, account_id: null, guardian_account_id: accountA }), error: null });
    await rejectCode(result, "save_unconfirmed", a);
  });

  t.testAsync("[identity] transport rejection after dispatch never retries or claims cancellation", async (a) => {
    const wait = deferred();
    const client = database(wait.promise);
    const result = service(client).update(playerA, { display_name: "Member" });
    await settle();
    wait.reject(new Error("PROVIDER SECRET aborted response"));
    await rejectCode(result, "save_unconfirmed", a);
    a.equal(client.calls.length, 1);
  });
}
