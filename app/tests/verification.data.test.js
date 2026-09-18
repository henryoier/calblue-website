// RPC doubles only: no Auth, network, database or browser globals are used.
export function verificationDataTests(verification, t) {
  const actor = "11111111-1111-4111-8111-111111111111";
  const playerA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const playerB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const timestamp = "2026-09-18T10:20:30.123456+00:00";
  const decisionTime = "2026-09-18T10:21:30.654321+00:00";
  const fields = ["id", "display_name", "legal_name", "verification_status", "verification_note",
    "created_at", "updated_at", "decided_by", "decided_at"];
  const row = (values = {}) => ({ id: playerA, display_name: "Member", legal_name: "Legal name",
    verification_status: "pending", verification_note: null, created_at: timestamp, updated_at: timestamp,
    decided_by: null, decided_at: null, ...values });
  const decided = (values = {}) => row({ verification_status: "verified", updated_at: decisionTime,
    decided_by: actor, decided_at: decisionTime, ...values });
  const page = (count) => Array.from({ length: count }, (_, index) => row({ id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}` }));

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
    const queue = [...results];
    const client = {
      calls: [],
      onRpc: null,
      from() { throw new Error("Direct table access is forbidden in verification tests."); },
      rpc(name, parameters) {
        if (client.onRpc) client.onRpc();
        const call = { name, parameters, sent: false, signal: null };
        client.calls.push(call);
        const builder = {
          abortSignal(signal) { call.signal = signal; return builder; },
          then(resolve, reject) {
            call.sent = true;
            const result = queue.shift();
            return Promise.resolve().then(() => {
              if (result instanceof Error) throw result;
              return typeof result === "function" ? result(call) : result;
            }).then(resolve, reject);
          },
        };
        return builder;
      },
    };
    return client;
  }

  const service = (client, options = {}) => verification.createVerificationService({ client, ...options });

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

  t.testAsync("[verification] list uses the bounded RPC, not table access, and strips unrelated private fields", async (a) => {
    const source = row({ id: playerA.toUpperCase(), medical_notes: "PRIVATE MEDICAL", claim_code: "PROVIDER SECRET", account_id: actor });
    const client = database({ data: [source], error: null });
    const result = await service(client).list();
    a.equal(client.calls[0].name, "list_player_verifications");
    a.equal(JSON.stringify(client.calls[0].parameters), JSON.stringify({ p_search: "", p_offset: 0 }));
    a.equal(result.rows.length, 1);
    a.equal(result.rows[0].id, playerA);
    a.equal(result.hasMore, false);
    a.equal(Object.keys(result.rows[0]).join(","), fields.join(","));
    a.assert(!JSON.stringify(result).includes("PRIVATE MEDICAL"));
    a.assert(!JSON.stringify(result).includes("PROVIDER SECRET"));
    result.rows[0].legal_name = "Changed locally";
    a.equal(source.legal_name, "Legal name");
  });

  t.testAsync("[verification] list sends literal search text and exact offsets with all-status results", async (a) => {
    const client = database({ data: [decided(), row({ id: playerB, verification_status: "rejected", verification_note: "Earlier review" })], error: null });
    const result = await service(client).list({ search: "  中文 %_ O'Name  ", offset: 50 });
    a.equal(client.calls[0].parameters.p_search, "中文 %_ O'Name");
    a.equal(client.calls[0].parameters.p_offset, 50);
    a.equal(result.rows[0].decided_by, actor);
    a.equal(result.rows[1].decided_at, null); // Legacy decisions may lack an actor.
    a.equal(result.rows.length, 2);
  });

  t.testAsync("[verification] list returns at most50 rows and validates the lookahead row", async (a) => {
    for (const count of [0, 1, 50, 51]) {
      const result = await service(database({ data: page(count), error: null })).list();
      a.equal(result.rows.length, Math.min(count, 50));
      a.equal(result.hasMore, count === 51);
    }
    const badLookahead = page(50).concat([row({ id: "INVALID" })]);
    await rejectCode(service(database({ data: badLookahead, error: null })).list(), "load_failed", a);
    await rejectCode(service(database({ data: page(52), error: null })).list(), "load_failed", a);
  });

  t.testAsync("[verification] blank pending queue rejects decided rows and duplicate case-insensitive IDs", async (a) => {
    for (const data of [[decided()], [row(), row({ id: playerA.toUpperCase() })]]) {
      await rejectCode(service(database({ data, error: null })).list(), "load_failed", a);
    }
  });

  t.testAsync("[verification] missing and malformed response columns fail closed", async (a) => {
    for (const field of fields) {
      const incomplete = row();
      delete incomplete[field];
      await rejectCode(service(database({ data: [incomplete], error: null })).list(), "load_failed", a);
    }
    for (const data of [null, {}, [null], [[]], [row({ id: "bad" })], [row({ display_name: 7 })],
      [row({ legal_name: {} })], [row({ verification_note: false })], [row({ verification_status: "admin" })],
      [row({ created_at: "2026-02-31T00:00:00Z" })], [row({ updated_at: new Date(timestamp) })],
      [row({ decided_by: "bad" })], [row({ decided_at: "today" })]]) {
      await rejectCode(service(database({ data, error: null })).list(), "load_failed", a);
    }
  });

  t.testAsync("[verification] invalid search and offsets dispatch no request", async (a) => {
    const client = database();
    const api = service(client);
    for (const search of [null, {}, "x".repeat(101), "A\u0000B"]) {
      await rejectCode(api.list({ search }), "invalid_verification", a);
    }
    for (const offset of [-1, 0.5, NaN, Infinity, "50", 2147483648]) {
      await rejectCode(api.list({ offset }), "invalid_verification", a);
    }
    a.equal(client.calls.length, 0);
  });

  t.testAsync("[verification] read errors expose only fixed access/load codes", async (a) => {
    await rejectCode(service(database({ data: null, error: { code: "42501", message: "PROVIDER SECRET" } })).list(), "access_denied", a);
    for (const response of [undefined, {}, { error: { code: "P0001", message: "PROVIDER SECRET" } }, new Error("PROVIDER SECRET")]) {
      await rejectCode(service(database(response)).list(), "load_failed", a);
    }
    const client = database();
    client.onRpc = () => { throw new Error("PROVIDER SECRET"); };
    await rejectCode(service(client).list(), "load_failed", a);
  });

  t.testAsync("[verification] inactive, throwing and aborted contexts dispatch no reads or decisions", async (a) => {
    for (const isCurrent of [() => false, () => null, () => { throw new Error("PROVIDER SECRET"); }]) {
      const client = database();
      const api = service(client, { isCurrent });
      await rejectCode(api.list(), "stale_request", a);
      await rejectCode(api.decide([row()], "verified"), "stale_request", a);
      a.equal(client.calls.length, 0);
    }
    const client = database();
    const api = service(client);
    const signal = { aborted: true };
    await rejectCode(api.list({ signal }), "stale_request", a);
    await rejectCode(api.decide([row()], "verified", "", { signal }), "stale_request", a);
    a.equal(client.calls.length, 0);
  });

  t.testAsync("[verification] auth loss during request construction prevents dispatch", async (a) => {
    for (const method of ["list", "decide"]) {
      let current = true;
      const client = database();
      client.onRpc = () => { current = false; };
      const api = service(client, { isCurrent: () => current });
      await rejectCode(method === "list" ? api.list() : api.decide([row()], "verified"), "stale_request", a);
      a.equal(client.calls.length, 1);
      a.equal(client.calls[0].sent, false);
    }
  });

  t.testAsync("[verification] late reads after auth loss or cancellation cannot return private rows", async (a) => {
    for (const outcome of ["success", "error", "abort"]) {
      const waiting = deferred();
      let current = true;
      const signal = { aborted: false };
      const client = database(waiting.promise);
      const request = service(client, { isCurrent: () => current }).list({ signal });
      await settle();
      a.equal(client.calls[0].signal, signal);
      if (outcome === "abort") signal.aborted = true;
      else current = false;
      if (outcome === "error") waiting.reject(new Error("PROVIDER SECRET"));
      else waiting.resolve({ data: [row()], error: null });
      await rejectCode(request, "stale_request", a);
    }
  });

  t.testAsync("[verification] decisions send only selected IDs, unrounded tokens, status and trimmed note", async (a) => {
    const selected = [row({ id: playerA.toUpperCase(), roles: ["admin"], decided_by: "FORGED" }), row({ id: playerB, updated_at: "2026-09-18T10:20:30.000001-07:00" })];
    const client = database({ data: [decided({ id: playerB, verification_note: "Reviewed" }), decided({ verification_note: "Reviewed", medical_notes: "PRIVATE MEDICAL" })], error: null });
    const result = await service(client).decide(selected, "verified", "  Reviewed  ");
    a.equal(client.calls[0].name, "decide_player_verifications");
    a.equal(JSON.stringify(client.calls[0].parameters), JSON.stringify({
      p_player_ids: [playerA, playerB], p_expected_updated_at: [timestamp, "2026-09-18T10:20:30.000001-07:00"], p_status: "verified", p_note: "Reviewed",
    }));
    a.equal(result.length, 2);
    a.equal(result[0].id, playerB); // RPC ordering need not match selection order.
    a.equal(result[1].updated_at, decisionTime);
    a.equal(Object.keys(result[1]).join(","), fields.join(","));
    a.assert(!JSON.stringify(result).includes("PRIVATE MEDICAL"));
  });

  t.testAsync("[verification] rejection uses one atomic RPC with a required shared reason", async (a) => {
    const client = database({ data: [decided({ verification_status: "rejected", verification_note: "Please correct the name." })], error: null });
    const result = await service(client).decide([row()], "rejected", " Please correct the name. ");
    a.equal(result[0].verification_status, "rejected");
    a.equal(client.calls.length, 1);
    a.equal(client.calls[0].parameters.p_note, "Please correct the name.");
  });

  t.testAsync("[verification] invalid and nonpending decisions never dispatch", async (a) => {
    const client = database();
    const api = service(client);
    for (const rows of [[], page(51), [row(), row()], [decided()], [row({ updated_at: "bad" })]]) {
      await rejectCode(api.decide(rows, "verified"), "invalid_verification", a);
    }
    const rejection = await rejectCode(api.decide([row()], "rejected", " "), "invalid_verification", a);
    a.assert(Boolean(rejection.fields.note));
    await rejectCode(api.decide([row()], "pending"), "invalid_verification", a);
    a.equal(client.calls.length, 0);
  });

  t.testAsync("[verification] selected row mutations cannot change an in-flight decision payload", async (a) => {
    const waiting = deferred();
    const selected = [row()];
    const client = database(waiting.promise);
    const request = service(client).decide(selected, "verified");
    selected[0].id = playerB;
    selected[0].updated_at = "CHANGED";
    selected.push(row());
    await settle();
    a.equal(client.calls[0].parameters.p_player_ids.join(","), playerA);
    a.equal(client.calls[0].parameters.p_expected_updated_at.join(","), timestamp);
    waiting.resolve({ data: [decided()], error: null });
    a.equal((await request)[0].id, playerA);
  });

  t.testAsync("[verification] a second in-flight decision is blocked and confirmed completion releases the guard", async (a) => {
    const waiting = deferred();
    const client = database(waiting.promise, { data: [decided({ id: playerB })], error: null });
    const api = service(client);
    const first = api.decide([row()], "verified");
    await settle();
    const error = await rejectCode(api.decide([row({ id: playerB })], "verified"), "invalid_verification", a);
    a.assert(Boolean(error.fields._form));
    a.equal(client.calls.length, 1);
    waiting.resolve({ data: [decided()], error: null });
    await first;
    await api.decide([row({ id: playerB })], "verified");
    a.equal(client.calls.length, 2);
  });

  t.testAsync("[verification] only exact owned conflict and authorization errors are classified as definite refusals", async (a) => {
    for (const [provider, code] of [[{ code: "P0001", message: "verification_conflict" }, "decision_conflict"],
      [{ code: "42501", message: "PROVIDER SECRET" }, "access_denied"]]) {
      const client = database({ data: null, error: { ...provider, details: "PRIVATE MEDICAL" } }, { data: [decided()], error: null });
      const api = service(client);
      await rejectCode(api.decide([row()], "verified"), code, a);
      a.equal(client.calls.length, 1);
      await api.decide([row()], "verified");
      a.equal(client.calls.length, 2);
    }
  });

  t.testAsync("[verification] unknown provider failures are unconfirmed, never replayed or exposed", async (a) => {
    for (const failure of [new Error("PROVIDER SECRET"), null, {},
      { error: { code: "P0001", message: "verification_conflict PROVIDER SECRET" } },
      { error: { code: "22023", message: "PROVIDER SECRET", details: "PRIVATE MEDICAL" } },
      { error: { code: "NETWORK", message: "PROVIDER SECRET" } }]) {
      const client = database(failure);
      const api = service(client);
      await rejectCode(api.decide([row()], "verified"), "save_unconfirmed", a);
      await rejectCode(api.decide([row()], "verified"), "save_unconfirmed", a);
      a.equal(client.calls.length, 1);
    }
  });

  t.testAsync("[verification] partial, duplicate, wrong-subject or malformed decision responses stay unconfirmed", async (a) => {
    for (const data of [null, [], [decided(), decided()], [decided({ id: playerB })], [row()],
      [decided({ verification_note: "Unexpected" })], [decided({ decided_by: null })],
      [decided({ decided_at: null })], [decided({ updated_at: "bad" })], [decided({ legal_name: undefined })]]) {
      await rejectCode(service(database({ data, error: null })).decide([row()], "verified"), "save_unconfirmed", a);
    }
    await rejectCode(service(database({ data: [decided()], error: null })).decide([row(), row({ id: playerB })], "verified"), "save_unconfirmed", a);
  });

  t.testAsync("[verification] cancellation or auth loss after dispatch cannot publish confirmed success", async (a) => {
    for (const mode of ["auth", "abort", "provider-error"]) {
      const waiting = deferred();
      let current = true;
      const signal = { aborted: false };
      const client = database(waiting.promise);
      const request = service(client, { isCurrent: () => current }).decide([row()], "verified", "", { signal });
      await settle();
      a.equal(client.calls[0].signal, signal);
      if (mode === "abort") signal.aborted = true;
      else current = false;
      waiting.resolve(mode === "provider-error" ? { error: { code: "42501", message: "PROVIDER SECRET" } } : { data: [decided()], error: null });
      await rejectCode(request, "save_unconfirmed", a);
      a.equal(client.calls.length, 1);
    }
  });

  t.testAsync("[verification] a deliberate successful reload releases an uncertain-outcome guard", async (a) => {
    const client = database(new Error("PROVIDER SECRET"), { data: [row({ id: playerB })], error: null },
      { data: [decided({ id: playerB })], error: null });
    const api = service(client);
    await rejectCode(api.decide([row()], "verified"), "save_unconfirmed", a);
    await rejectCode(api.decide([row({ id: playerB })], "verified"), "save_unconfirmed", a);
    const result = await api.list();
    a.equal(result.rows[0].id, playerB);
    await api.decide(result.rows, "verified");
    a.equal(client.calls.length, 3);
  });

  t.testAsync("[verification] a failed reload cannot unlock an uncertain write", async (a) => {
    const client = database(null, { data: null, error: { code: "NETWORK", message: "PROVIDER SECRET" } });
    const api = service(client);
    await rejectCode(api.decide([row()], "verified"), "save_unconfirmed", a);
    await rejectCode(api.list(), "load_failed", a);
    await rejectCode(api.decide([row()], "verified"), "save_unconfirmed", a);
    a.equal(client.calls.length, 2);
  });

  t.testAsync("[verification] a read started before the uncertain outcome cannot unlock a retry", async (a) => {
    const write = deferred();
    const read = deferred();
    const client = database(write.promise, read.promise);
    const api = service(client);
    const decision = api.decide([row()], "verified");
    const listing = api.list();
    await settle();
    write.resolve(null);
    await rejectCode(decision, "save_unconfirmed", a);
    read.resolve({ data: [row()], error: null });
    await listing;
    await rejectCode(api.decide([row()], "verified"), "save_unconfirmed", a);
    a.equal(client.calls.length, 2);
  });

  t.testAsync("[verification] a non-RPC client is rejected without table or Auth access", async (a) => {
    for (const client of [null, {}, { rpc: true }, { from() { throw new Error("Must not run"); } }]) {
      let error;
      try { service(client); } catch (caught) { error = caught; }
      a.equal(error?.code, "load_failed");
      a.equal(error?.message, "load_failed");
    }
  });
}
