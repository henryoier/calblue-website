import { html, mount } from "../js/dom.js";
import { validateIdentity, identityToday, IDENTITY_LIMITS } from "../js/identity.js";

const LABELS = {
  display_name: "Display name", legal_name: "Legal name", date_of_birth: "Date of birth",
  default_positions: "Preferred positions", preferred_number: "Preferred shirt number",
  jersey_size: "Jersey size", emergency_contact_name: "Emergency contact name",
  emergency_contact_phone: "Emergency contact phone", medical_notes: "Medical notes",
  is_public: "Public roster preference",
};
const TEXT_FIELDS = ["display_name", "legal_name", "default_positions", "preferred_number", "jersey_size",
  "emergency_contact_name", "emergency_contact_phone", "medical_notes"];
const text = (value) => typeof value === "string" ? value : "";
function statusLabel(value) {
  switch (value) {
    case "pending": return "Pending verification";
    case "verified": return "Verified";
    case "rejected": return "Not approved";
    default: return "Verification status unavailable";
  }
}

function summary(row) {
  if (!row || typeof row.id !== "string" || !row.id || typeof row.display_name !== "string") return null;
  // Keep only list-safe fields, even when a service double returns a detail row.
  return {
    id: row.id, display_name: row.display_name, verification_status: row.verification_status,
    is_public: row.is_public === true,
    default_positions: Array.isArray(row.default_positions) ? row.default_positions.filter((value) => typeof value === "string") : [],
    preferred_number: Number.isInteger(row.preferred_number) && row.preferred_number >= 0 && row.preferred_number <= 99 ? row.preferred_number : null,
  };
}

function rosterStatus(row) {
  if (!row?.is_public) return "Not opted in to the public roster.";
  return row.verification_status === "verified"
    ? "Public roster data: available. Changes to public fields become available when saved."
    : "Opted in, but data is not publicly available until this identity is verified.";
}

function errorText(error, saving = false) {
  switch (error?.code) {
    case "invalid_identity": return "Review the highlighted fields and try again.";
    case "identity_exists": return "Your account already has a player identity. Reload your identities to open the existing record.";
    case "identity_unavailable": return "This identity is unavailable or you no longer have access. Reload your identities to check.";
    case "stale_request": return "Your account or this request has changed. Reload your identities before continuing.";
    case "save_unconfirmed": return "We could not confirm whether your changes were saved. Reload your identities and check the record before trying again. Leaving this page does not undo a save already sent.";
    default: return saving
      ? "We could not confirm whether your changes were saved. Reload your identities and check the record before trying again. Leaving this page does not undo a save already sent."
      : "Your identities could not be loaded. Check your connection and try again.";
  }
}

function field(name, type = "text", hint = "") {
  return html`
    <div class="app-identity-field">
      <label for="identity-${name}">${LABELS[name]}${name === "display_name" ? " (required)" : " (optional)"}</label>
      <input id="identity-${name}" name="${name}" type="${type}" aria-describedby="identity-${name}-help identity-${name}-error">
      <p id="identity-${name}-help" class="app-muted app-identity-help">${hint}</p>
      <p id="identity-${name}-error" class="app-identity-field-error" data-field-error="${name}" hidden></p>
    </div>
  `;
}

