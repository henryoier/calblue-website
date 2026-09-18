import { verificationView } from "../views/verification.js";
import { VERIFICATION_LIMITS } from "../js/verification.js";
import { testAsync } from "./runner.js";

// Real DOM, local service doubles only. These tests never contact a database,
// authentication provider, or another person's profile.
const verificationTick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function verificationSettle() { await verificationTick(); await verificationTick(); }
function verificationGate() {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function verificationRow(index = 1, overrides = {}) {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    display_name: `Demo ${index}`, legal_name: `Legal Demo ${index}`,
    verification_status: "pending", verification_note: null,
    created_at: `2026-09-${String(Math.min(index, 28)).padStart(2, "0")}T12:00:00.000001Z`,
    updated_at: "2026-09-18T12:00:00.123456Z", decided_by: null, decided_at: null,
    ...overrides,
  };
}
function verificationUpdated(rows, status = "verified", note = null) {
  return rows.map((row) => ({ ...row, verification_status: status, verification_note: note,
    updated_at: "2026-09-18T13:00:00.654321Z", decided_at: "2026-09-18T13:00:00.654321Z",
    decided_by: "11111111-1111-4111-8111-111111111111" }));
}
function verificationService(initialRows = [verificationRow()], overrides = {}) {
  let records = [...initialRows];
  const calls = { list: [], decide: [] };
  const service = {
    calls,
    async list(options) {
      calls.list.push(options);
      const query = options.search.toLowerCase();
      const matching = records.filter((row) => query
        ? `${row.display_name} ${row.legal_name || ""}`.toLowerCase().includes(query)
        : row.verification_status === "pending")
        .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
      return { rows: matching.slice(options.offset, options.offset + VERIFICATION_LIMITS.page),
        hasMore: matching.length > options.offset + VERIFICATION_LIMITS.page };
    },
    async decide(rows, status, note, options) {
      calls.decide.push({ rows, status, note, ...options });
      const updated = verificationUpdated(rows, status, note);
      records = records.map((row) => updated.find((next) => next.id === row.id) || row);
      return updated;
    },
    ...overrides,
  };
  return service;
}
async function withVerification(options, run) {
  const previousFocus = document.activeElement;
  const main = document.createElement("main"); main.className = "app-main"; document.body.append(main);
  const service = options?.service || verificationService();
  const cleanup = verificationView(main, { service, ...options });
  const fixture = {
    main, service, cleanup,
    button: (action, id) => main.querySelector(`[data-verification-action="${action}"]${id ? `[data-verification-id="${id}"]` : ""}`),
    search: () => main.querySelector('[name="search"]'),
    searchForm: () => main.querySelector("[data-verification-search-form]"),
    form: () => main.querySelector("[data-verification-form]"),
    note: () => main.querySelector('[name="note"]'),
    status: () => main.querySelector("[data-verification-status]"),
    error: () => main.querySelector("[data-verification-error]"),
    select: (id) => main.querySelector(`[data-verification-select="${id}"]`),
  };
  try { await verificationSettle(); await run(fixture); }
  finally {
    cleanup(); main.remove();
    if (previousFocus?.isConnected && typeof previousFocus.focus === "function") previousFocus.focus();
  }
}
function verificationSubmit(form) {
  const event = new Event("submit", { bubbles: true, cancelable: true }); form.dispatchEvent(event); return event;
}
function verificationCheck(control, checked = true) {
  control.checked = checked; control.dispatchEvent(new Event("change", { bubbles: true }));
}

testAsync("[verification view] opens the pending queue newest first without sending decisions", async (t) => {
  await withVerification({ service: verificationService([verificationRow(1), verificationRow(2)]) }, async (view) => {
    t.equal(view.main.querySelector("h1").textContent, "Verify players");
    t.equal(view.service.calls.list[0].search, ""); t.equal(view.service.calls.list[0].offset, 0);
    t.equal(view.service.calls.decide.length, 0); t.equal(view.form(), null);
    const headings = [...view.main.querySelectorAll(".app-verification-row h3")].map((node) => node.textContent);
    t.equal(headings.join(","), "Demo 2,Demo 1");
    t.assert(view.main.textContent.includes("Verification does not grant the player role"));
    t.assert(view.button("previous").disabled); t.assert(view.button("next").disabled);
    t.assert(view.button("bulk").disabled);
  });
});

