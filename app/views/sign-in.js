import { html, mount } from "../js/dom.js";

const REQUEST_FAILED = "We could not request a sign-in link. Check your connection, wait at least one minute, and try again. If it still does not work, contact a CalBlue administrator.";
const LINK_REQUESTED = "If this email address can receive a sign-in link, it will arrive shortly. Check your inbox and spam folder. Wait at least one minute before requesting another link.";
const CALLBACK_FAILED = "That sign-in link could not be used. It may have expired, already been used, or been opened in a different browser. Request a new link below and open it in this browser.";

// The app validates returnTo before passing it here. Keep the rendering boundary
// fragment-only as well: escaping an attribute does not make an arbitrary URL safe.
function continueHref(returnTo) {
  return typeof returnTo === "string" && /^#\/(?!\/)/.test(returnTo) && !/[\u0000-\u001f\u007f\\]/.test(returnTo)
    ? returnTo
    : "#/";
}

// Provider messages may include account details or untrusted text. Only recognized
// error codes can select code-owned guidance; never render an error's message.
function requestErrorMessage(error) {
  switch (error?.code) {
    case "invalid_email":
      return "Enter a valid email address, then request a new sign-in link.";
    case "storage_unavailable":
      return "Allow browser storage for this website, then reload the page and request a new sign-in link. Open the link in this same browser and device.";
    case "unsupported_origin":
      return "Sign-in is not available at this website address. Open the official CalBlue members app or contact a CalBlue administrator for the correct link.";
    case "rate_limited":
      return "Please wait at least one minute before requesting another sign-in link. If you already requested one, check your inbox and spam folder.";
    case "auth_busy":
      return "Another sign-in request is still finishing. Wait at least one minute, then try again.";
    default:
      return REQUEST_FAILED;
  }
}

function callbackErrorMessage(error, authenticated) {
  if (error?.code === "storage_unavailable" || error?.code === "unsupported_origin") {
    return requestErrorMessage(error) + (authenticated ? " Your existing account is still signed in." : "");
  }
  return authenticated
    ? "That sign-in link could not be used. Your existing account is still signed in. Continue with that account, or sign out before requesting a new link for a different account."
    : CALLBACK_FAILED;
}

