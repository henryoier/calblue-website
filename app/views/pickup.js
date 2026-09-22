import { html, mount } from "../js/dom.js";
import { PICKUP_LIMITS, validatePickupDetails, pickupLocalInput } from "../js/pickup.js";

const pickupText = (value) => typeof value === "string" ? value : "";
const pickupStatus = (value) => ({ draft: "Draft", published: "Published", reg_closed: "Registration closed",
  cancelled: "Cancelled", completed: "Completed", locked: "Attendance locked" })[value] || "Unavailable";
const pickupEditable = (row) => ["draft", "published", "reg_closed"].includes(row?.status);
const pickupDates = ["gather_time", "start_time", "end_time", "registration_opens_at", "registration_closes_at"];
const pickupOptionLabel = (option, kind) => option.name.trim() || `Unnamed ${kind} (${option.id.slice(0, 8)})`;

function pickupViewError(error, writing = false) {
  switch (error?.code) {
    case "access_denied": return "Pickup management requires administrator access or an organizer grant on the game's team. Your access could not be confirmed.";
    case "invalid_pickup": return "Check the highlighted game details before continuing.";
    case "pickup_conflict":
    case "decision_conflict":
    case "save_conflict": return "This game changed after you opened it. Reload and review its current details before trying again.";
    case "stale_request": return "This screen is no longer current. Reload games before continuing.";
    case "save_unconfirmed": return "We could not confirm whether the change was saved. Reload and check the game before retrying. For a new draft, look for it in the list to avoid creating a duplicate.";
    default: return writing
      ? "We could not confirm whether the change was saved. Reload and check the game before retrying. Leaving this page does not undo a change already sent."
      : "Pickup games could not be loaded. Check your connection and reload games.";
  }
}