testAsync("[verification view] submitted name search is literal and includes read-only completed identities", async (t) => {
  const special = "Name %_ literal";
  const complete = verificationRow(2, { display_name: special, verification_status: "verified", verification_note: "Approved earlier" });
  await withVerification({ service: verificationService([verificationRow(1, { display_name: special }), complete]) }, async (view) => {
    view.search().value = `  ${special}  `;
    t.equal(view.service.calls.list.length, 1, "typing alone does not send a search");
    t.assert(verificationSubmit(view.searchForm()).defaultPrevented); await verificationSettle();
    t.equal(view.service.calls.list[1].search, special);
    t.equal(view.service.calls.list[1].offset, 0);
    t.equal(view.main.querySelectorAll(".app-verification-row").length, 2);
    t.equal(view.select(complete.id), null);
    t.equal(view.button("approve", complete.id), null); t.equal(view.button("reject", complete.id), null);
    t.assert(view.main.textContent.includes("Already reviewed"));
    t.assert(view.main.textContent.includes("Approved earlier"));
    view.button("pending").click(); await verificationSettle();
    t.equal(view.search().value, "");
    t.equal(view.main.querySelectorAll(".app-verification-row").length, 1);
  });
});

testAsync("[verification view] paging is bounded to fifty and clears page-specific selections", async (t) => {
  const records = Array.from({ length: 51 }, (_, index) => verificationRow(index + 1));
  await withVerification({ service: verificationService(records) }, async (view) => {
    t.equal(view.main.querySelectorAll(".app-verification-row").length, 50);
    verificationCheck(view.main.querySelector("[data-verification-select]"));
    t.assert(!view.button("bulk").disabled);
    view.button("next").click(); await verificationSettle();
    t.equal(view.service.calls.list[1].offset, 50);
    t.equal(view.main.querySelectorAll(".app-verification-row").length, 1);
    t.assert(view.button("bulk").disabled);
    t.assert(view.main.querySelector("[data-verification-selection-count]").textContent.startsWith("0 "));
    t.assert(!view.button("previous").disabled); t.assert(view.button("next").disabled);
    view.button("previous").click(); await verificationSettle();
    t.equal(view.service.calls.list[2].offset, 0);
    t.equal(view.main.querySelectorAll("[data-verification-select]:checked").length, 0);
  });
});

testAsync("[verification view] a new search clears selections without changing the URL", async (t) => {
  await withVerification({ service: verificationService([verificationRow(1), verificationRow(2)]) }, async (view) => {
    const originalUrl = location.href;
    verificationCheck(view.select(verificationRow(1).id));
    view.search().value = "Demo 2"; verificationSubmit(view.searchForm()); await verificationSettle();
    t.equal(location.href, originalUrl, "names must not be written into the URL");
    t.assert(view.button("bulk").disabled);
    t.equal(view.main.querySelectorAll("[data-verification-select]:checked").length, 0);
  });
});

