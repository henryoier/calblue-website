import { identityView } from "../views/identity.js";
import { identityToday } from "../js/identity.js";
import { testAsync } from "./runner.js";

// Browser-only DOM tests. Every identity operation below is an injected local
// double; no SDK, account, profile, or database is contacted.
const SELF_ID = "c0250000-0000-4000-8000-000000000201";
const CHILD_ID = "c0250000-0000-4000-8000-000000000202";
const tickIdentity = () => new Promise((resolve) => setTimeout(resolve, 0));
async function settleIdentity() { await tickIdentity(); await tickIdentity(); }
function deferredIdentity() {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function identityRow(id = SELF_ID, overrides = {}) {
  return {
    id, display_name: id === SELF_ID ? "Demo Member" : "Demo Child", verification_status: "pending",
    is_public: false, default_positions: ["CM"], preferred_number: 0,
    legal_name: "PRIVATE LEGAL NAME", date_of_birth: "2000-01-03", jersey_size: "M",
    emergency_contact_name: "PRIVATE CONTACT", emergency_contact_phone: "PRIVATE PHONE",
    medical_notes: "PRIVATE MEDICAL NOTES", ...overrides,
  };
}
function identityService(overrides = {}) {
  const calls = { list: [], load: [], create: [], update: [] };
  const service = {
    calls,
    async list(options) { calls.list.push(options); return { own: null, children: [] }; },
    async load(id, options) { calls.load.push({ id, ...options }); return identityRow(id); },
    async create(kind, values, options) {
      calls.create.push({ kind, values, ...options });
      return identityRow(kind === "self" ? SELF_ID : CHILD_ID, { ...values, verification_status: "pending" });
    },
    async update(id, values, options) { calls.update.push({ id, values, ...options }); return identityRow(id, values); },
    ...overrides,
  };
  return service;
}
async function withIdentity(options, run) {
  const originalFocus = document.activeElement;
  const main = document.createElement("main");
  main.className = "app-main";
  document.body.append(main);
  const service = options?.service || identityService();
  const cleanup = identityView(main, { service, ...options });
  const fixture = {
    main, service, cleanup,
    button: (action) => main.querySelector(`[data-identity-action="${action}"]`),
    input: (name) => main.querySelector(`[name="${name}"]`),
    form: () => main.querySelector("[data-identity-form]"),
    status: () => main.querySelector("[data-identity-status]"),
    error: () => main.querySelector("[data-identity-error]"),
  };
  try { await settleIdentity(); await run(fixture); }
  finally {
    cleanup(); main.remove();
    if (originalFocus?.isConnected && typeof originalFocus.focus === "function") originalFocus.focus();
  }
}
function submitIdentity(form) {
  const event = new Event("submit", { bubbles: true, cancelable: true });
  form.dispatchEvent(event);
  return event;
}

testAsync("[identity view] starts with summaries, one-self creation and guardian child controls", async (t) => {
  await withIdentity({}, async (view) => {
    t.equal(view.main.querySelector("h1").textContent, "My identity");
    t.equal(view.service.calls.list.length, 1);
    t.equal(view.service.calls.load.length, 0, "initial list must not load private details");
    t.equal(view.form(), null);
    t.assert(view.button("create-self"));
    t.assert(view.button("create-child"));
    t.assert(view.main.textContent.includes("No child identities"));
    t.assert(view.main.textContent.includes("does not change your account name"));
    t.assert(view.main.textContent.includes("Pickup and training do not require identity verification"));
    t.assert(view.main.textContent.includes("verified identity and competition approval"));
    t.assert(view.main.textContent.includes("Players with their own account also need the player role"));
  });
});

testAsync("[identity view] lists omit sensitive fields and escape names and positions", async (t) => {
  const name = '<img src=x onerror="alert(1)"> Demo';
  const service = identityService({ list: async () => ({
    own: identityRow(SELF_ID, { display_name: name, default_positions: ["<script>CM</script>"] }),
    children: [identityRow(CHILD_ID)],
  }) });
  await withIdentity({ service }, async (view) => {
    t.equal(view.button("create-self"), null, "an existing self identity must not offer another self create");
    t.equal(view.main.querySelectorAll('[data-identity-action="open"]').length, 2);
    t.assert(view.main.textContent.includes(name));
    t.equal(view.main.querySelector("img, script"), null);
    for (const privateValue of ["PRIVATE LEGAL NAME", "2000-01-03", "PRIVATE CONTACT", "PRIVATE PHONE", "PRIVATE MEDICAL NOTES"]) {
      t.assert(!view.main.textContent.includes(privateValue), "summary must omit " + privateValue);
    }
    t.equal(view.main.querySelector("input, textarea"), null);
  });
});

testAsync("[identity view] opening an identity loads one private editor with protected fields", async (t) => {
  const service = identityService({ list: async () => ({ own: identityRow(), children: [] }) });
  await withIdentity({ service }, async (view) => {
    view.button("open").click();
    await settleIdentity();
    t.equal(service.calls.load.length, 1);
    t.equal(service.calls.load[0].id, SELF_ID);
    t.equal(view.input("legal_name").value, "PRIVATE LEGAL NAME");
    t.equal(view.input("medical_notes").value, "PRIVATE MEDICAL NOTES");
    t.equal(view.input("date_of_birth"), null, "DOB must not be an editable update field");
    t.equal(view.main.querySelector("[data-identity-dob]").textContent, "2000-01-03");
    t.equal(view.input("verification_status"), null);
    t.equal(view.input("verification_note"), null);
    t.equal(view.main.querySelector("[data-identity-verification]").textContent, "Pending verification");
    t.assert(view.main.textContent.includes("Only an administrator can correct a date of birth"));
    t.assert(view.main.textContent.includes("Authorized match staff"));
    t.equal(document.activeElement, view.main.querySelector("[data-identity-detail]"));
  });
});

testAsync("[identity view] private field contents remain text, not executable markup", async (t) => {
  const payload = '</textarea><img src=x onerror="alert(1)">';
  const row = identityRow(SELF_ID, { legal_name: payload, medical_notes: payload, emergency_contact_name: payload });
  await withIdentity({ service: identityService({ list: async () => ({ own: row, children: [] }), load: async () => row }) }, async (view) => {
    view.button("open").click(); await settleIdentity();
    for (const name of ["legal_name", "medical_notes", "emergency_contact_name"]) {
      t.equal(view.input(name).value, payload);
    }
    t.equal(view.main.querySelector("img, script"), null);
    t.equal(view.main.querySelectorAll("textarea").length, 1);
  });
});

testAsync("[identity view] creation validates and passes only permitted fields with the chosen kind", async (t) => {
  for (const kind of ["self", "child"]) {
    await withIdentity({}, async (view) => {
      view.button(kind === "self" ? "create-self" : "create-child").click();
      t.assert(view.input("date_of_birth"));
      t.equal(view.input("date_of_birth").max, identityToday());
      t.assert(!view.input("is_public").checked, "public visibility starts opt-out");
      view.input("display_name").value = "  Demo Identity  ";
      view.input("default_positions").value = "CM, CF, CM";
      view.input("preferred_number").value = "0";
      view.input("date_of_birth").value = kind === "self" ? "2000-01-01" : "2020-01-01";
      const injected = document.createElement("input");
      injected.name = "verification_status"; injected.value = "verified"; view.form().append(injected);
      t.assert(submitIdentity(view.form()).defaultPrevented);
      await settleIdentity();
      const call = view.service.calls.create[0];
      t.equal(call.kind, kind);
      t.equal(call.values.display_name, "Demo Identity");
      t.equal(call.values.default_positions.join(","), "CM,CF");
      t.equal(call.values.preferred_number, 0);
      t.equal(call.values.is_public, false);
      for (const forbidden of ["id", "account_id", "guardian_account_id", "verification_status", "verification_note", "claim_code", "payer_account_id"]) {
        t.assert(!(forbidden in call.values), "UI must omit " + forbidden);
      }
      t.equal(view.form(), null, "success closes and clears private fields");
      t.assert(view.status().textContent.includes("was created"));
      t.equal(view.service.calls.list.length, 1, "successful save uses returned safe summary, not another request");
    });
  }
});

testAsync("[identity view] invalid names and known minor self-creation never call the service", async (t) => {
  await withIdentity({}, async (view) => {
    view.button("create-self").click();
    view.input("display_name").value = "   ";
    submitIdentity(view.form());
    await settleIdentity();
    t.equal(view.service.calls.create.length, 0);
    t.equal(view.input("display_name").getAttribute("aria-invalid"), "true");
    t.equal(document.activeElement, view.input("display_name"));
    view.input("display_name").value = "Demo";
    view.input("date_of_birth").value = identityToday();
    submitIdentity(view.form());
    await settleIdentity();
    t.equal(view.service.calls.create.length, 0);
    t.assert(!view.error().hidden);
    t.equal(view.input("date_of_birth").getAttribute("aria-invalid"), "true");
  });
});

testAsync("[identity view] public roster guidance distinguishes pending and verified identities", async (t) => {
  for (const verification_status of ["pending", "verified"]) {
    const row = identityRow(SELF_ID, { verification_status, is_public: true });
    await withIdentity({ service: identityService({ list: async () => ({ own: row, children: [] }), load: async () => row }) }, async (view) => {
      view.button("open").click(); await settleIdentity();
      t.assert(view.input("is_public").checked);
      t.assert(view.main.textContent.includes("player's ID, display name, preferred number, positions, and photo"));
      const state = view.main.querySelector("[data-identity-public-state]");
      t.assert(state.textContent.includes(verification_status === "verified" ? "available" : "not publicly available until"));
      t.assert(view.main.textContent.includes("does not update the website's current player directory"));
      view.input("is_public").checked = false;
      view.input("is_public").dispatchEvent(new Event("change", { bubbles: true }));
      t.assert(state.textContent.includes("excludes this identity from the public roster data view"));
      view.input("is_public").checked = true;
      view.input("is_public").dispatchEvent(new Event("change", { bubbles: true }));
      t.assert(state.textContent.includes(verification_status === "verified" ? "immediately" : "will not be publicly available until verified"));
    });
  }
});

testAsync("[identity view] update excludes DOB and protected metadata even when fields are injected", async (t) => {
  const service = identityService({ list: async () => ({ own: identityRow(), children: [] }) });
  await withIdentity({ service }, async (view) => {
    view.button("open").click(); await settleIdentity();
    view.input("display_name").value = "Changed name";
    for (const name of ["date_of_birth", "account_id", "is_admin", "claim_code"]) {
      const input = document.createElement("input"); input.name = name; input.value = "forged"; view.form().append(input);
    }
    submitIdentity(view.form()); await settleIdentity();
    t.equal(service.calls.update.length, 1);
    const request = service.calls.update[0];
    t.equal(request.id, SELF_ID);
    t.equal(request.values.display_name, "Changed name");
    for (const name of ["date_of_birth", "account_id", "is_admin", "claim_code"]) t.assert(!(name in request.values));
    t.assert(view.main.textContent.includes("Changed name"));
    t.equal(view.form(), null);
    t.equal(view.status().textContent, "Your changes were saved.");
  });
});

testAsync("[identity view] pending save disables controls and coalesces duplicate submits", async (t) => {
  const gate = deferredIdentity();
  let writes = 0;
  await withIdentity({ service: identityService({ create: () => { writes += 1; return gate.promise; } }) }, async (view) => {
    view.button("create-self").click(); view.input("display_name").value = "Demo";
    const form = view.form(); submitIdentity(form); submitIdentity(form);
    t.equal(writes, 1);
    t.assert(form.querySelector("fieldset").disabled);
    t.equal(form.getAttribute("aria-busy"), "true");
    t.assert(view.button("create-child").disabled);
    t.assert(view.button("reload").disabled);
    gate.resolve(identityRow()); await settleIdentity();
    t.equal(view.form(), null);
    t.equal(document.activeElement, view.status());
  });
});

testAsync("[identity view] switching identities requires deliberate local-draft cancellation", async (t) => {
  const service = identityService({ list: async () => ({ own: identityRow(), children: [identityRow(CHILD_ID)] }) });
  await withIdentity({ service }, async (view) => {
    view.button("open").click(); await settleIdentity();
    const oldForm = view.form(); const medical = view.input("medical_notes");
    medical.value = "UNSAVED PRIVATE DRAFT";
    const child = view.main.querySelector(`[data-identity-id="${CHILD_ID}"]`);
    t.assert(child.disabled); child.click();
    t.equal(service.calls.load.length, 1);
    t.equal(view.form(), oldForm);
    view.button("cancel").click();
    t.equal(medical.value, "", "discard clears detached control values");
    t.equal(view.form(), null);
    t.assert(view.status().textContent.includes("Unsaved local changes discarded"));
    t.assert(!child.disabled);
    child.click(); await settleIdentity();
    t.equal(service.calls.load[1].id, CHILD_ID);
  });
});

testAsync("[identity view] unknown save outcomes lock retry and require deliberate list reload", async (t) => {
  let writes = 0;
  const service = identityService({ create: async () => { writes += 1; throw { code: "save_unconfirmed", message: "PRIVATE PROVIDER DETAIL" }; } });
  await withIdentity({ service }, async (view) => {
    view.button("create-child").click(); view.input("display_name").value = "Child";
    const form = view.form(); const name = view.input("display_name");
    submitIdentity(form); await settleIdentity();
    t.assert(view.error().textContent.includes("could not confirm"));
    t.assert(view.error().textContent.includes("does not undo"));
    t.assert(!view.main.textContent.includes("PRIVATE PROVIDER DETAIL"));
    t.assert(form.querySelector("fieldset").disabled);
    t.equal(form.getAttribute("aria-busy"), "false");
    submitIdentity(form); t.equal(writes, 1);
    t.assert(!view.button("recover").disabled);
    view.button("recover").click(); await settleIdentity();
    t.equal(service.calls.list.length, 2);
    t.equal(writes, 1, "recovery must never retry a possibly committed create");
    t.equal(name.value, "");
    t.equal(view.form(), null);
  });
});

testAsync("[identity view] validation errors are field-scoped without rendering provider messages", async (t) => {
  const malicious = '<img src=x onerror="alert(1)"> PRIVATE';
  await withIdentity({ service: identityService({ create: async () => { throw { code: "invalid_identity", message: malicious, fields: { display_name: malicious, unknown: malicious } }; } }) }, async (view) => {
    view.button("create-self").click(); view.input("display_name").value = "Demo";
    submitIdentity(view.form()); await settleIdentity();
    t.assert(!view.form().querySelector("fieldset").disabled);
    t.equal(view.input("display_name").getAttribute("aria-invalid"), "true");
    t.equal(document.activeElement, view.input("display_name"));
    t.assert(!view.main.textContent.includes("PRIVATE"));
    t.equal(view.main.querySelector("img"), null);
  });
});

testAsync("[identity view] load errors stay actionable and stale detail loads cannot win", async (t) => {
  const gate = deferredIdentity();
  const service = identityService({
    list: async () => ({ own: identityRow(), children: [identityRow(CHILD_ID)] }),
    load: (id) => id === SELF_ID ? gate.promise : Promise.resolve(identityRow(CHILD_ID)),
  });
  await withIdentity({ service }, async (view) => {
    view.main.querySelector(`[data-identity-id="${SELF_ID}"]`).click();
    view.main.querySelector(`[data-identity-id="${CHILD_ID}"]`).click();
    await settleIdentity();
    t.equal(view.input("display_name").value, "Demo Child");
    const currentForm = view.form();
    gate.resolve(identityRow(SELF_ID, { display_name: "STALE SELF" })); await settleIdentity();
    t.equal(view.form(), currentForm);
    t.equal(view.input("display_name").value, "Demo Child");
    t.assert(!view.main.textContent.includes("STALE SELF"));
  });
  await withIdentity({ service: identityService({ list: async () => { throw new Error("PRIVATE DATABASE ERROR"); } }) }, async (view) => {
    t.assert(!view.error().hidden);
    t.assert(!view.button("reload").disabled);
    t.assert(!view.main.textContent.includes("PRIVATE DATABASE ERROR"));
  });
});

testAsync("[identity view] a failed detail read offers retry without exposing its error", async (t) => {
  let reads = 0;
  const service = identityService({
    list: async () => ({ own: identityRow(), children: [] }),
    load: async () => { if (++reads === 1) throw { code: "identity_unavailable", message: "PRIVATE DETAIL" }; return identityRow(); },
  });
  await withIdentity({ service }, async (view) => {
    view.button("open").click(); await settleIdentity();
    t.assert(view.error().textContent.includes("unavailable"));
    t.assert(!view.main.textContent.includes("PRIVATE DETAIL"));
    t.equal(view.form(), null);
    view.button("retry-detail").click(); await settleIdentity();
    t.assert(view.form());
    t.equal(reads, 2);
  });
});

testAsync("[identity view] cleanup aborts reads, clears private values and removes handlers", async (t) => {
  const service = identityService({ list: async () => ({ own: identityRow(), children: [] }) });
  await withIdentity({ service }, async (view) => {
    view.button("open").click(); await settleIdentity();
    const form = view.form(); const legal = view.input("legal_name"); const medical = view.input("medical_notes");
    view.cleanup(); view.cleanup();
    t.equal(legal.value, ""); t.equal(medical.value, "");
    t.equal(view.main.textContent.trim(), "");
    t.assert(service.calls.load[0].signal.aborted);
    t.assert(!submitIdentity(form).defaultPrevented, "cleanup removed its delegated handler");
    t.equal(service.calls.update.length, 0);
  });
});

testAsync("[identity view] navigation fences late list responses and never steals focus", async (t) => {
  const gate = deferredIdentity();
  let current = true;
  await withIdentity({ context: { isCurrent: () => current }, service: identityService({ list: () => gate.promise }) }, async (view) => {
    current = false;
    const next = document.createElement("button"); next.textContent = "Next route";
    view.main.replaceChildren(next); next.focus();
    gate.resolve({ own: identityRow(), children: [] }); await settleIdentity();
    t.equal(view.main.textContent, "Next route");
    t.equal(document.activeElement, next);
  });
});

testAsync("[identity view] abort fences a late save result without follow-up requests", async (t) => {
  const controller = new AbortController(); const gate = deferredIdentity();
  let signal;
  const service = identityService({ create: (_kind, _values, options) => { signal = options.signal; return gate.promise; } });
  await withIdentity({ context: { signal: controller.signal }, service }, async (view) => {
    view.button("create-self").click(); view.input("display_name").value = "OLD ACCOUNT";
    const name = view.input("display_name"); submitIdentity(view.form());
    controller.abort();
    t.assert(signal.aborted);
    t.equal(name.value, "");
    const next = document.createElement("button"); next.textContent = "New account";
    view.main.replaceChildren(next); next.focus();
    gate.resolve(identityRow(SELF_ID, { display_name: "OLD ACCOUNT" })); await settleIdentity();
    t.equal(view.main.textContent, "New account");
    t.equal(document.activeElement, next);
    t.equal(service.calls.list.length, 1, "a stale save must not trigger another account's list request");
  });
});

testAsync("[identity view] current unknown errors are unconfirmed saves, not success", async (t) => {
  for (const code of ["identity_exists", "stale_request", "unexpected_provider_code"]) {
    await withIdentity({ service: identityService({ create: async () => { throw { code, message: "PRIVATE" }; } }) }, async (view) => {
      view.button("create-self").click(); view.input("display_name").value = "Demo";
      submitIdentity(view.form()); await settleIdentity();
      t.assert(!view.error().hidden);
      t.assert(view.form().querySelector("fieldset").disabled);
      t.assert(view.button("recover"));
      t.assert(!view.main.textContent.includes("PRIVATE"));
      t.assert(!view.status().textContent.includes("saved"));
    });
  }
});

testAsync("[identity view] an empty save response cannot report success or enable blind retry", async (t) => {
  await withIdentity({ service: identityService({ create: async () => null }) }, async (view) => {
    view.button("create-self").click(); view.input("display_name").value = "Demo";
    submitIdentity(view.form()); await settleIdentity();
    t.assert(view.error().textContent.includes("could not confirm"));
    t.assert(view.form().querySelector("fieldset").disabled);
    t.assert(view.button("recover"));
    t.equal(view.button("open"), null);
  });
});

testAsync("[identity view] a stale rejected save cannot expose an error on the next route", async (t) => {
  const gate = deferredIdentity();
  let current = true;
  const service = identityService({ create: () => gate.promise });
  await withIdentity({ context: { isCurrent: () => current }, service }, async (view) => {
    view.button("create-child").click(); view.input("display_name").value = "Demo Child";
    submitIdentity(view.form());
    current = false;
    const next = document.createElement("button"); next.textContent = "Other route";
    view.main.replaceChildren(next); next.focus();
    gate.reject({ code: "save_unconfirmed", message: "PRIVATE DATABASE DETAILS" });
    await settleIdentity();
    t.equal(view.main.textContent, "Other route");
    t.equal(document.activeElement, next);
    t.equal(service.calls.list.length, 1);
  });
});

testAsync("[identity view] unavailable service and already-stale contexts never request data", async (t) => {
  await withIdentity({ service: {} }, async (view) => {
    t.assert(view.main.textContent.includes("Identity services are unavailable"));
    t.assert(view.button("reload").disabled);
    t.equal(view.form(), null);
  });
  const main = document.createElement("main"); main.textContent = "Current page";
  const service = identityService();
  const cleanup = identityView(main, { service, context: { isCurrent: () => false } });
  t.equal(main.textContent, "Current page"); t.equal(service.calls.list.length, 0); cleanup();
});

testAsync("[identity view] form labels, live states and narrow layout remain usable", async (t) => {
  await withIdentity({}, async (view) => {
    view.main.style.width = "360px";
    view.button("create-self").click();
    t.equal(view.form().getAttribute("autocomplete"), "off");
    t.assert(view.main.scrollWidth <= 360, `identity form overflowed: ${view.main.scrollWidth}px`);
    t.equal(view.status().getAttribute("role"), "status");
    t.equal(view.error().getAttribute("role"), "alert");
    for (const control of view.form().querySelectorAll("input, textarea")) {
      t.assert(view.form().querySelector(`label[for="${control.id}"]`), "every editable field needs a label");
      for (const id of (control.getAttribute("aria-describedby") || "").split(" ").filter(Boolean)) {
        t.assert(view.form().querySelector(`[id="${id}"]`), "field descriptions must exist");
      }
    }
    t.assert(parseFloat(getComputedStyle(view.input("display_name")).fontSize) >= 16);
    t.assert(parseFloat(getComputedStyle(view.button("save")).minHeight) >= 44);
  });
});