export function signInView(mainEl, {
  authenticated = false,
  signedOut = false,
  returnTo = "#/",
  callbackError = "",
  available = true,
  requestLink,
  context = {},
} = {}) {
  let disposed = false;
  const routeIsCurrent = () => !disposed && !context?.signal?.aborted &&
    (typeof context?.isCurrent !== "function" || context.isCurrent());
  if (!routeIsCurrent()) return () => {};

  const canRequest = available === true && typeof requestLink === "function";
  mount(mainEl, html`
    <section class="app-state app-sign-in" aria-labelledby="app-sign-in-title">
      <p class="app-eyebrow">Account access</p>
      <h1 id="app-sign-in-title">Sign in</h1>
      ${signedOut && !authenticated ? html`<p class="app-success" role="status">You have been signed out on this device.</p>` : null}
      ${callbackError ? html`
        <div class="app-error" role="alert">
          <p>${callbackErrorMessage(callbackError, authenticated)}</p>
          ${authenticated ? html`<p><a href="#/sign-out">Sign out before using a different account</a>.</p>` : null}
        </div>
      ` : null}
      ${authenticated
        ? html`<p>You are already signed in.</p><a class="app-link-primary" href="${continueHref(returnTo)}">Continue to the members app</a>`
        : html`
          <p>Enter your email address to receive a secure sign-in link. No password is needed.</p>
          ${!canRequest ? html`<p class="app-error" role="status">Sign-in is temporarily unavailable on this page. Reload the page to try again, or contact a CalBlue administrator.</p>` : null}
          <form class="app-sign-in-form" aria-labelledby="app-sign-in-title" aria-busy="false">
            <label for="app-sign-in-email">Email address</label>
            <input id="app-sign-in-email" name="email" type="email" required autocomplete="email"
              inputmode="email" autocapitalize="none" spellcheck="false" maxlength="254"
              aria-describedby="app-sign-in-email-help app-sign-in-guidance">
            <p id="app-sign-in-email-help" class="app-muted app-sign-in-help">Use an email address you can open on this device.</p>
            <div class="app-sign-in-actions">
              <button class="app-button app-sign-in-submit" type="submit">Send sign-in link</button>
              <button class="app-button app-sign-in-retry" type="button" hidden>Request another link</button>
            </div>
            <p class="app-sign-in-status" role="status" aria-live="polite" aria-atomic="true" tabindex="-1"></p>
            <p class="app-error app-sign-in-error" role="alert" tabindex="-1" hidden></p>
          </form>
          <div id="app-sign-in-guidance" class="app-sign-in-guidance">
            <h2>Open the link here</h2>
            <p>Open the email link in the <strong>same browser and on the same device</strong> that requested it. If your email app opens a different browser, copy the link into this browser instead.</p>
            <p>Use only the latest link. Each link can be used once and expires. If it no longer works, wait at least one minute and request a new one.</p>
            <p>On a shared device, sign out when you are finished.</p>
          </div>
        `}
    </section>
  `);

  if (authenticated) return () => { disposed = true; };

  const section = mainEl.querySelector(".app-sign-in");
  const form = section.querySelector("form");
  const emailInput = form.querySelector("input");
  const submitButton = form.querySelector(".app-sign-in-submit");
  const retryButton = form.querySelector(".app-sign-in-retry");
  const status = form.querySelector(".app-sign-in-status");
  const errorMessage = form.querySelector(".app-sign-in-error");
  const isCurrent = () => routeIsCurrent() && mainEl.contains(section);
  let busy = false;
  let sent = false;
  emailInput.disabled = !canRequest;
  submitButton.disabled = !canRequest;

  function setBusy(value) {
    busy = value;
    form.setAttribute("aria-busy", String(value));
    emailInput.readOnly = value || sent;
    submitButton.disabled = !canRequest || value || sent;
    submitButton.textContent = value ? "Sending sign-in link..." : sent ? "Link requested" : "Send sign-in link";
  }

  async function submit(event) {
    event.preventDefault();
    if (!isCurrent() || !canRequest || busy || sent) return;
    emailInput.value = emailInput.value.trim();
    if (!form.reportValidity()) return;

    errorMessage.hidden = true;
    errorMessage.textContent = "";
    status.classList.remove("app-success");
    status.textContent = "Requesting your sign-in link...";
    setBusy(true);
    try {
      const result = await requestLink(emailInput.value);
      if (!isCurrent()) return;
      if (result?.error) throw result.error;
      sent = true;
      status.textContent = LINK_REQUESTED;
      status.classList.add("app-success");
      retryButton.hidden = false;
      setBusy(false);
      status.focus();
    } catch (error) {
      if (!isCurrent()) return;
      status.textContent = "";
      errorMessage.textContent = requestErrorMessage(error);
      errorMessage.hidden = false;
      setBusy(false);
      errorMessage.focus();
    }
  }

  function retry() {
    if (!isCurrent() || busy || !sent || !canRequest) return;
    sent = false;
    retryButton.hidden = true;
    status.textContent = "";
    status.classList.remove("app-success");
    setBusy(false);
    emailInput.focus();
  }

  function cleanup() {
    if (disposed) return;
    disposed = true;
    form.removeEventListener("submit", submit);
    retryButton.removeEventListener("click", retry);
    context?.signal?.removeEventListener("abort", cleanup);
    // Disable this form's own controls before its route is replaced. With its
    // listeners removed it must not fall back to a native email-bearing submit.
    emailInput.disabled = true;
    submitButton.disabled = true;
    retryButton.disabled = true;
  }

  form.addEventListener("submit", submit);
  retryButton.addEventListener("click", retry);
  context?.signal?.addEventListener("abort", cleanup, { once: true });
  return cleanup;
}
