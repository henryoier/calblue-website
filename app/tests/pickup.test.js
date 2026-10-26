import { pickupView } from "../views/pickup.js";
import { PICKUP_LIMITS } from "../js/pickup.js";
import { testAsync } from "./runner.js";

// Native DOM tests with invented local service doubles. No Auth, RPC, database,
// or network calls. Registering these cases is not a browser execution result.
const pickupTestTick = () => new Promise((resolve) => setTimeout(resolve, 0));
export async function pickupTestSettle() { await pickupTestTick(); await pickupTestTick(); }
export function pickupTestGate() {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const PICKUP_TEST_TEAM = "c0330000-0000-4000-8000-000000000101";
const PICKUP_TEST_VENUE = "c0330000-0000-4000-8000-000000000201";
export function pickupTestOptions(overrides = {}) {
  return { can_override_fee: true,
    teams: [{ id: PICKUP_TEST_TEAM, name: "Invented organizers" }],
    venues: [{ id: PICKUP_TEST_VENUE, name: "Invented east-coast field", timezone: "America/New_York",
      address: null, map_url: null }],
    ...overrides };
}
export function pickupTestRow(index = 1, overrides = {}) {
  return {
    id: `c0330000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    team_id: PICKUP_TEST_TEAM, venue_id: null, title: `Invented pickup ${index}`,
    field_label: "Practice field", timezone: "America/Los_Angeles",
    gather_time: "2030-06-15T19:30:00Z", start_time: "2030-06-15T20:00:00Z",
    end_time: "2030-06-15T22:00:00Z", game_date: "2030-06-15", capacity: 20,
    registration_opens_at: null, registration_closes_at: null,
    kit_color: "Blue", notes: null, fee_override: null, status: "draft",
    cancellation_reason: null, created_at: "2030-06-01T10:00:00.123456Z",
    updated_at: "2030-06-01T10:00:00.123456Z", ...overrides,
  };
}
export function pickupTestService(initialRows = [pickupTestRow()], overrides = {}) {
  let records = [...initialRows];
  const calls = { options: [], list: [], save: [], transition: [] };
  const implementations = {
    options: async () => pickupTestOptions(),
    list: async ({ offset }) => ({ rows: records.slice(offset, offset + PICKUP_LIMITS.page),
      hasMore: records.length > offset + PICKUP_LIMITS.page }),
    save: async (details, { row }) => {
      const saved = pickupTestRow(row ? 1 : 900, { ...row, ...details,
        updated_at: "2030-06-01T11:00:00.123457Z" });
      records = row ? records.map((record) => record.id === row.id ? saved : record) : [saved, ...records];
      return saved;
    },
    transition: async (row, action, reason) => {
      const saved = { ...row, status: ({ publish: "published", close: "reg_closed", cancel: "cancelled" })[action],
        cancellation_reason: reason, updated_at: "2030-06-01T11:00:00.123457Z" };
      records = records.map((record) => record.id === row.id ? saved : record);
      return saved;
    },
    ...overrides,
  };
  const service = { calls };
  for (const name of Object.keys(calls)) service[name] = (...args) => {
    calls[name].push(args);
    return Promise.resolve().then(() => implementations[name](...args));
  };
  return service;
}
async function withPickup(setup, run) {
  const previousFocus = document.activeElement;
  const main = document.createElement("main"); main.className = "app-main"; document.body.append(main);
  const service = setup?.service === undefined ? pickupTestService() : setup.service;
  const cleanup = pickupView(main, { service, ...setup });
  const view = { main, service, cleanup,
    button: (action, id) => main.querySelector(`[data-pickup-action="${action}"]${id ? `[data-pickup-id="${id}"]` : ""}`),
    form: () => main.querySelector("[data-pickup-form], [data-pickup-transition]"),
    field: (name) => main.querySelector(`[name="${name}"]`),
    status: () => main.querySelector("[data-pickup-status]"),
    error: () => main.querySelector("[data-pickup-error]"),
  };
  try { await pickupTestSettle(); await run(view); }
  finally {
    cleanup(); main.remove();
    if (previousFocus?.isConnected && typeof previousFocus.focus === "function") previousFocus.focus();
  }
}
export function pickupTestSubmit(form) {
  const event = new Event("submit", { bubbles: true, cancelable: true }); form.dispatchEvent(event); return event;
}
export function pickupTestFill(form, overrides = {}) {
  const values = { title: "Invented Saturday pickup", timezone: "America/Los_Angeles",
    start_time: "2030-06-15T13:00", gather_time: "2030-06-15T12:30", end_time: "2030-06-15T15:00",
    registration_opens_at: "2030-06-01T09:00", registration_closes_at: "2030-06-15T12:00", ...overrides };
  for (const [name, value] of Object.entries(values)) form.elements.namedItem(name).value = value;
  return form;
}

testAsync("[pickup view] initial load is a bounded read with explicit lifecycle controls", async (t) => {
  await withPickup({}, async (view) => {
    t.equal(view.main.querySelector("h1").textContent, "Manage pickup games");
    t.equal(view.service.calls.options.length, 1); t.equal(view.service.calls.list[0][0].offset, 0);
    t.equal(view.service.calls.save.length, 0); t.equal(view.service.calls.transition.length, 0);
    t.equal(view.main.querySelectorAll(".app-pickup-row").length, 1);
    t.assert(view.button("publish")); t.equal(view.button("close"), null);
    t.assert(view.button("previous").disabled); t.assert(view.button("next").disabled);
    t.assert(view.main.textContent.includes("Member game browsing and registration are separate"));
  });
});

testAsync("[pickup view] a new game saves only a draft using the selected local timezone", async (t) => {
  await withPickup({ service: pickupTestService([]) }, async (view) => {
    view.button("new").click(); const form = pickupTestFill(view.form());
    t.equal(view.service.calls.save.length, 0); t.assert(pickupTestSubmit(form).defaultPrevented);
    await pickupTestSettle();
    const [details, request] = view.service.calls.save[0];
    t.equal(request.row, null); t.equal(details.start_time, "2030-06-15T20:00:00Z");
    t.equal(details.gather_time, "2030-06-15T19:30:00Z"); t.equal(details.timezone, "America/Los_Angeles");
    t.equal(details.fee_override, null); t.equal(details.capacity, null);
    t.equal(view.service.calls.transition.length, 0, "save must not silently publish");
    t.assert(view.status().textContent.includes("Draft saved")); t.equal(view.form(), null);
    t.assert(view.button("publish")); t.equal(view.service.calls.list[1][0].offset, 0);
  });
});

testAsync("[pickup view] editing preserves the reviewed row version and publication state", async (t) => {
  const row = pickupTestRow(1, { status: "published" });
  await withPickup({ service: pickupTestService([row]) }, async (view) => {
    view.button("open").click();
    t.equal(view.field("start_time").value, "2030-06-15T13:00");
    view.field("title").value = "Updated invented game";
    pickupTestSubmit(view.form()); await pickupTestSettle();
    const [details, request] = view.service.calls.save[0];
    t.equal(request.row.id, row.id); t.equal(request.row.updated_at, row.updated_at);
    t.equal(request.row.status, "published"); t.equal(details.start_time, row.start_time);
    t.equal(row.title, "Invented pickup 1", "editing must not mutate the reviewed object");
    t.equal(view.service.calls.transition.length, 0); t.assert(view.status().textContent.includes("Game details saved"));
    t.assert(view.button("close")); t.equal(view.button("publish"), null);
  });
});

testAsync("[pickup view] unchanged native datetime fields preserve full database microseconds", async (t) => {
  const row = pickupTestRow(1, {
    gather_time: "2030-06-15T19:30:00.654321Z", start_time: "2030-06-15T20:00:00.123456Z",
    end_time: "2030-06-15T22:00:00.987654Z", registration_opens_at: "2030-06-01T19:00:00.111222Z",
    registration_closes_at: "2030-06-15T19:00:00.333444Z",
  });
  await withPickup({ service: pickupTestService([row]) }, async (view) => {
    view.button("open").click();
    const names = ["gather_time", "start_time", "end_time", "registration_opens_at", "registration_closes_at"];
    for (const name of names) t.assert(view.field(name).value.length > 0, `${name} must not become an empty native control`);
    view.field("title").value = "Only the invented title changed";
    pickupTestSubmit(view.form()); await pickupTestSettle();
    t.equal(view.service.calls.save.length, 1);
    const [data, request] = view.service.calls.save[0];
    for (const name of names) t.equal(data[name], row[name], name);
    t.equal(request.row.updated_at, row.updated_at); t.equal(request.row.timezone, row.timezone);
  });
});

testAsync("[pickup view] invalid gather end and registration times never reach the service", async (t) => {
  await withPickup({}, async (view) => {
    view.button("new").click(); const form = view.form();
    for (const [field, value] of [
      ["gather_time", "2030-06-15T13:01"], ["end_time", "2030-06-15T13:00"],
      ["registration_closes_at", "2030-06-15T13:01"], ["registration_opens_at", "2030-06-15T12:01"],
      ["title", "   "], ["capacity", "0"], ["timezone", "Not/A_Timezone"],
    ]) {
      pickupTestFill(form, { capacity: "20", [field]: value }); pickupTestSubmit(form); await pickupTestSettle();
      t.equal(view.service.calls.save.length, 0, field);
      t.equal(form.elements.namedItem(field).getAttribute("aria-invalid"), "true", field);
      t.equal(document.activeElement, form.elements.namedItem(field), field);
    }
    t.equal(view.service.calls.transition.length, 0);
  });
});

testAsync("[pickup view] saved venues control the timezone and prompt local-time review", async (t) => {
  await withPickup({}, async (view) => {
    view.button("new").click();
    const venue = view.field("venue_id"); const zone = view.field("timezone");
    venue.value = PICKUP_TEST_VENUE; venue.dispatchEvent(new Event("change", { bubbles: true }));
    t.equal(zone.value, "America/New_York"); t.assert(zone.readOnly);
    t.assert(view.status().textContent.includes("Review all local times"));
    pickupTestFill(view.form(), { timezone: "America/New_York" });
    pickupTestSubmit(view.form()); await pickupTestSettle();
    t.equal(view.service.calls.save[0][0].venue_id, PICKUP_TEST_VENUE);
    t.equal(view.service.calls.save[0][0].start_time, "2030-06-15T17:00:00Z");
  });
});

testAsync("[pickup view] a changed saved-venue timezone preserves instants and requires explicit review", async (t) => {
  const row = pickupTestRow(1, { venue_id: PICKUP_TEST_VENUE });
  await withPickup({ service: pickupTestService([row]) }, async (view) => {
    view.button("open").click();
    t.equal(view.field("timezone").value, "America/New_York"); t.assert(view.field("timezone").readOnly);
    t.equal(view.field("start_time").value, "2030-06-15T16:00");
    t.equal(view.field("gather_time").value, "2030-06-15T15:30");
    t.assert(view.error().textContent.includes("timezone changed")); t.equal(view.service.calls.save.length, 0);
    pickupTestSubmit(view.form()); await pickupTestSettle();
    t.equal(view.service.calls.save[0][0].start_time, row.start_time);
    t.equal(view.service.calls.save[0][0].timezone, "America/New_York");
  });
});

testAsync("[pickup view] a saved-venue timezone change preserves a known fall-back instant", async (t) => {
  const row = pickupTestRow(1, { venue_id: PICKUP_TEST_VENUE, timezone: "UTC", game_date: "2030-11-03",
    gather_time: "2030-11-03T06:00:00Z", start_time: "2030-11-03T06:30:00Z", end_time: "2030-11-03T07:30:00Z" });
  await withPickup({ service: pickupTestService([row]) }, async (view) => {
    view.button("open").click();
    t.equal(view.field("timezone").value, "America/New_York");
    t.equal(view.field("start_time").value, "2030-11-03T01:30");
    t.assert(view.error().textContent.includes("timezone changed"));
    view.field("title").value = "Reviewed existing fall-back instant";
    pickupTestSubmit(view.form()); await pickupTestSettle();
    t.equal(view.service.calls.save.length, 1, "an unchanged known instant must not be rejected as newly ambiguous input");
    const [data, request] = view.service.calls.save[0];
    t.equal(data.start_time, row.start_time); t.equal(data.gather_time, row.gather_time); t.equal(data.end_time, row.end_time);
    t.equal(data.timezone, "America/New_York"); t.equal(request.row.timezone, "UTC");
    t.equal(request.row.updated_at, row.updated_at);
  });
});

testAsync("[pickup view] native length limits allow the validated number of astral characters", async (t) => {
  await withPickup({}, async (view) => {
    view.button("new").click(); pickupTestFill(view.form(), { title: "⚽".repeat(PICKUP_LIMITS.title) });
    t.equal(view.field("title").maxLength, PICKUP_LIMITS.title * 2);
    t.equal(view.field("notes").maxLength, PICKUP_LIMITS.notes * 2);
    view.field("title").value = "\u{1F600}".repeat(PICKUP_LIMITS.title);
    pickupTestSubmit(view.form()); await pickupTestSettle();
    t.equal([...view.service.calls.save[0][0].title].length, PICKUP_LIMITS.title);
    view.button("cancel").click(); t.equal(view.field("reason").maxLength, PICKUP_LIMITS.reason * 2);
  });
});

testAsync("[pickup view] organizers get a scoped team and no fee override control or payload", async (t) => {
  await withPickup({ service: pickupTestService([], { options: async () => pickupTestOptions({ can_override_fee: false }) }) }, async (view) => {
    view.button("new").click();
    t.equal(view.field("team_id").value, PICKUP_TEST_TEAM); t.equal(view.field("fee_override"), null);
    t.equal(view.field("team_id").querySelector('option[value=""]'), null);
    t.assert(view.main.textContent.includes("Only an administrator can change fees"));
    pickupTestFill(view.form()); pickupTestSubmit(view.form()); await pickupTestSettle();
    const data = view.service.calls.save[0][0];
    t.equal(data.team_id, PICKUP_TEST_TEAM); t.assert(!Object.prototype.hasOwnProperty.call(data, "fee_override"));
  });
});

testAsync("[pickup view] an administrator can distinguish zero fee from inherited fee", async (t) => {
  await withPickup({}, async (view) => {
    view.button("new").click(); pickupTestFill(view.form()); view.field("fee_override").value = "0";
    pickupTestSubmit(view.form()); await pickupTestSettle();
    t.equal(view.service.calls.save[0][0].fee_override, 0);
  });
});

testAsync("[pickup view] publication requires confirmation and Go back performs no write", async (t) => {
  await withPickup({}, async (view) => {
    view.button("publish").click(); const form = view.form();
    t.equal(view.service.calls.transition.length, 0); t.assert(view.main.textContent.includes("Check the venue and local times"));
    view.button("discard").click(); t.equal(view.form(), null); t.equal(view.service.calls.transition.length, 0);
    t.assert(!pickupTestSubmit(form).defaultPrevented);
    view.button("publish").click(); pickupTestSubmit(view.form()); await pickupTestSettle();
    const [row, action, reason] = view.service.calls.transition[0];
    t.equal(action, "publish"); t.equal(reason, null); t.equal(row.updated_at, pickupTestRow().updated_at);
    t.assert(view.status().textContent.includes("Game published")); t.assert(view.button("close"));
  });
});

testAsync("[pickup view] closing registration is a distinct confirmed transition", async (t) => {
  await withPickup({ service: pickupTestService([pickupTestRow(1, { status: "published" })]) }, async (view) => {
    view.button("close").click(); t.equal(view.service.calls.transition.length, 0);
    t.assert(view.main.textContent.includes("Existing registrations are kept"));
    pickupTestSubmit(view.form()); await pickupTestSettle();
    t.equal(view.service.calls.transition[0][1], "close"); t.equal(view.service.calls.save.length, 0);
    t.assert(view.status().textContent.includes("Registration closed")); t.equal(view.button("close"), null);
    t.assert(view.button("cancel"));
  });
});

testAsync("[pickup view] cancellation requires a bounded reason and renders it only as text", async (t) => {
  const reason = '<img src=x onerror="alert(1)"> Rain closure';
  await withPickup({}, async (view) => {
    view.button("cancel").click();
    for (const value of ["", "  ", "x".repeat(PICKUP_LIMITS.reason + 1)]) {
      view.field("reason").value = value; pickupTestSubmit(view.form()); await pickupTestSettle();
      t.equal(view.service.calls.transition.length, 0); t.equal(view.field("reason").getAttribute("aria-invalid"), "true");
    }
    view.field("reason").value = `  ${reason}  `; pickupTestSubmit(view.form()); await pickupTestSettle();
    t.equal(view.service.calls.transition[0][1], "cancel"); t.equal(view.service.calls.transition[0][2], reason);
    t.assert(view.status().textContent.includes("Existing registrations were kept"));
    t.assert(view.main.querySelector(".app-pickup-reason").textContent.includes(reason));
    t.equal(view.main.querySelector("img, script"), null); t.equal(view.button("cancel"), null);
  });
});

testAsync("[pickup view] terminal games are read-only and unsafe title notes and reasons stay text", async (t) => {
  const markup = '<svg onload="alert(1)">not markup</svg>';
  for (const state of ["cancelled", "completed", "locked"]) {
    await withPickup({ service: pickupTestService([pickupTestRow(1, { status: state,
      title: markup, notes: markup, cancellation_reason: state === "cancelled" ? markup : null })]) }, async (view) => {
      t.equal(view.button("publish"), null); t.equal(view.button("close"), null); t.equal(view.button("cancel"), null);
      view.button("open").click(); t.equal(view.form(), null);
      t.assert(view.main.textContent.includes("read only")); t.assert(view.main.textContent.includes(markup));
      t.equal(view.main.querySelector("svg, img, script"), null);
      t.equal(view.service.calls.save.length, 0); t.equal(view.service.calls.transition.length, 0);
      view.button("discard").click(); t.assert(!view.button("new").disabled);
    });
  }
});

testAsync("[pickup view] an open editor locks paging and discard clears detached values", async (t) => {
  await withPickup({ service: pickupTestService(Array.from({ length: 21 }, (_, index) => pickupTestRow(index + 1))) }, async (view) => {
    t.equal(view.main.querySelectorAll(".app-pickup-row").length, 20); t.assert(!view.button("next").disabled);
    view.button("next").click(); await pickupTestSettle(); t.equal(view.service.calls.list[1][0].offset, 20);
    t.equal(view.main.querySelectorAll(".app-pickup-row").length, 1); t.assert(!view.button("previous").disabled);
    view.button("open").click(); const form = view.form(); const notes = view.field("notes"); notes.value = "UNSAVED PRIVATE DRAFT";
    for (const action of ["new", "reload", "next", "previous", "open"]) t.assert(view.button(action).disabled, action);
    view.button("previous").dispatchEvent(new Event("click", { bubbles: true }));
    t.equal(view.service.calls.list.length, 2); view.button("discard").click();
    t.equal(notes.value, ""); t.equal(notes.defaultValue, ""); t.equal(view.form(), null);
    t.assert(!pickupTestSubmit(form).defaultPrevented); t.equal(view.service.calls.save.length, 0);
    view.button("previous").click(); await pickupTestSettle(); t.equal(view.service.calls.list[2][0].offset, 0);
  });
});

testAsync("[pickup view] pending saves block duplicate submits and cannot be discarded", async (t) => {
  const gate = pickupTestGate();
  await withPickup({ service: pickupTestService([], { save: () => gate.promise }) }, async (view) => {
    view.button("new").click(); const form = pickupTestFill(view.form());
    pickupTestSubmit(form); pickupTestSubmit(form);
    t.equal(view.service.calls.save.length, 1); t.assert(form.querySelector("fieldset").disabled);
    t.equal(view.main.querySelector("[data-pickup-editor]").getAttribute("aria-busy"), "true");
    view.button("discard").dispatchEvent(new Event("click", { bubbles: true })); t.equal(view.form(), form);
    gate.resolve(pickupTestRow(900)); await pickupTestSettle();
    t.equal(view.service.calls.save.length, 1); t.equal(view.form(), null);
  });
});

testAsync("[pickup view] conflicts and unknown save results require deliberate reload without retry", async (t) => {
  for (const code of ["pickup_conflict", "save_unconfirmed"]) {
    await withPickup({ service: pickupTestService(undefined, { save: async () => { throw { code, message: "PRIVATE PROVIDER DETAIL" }; } }) }, async (view) => {
      view.button("open").click(); const form = view.form(); const notes = view.field("notes"); notes.value = "Unsaved invented note";
      pickupTestSubmit(form); await pickupTestSettle();
      t.assert(form.querySelector("fieldset").disabled); t.assert(!view.button("recover").disabled);
      t.assert(!view.error().textContent.includes("PRIVATE PROVIDER DETAIL"));
      t.assert(view.error().textContent.includes(code === "pickup_conflict" ? "changed after" : "could not confirm"));
      pickupTestSubmit(form); view.button("discard").dispatchEvent(new Event("click", { bubbles: true }));
      t.equal(view.service.calls.save.length, 1); t.equal(view.service.calls.list.length, 1); t.equal(view.form(), form);
      view.button("recover").click(); await pickupTestSettle();
      t.equal(view.form(), null); t.equal(notes.value, ""); t.equal(view.service.calls.list.length, 2);
      t.equal(view.service.calls.save.length, 1, "recovery is a read, not a retry");
    });
  }
});

testAsync("[pickup view] an uncertain new draft on page two recovers from the first page", async (t) => {
  let records = Array.from({ length: 21 }, (_, index) => pickupTestRow(index + 1));
  const created = pickupTestRow(900, { title: "New draft saved despite a lost response" });
  const service = pickupTestService([], {
    list: async ({ offset }) => ({ rows: records.slice(offset, offset + 20), hasMore: records.length > offset + 20 }),
    save: async () => { records = [created, ...records]; throw { code: "save_unconfirmed" }; },
  });
  await withPickup({ service }, async (view) => {
    view.button("next").click(); await pickupTestSettle(); t.equal(service.calls.list[1][0].offset, 20);
    view.button("new").click(); pickupTestFill(view.form()); pickupTestSubmit(view.form()); await pickupTestSettle();
    t.equal(service.calls.save.length, 1); t.equal(service.calls.list.length, 2);
    view.button("recover").click(); await pickupTestSettle();
    t.equal(service.calls.list[2][0].offset, 0, "newest drafts must be visible when checking an unknown create");
    t.assert(view.main.textContent.includes(created.title)); t.assert(view.button("previous").disabled);
    t.equal(service.calls.save.length, 1, "recovery must not create a duplicate");
  });
});

testAsync("[pickup view] changed scope during uncertain creation resets the normal reload offset", async (t) => {
  const records = Array.from({ length: 21 }, (_, index) => pickupTestRow(index + 1));
  let changed = false;
  const service = pickupTestService(records, {
    options: async () => pickupTestOptions({ can_override_fee: !changed }),
    save: async () => { throw { code: "save_unconfirmed" }; },
  });
  await withPickup({ service }, async (view) => {
    view.button("next").click(); await pickupTestSettle();
    view.button("new").click(); pickupTestFill(view.form()); pickupTestSubmit(view.form()); await pickupTestSettle();
    changed = true; await view.cleanup.refreshAccess(); await pickupTestSettle();
    t.equal(view.form(), null); t.assert(!view.button("reload").disabled);
    view.button("reload").click(); await pickupTestSettle();
    t.equal(service.calls.list[2][0].offset, 0, "access refresh must not leave recovery stuck on an old page");
    t.equal(service.calls.save.length, 1); t.assert(view.button("previous").disabled);
  });
});

testAsync("[pickup view] missing or mismatched save results cannot announce success", async (t) => {
  for (const result of [null, pickupTestRow(2)]) {
    await withPickup({ service: pickupTestService(undefined, { save: async () => result }) }, async (view) => {
      view.button("open").click(); pickupTestSubmit(view.form()); await pickupTestSettle();
      t.assert(view.error().textContent.includes("could not confirm"));
      t.assert(view.form().querySelector("fieldset").disabled); t.assert(!view.button("recover").disabled);
      t.equal(view.service.calls.list.length, 1); t.equal(view.service.calls.save.length, 1);
      t.assert(!view.status().textContent.includes("Game details saved"));
    });
  }
});

testAsync("[pickup view] server field validation keeps the editable draft without an automatic retry", async (t) => {
  await withPickup({ service: pickupTestService(undefined, { save: async () => {
    throw { code: "invalid_pickup", fields: { title: "Choose another invented title." } };
  } }) }, async (view) => {
    view.button("open").click(); const form = view.form(); pickupTestSubmit(form); await pickupTestSettle();
    t.equal(view.form(), form); t.assert(!form.querySelector("fieldset").disabled);
    t.equal(view.field("title").getAttribute("aria-invalid"), "true");
    t.assert(view.main.textContent.includes("Choose another invented title"));
    t.equal(view.service.calls.save.length, 1); t.equal(view.service.calls.list.length, 1);
  });
});

testAsync("[pickup view] form-level validation gives reload guidance without exposing service details", async (t) => {
  await withPickup({ service: pickupTestService(undefined, { save: async () => {
    throw { code: "invalid_pickup", message: "PRIVATE PROVIDER FORM DETAIL",
      fields: { _form: "The game could not be changed. Reload its options and check the details." } };
  } }) }, async (view) => {
    view.button("open").click(); const form = view.form(); pickupTestSubmit(form); await pickupTestSettle();
    t.equal(view.form(), form); t.assert(!form.querySelector("fieldset").disabled);
    t.assert(view.error().textContent.toLowerCase().includes("reload"));
    t.assert(!view.main.textContent.includes("PRIVATE PROVIDER FORM DETAIL"));
    t.equal(view.service.calls.save.length, 1); t.equal(view.service.calls.list.length, 1);
  });
});

testAsync("[pickup view] a confirmed save remains confirmed if the follow-up read fails", async (t) => {
  let reads = 0;
  await withPickup({ service: pickupTestService([], { list: async () => {
    reads += 1; if (reads > 1) throw new Error("PRIVATE READ DETAIL"); return { rows: [], hasMore: false };
  } }) }, async (view) => {
    view.button("new").click(); pickupTestFill(view.form()); pickupTestSubmit(view.form()); await pickupTestSettle();
    t.assert(view.status().textContent.includes("Draft saved")); t.assert(view.error().textContent.includes("could not be loaded"));
    t.assert(!view.main.textContent.includes("PRIVATE READ DETAIL")); t.equal(view.form(), null);
    t.equal(view.service.calls.save.length, 1); t.assert(view.button("new").disabled);
  });
});

testAsync("[pickup view] options denial does not load games or expose provider errors", async (t) => {
  await withPickup({ service: pickupTestService(undefined, { options: async () => { throw { code: "access_denied", message: "PRIVATE ACCESS DETAIL" }; } }) }, async (view) => {
    t.equal(view.service.calls.list.length, 0); t.equal(view.form(), null); t.assert(view.button("new").disabled);
    t.assert(view.error().textContent.includes("organizer grant")); t.assert(!view.main.textContent.includes("PRIVATE ACCESS DETAIL"));
    t.assert(!view.button("reload").disabled);
  });
});

testAsync("[pickup view] unavailable services fail closed without starting any work", async (t) => {
  await withPickup({ service: {} }, async (view) => {
    t.assert(view.error().textContent.includes("Pickup services are unavailable"));
    t.assert(view.button("new").disabled); t.equal(view.form(), null);
    t.equal(view.main.querySelector("[data-pickup-list]").getAttribute("aria-busy"), "false");
  });
});

testAsync("[pickup view] cleanup fences delayed options and prevents the subsequent list read", async (t) => {
  const gate = pickupTestGate();
  await withPickup({ service: pickupTestService(undefined, { options: () => gate.promise }) }, async (view) => {
    const signal = view.service.calls.options[0][0].signal; view.cleanup();
    t.assert(signal.aborted); gate.resolve(pickupTestOptions()); await pickupTestSettle();
    t.equal(view.service.calls.list.length, 0); t.equal(view.main.textContent.trim(), "");
  });
});

testAsync("[pickup view] route abort clears the view and suppresses late list results", async (t) => {
  const gate = pickupTestGate(); const route = new AbortController();
  await withPickup({ context: { signal: route.signal }, service: pickupTestService(undefined, { list: () => gate.promise }) }, async (view) => {
    const signal = view.service.calls.list[0][0].signal; route.abort(); t.assert(signal.aborted);
    gate.resolve({ rows: [pickupTestRow(1, { title: "LATE PRIVATE GAME" })], hasMore: false }); await pickupTestSettle();
    t.equal(view.main.textContent.trim(), ""); t.equal(view.form(), null);
  });
});

testAsync("[pickup view] route abort clears draft values and fences an already-sent save", async (t) => {
  const gate = pickupTestGate(); const route = new AbortController();
  await withPickup({ context: { signal: route.signal }, service: pickupTestService([], { save: () => gate.promise }) }, async (view) => {
    view.button("new").click(); const form = pickupTestFill(view.form()); const notes = view.field("notes"); notes.value = "PRIVATE IN-FLIGHT NOTE";
    pickupTestSubmit(form); const signal = view.service.calls.save[0][1].signal;
    route.abort(); t.assert(signal.aborted); t.equal(notes.value, ""); t.equal(notes.defaultValue, "");
    gate.resolve(pickupTestRow(900)); await pickupTestSettle();
    t.equal(view.main.textContent.trim(), ""); t.equal(view.service.calls.list.length, 1); t.equal(view.service.calls.save.length, 1);
    t.assert(!pickupTestSubmit(form).defaultPrevented);
  });
});

testAsync("[pickup view] an already-obsolete route never mounts or reads", async (t) => {
  await withPickup({ context: { isCurrent: () => false } }, async (view) => {
    t.equal(view.main.textContent.trim(), ""); t.equal(view.service.calls.options.length, 0); t.equal(view.service.calls.list.length, 0);
  });
});

testAsync("[pickup view] same-options access refresh preserves an unsaved draft and performs no write", async (t) => {
  const gate = pickupTestGate(); let reads = 0;
  await withPickup({ service: pickupTestService(undefined, { options: () => ++reads === 1 ? pickupTestOptions() : gate.promise }) }, async (view) => {
    view.button("open").click(); const form = view.form(); const notes = view.field("notes"); notes.value = "SAME ACCOUNT DRAFT";
    const refresh = view.cleanup.refreshAccess(); t.assert(form.querySelector("fieldset").disabled);
    pickupTestSubmit(form); t.equal(view.service.calls.save.length, 0);
    gate.resolve(pickupTestOptions()); await refresh; await pickupTestSettle();
    t.equal(view.form(), form); t.equal(notes.value, "SAME ACCOUNT DRAFT");
    t.assert(!form.querySelector("fieldset").disabled); t.equal(view.service.calls.list.length, 1);
    t.equal(view.service.calls.save.length, 0);
  });
});

testAsync("[pickup view] changed options or revoked access clear the old draft before more work", async (t) => {
  for (const revoked of [false, true]) {
    let reads = 0;
    await withPickup({ service: pickupTestService(undefined, { options: async () => {
      if (++reads === 1) return pickupTestOptions();
      if (revoked) throw { code: "access_denied" };
      return pickupTestOptions({ can_override_fee: false });
    } }) }, async (view) => {
      view.button("open").click(); const form = view.form(); const notes = view.field("notes"); notes.value = "OLD ACCESS DRAFT";
      await view.cleanup.refreshAccess(); await pickupTestSettle();
      t.equal(view.form(), null); t.equal(notes.value, ""); t.equal(notes.defaultValue, "");
      t.assert(view.button("new").disabled); t.assert(!view.button("reload").disabled);
      t.assert(!pickupTestSubmit(form).defaultPrevented); t.equal(view.service.calls.save.length, 0);
      t.assert(view.error().textContent.includes(revoked ? "organizer grant" : "unsaved editor was cleared"));
    });
  }
});

testAsync("[pickup view] cleanup fences late access refresh results", async (t) => {
  const gate = pickupTestGate(); let reads = 0;
  await withPickup({ service: pickupTestService(undefined, { options: () => ++reads === 1 ? pickupTestOptions() : gate.promise }) }, async (view) => {
    view.button("open").click(); const notes = view.field("notes"); notes.value = "PRIVATE REFRESH DRAFT";
    const refresh = view.cleanup.refreshAccess(); const signal = view.service.calls.options[1][0].signal;
    view.cleanup(); t.assert(signal.aborted); t.equal(notes.value, "");
    gate.resolve(pickupTestOptions()); await refresh; await pickupTestSettle();
    t.equal(view.main.textContent.trim(), ""); t.equal(view.service.calls.save.length, 0);
  });
});

testAsync("[pickup view] fields remain labelled and focusable with a 360px layout", async (t) => {
  await withPickup({}, async (view) => {
    view.main.style.width = "360px"; view.button("new").click(); const form = view.form();
    t.assert(view.main.scrollWidth <= 360, `pickup editor overflowed: ${view.main.scrollWidth}px`);
    t.equal(form.getAttribute("autocomplete"), "off");
    t.equal(document.activeElement, view.main.querySelector("[data-pickup-editor]"));
    for (const input of form.querySelectorAll("input, textarea, select")) {
      t.assert(form.querySelector(`label[for="${input.id}"]`), input.name);
      for (const id of (input.getAttribute("aria-describedby") || "").split(" ").filter(Boolean)) {
        t.assert(form.querySelector(`[id="${id}"]`), id);
      }
      t.assert(parseFloat(getComputedStyle(input).fontSize) >= 16, input.name);
      t.assert(parseFloat(getComputedStyle(input).minHeight) >= 44, input.name);
    }
    t.equal(view.status().getAttribute("role"), "status"); t.equal(view.error().getAttribute("role"), "alert");
    t.assert(parseFloat(getComputedStyle(form.querySelector('[type="submit"]')).minHeight) >= 44);
  });
});