testAsync("[verification view] bulk confirmation includes only the current page's pending identities", async (t) => {
  const pending = [verificationRow(1), verificationRow(2)];
  const completed = verificationRow(3, { verification_status: "rejected" });
  await withVerification({ service: verificationService([...pending, completed]) }, async (view) => {
    view.search().value = "Demo"; verificationSubmit(view.searchForm()); await verificationSettle();
    verificationCheck(view.main.querySelector("[data-verification-select-all]"));
    t.equal(view.main.querySelectorAll("[data-verification-select]:checked").length, 2);
    view.button("bulk").click();
    t.equal(view.service.calls.decide.length, 0, "review is not confirmation");
    t.assert(view.main.querySelector("[data-verification-review]").textContent.includes("Approve 2 identities"));
    t.assert(!view.main.querySelector("[data-verification-review]").textContent.includes(completed.id));
    verificationSubmit(view.form()); await verificationSettle();
    const call = view.service.calls.decide[0];
    t.equal(call.rows.length, 2); t.equal(call.status, "verified"); t.equal(call.note, null);
    t.assert(call.rows.every((row) => row.verification_status === "pending"), "original rows, not compact tokens, reach the service");
    t.equal(call.rows[0].updated_at, "2026-09-18T12:00:00.123456Z", "timestamp precision must survive the UI");
    t.equal(view.service.calls.list[2].offset, 0, "confirmed changes restart pagination");
    t.assert(view.status().textContent.includes("2 identities approved"));
    t.assert(view.status().textContent.includes("Account roles and competition approval are unchanged"));
    t.equal(view.form(), null);
  });
});

testAsync("[verification view] single approval waits for confirmation and trims an optional note", async (t) => {
  await withVerification({}, async (view) => {
    view.button("approve").click();
    t.equal(view.service.calls.decide.length, 0);
    t.equal(document.activeElement, view.main.querySelector("[data-verification-review]"));
    t.assert(!view.note().required);
    view.note().value = "  Identity reviewed  ";
    verificationSubmit(view.form()); await verificationSettle();
    t.equal(view.service.calls.decide.length, 1);
    t.equal(view.service.calls.decide[0].rows.length, 1);
    t.equal(view.service.calls.decide[0].note, "Identity reviewed");
    t.equal(view.service.calls.decide[0].status, "verified");
    t.assert(view.main.textContent.includes("No pending identities"));
    t.equal(document.activeElement, view.status());
  });
});

testAsync("[verification view] rejection requires a nonblank bounded reason", async (t) => {
  await withVerification({}, async (view) => {
    view.button("reject").click(); t.assert(view.note().required);
    for (const note of ["", "   ", "x".repeat(VERIFICATION_LIMITS.note + 1)]) {
      view.note().value = note; verificationSubmit(view.form()); await verificationSettle();
      t.equal(view.service.calls.decide.length, 0);
      t.equal(view.note().getAttribute("aria-invalid"), "true");
      t.equal(document.activeElement, view.note());
    }
    view.note().value = "  Please confirm the legal name.  ";
    verificationSubmit(view.form()); await verificationSettle();
    t.equal(view.service.calls.decide[0].status, "rejected");
    t.equal(view.service.calls.decide[0].note, "Please confirm the legal name.");
    t.assert(view.status().textContent.includes("1 identity rejected"));
  });
});

testAsync("[verification view] names and decision notes cannot create markup or leak medical fields", async (t) => {
  const malicious = '<img src=x onerror="alert(1)">';
  const row = verificationRow(1, { display_name: malicious, legal_name: malicious, verification_note: malicious,
    medical_notes: "PRIVATE MEDICAL", emergency_contact_phone: "PRIVATE PHONE", date_of_birth: "PRIVATE DOB" });
  await withVerification({ service: verificationService([row]) }, async (view) => {
    t.assert(view.main.textContent.includes(malicious));
    t.equal(view.main.querySelector("img, script"), null);
    for (const value of ["PRIVATE MEDICAL", "PRIVATE PHONE", "PRIVATE DOB"]) t.assert(!view.main.textContent.includes(value));
    view.button("approve").click();
    t.assert(view.main.querySelector("[data-verification-review]").textContent.includes(malicious));
    t.equal(view.main.querySelector("img, script"), null);
    view.note().value = "</textarea>" + malicious;
    t.equal(view.main.querySelectorAll("textarea").length, 1);
    t.equal(view.main.querySelector("img"), null);
  });
});