export function pickupView(mainEl, { service, context = {} } = {}) {
  let disposed = false;
  let generation = 0;
  let accessGeneration = 0;
  let readController = null;
  let writeController = null;
  let accessController = null;
  let options = null;
  let rows = [];
  let offset = 0;
  let hasMore = false;
  let ready = false;
  let loading = false;
  let checkingAccess = false;
  let editor = null;
  let recoveryRequired = false;
  const routeCurrent = () => !disposed && !context.signal?.aborted
    && (typeof context.isCurrent !== "function" || context.isCurrent());
  if (!routeCurrent()) return () => {};
  mount(mainEl, html`
    <section class="app-pickup" aria-labelledby="pickup-title">
      <header class="app-state">
        <p class="app-eyebrow">Organize a game</p><h1 id="pickup-title">Manage pickup games</h1>
        <p>Create a draft, review its local times, then publish it. Organizers manage only their assigned teams; fee overrides require an administrator.</p>
        <p class="app-muted">Member game browsing and registration are separate upcoming features. This screen manages pickup games only.</p>
      </header>
      <div class="app-pickup-actions">
        <button type="button" class="app-button app-pickup-primary" data-pickup-action="new">Create pickup</button>
        <button type="button" class="app-button" data-pickup-action="reload">Reload games</button>
      </div>
      <p data-pickup-status role="status" aria-live="polite" tabindex="-1"></p>
      <div data-pickup-error class="app-error" role="alert" tabindex="-1" hidden></div>
      <section class="app-state" aria-labelledby="pickup-list-title">
        <h2 id="pickup-list-title">Pickup games — newest created first</h2>
        <div data-pickup-list aria-busy="true"></div>
        <nav class="app-pickup-actions" aria-label="Pickup game pages">
          <button type="button" class="app-button" data-pickup-action="previous">Previous page</button>
          <p data-pickup-page></p>
          <button type="button" class="app-button" data-pickup-action="next">Next page</button>
        </nav>
      </section>
      <section class="app-state" data-pickup-editor tabindex="-1" aria-label="Pickup game details"></section>
    </section>
  `);
  const section = mainEl.querySelector(".app-pickup");
  const list = section.querySelector("[data-pickup-list]");
  const panel = section.querySelector("[data-pickup-editor]");
  const status = section.querySelector("[data-pickup-status]");
  const failure = section.querySelector("[data-pickup-error]");
  const page = section.querySelector("[data-pickup-page]");
  const available = ["options", "list", "save", "transition"].every((key) => typeof service?.[key] === "function");
  const current = () => routeCurrent() && mainEl.contains(section) && section.isConnected;
  const button = (action) => section.querySelector(`[data-pickup-action="${action}"]`);

  function announce(message = "", error = false, focus = false, confirmed = "") {
    status.textContent = error ? confirmed : message;
    failure.textContent = error ? message : "";
    failure.hidden = !error;
    if (focus) (error ? failure : status).focus();
  }
  function clearInputs(root) {
    for (const input of root.querySelectorAll("input, textarea, select")) {
      input.value = "";
      if ("defaultValue" in input) input.defaultValue = "";
    }
  }
  function emptyEditor() {
    clearInputs(panel); editor = null;
    mount(panel, html`<h2>Game details</h2><p>Create a draft or open a game above. Unsaved details stay only on this page; leaving it or signing out discards them.</p>`);
    panel.setAttribute("aria-busy", "false");
  }
  function controls() {
    const blocked = !available || loading || checkingAccess || Boolean(editor);
    button("new").disabled = blocked || !ready || recoveryRequired;
    button("reload").disabled = blocked;
    button("previous").disabled = blocked || !ready || recoveryRequired || offset === 0;
    button("next").disabled = blocked || !ready || recoveryRequired || !hasMore;
    for (const action of list.querySelectorAll("button")) action.disabled = blocked || recoveryRequired;
    const fieldset = panel.querySelector("fieldset");
    if (fieldset) fieldset.disabled = Boolean(editor?.busy || editor?.uncertain || checkingAccess);
    const recover = panel.querySelector('[data-pickup-action="recover"]');
    if (recover) recover.disabled = Boolean(editor?.busy || checkingAccess);
  }
  function clock(value, zone) {
    if (!value) return "Not set";
    try { return `${pickupLocalInput(value, zone).replace("T", " ")} (${zone})`; }
    catch { return "Time unavailable"; }
  }
  function renderRows() {
    page.textContent = `Page ${Math.floor(offset / PICKUP_LIMITS.page) + 1} · ${rows.length} shown`;
    mount(list, rows.length ? html`<ul class="app-pickup-rows">${rows.map((row) => html`
      <li class="app-pickup-row">
        <h3>${row.title.trim() || "Untitled pickup"}</h3><p><strong>${pickupStatus(row.status)}</strong></p>
        <p>Gather: ${clock(row.gather_time, row.timezone)}<br>Kick-off: ${clock(row.start_time, row.timezone)}</p>
        <p>${row.venue_id && options?.venues.some((venue) => venue.id === row.venue_id)
          ? pickupOptionLabel(options.venues.find((venue) => venue.id === row.venue_id), "venue")
          : "No saved venue"}${row.field_label ? ` · ${row.field_label}` : ""}</p>
        ${row.status === "cancelled" ? html`<p class="app-pickup-reason">Cancellation reason: ${row.cancellation_reason || "Not recorded"}</p>` : null}
        <div class="app-pickup-actions">
          <button type="button" class="app-button" data-pickup-action="open" data-pickup-id="${row.id}">${pickupEditable(row) ? "Edit details" : "View details"}</button>
          ${row.status === "draft" ? html`<button type="button" class="app-button" data-pickup-action="publish" data-pickup-id="${row.id}">Review publication</button>` : null}
          ${row.status === "published" ? html`<button type="button" class="app-button" data-pickup-action="close" data-pickup-id="${row.id}">Close registration</button>` : null}
          ${pickupEditable(row) ? html`<button type="button" class="app-button" data-pickup-action="cancel" data-pickup-id="${row.id}">Cancel game</button>` : null}
        </div>
      </li>`)}</ul>` : html`<p>No pickup games on this page. Create a draft to start.</p>`);
  }
  function checkedOptions(value) {
    if (!value || typeof value.can_override_fee !== "boolean" || !Array.isArray(value.teams)
        || !Array.isArray(value.venues)) throw new Error("invalid options");
    return value;
  }
  function denyAccess() {
    options = null; rows = []; ready = false; hasMore = false; recoveryRequired = true;
    emptyEditor(); mount(list, html`<p>Pickup management access could not be confirmed. Reload games after your access has been restored.</p>`);
    page.textContent = "";
  }
  async function loadPage(nextOffset = offset, confirmed = "") {
    if (!current() || !available || editor || checkingAccess) return;
    // An uncertain create may have committed on the newest page. Recovery,
    // including after an access refresh clears its editor, must inspect there.
    if (recoveryRequired) nextOffset = 0;
    const ticket = ++generation;
    readController?.abort();
    const controller = new AbortController(); readController = controller;
    loading = true; ready = false; rows = []; offset = nextOffset; hasMore = false;
    recoveryRequired = true;
    announce(confirmed); mount(list, html`<p role="status">Loading pickup games…</p>`);
    list.setAttribute("aria-busy", "true"); controls();
    const active = () => current() && ticket === generation && !controller.signal.aborted;
    try {
      const nextOptions = checkedOptions(await service.options({ signal: controller.signal }));
      if (!active()) return;
      const result = await service.list({ offset, signal: controller.signal });
      if (!active()) return;
      if (!result || !Array.isArray(result.rows) || result.rows.length > PICKUP_LIMITS.page || typeof result.hasMore !== "boolean"
          || result.rows.some((row) => !row || typeof row.id !== "string" || typeof row.title !== "string"
            || typeof row.updated_at !== "string" || !["draft", "published", "reg_closed", "completed", "locked", "cancelled"].includes(row.status))
          || new Set(result.rows.map((row) => row.id)).size !== result.rows.length) throw new Error("invalid games");
      options = nextOptions; rows = result.rows; hasMore = result.hasMore; ready = true; recoveryRequired = false;
      renderRows(); announce(confirmed, false, Boolean(confirmed));
    } catch (error) {
      if (!active()) return;
      if (error?.code === "access_denied") denyAccess();
      else mount(list, html`<p>No games are available. Use Reload games to try again.</p>`);
      announce(pickupViewError(error), true, Boolean(confirmed), confirmed);
    } finally {
      if (active()) { loading = false; list.setAttribute("aria-busy", "false"); controls(); }
    }
  }

  const fields = [
    ["title", "Game title", "text", 200], ["field_label", "Field / location label", "text", 200],
    ["gather_time", "Gather time (optional)", "datetime-local"], ["start_time", "Kick-off time", "datetime-local"],
    ["end_time", "End time (optional)", "datetime-local"], ["capacity", "Player capacity (blank means unlimited)", "number"],
    ["registration_opens_at", "Registration opens (optional)", "datetime-local"],
    ["registration_closes_at", "Registration closes (optional)", "datetime-local"],
    ["kit_color", "Kit color (optional)", "text", 100],
  ];
  function fieldError(name) { return html`<p id="pickup-${name}-error" class="app-pickup-field-error" data-pickup-field-error="${name}" hidden></p>`; }
  function fillForm(form, row) {
    for (const name of ["title", "team_id", "venue_id", "field_label", "timezone", "capacity", "kit_color", "notes", "fee_override"]) {
      const input = form.elements.namedItem(name);
      if (input) input.value = row?.[name] == null ? "" : String(row[name]);
    }
    const team = form.elements.namedItem("team_id");
    if (!row && !options.can_override_fee && options.teams.length) team.value = options.teams[0].id;
    const venue = options.venues.find((item) => item.id === row?.venue_id);
    const timezone = venue?.timezone || row?.timezone || "America/Los_Angeles";
    form.elements.namedItem("timezone").value = timezone;
    // The display baseline may use a venue's newly changed zone, while the
    // service/CAS row stays untouched. Preserve known instants in DST folds.
    editor.formOriginalRow = row ? { ...row, timezone } : null;
    editor.initialTimezone = timezone;
    editor.initialTimes = {};
    for (const name of pickupDates) {
      const full = row?.[name] ? pickupLocalInput(row[name], timezone) : "";
      const input = form.elements.namedItem(name);
      // Native datetime-local controls support milliseconds, not PostgreSQL's
      // six fractional digits. Restore the full value only if left unchanged.
      input.value = full.replace(/(\.\d{3})\d+$/, "$1");
      editor.initialTimes[name] = { full, displayed: input.value };
    }
    form.elements.namedItem("timezone").readOnly = Boolean(form.elements.namedItem("venue_id").value);
    form.elements.namedItem("title").required = true;
    form.elements.namedItem("start_time").required = true;
    form.elements.namedItem("timezone").required = true;
    form.elements.namedItem("capacity").min = "1"; form.elements.namedItem("capacity").max = "10000";
    for (const name of pickupDates) form.elements.namedItem(name).step = "any";
    const fee = form.elements.namedItem("fee_override");
    if (fee) { fee.min = "0"; fee.max = "99999999.99"; fee.step = "0.01"; }
    if (row && timezone !== row.timezone) {
      announce("The saved venue's timezone changed. Times below show the existing instants in its current timezone. Review every time before saving.", true);
    }
  }
  function openEditor(row = null) {
    if (!current() || editor || !ready || loading || checkingAccess || recoveryRequired) return;
    if (row && pickupEditable(row) && ((row.team_id && !options.teams.some((team) => team.id === row.team_id))
        || (row.venue_id && !options.venues.some((venue) => venue.id === row.venue_id)))) {
      announce("This game's team or venue is not available in the current options. Reload games before editing; no details have been changed.", true, true);
      return;
    }
    editor = { kind: "details", row: row ? { ...row } : null, busy: false, uncertain: false };
    announce("");
    if (row && !pickupEditable(row)) {
      mount(panel, html`<h2>${row.title.trim() || "Untitled pickup"}</h2><p><strong>${pickupStatus(row.status)}</strong> — read only</p>
        <p>Gather: ${clock(row.gather_time, row.timezone)}<br>Kick-off: ${clock(row.start_time, row.timezone)}<br>End: ${clock(row.end_time, row.timezone)}</p>
        <p>Cancellation reason: ${row.cancellation_reason || "Not recorded"}</p><p class="app-pickup-notes">${row.notes || "No notes"}</p>
        <button type="button" class="app-button" data-pickup-action="discard">Close details</button>`);
    } else {
      mount(panel, html`<h2>${row ? "Edit pickup game" : "Create a pickup draft"}</h2>
        <p>${row ? "Saving details does not change this game's publication status." : "A new game is private until you separately confirm publication."}</p>
        <form data-pickup-form autocomplete="off" novalidate>
          <fieldset><legend>Game details</legend>
            <div class="app-pickup-grid">
              <div><label for="pickup-team_id">Organizing team</label><select id="pickup-team_id" name="team_id" aria-describedby="pickup-team_id-error">
                ${options.can_override_fee ? html`<option value="">No team (administrator only)</option>` : null}
                ${options.teams.map((team) => html`<option value="${team.id}">${pickupOptionLabel(team, "team")}</option>`)}</select>${fieldError("team_id")}</div>
              <div><label for="pickup-venue_id">Saved venue (optional)</label><select id="pickup-venue_id" name="venue_id" aria-describedby="pickup-venue_id-error">
                <option value="">No saved venue — use the location label</option>${options.venues.map((venue) => html`<option value="${venue.id}">${pickupOptionLabel(venue, "venue")}</option>`)}</select>${fieldError("venue_id")}</div>
              <div><label for="pickup-timezone">IANA timezone</label><input id="pickup-timezone" name="timezone" type="text" maxlength="100" aria-describedby="pickup-timezone-help pickup-timezone-error">
                <p id="pickup-timezone-help" class="app-muted">All times below use this timezone, not your browser's. A saved venue sets it automatically. Review the times if you change venue or timezone.</p>${fieldError("timezone")}</div>
              ${fields.map(([name, label, type, max]) => html`<div><label for="pickup-${name}">${label}</label>
                <input id="pickup-${name}" name="${name}" type="${type}" maxlength="${max ? max * 2 : 100}" aria-describedby="pickup-${name}-error">${fieldError(name)}</div>`)}
              ${options.can_override_fee ? html`<div><label for="pickup-fee_override">Game fee override (optional, administrator only)</label>
                <input id="pickup-fee_override" name="fee_override" type="number" aria-describedby="pickup-fee-help pickup-fee_override-error">
                <p id="pickup-fee-help" class="app-muted">Blank inherits the applicable fee schedule; 0 makes the game free.</p>${fieldError("fee_override")}</div>`
                : html`<p>Fee override: ${row?.fee_override == null ? "Inherited from the fee schedule" : row.fee_override}. Only an administrator can change fees.</p>`}
            </div>
            <label for="pickup-notes">Operational notes (optional)</label><textarea id="pickup-notes" name="notes" rows="4" maxlength="8000" aria-describedby="pickup-notes-help pickup-notes-error"></textarea>
            <p id="pickup-notes-help" class="app-muted">Published game notes may be visible to signed-in members. Do not include medical or personal contact details.</p>${fieldError("notes")}
            <div class="app-pickup-actions"><button type="submit" class="app-button app-pickup-primary">${row ? "Save details" : "Save draft"}</button>
              <button type="button" class="app-button" data-pickup-action="discard">Discard unsaved changes</button></div>
          </fieldset>
          <div data-pickup-recovery class="app-error" hidden><p>Reloading discards this draft. Check the current game before retrying a change; a lost response does not undo it.</p>
            <button type="button" class="app-button" data-pickup-action="recover">Reload games to check</button></div>
        </form>`);
      try { fillForm(panel.querySelector("form"), row); }
      catch { emptyEditor(); announce("The game details could not be opened safely. Reload games and try again.", true, true); }
    }
    controls(); panel.focus();
  }
  function openTransition(row, action) {
    if (!current() || editor || !ready || loading || checkingAccess || recoveryRequired || !pickupEditable(row)) return;
    if ((action === "publish" && row.status !== "draft") || (action === "close" && row.status !== "published")) return;
    editor = { kind: "transition", row: { ...row }, action, busy: false, uncertain: false };
    const label = ({ publish: "Publish game", close: "Close registration", cancel: "Cancel game" })[action];
    mount(panel, html`<h2>${label}: ${row.title.trim() || "Untitled pickup"}</h2>
      <p>Gather: ${clock(row.gather_time, row.timezone)}<br>Kick-off: ${clock(row.start_time, row.timezone)}</p>
      <p>${action === "publish" ? "This makes the game visible to members and public game readers. Check the venue and local times before confirming."
        : action === "close" ? "This stops new registrations. Existing registrations are kept."
          : "Cancellation keeps existing registrations for the record. A cancelled game cannot be finalized or generate attendance charges. This screen cannot reopen it."}</p>
      <form data-pickup-transition autocomplete="off" novalidate><fieldset><legend>Confirm the change</legend>
        ${action === "cancel" ? html`<label for="pickup-reason">Cancellation reason (required)</label><textarea id="pickup-reason" name="reason" rows="3" maxlength="4000" required aria-describedby="pickup-reason-error"></textarea>
          <p class="app-muted">This reason appears on the game. Do not include private personal information.</p>${fieldError("reason")}` : null}
        <div class="app-pickup-actions"><button type="submit" class="app-button app-pickup-primary">Confirm ${action === "publish" ? "publication" : action === "close" ? "registration closure" : "cancellation"}</button>
          <button type="button" class="app-button" data-pickup-action="discard">Go back without changing the game</button></div>
      </fieldset><div data-pickup-recovery class="app-error" hidden><p>Reload and check the current game before trying again.</p>
        <button type="button" class="app-button" data-pickup-action="recover">Reload games to check</button></div></form>`);
    announce(""); controls(); panel.focus();
  }
  function fieldErrors(errors = {}) {
    for (const output of panel.querySelectorAll("[data-pickup-field-error]")) {
      const name = output.dataset.pickupFieldError;
      const message = pickupText(errors[name]); output.textContent = message; output.hidden = !message;
      const input = panel.querySelector(`[name="${name}"]`);
      input?.setAttribute("aria-invalid", String(Boolean(message)));
    }
    if (pickupText(errors._form)) announce(errors._form, true);
    panel.querySelector('[aria-invalid="true"]')?.focus();
  }
  async function submit(event) {
    const form = event.target;
    if (!form.matches("[data-pickup-form], [data-pickup-transition]") || !panel.contains(form)) return;
    event.preventDefault();
    if (!current() || !editor || editor.busy || editor.uncertain || checkingAccess) return;
    const state = editor;
    let data = null; let reason = null;
    fieldErrors();
    if (state.kind === "details") {
      const values = Object.fromEntries(new FormData(form));
      if (values.timezone === state.initialTimezone) {
        for (const name of pickupDates) {
          if (values[name] === state.initialTimes[name].displayed) values[name] = state.initialTimes[name].full;
        }
      }
      const checked = validatePickupDetails(values, { ...options, originalRow: state.formOriginalRow });
      if (Object.keys(checked.errors).length) {
        announce("Check the highlighted game details before continuing.", true); fieldErrors(checked.errors); return;
      }
      data = checked.data;
    } else if (state.action === "cancel") {
      reason = form.elements.namedItem("reason").value.trim();
      if (!reason || [...reason].length > 2000) {
        announce("Enter a cancellation reason before confirming.", true);
        fieldErrors({ reason: "Enter a reason of 1–2000 characters." }); return;
      }
    }
    const controller = new AbortController(); writeController = controller;
    const ticket = generation;
    state.busy = true; panel.setAttribute("aria-busy", "true"); controls(); announce("Saving the game…");
    const active = () => current() && editor === state && ticket === generation && !controller.signal.aborted;
    try {
      const saved = state.kind === "details"
        ? await service.save(data, { row: state.row, signal: controller.signal })
        : await service.transition(state.row, state.action, reason, { signal: controller.signal });
      if (!active()) return;
      if (!saved || typeof saved.id !== "string" || (state.row && saved.id !== state.row.id)) throw { code: "save_unconfirmed" };
      let confirmation = state.kind === "details" ? (state.row ? "Game details saved." : "Draft saved. Open Review publication when you are ready to publish it.")
        : state.action === "publish" ? "Game published." : state.action === "close" ? "Registration closed." : "Game cancelled. Existing registrations were kept.";
      if (state.kind === "transition" && saved.timezone !== state.row.timezone) {
        confirmation += " The saved venue's current timezone was applied; existing game times kept their instants.";
      }
      emptyEditor(); loading = false; void loadPage(0, confirmation);
    } catch (error) {
      if (!active()) return;
      state.busy = false; panel.setAttribute("aria-busy", "false");
      if (error?.code === "access_denied") { denyAccess(); announce(pickupViewError(error), true, true); }
      else if (error?.code === "invalid_pickup") {
        announce(pickupViewError(error), true, true); fieldErrors(error.fields || {});
      } else {
        state.uncertain = true; recoveryRequired = true;
        panel.querySelector("[data-pickup-recovery]").hidden = false;
        announce(pickupViewError(error, true), true, true);
      }
      controls();
    }
  }
  function click(event) {
    const control = event.target.closest("button[data-pickup-action]");
    if (!control || !section.contains(control) || control.disabled || !current()) return;
    const action = control.dataset.pickupAction;
    if (action === "discard" && editor && !editor.busy && !editor.uncertain && !checkingAccess) {
      emptyEditor(); controls(); announce("Closed without changing the game.", false, true); return;
    }
    if (action === "recover" && editor?.uncertain && !editor.busy && !checkingAccess) {
      emptyEditor(); void loadPage(0); return;
    }
    if (editor || loading || checkingAccess || !available) return;
    if (action === "reload") void loadPage(offset);
    else if (action === "new") openEditor();
    else if (action === "previous" && offset > 0) void loadPage(Math.max(0, offset - PICKUP_LIMITS.page));
    else if (action === "next" && hasMore) void loadPage(offset + PICKUP_LIMITS.page);
    else if (["open", "publish", "close", "cancel"].includes(action)) {
      const row = rows.find((item) => item.id === control.dataset.pickupId);
      if (row) { if (action === "open") openEditor(row); else openTransition(row, action); }
    }
  }
  function change(event) {
    if (!current() || editor?.kind !== "details" || editor.busy || editor.uncertain || checkingAccess) return;
    if (event.target.name === "venue_id") {
      const timezone = panel.querySelector('[name="timezone"]');
      const venue = options.venues.find((item) => item.id === event.target.value);
      timezone.readOnly = Boolean(venue);
      if (venue) timezone.value = venue.timezone;
      announce("Review all local times after changing the venue or timezone.");
    }
  }
  async function refreshAccess() {
    if (!current() || !available || loading || editor?.busy) return;
    const ticket = ++accessGeneration;
    accessController?.abort(); const controller = new AbortController(); accessController = controller;
    checkingAccess = true; controls();
    const active = () => current() && ticket === accessGeneration && !controller.signal.aborted;
    try {
      const next = checkedOptions(await service.options({ signal: controller.signal }));
      if (!active()) return;
      if (JSON.stringify(next) !== JSON.stringify(options)) {
        emptyEditor(); rows = []; ready = false; mount(list, html`<p>Access or venue settings changed. Reload games to review the current details.</p>`);
        announce("Access or venue settings changed; the unsaved editor was cleared. Reload games before continuing.", true);
      }
      options = next;
    } catch (error) {
      if (!active()) return;
      denyAccess(); announce(pickupViewError(error), true);
    } finally { if (active()) { checkingAccess = false; controls(); } }
  }
  function cleanup() {
    if (disposed) return;
    disposed = true; generation += 1; accessGeneration += 1;
    readController?.abort(); writeController?.abort(); accessController?.abort();
    section.removeEventListener("click", click); section.removeEventListener("submit", submit); section.removeEventListener("change", change);
    context.signal?.removeEventListener("abort", cleanup);
    clearInputs(section); rows = []; options = null; editor = null; section.replaceChildren();
  }
  cleanup.refreshAccess = refreshAccess;
  section.addEventListener("click", click); section.addEventListener("submit", submit); section.addEventListener("change", change);
  context.signal?.addEventListener("abort", cleanup, { once: true });
  emptyEditor(); controls();
  if (available) void loadPage(0);
  else { list.setAttribute("aria-busy", "false"); announce("Pickup services are unavailable. Reload the page to try again.", true); }
  return cleanup;
}
