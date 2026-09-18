import { html, mount } from "../js/dom.js";
import { VERIFICATION_LIMITS, validateVerificationSearch, validateVerificationDecision } from "../js/verification.js";

const text = (value) => typeof value === "string" ? value : "";
function statusLabel(value) {
  switch (value) {
    case "pending": return "Pending";
    case "verified": return "Verified";
    case "rejected": return "Rejected";
    default: return "Status unavailable";
  }
}
function dateLabel(value) {
  const date = typeof value === "string" ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : "Not recorded";
}
function safeRow(row) {
  if (!row || typeof row.id !== "string" || !row.id || typeof row.display_name !== "string"
      || !["pending", "verified", "rejected"].includes(row.verification_status)
      || typeof row.updated_at !== "string") return null;
  // Verification needs names and decision metadata, not medical/contact fields.
  return {
    id: row.id, display_name: row.display_name, legal_name: text(row.legal_name),
    verification_status: row.verification_status, verification_note: text(row.verification_note),
    created_at: text(row.created_at), updated_at: row.updated_at,
    decided_by: text(row.decided_by), decided_at: text(row.decided_at),
  };
}
function errorMessage(error, saving = false) {
  switch (error?.code) {
    case "invalid_verification": return "Check the decision details and note before continuing.";
    case "access_denied": return "Your administrator access could not be confirmed. Refresh your access or sign in again, then reload the queue.";
    case "decision_conflict": return "One or more identities changed since this page was loaded. The selection has been cleared. Reload the queue and review the current records before deciding.";
    case "stale_request": return "This review is no longer current. Reload the queue before continuing.";
    case "save_unconfirmed": return "We could not confirm whether the decision was recorded. Reload the queue and check the identities before trying again. Leaving this page does not undo a decision already sent.";
    default: return saving
      ? "We could not confirm whether the decision was recorded. Reload the queue and check the identities before trying again. Leaving this page does not undo a decision already sent."
      : "The verification queue could not be loaded. Check your connection and reload the queue.";
  }
}