testAsync("[verification view] an unfinished note locks queue changes until deliberate discard", async (t) => {
  await withVerification({}, async (view) => {
    view.button("approve").click();
    const form = view.form(); const note = view.note(); note.value = "UNSAVED PRIVATE REVIEW";
    t.assert(view.searchForm().querySelector("fieldset").disabled);
    t.assert(view.button("reload").disabled); t.assert(view.button("bulk").disabled);
    t.assert(view.button("approve").disabled);
    verificationSubmit(view.searchForm()); t.equal(view.service.calls.list.length, 1);
    view.button("cancel").click();
    t.equal(view.form(), null); t.equal(note.value, ""); t.equal(note.defaultValue, "");
    t.assert(!view.searchForm().querySelector("fieldset").disabled);
    t.assert(view.status().textContent.includes("Unsaved decision note discarded"));
    t.equal(view.service.calls.decide.length, 0);
    t.assert(!verificationSubmit(form).defaultPrevented, "detached review does not retain delegated handlers");
  });
});

testAsync("[verification view] a pending decision disables controls and prevents duplicate writes", async (t) => {
  const gate = verificationGate(); let writes = 0;
  const row = verificationRow();
  await withVerification({ service: verificationService([row], { decide: () => { writes += 1; return gate.promise; } }) }, async (view) => {
    view.button("approve").click(); const form = view.form();
    verificationSubmit(form); verificationSubmit(form);
    t.equal(writes, 1); t.assert(form.querySelector("fieldset").disabled);
    t.equal(form.getAttribute("aria-busy"), "true");
    view.button("cancel").dispatchEvent(new Event("click", { bubbles: true }));
    t.equal(view.form(), form, "even a dispatched cancel cannot interrupt an in-flight decision");
    gate.resolve(verificationUpdated([row])); await verificationSettle();
    t.equal(view.form(), null); t.equal(writes, 1);
  });
});

testAsync("[verification view] an unconfirmed decision needs deliberate reload, never automatic retry", async (t) => {
  let writes = 0;
  await withVerification({ service: verificationService(undefined, { decide: async () => { writes += 1; throw { code: "save_unconfirmed", message: "PRIVATE PROVIDER DATA" }; } }) }, async (view) => {
    view.button("approve").click(); view.note().value = "PRIVATE DRAFT";
    const note = view.note(); const form = view.form();
    verificationSubmit(form); await verificationSettle();
    t.assert(view.error().textContent.includes("could not confirm"));
    t.assert(view.error().textContent.includes("does not undo"));
    t.assert(!view.main.textContent.includes("PRIVATE PROVIDER DATA"));
    t.assert(form.querySelector("fieldset").disabled);
    t.equal(form.getAttribute("aria-busy"), "false");
    t.equal(view.service.calls.list.length, 1, "uncertainty does not start an automatic read/retry");
    verificationSubmit(form); t.equal(writes, 1);
    view.button("recover").click(); await verificationSettle();
    t.equal(view.service.calls.list.length, 2); t.equal(writes, 1);
    t.equal(note.value, ""); t.equal(view.form(), null);
  });
});

testAsync("[verification view] a conflict clears selection and blocks decisions until reload", async (t) => {
  const service = verificationService([verificationRow(1), verificationRow(2)], {
    decide: async () => { throw { code: "decision_conflict", message: "PRIVATE CONFLICT DETAIL" }; },
  });
  await withVerification({ service }, async (view) => {
    verificationCheck(view.main.querySelector("[data-verification-select-all]")); view.button("bulk").click();
    verificationSubmit(view.form()); await verificationSettle();
    t.assert(view.error().textContent.includes("changed since this page was loaded"));
    t.equal(view.main.querySelectorAll("[data-verification-select]:checked").length, 0);
    t.assert(view.form().querySelector("fieldset").disabled);
    t.assert(view.button("approve").disabled);
    t.assert(!view.main.textContent.includes("PRIVATE CONFLICT DETAIL"));
    view.button("recover").click(); await verificationSettle();
    t.assert(!view.button("approve").disabled);
    t.equal(view.main.querySelectorAll("[data-verification-select]:checked").length, 0);
  });
});