export function identityView(mainEl, { service, context = {} } = {}) {
  let disposed = false;
  let listGeneration = 0;
  let detailGeneration = 0;
  let listController = null;
  let detailController = null;
  let saveController = null;
  let rows = null;
  let editor = null;
  let failedSelection = null;
  let listBusy = false;
  const routeCurrent = () => !disposed && !context?.signal?.aborted &&
    (typeof context?.isCurrent !== "function" || context.isCurrent());
  if (!routeCurrent()) return () => {};

  mount(mainEl, html`
    <section class="app-identity" aria-labelledby="identity-title">
      <header class="app-state">
        <p class="app-eyebrow">Member profile</p><h1 id="identity-title">My identity</h1>
        <p>Your account can have one player identity of its own. Children have separate identities managed by their guardian.</p>
        <p>Creating or editing a player identity does not change your account name or grant account roles.</p>
        <p class="app-muted">Official-league participation requires a verified identity and competition approval. Players with their own account also need the player role. Pickup and training do not require identity verification. Registration and scheduling are separate, upcoming features.</p>
      </header>
      <div class="app-identity-toolbar">
        <button type="button" class="app-button" data-identity-action="reload">Reload identities</button>
        <p class="app-muted" data-identity-switch-help hidden>Finish or cancel this editor before opening another identity.</p>
      </div>
      <p data-identity-status role="status" aria-live="polite" aria-atomic="true" tabindex="-1"></p>
      <div class="app-error" data-identity-error role="alert" tabindex="-1" hidden></div>
      <div data-identity-list aria-busy="true"><p role="status">Loading your identities...</p></div>
      <section class="app-state app-identity-detail" data-identity-detail aria-label="Private identity details" tabindex="-1"></section>
    </section>
  `);
  const section = mainEl.querySelector(".app-identity");
  const list = section.querySelector("[data-identity-list]");
  const detail = section.querySelector("[data-identity-detail]");
  const notice = section.querySelector("[data-identity-status]");
  const failure = section.querySelector("[data-identity-error]");
  const reload = section.querySelector('[data-identity-action="reload"]');
  const switchHelp = section.querySelector("[data-identity-switch-help]");
  const isCurrent = () => routeCurrent() && mainEl.contains(section) && section.isConnected;
  const available = ["list", "load", "create", "update"].every((method) => typeof service?.[method] === "function");

  function announce(message, error = false, focus = false) {
    notice.textContent = error ? "" : message;
    failure.textContent = error ? message : "";
    failure.hidden = !error;
    if (focus) (error ? failure : notice).focus();
  }

  function clearValues(root) {
    for (const input of root.querySelectorAll("input, textarea")) {
      input.value = "";
      input.defaultValue = "";
      if (input.type === "checkbox") input.checked = false;
    }
  }

  function syncControls() {
    reload.disabled = !available || listBusy || Boolean(editor);
    switchHelp.hidden = !editor;
    for (const button of list.querySelectorAll("button")) button.disabled = listBusy || Boolean(editor);
  }

  function emptyDetail() {
    mount(detail, html`<h2>Private details</h2><p>Choose <strong>Open / edit</strong> to load one identity's private details. No private detail form is loaded until you choose an identity.</p>`);
    detail.setAttribute("aria-busy", "false");
  }

  function closeEditor() {
    detailGeneration += 1;
    detailController?.abort();
    detailController = null;
    clearValues(detail);
    editor = null;
    failedSelection = null;
    emptyDetail();
    syncControls();
  }

  function card(row) {
    return html`
      <li class="app-identity-card">
        <h3>${row.display_name}</h3>
        <p class="app-identity-badge">${statusLabel(row.verification_status)}</p>
        <p>Positions: ${row.default_positions.join(", ") || "Not set"} · Number: ${row.preferred_number ?? "Not set"}</p>
        <p class="app-muted">${rosterStatus(row)}</p>
        <button type="button" class="app-button" data-identity-action="open" data-identity-id="${row.id}" aria-label="Open or edit ${row.display_name}">Open / edit</button>
      </li>
    `;
  }

  function renderList() {
    mount(list, html`
      <section class="app-state" aria-labelledby="identity-own-title">
        <h2 id="identity-own-title">Your player identity</h2>
        ${rows.own ? html`<ul class="app-identity-cards">${card(rows.own)}</ul>` : html`
          <p>You have not created your own player identity yet.</p>
          <button type="button" class="app-button" data-identity-action="create-self">Create my identity</button>`}
      </section>
      <section class="app-state" aria-labelledby="identity-children-title">
        <h2 id="identity-children-title">Children you manage</h2>
        ${rows.children.length ? html`<ul class="app-identity-cards">${rows.children.map(card)}</ul>` : html`<p>No child identities are linked to your account.</p>`}
        <button type="button" class="app-button" data-identity-action="create-child">Add child</button>
      </section>
    `);
    syncControls();
  }

  async function loadList() {
    if (!isCurrent() || !available || editor) return;
    const generation = ++listGeneration;
    listController?.abort();
    const controller = new AbortController();
    listController = controller;
    closeEditor();
    listBusy = true;
    rows = null;
    announce("");
    mount(list, html`<p role="status">Loading your identities...</p>`);
    list.setAttribute("aria-busy", "true");
    syncControls();
    const active = () => isCurrent() && generation === listGeneration && !controller.signal.aborted;
    try {
      const result = await service.list({ signal: controller.signal });
      if (!active()) return;
      if (!result || !Array.isArray(result.children)) throw new Error("invalid list");
      const own = result.own == null ? null : summary(result.own);
      const children = result.children.map(summary);
      if ((result.own && !own) || children.some((row) => !row)) throw new Error("invalid list");
      rows = { own, children };
      renderList();
    } catch (error) {
      if (!active()) return;
      mount(list, html`<p>Your identity list is not available yet. Use <strong>Reload identities</strong> to try again.</p>`);
      announce(errorText(error), true);
    } finally {
      if (active()) {
        listBusy = false;
        list.setAttribute("aria-busy", "false");
        syncControls();
      }
    }
  }

  function showEditor(kind, row = null) {
    clearValues(detail);
    editor = { kind, id: row?.id || null, creating: !row, verification: row?.verification_status || "pending", busy: false, uncertain: false };
    failedSelection = null;
    const heading = row ? `Edit ${kind === "self" ? "your identity" : "child identity"}` : kind === "self" ? "Create my identity" : "Add child";
    mount(detail, html`
      <h2>${heading}</h2>
      <p class="app-muted">Private details are available to the person, their guardian where applicable, and administrators. Authorized match staff can access emergency contacts and medical information for their match duties.</p>
      <p><strong>Verification:</strong> <span data-identity-verification>${statusLabel(row?.verification_status || "pending")}</span>. Verification is managed by administrators, not by this form.</p>
      ${row?.verification_note ? html`<div data-identity-verification-note>
        <p><strong>${row.verification_status === "rejected" ? "Reason not approved" : "Verification note"}:</strong></p>
        <p>${text(row.verification_note)}</p>
        <p class="app-muted">Contact a club administrator if you have questions about this decision. Editing your details does not automatically request another review.</p>
      </div>` : ""}
      <form data-identity-form novalidate autocomplete="off" aria-label="${heading}" aria-busy="false">
        <fieldset>
          <legend>Player details</legend>
          <div class="app-identity-fields">
            ${field("display_name", "text", "The name used on schedules and, if you opt in and are verified, the public roster.")}
            ${field("legal_name", "text", "Kept out of the public roster.")}
            ${!row ? field("date_of_birth", "date", "Set this carefully. After creation, only an administrator can correct it. A known minor needs a guardian-managed identity.") : html`
              <div class="app-identity-field"><span class="app-identity-label">Date of birth (read-only)</span>
                <p data-identity-dob>${text(row.date_of_birth) || "Not provided"}</p>
                <p class="app-muted app-identity-help">Only an administrator can correct a date of birth after creation. Contact an administrator if this is wrong or missing.</p></div>`}
            ${field("default_positions", "text", "Separate positions with commas, for example CM, CF.")}
            ${field("preferred_number", "number", "A whole number from 0 to 99.")}
            ${field("jersey_size")}
            ${field("emergency_contact_name")}
            ${field("emergency_contact_phone", "tel")}
            <div class="app-identity-field app-identity-field-wide">
              <label for="identity-medical_notes">Medical notes (optional)</label>
              <textarea id="identity-medical_notes" name="medical_notes" rows="4" aria-describedby="identity-medical_notes-help identity-medical_notes-error"></textarea>
              <p id="identity-medical_notes-help" class="app-muted app-identity-help">Only include information relevant to safe participation. These notes do not appear on the public roster.</p>
              <p id="identity-medical_notes-error" class="app-identity-field-error" data-field-error="medical_notes" hidden></p>
            </div>
          </div>
          <div class="app-identity-privacy">
            <label class="app-identity-checkbox" for="identity-is_public"><input id="identity-is_public" name="is_public" type="checkbox" aria-describedby="identity-is_public-help identity-is_public-error">Opt in to the public roster</label>
            <p id="identity-is_public-help">Once verified, the public roster data view makes this player's ID, display name, preferred number, positions, and photo if present publicly available. Legal name, date of birth, emergency contacts, and medical notes are not part of that public view.</p>
            <p>Display on the public website is a separate integration. This form does not update the website's current player directory.</p>
            <p data-identity-public-state>Saved preference: ${rosterStatus(row)}</p>
            <p id="identity-is_public-error" class="app-identity-field-error" data-field-error="is_public" hidden></p>
          </div>
          <div class="app-identity-actions">
            <button type="submit" class="app-button app-identity-primary" data-identity-action="save">${row ? "Save changes" : "Create identity"}</button>
            <button type="button" class="app-button" data-identity-action="cancel">Cancel and discard changes</button>
          </div>
        </fieldset>
        <div class="app-error" data-identity-recovery hidden>
          <p>The save may already have completed. Reload and check before submitting again; reloading discards this local draft and does not undo a saved change.</p>
          <button type="button" class="app-button" data-identity-action="recover">Reload identities to check</button>
        </div>
      </form>
    `);
    const form = detail.querySelector("form");
    for (const name of TEXT_FIELDS) {
      const input = form.elements.namedItem(name);
      input.value = name === "default_positions" ? (Array.isArray(row?.[name]) ? row[name].join(", ") : "")
        : name === "preferred_number" ? (row?.[name] ?? "") : text(row?.[name]);
      if (IDENTITY_LIMITS[name]) input.maxLength = IDENTITY_LIMITS[name];
    }
    form.elements.namedItem("display_name").required = true;
    const number = form.elements.namedItem("preferred_number");
    number.min = "0"; number.max = "99"; number.step = "1";
    const birth = form.elements.namedItem("date_of_birth");
    if (birth) birth.max = identityToday();
    form.elements.namedItem("is_public").checked = row?.is_public === true;
    detail.setAttribute("aria-busy", "false");
    syncControls();
    detail.focus();
  }

  async function openDetail(id) {
    if (!isCurrent() || editor || !rows || listBusy) return;
    const kind = rows.own?.id === id ? "self" : rows.children.some((row) => row.id === id) ? "child" : null;
    if (!kind) return;
    const generation = ++detailGeneration;
    detailController?.abort();
    const controller = new AbortController();
    detailController = controller;
    clearValues(detail);
    announce("");
    mount(detail, html`<h2>Private details</h2><p role="status">Loading this identity's private details...</p>`);
    detail.setAttribute("aria-busy", "true");
    const active = () => isCurrent() && generation === detailGeneration && !controller.signal.aborted;
    try {
      const row = await service.load(id, { signal: controller.signal });
      if (!active()) return;
      if (!summary(row) || row.id !== id) throw new Error("invalid detail");
      showEditor(kind, row);
    } catch (error) {
      if (!active()) return;
      failedSelection = id;
      mount(detail, html`<h2>Private details</h2><p>This private detail form could not be opened.</p><button type="button" class="app-button" data-identity-action="retry-detail">Try opening again</button>`);
      announce(errorText(error), true, true);
    } finally { if (active()) detail.setAttribute("aria-busy", "false"); }
  }

  function valuesFrom(form) {
    const values = {};
    for (const name of TEXT_FIELDS) values[name] = form.elements.namedItem(name).value;
    values.is_public = form.elements.namedItem("is_public").checked === true;
    if (editor.creating) values.date_of_birth = form.elements.namedItem("date_of_birth").value;
    return values;
  }

  function fieldErrors(form, errors, local = false) {
    let first = null;
    for (const name of Object.keys(LABELS)) {
      const input = form.elements.namedItem(name);
      const output = form.querySelector(`[data-field-error="${name}"]`);
      if (!input || !output) continue;
      const invalid = Object.prototype.hasOwnProperty.call(errors || {}, name);
      input.setAttribute("aria-invalid", String(invalid));
      output.hidden = !invalid;
      output.textContent = invalid ? (local && typeof errors[name] === "string" ? errors[name] : `Check ${LABELS[name].toLowerCase()} and try again.`) : "";
      if (invalid && !first) first = input;
    }
    if (first) first.focus();
  }

  async function save(event) {
    const form = event.target.closest("[data-identity-form]");
    if (!form || !section.contains(form)) return;
    event.preventDefault();
    if (!isCurrent() || !editor || editor.busy || editor.uncertain) return;
    fieldErrors(form, {});
    if (!form.reportValidity()) return;
    const state = editor;
    const values = valuesFrom(form);
    const checked = validateIdentity(values, { creating: state.creating, kind: state.kind, today: identityToday() });
    if (Object.keys(checked.errors).length) {
      announce("Review the highlighted fields and try again.", true);
      fieldErrors(form, checked.errors, true);
      return;
    }
    const generation = detailGeneration;
    const controller = new AbortController();
    saveController = controller;
    state.busy = true;
    form.querySelector("fieldset").disabled = true;
    form.setAttribute("aria-busy", "true");
    announce("Saving your identity...");
    const active = () => isCurrent() && editor === state && generation === detailGeneration && !controller.signal.aborted;
    try {
      const saved = state.creating
        ? await service.create(state.kind, checked.data, { signal: controller.signal })
        : await service.update(state.id, checked.data, { signal: controller.signal });
      if (!active()) return;
      const savedSummary = summary(saved);
      if (!savedSummary || (!state.creating && saved.id !== state.id)) throw { code: "save_unconfirmed" };
      if (state.kind === "self") rows.own = savedSummary;
      else rows.children = [...rows.children.filter((row) => row.id !== saved.id), savedSummary];
      closeEditor();
      renderList();
      announce(state.creating ? "The player identity was created. Open it to review the saved details." : "Your changes were saved.", false, true);
    } catch (error) {
      if (!active()) return;
      state.busy = false;
      form.setAttribute("aria-busy", "false");
      announce(errorText(error, true), true, true);
      if (error?.code === "invalid_identity") {
        form.querySelector("fieldset").disabled = false;
        fieldErrors(form, error.fields);
      } else {
        state.uncertain = true;
        form.querySelector("[data-identity-recovery]").hidden = false;
      }
    }
  }

  function click(event) {
    const button = event.target.closest("button[data-identity-action]");
    if (!button || !section.contains(button) || button.disabled || !isCurrent()) return;
    const action = button.dataset.identityAction;
    if (action === "reload" && !editor) void loadList();
    else if (action === "open") void openDetail(button.dataset.identityId);
    else if (action === "retry-detail" && failedSelection) void openDetail(failedSelection);
    else if (action === "create-self" || action === "create-child") {
      if (!rows || editor || listBusy || (action === "create-self" && rows.own)) return;
      detailGeneration += 1;
      detailController?.abort();
      announce("");
      showEditor(action === "create-self" ? "self" : "child");
    } else if (action === "cancel" && editor && !editor.busy && !editor.uncertain) {
      closeEditor();
      announce("Unsaved local changes discarded.", false, true);
    } else if (action === "recover" && editor?.uncertain && !editor.busy) {
      closeEditor();
      void loadList();
    }
  }

  function change(event) {
    if (!isCurrent() || !editor || editor.busy || editor.uncertain || event.target.name !== "is_public") return;
    detail.querySelector("[data-identity-public-state]").textContent = event.target.checked
      ? editor.verification === "verified"
        ? "Saving this choice makes the approved public fields available through the public roster data view immediately."
        : "If saved, this identity will be opted in but will not be publicly available until verified."
      : "Saving this choice excludes this identity from the public roster data view.";
  }

  function cleanup() {
    if (disposed) return;
    disposed = true;
    listGeneration += 1;
    detailGeneration += 1;
    listController?.abort(); detailController?.abort(); saveController?.abort();
    section.removeEventListener("click", click);
    section.removeEventListener("submit", save);
    section.removeEventListener("change", change);
    context?.signal?.removeEventListener("abort", cleanup);
    clearValues(section);
    editor = rows = failedSelection = null;
    section.replaceChildren();
  }

  section.addEventListener("click", click);
  section.addEventListener("submit", save);
  section.addEventListener("change", change);
  context?.signal?.addEventListener("abort", cleanup, { once: true });
  emptyDetail();
  if (available) void loadList();
  else {
    list.setAttribute("aria-busy", "false");
    mount(list, html`<p>Identity services are unavailable. Reload the page or sign in again to try.</p>`);
    syncControls();
  }
  return cleanup;
}