export function verificationView(mainEl, { service, context = {} } = {}) {
  let disposed = false;
  let generation = 0;
  let listController = null;
  let decisionController = null;
  let rows = [];
  let selected = new Set();
  let editor = null;
  let search = "";
  let offset = 0;
  let hasMore = false;
  let loading = false;
  let ready = false;
  let recoveryRequired = false;
  const routeCurrent = () => !disposed && !context?.signal?.aborted &&
    (typeof context?.isCurrent !== "function" || context.isCurrent());
  if (!routeCurrent()) return () => {};

  mount(mainEl, html`
    <section class="app-verification" aria-labelledby="verification-title">
      <header class="app-state">
        <p class="app-eyebrow">Administration</p><h1 id="verification-title">Verify players</h1>
        <p>Review pending player identities, newest first, or search names across all verification statuses.</p>
        <p>Verification does not grant the player role or approve a player for a competition. Approving an opted-in identity may make its public roster data available; the public website's player directory is a separate integration.</p>
      </header>
      <form data-verification-search-form class="app-state app-verification-search" role="search" autocomplete="off" novalidate>
        <fieldset><legend>Find identities</legend>
          <label for="verification-search">Search by name</label>
          <input id="verification-search" name="search" type="search" maxlength="${VERIFICATION_LIMITS.search}" aria-describedby="verification-search-help verification-search-error">
          <p id="verification-search-help" class="app-muted">Submit a name to search all statuses. Leave it blank to return to the pending queue.</p>
          <p id="verification-search-error" class="app-verification-field-error" hidden></p>
          <div class="app-verification-actions">
            <button type="submit" class="app-button" data-verification-action="search">Search</button>
            <button type="button" class="app-button" data-verification-action="pending">Pending queue</button>
          </div>
        </fieldset>
      </form>
      <div class="app-verification-toolbar">
        <button type="button" class="app-button" data-verification-action="reload">Reload queue</button>
        <p class="app-muted" data-verification-draft-help hidden>Finish or cancel this review before changing the queue.</p>
      </div>
      <p data-verification-status role="status" aria-live="polite" aria-atomic="true" tabindex="-1"></p>
      <div data-verification-error class="app-error" role="alert" tabindex="-1" hidden></div>
      <section class="app-state" aria-labelledby="verification-results-title">
        <h2 id="verification-results-title">Pending queue</h2>
        <div class="app-verification-selection" data-verification-selection hidden>
          <label class="app-verification-checkbox"><input type="checkbox" data-verification-select-all>Select all pending identities on this page</label>
          <p data-verification-selection-count role="status" aria-live="polite"></p>
          <button type="button" class="app-button" data-verification-action="bulk">Review selected approvals</button>
        </div>
        <div data-verification-list aria-busy="true"><p role="status">Loading player identities...</p></div>
        <nav class="app-verification-pagination" aria-label="Verification result pages">
          <button type="button" class="app-button" data-verification-action="previous">Previous page</button>
          <p data-verification-page></p>
          <button type="button" class="app-button" data-verification-action="next">Next page</button>
        </nav>
      </section>
      <section class="app-state" data-verification-review aria-label="Review verification decision" tabindex="-1"></section>
    </section>
  `);
  const section = mainEl.querySelector(".app-verification");
  const list = section.querySelector("[data-verification-list]");
  const review = section.querySelector("[data-verification-review]");
  const searchForm = section.querySelector("[data-verification-search-form]");
  const searchInput = searchForm.elements.namedItem("search");
  const searchError = section.querySelector("#verification-search-error");
  const status = section.querySelector("[data-verification-status]");
  const failure = section.querySelector("[data-verification-error]");
  const selection = section.querySelector("[data-verification-selection]");
  const selectAll = section.querySelector("[data-verification-select-all]");
  const selectionCount = section.querySelector("[data-verification-selection-count]");
  const pageLabel = section.querySelector("[data-verification-page]");
  const resultsTitle = section.querySelector("#verification-results-title");
  const available = typeof service?.list === "function" && typeof service?.decide === "function";
  const isCurrent = () => routeCurrent() && mainEl.contains(section) && section.isConnected;
  const button = (action) => section.querySelector(`[data-verification-action="${action}"]`);

  function announce(message = "", error = false, focus = false, confirmed = "") {
    status.textContent = error ? confirmed : message;
    failure.textContent = error ? message : "";
    failure.hidden = !error;
    if (focus) (error ? failure : status).focus();
  }
  function clearControls(root) {
    for (const input of root.querySelectorAll("input, textarea")) {
      input.value = ""; input.defaultValue = "";
      if (input.type === "checkbox") input.checked = false;
    }
  }
  function emptyReview() {
    mount(review, html`<h2>Review a decision</h2><p>Choose an approval or rejection to review it before confirming. Bulk approval applies only to selected pending identities on the current page.</p>`);
    review.setAttribute("aria-busy", "false");
  }
  function closeReview() {
    clearControls(review);
    editor = null;
    emptyReview();
    syncControls();
  }
  function syncControls() {
    const locked = !available || loading || Boolean(editor);
    searchForm.querySelector("fieldset").disabled = locked;
    button("reload").disabled = locked;
    button("previous").disabled = locked || !ready || recoveryRequired || offset === 0;
    button("next").disabled = locked || !ready || recoveryRequired || !hasMore;
    button("bulk").disabled = locked || recoveryRequired || selected.size === 0;
    section.querySelector("[data-verification-draft-help]").hidden = !editor;
    const pending = rows.filter((row) => row.verification_status === "pending");
    selection.hidden = !ready || !pending.length;
    selectAll.disabled = locked || recoveryRequired || !pending.length;
    selectAll.checked = pending.length > 0 && selected.size === pending.length;
    selectAll.indeterminate = selected.size > 0 && selected.size < pending.length;
    selectionCount.textContent = `${selected.size} pending ${selected.size === 1 ? "identity" : "identities"} selected on this page.`;
    for (const input of list.querySelectorAll("[data-verification-select]")) {
      input.disabled = locked || recoveryRequired;
      input.checked = selected.has(input.dataset.verificationSelect);
    }
    for (const action of list.querySelectorAll("button")) action.disabled = locked || recoveryRequired;
  }
  function renderRows() {
    resultsTitle.textContent = search ? `Name results for “${search}”` : "Pending queue — newest first";
    pageLabel.textContent = `Page ${Math.floor(offset / VERIFICATION_LIMITS.page) + 1} · ${rows.length} shown`;
    mount(list, rows.length ? html`<ul class="app-verification-rows">${rows.map((row) => html`
      <li class="app-verification-row">
        <h3>${row.display_name}</h3>
        <p>Legal name: ${row.legal_name || "Not provided"}</p>
        <p><strong>${statusLabel(row.verification_status)}</strong> · Created ${dateLabel(row.created_at)}</p>
        ${row.verification_status === "pending" ? html`
          <label class="app-verification-checkbox"><input type="checkbox" data-verification-select="${row.id}" aria-label="Select ${row.display_name} for bulk approval">Select for bulk approval</label>
          <div class="app-verification-actions">
            <button type="button" class="app-button" data-verification-action="approve" data-verification-id="${row.id}" aria-label="Review approval for ${row.display_name}">Review approval</button>
            <button type="button" class="app-button" data-verification-action="reject" data-verification-id="${row.id}" aria-label="Review rejection for ${row.display_name}">Review rejection</button>
          </div>` : html`
          <p>Decision recorded: ${dateLabel(row.decided_at)}</p>
          <p>Decision note: ${row.verification_note || "No note recorded"}</p>
          <p class="app-muted">Already reviewed. This screen only makes decisions on pending identities.</p>`}
      </li>` )}</ul>` : html`<p>${search ? "No identities match this name on this page." : "No pending identities on this page."}</p>`);
    syncControls();
  }
  async function loadPage(nextSearch = search, nextOffset = offset, confirmed = "") {
    if (!isCurrent() || !available || editor) return;
    const ticket = ++generation;
    listController?.abort();
    const controller = new AbortController(); listController = controller;
    search = nextSearch; offset = nextOffset; rows = []; selected.clear(); hasMore = false;
    loading = true; ready = false; recoveryRequired = false;
    searchInput.value = search;
    searchInput.setAttribute("aria-invalid", "false"); searchError.hidden = true; searchError.textContent = "";
    announce(confirmed);
    mount(list, html`<p role="status">Loading player identities...</p>`);
    list.setAttribute("aria-busy", "true");
    resultsTitle.textContent = search ? "Searching identities" : "Pending queue — newest first";
    pageLabel.textContent = "";
    syncControls();
    const active = () => isCurrent() && ticket === generation && !controller.signal.aborted;
    try {
      const result = await service.list({ search, offset, signal: controller.signal });
      if (!active()) return;
      if (!result || !Array.isArray(result.rows) || result.rows.length > VERIFICATION_LIMITS.page || typeof result.hasMore !== "boolean") throw new Error("invalid list");
      const nextRows = result.rows.map(safeRow);
      if (nextRows.some((row) => !row) || new Set(nextRows.map((row) => row.id)).size !== nextRows.length) throw new Error("invalid list");
      rows = nextRows; hasMore = result.hasMore; ready = true;
      renderRows();
      if (confirmed) announce(confirmed, false, true);
    } catch (error) {
      if (!active()) return;
      rows = []; selected.clear(); hasMore = false;
      mount(list, html`<p>No verification results are available. Use <strong>Reload queue</strong> to check again.</p>`);
      announce(errorMessage(error), true, Boolean(confirmed), confirmed);
    } finally {
      if (active()) { loading = false; list.setAttribute("aria-busy", "false"); syncControls(); }
    }
  }
  function openReview(candidates, decision) {
    if (!isCurrent() || editor || loading || recoveryRequired || !ready || !candidates.length || candidates.length > VERIFICATION_LIMITS.page) return;
    if (!candidates.every((row) => row.verification_status === "pending" && rows.includes(row))) return;
    editor = { rows: candidates.map((row) => ({ ...row })), decision, busy: false, uncertain: false };
    announce("");
    const title = `${decision === "verified" ? "Approve" : "Reject"} ${candidates.length} ${candidates.length === 1 ? "identity" : "identities"}`;
    mount(review, html`
      <h2>${title}</h2>
      <p>Confirm that these are the identities you reviewed. Only a pending identity can receive a decision.</p>
      <ul class="app-verification-review-list">${candidates.map((row) => html`
        <li><strong>${row.display_name}</strong> · ${row.legal_name || "Legal name not provided"}<br><span class="app-muted">Player ID: ${row.id}</span>
          ${row.verification_note ? html`<p>Current note: ${row.verification_note}</p>` : null}</li>`)}</ul>
      <form data-verification-form autocomplete="off" novalidate aria-label="${title}" aria-busy="false">
        <fieldset><legend>Confirm the decision</legend>
          <label for="verification-note">Decision note (${decision === "rejected" ? "required" : "optional"})</label>
          <textarea id="verification-note" name="note" rows="4" maxlength="${VERIFICATION_LIMITS.note}" aria-describedby="verification-note-help verification-note-error"></textarea>
          <p id="verification-note-help" class="app-muted">This note replaces the current verification note for each listed identity. It may be visible to the player or guardian. Keep it concise and do not include medical information.</p>
          <p id="verification-note-error" class="app-verification-field-error" hidden></p>
          <p>Recording this decision does not grant account roles or competition approval.</p>
          <div class="app-verification-actions">
            <button type="submit" class="app-button app-verification-primary" data-verification-action="confirm">${decision === "verified" ? "Confirm approval" : "Confirm rejection"}</button>
            <button type="button" class="app-button" data-verification-action="cancel">Cancel and discard note</button>
          </div>
        </fieldset>
        <div data-verification-recovery class="app-error" hidden>
          <p>Do not submit this decision again until you reload and check the current records. Reloading discards this draft; it does not undo a decision already sent.</p>
          <button type="button" class="app-button" data-verification-action="recover">Reload queue to check</button>
        </div>
      </form>
    `);
    review.querySelector('textarea[name="note"]').required = decision === "rejected";
    syncControls(); review.focus();
  }
  function noteError(message) {
    const input = review.querySelector('textarea[name="note"]');
    const output = review.querySelector("#verification-note-error");
    input.setAttribute("aria-invalid", String(Boolean(message)));
    output.hidden = !message; output.textContent = message;
    if (message) input.focus();
  }
  async function confirm(event) {
    const form = event.target.closest("[data-verification-form]");
    if (!form || !section.contains(form)) return;
    event.preventDefault();
    if (!isCurrent() || !editor || editor.busy || editor.uncertain) return;
    noteError("");
    const state = editor;
    const checked = validateVerificationDecision(state.rows, state.decision, form.elements.namedItem("note").value);
    if (Object.keys(checked.errors).length) {
      announce("Check the decision details and note before continuing.", true);
      if (checked.errors.note) noteError(text(checked.errors.note));
      else failure.focus();
      return;
    }
    const controller = new AbortController(); decisionController = controller;
    const ticket = generation;
    state.busy = true;
    form.querySelector("fieldset").disabled = true;
    form.setAttribute("aria-busy", "true");
    announce("Recording the verification decision...");
    const active = () => isCurrent() && editor === state && ticket === generation && !controller.signal.aborted;
    try {
      // Original canonical rows include pending status; validation's compact
      // optimistic-concurrency tokens alone are not the service input contract.
      const result = await service.decide(state.rows, state.decision, checked.data.note, { signal: controller.signal });
      if (!active()) return;
      const saved = Array.isArray(result) ? result.map(safeRow) : [];
      const expected = new Set(state.rows.map((row) => row.id));
      if (saved.length !== expected.size || saved.some((row) => !row || !expected.has(row.id) || row.verification_status !== state.decision)
          || new Set(saved.map((row) => row.id)).size !== expected.size) throw { code: "save_unconfirmed" };
      const confirmed = `${saved.length} ${saved.length === 1 ? "identity" : "identities"} ${state.decision === "verified" ? "approved" : "rejected"}. Account roles and competition approval are unchanged.`;
      selected.clear(); closeReview();
      // Pending rows move out of the queue. Restart its pagination rather than
      // letting an old offset skip records after removal.
      if (isCurrent()) void loadPage(search, 0, confirmed);
    } catch (error) {
      if (!active()) return;
      state.busy = false;
      form.setAttribute("aria-busy", "false");
      if (error?.code === "access_denied") {
        selected.clear(); rows = []; ready = false; hasMore = false;
        closeReview(); mount(list, html`<p>Administrator access is required to view this queue.</p>`);
        announce(errorMessage(error), true, true); syncControls();
      } else if (error?.code === "invalid_verification" && error?.fields?.note) {
        form.querySelector("fieldset").disabled = false;
        announce(errorMessage(error), true);
        noteError("Enter a valid decision note within the displayed limit. A rejection needs a reason.");
      } else {
        state.uncertain = true; recoveryRequired = true; selected.clear();
        announce(errorMessage(error, true), true, true);
        form.querySelector("[data-verification-recovery]").hidden = false;
        syncControls();
      }
    }
  }
  function submit(event) {
    if (event.target === searchForm) {
      event.preventDefault();
      if (!isCurrent() || editor || loading || !available) return;
      const checked = validateVerificationSearch(searchInput.value);
      searchInput.setAttribute("aria-invalid", String(Boolean(checked.errors.search)));
      searchError.hidden = !checked.errors.search;
      searchError.textContent = text(checked.errors.search);
      if (checked.errors.search) { searchInput.focus(); return; }
      void loadPage(checked.data.search, 0);
    } else void confirm(event);
  }
  function click(event) {
    const control = event.target.closest("button[data-verification-action]");
    if (!control || !section.contains(control) || control.disabled || !isCurrent()) return;
    const action = control.dataset.verificationAction;
    if (action === "recover" && editor?.uncertain && !editor.busy) { closeReview(); void loadPage(search, offset); return; }
    if (action === "cancel" && editor && !editor.busy && !editor.uncertain) {
      closeReview(); announce("Unsaved decision note discarded.", false, true); return;
    }
    if (editor || loading || !available) return;
    if (action === "reload") void loadPage(search, offset);
    else if (action === "pending") void loadPage("", 0);
    else if (action === "previous" && offset > 0 && !recoveryRequired) void loadPage(search, Math.max(0, offset - VERIFICATION_LIMITS.page));
    else if (action === "next" && hasMore && !recoveryRequired) void loadPage(search, offset + VERIFICATION_LIMITS.page);
    else if (action === "bulk") openReview(rows.filter((row) => selected.has(row.id)), "verified");
    else if (action === "approve" || action === "reject") {
      const row = rows.find((item) => item.id === control.dataset.verificationId);
      if (row) openReview([row], action === "approve" ? "verified" : "rejected");
    }
  }
  function change(event) {
    if (!isCurrent() || editor || loading || recoveryRequired || !ready) return;
    const pending = rows.filter((row) => row.verification_status === "pending");
    if (event.target === selectAll) selected = new Set(selectAll.checked ? pending.map((row) => row.id) : []);
    else if (event.target.matches("[data-verification-select]")) {
      const id = event.target.dataset.verificationSelect;
      if (!pending.some((row) => row.id === id)) return;
      if (event.target.checked) selected.add(id); else selected.delete(id);
    } else return;
    syncControls();
  }
  function cleanup() {
    if (disposed) return;
    disposed = true; generation += 1;
    listController?.abort(); decisionController?.abort();
    section.removeEventListener("submit", submit); section.removeEventListener("click", click); section.removeEventListener("change", change);
    context?.signal?.removeEventListener("abort", cleanup);
    clearControls(section); selected.clear(); rows = []; editor = null; search = "";
    section.replaceChildren();
  }
  section.addEventListener("submit", submit); section.addEventListener("click", click); section.addEventListener("change", change);
  context?.signal?.addEventListener("abort", cleanup, { once: true });
  emptyReview();
  if (available) void loadPage();
  else {
    list.setAttribute("aria-busy", "false");
    mount(list, html`<p>Verification services are unavailable. Reload the page or sign in again to try.</p>`);
    syncControls();
  }
  return cleanup;
}