testAsync("[verification view] returned validation messages cannot expose provider text", async (t) => {
  const payload = '<script>PRIVATE PROVIDER DATA</script>';
  await withVerification({ service: verificationService(undefined, { decide: async () => { throw { code: "invalid_verification", fields: { note: payload }, message: payload }; } }) }, async (view) => {
    view.button("approve").click(); verificationSubmit(view.form()); await verificationSettle();
    t.assert(!view.form().querySelector("fieldset").disabled);
    t.equal(view.note().getAttribute("aria-invalid"), "true");
    t.equal(document.activeElement, view.note());
    t.assert(!view.main.textContent.includes("PRIVATE PROVIDER DATA"));
    t.equal(view.main.querySelector("script"), null);
  });
});

testAsync("[verification view] confirmed success remains truthful if the queue refresh fails", async (t) => {
  let reads = 0; const row = verificationRow();
  const service = verificationService([row], { list: async () => {
    if (++reads === 1) return { rows: [row], hasMore: false };
    throw new Error("PRIVATE READ FAILURE");
  } });
  await withVerification({ service }, async (view) => {
    view.button("approve").click(); verificationSubmit(view.form()); await verificationSettle();
    t.assert(view.status().textContent.includes("1 identity approved"));
    t.assert(view.error().textContent.includes("queue could not be loaded"));
    t.assert(!view.error().textContent.includes("whether the decision was recorded"));
    t.assert(!view.main.textContent.includes("PRIVATE READ FAILURE"));
    t.assert(!view.button("reload").disabled);
  });
});

testAsync("[verification view] missing or mismatched save rows cannot report false success", async (t) => {
  for (const result of [null, [], verificationUpdated([verificationRow(2)]), [verificationRow()]]) {
    await withVerification({ service: verificationService(undefined, { decide: async () => result }) }, async (view) => {
      view.button("approve").click(); verificationSubmit(view.form()); await verificationSettle();
      t.assert(view.error().textContent.includes("could not confirm"));
      t.assert(view.form().querySelector("fieldset").disabled);
      t.equal(view.service.calls.list.length, 1);
    });
  }
});

testAsync("[verification view] access-denied decisions clear notes and result identities", async (t) => {
  await withVerification({ service: verificationService(undefined, { decide: async () => { throw { code: "access_denied" }; } }) }, async (view) => {
    view.button("reject").click(); const note = view.note(); note.value = "PRIVATE REVIEW";
    verificationSubmit(view.form()); await verificationSettle();
    t.equal(note.value, ""); t.equal(view.form(), null);
    t.equal(view.main.querySelectorAll(".app-verification-row").length, 0);
    t.assert(view.error().textContent.includes("administrator access"));
    t.assert(!view.main.textContent.includes("Demo 1"));
  });
});

testAsync("[verification view] search validation and read failures are recoverable without raw errors", async (t) => {
  await withVerification({}, async (view) => {
    view.search().value = "x".repeat(VERIFICATION_LIMITS.search + 1);
    verificationSubmit(view.searchForm()); await verificationSettle();
    t.equal(view.service.calls.list.length, 1);
    t.equal(view.search().getAttribute("aria-invalid"), "true");
    t.equal(document.activeElement, view.search());
  });
  let reads = 0;
  await withVerification({ service: verificationService([], { list: async () => {
    if (++reads === 1) throw new Error("PRIVATE QUERY DETAIL");
    return { rows: [], hasMore: false };
  } }) }, async (view) => {
    t.assert(!view.error().hidden); t.assert(!view.main.textContent.includes("PRIVATE QUERY DETAIL"));
    view.button("reload").click(); await verificationSettle();
    t.equal(reads, 2); t.assert(view.error().hidden);
    t.assert(view.main.textContent.includes("No pending identities"));
  });
});

testAsync("[verification view] cleanup clears search, review notes, results and selection", async (t) => {
  await withVerification({}, async (view) => {
    view.search().value = "Private search";
    verificationCheck(view.main.querySelector("[data-verification-select-all]"));
    view.button("bulk").click();
    const note = view.note(); const search = view.search(); const selection = view.main.querySelector("[data-verification-select-all]");
    note.value = "PRIVATE REVIEW NOTE"; const form = view.form();
    view.cleanup(); view.cleanup();
    t.equal(note.value, ""); t.equal(search.value, ""); t.assert(!selection.checked);
    t.equal(view.main.textContent.trim(), "");
    t.assert(view.service.calls.list[0].signal.aborted);
    t.assert(!verificationSubmit(form).defaultPrevented);
    t.equal(view.service.calls.decide.length, 0);
  });
});

testAsync("[verification view] stale list success and failure cannot replace the next route", async (t) => {
  for (const rejects of [false, true]) {
    const gate = verificationGate(); let current = true;
    await withVerification({ context: { isCurrent: () => current }, service: verificationService([], { list: () => gate.promise }) }, async (view) => {
      current = false; view.cleanup();
      const next = document.createElement("button"); next.textContent = "Another route"; view.main.replaceChildren(next); next.focus();
      if (rejects) gate.reject(new Error("PRIVATE OLD FAILURE")); else gate.resolve({ rows: [verificationRow()], hasMore: false });
      await verificationSettle();
      t.equal(view.main.textContent, "Another route"); t.equal(document.activeElement, next);
    });
  }
});

testAsync("[verification view] role-loss abort fences late decision results and any refresh", async (t) => {
  for (const rejects of [false, true]) {
    const controller = new AbortController(); const gate = verificationGate(); let signal;
    const row = verificationRow();
    const service = verificationService([row], { decide: (_rows, _status, _note, options) => { signal = options.signal; return gate.promise; } });
    await withVerification({ service, context: { signal: controller.signal } }, async (view) => {
      view.button("approve").click(); const note = view.note(); note.value = "OLD ADMIN NOTE";
      verificationSubmit(view.form()); controller.abort();
      t.assert(signal.aborted); t.equal(note.value, "");
      const next = document.createElement("button"); next.textContent = "Access denied"; view.main.replaceChildren(next); next.focus();
      if (rejects) gate.reject({ code: "save_unconfirmed" }); else gate.resolve(verificationUpdated([row]));
      await verificationSettle();
      t.equal(view.main.textContent, "Access denied"); t.equal(document.activeElement, next);
      t.equal(service.calls.list.length, 1, "stale success must not start a privileged list refresh");
    });
  }
});

testAsync("[verification view] unavailable and already-stale contexts cannot start operations", async (t) => {
  await withVerification({ service: {} }, async (view) => {
    t.assert(view.main.textContent.includes("Verification services are unavailable"));
    t.assert(view.button("reload").disabled); t.equal(view.form(), null);
  });
  const main = document.createElement("main"); main.textContent = "Current route";
  const service = verificationService();
  const cleanup = verificationView(main, { service, context: { isCurrent: () => false } });
  t.equal(main.textContent, "Current route"); t.equal(service.calls.list.length, 0); cleanup();
});

testAsync("[verification view] controls remain labelled, keyboard-ready and usable at 360px", async (t) => {
  await withVerification({}, async (view) => {
    view.main.style.width = "360px";
    view.button("reject").click();
    t.assert(view.main.scrollWidth <= 360, `verification page overflowed: ${view.main.scrollWidth}px`);
    t.equal(view.form().getAttribute("autocomplete"), "off");
    t.assert(view.form().querySelector(`label[for="${view.note().id}"]`));
    t.assert(view.searchForm().querySelector(`label[for="${view.search().id}"]`));
    t.equal(view.status().getAttribute("role"), "status"); t.equal(view.error().getAttribute("role"), "alert");
    t.assert(parseFloat(getComputedStyle(view.note()).fontSize) >= 16);
    t.assert(parseFloat(getComputedStyle(view.button("confirm")).minHeight) >= 44);
    for (const id of view.note().getAttribute("aria-describedby").split(" ")) t.assert(view.form().querySelector(`[id="${id}"]`));
  });
});
