import { signInView } from "../views/sign-in.js";
import { testAsync } from "./runner.js";

// All email requests in this suite are local stubs. No authentication service or
// real mailbox is contacted. The DOM/focus/constraint checks require a browser.
async function withSignIn(options, run) {
  const originalFocus = document.activeElement;
  const main = document.createElement("main");
  main.className = "app-main";
  document.body.append(main);
  const cleanup = signInView(main, { requestLink: async () => ({ sent: true }), ...options });
  const elements = {
    main,
    cleanup,
    form: main.querySelector("form"),
    email: main.querySelector("input"),
    send: main.querySelector(".app-sign-in-submit"),
    retry: main.querySelector(".app-sign-in-retry"),
    status: main.querySelector(".app-sign-in-status"),
    error: main.querySelector(".app-sign-in-error"),
  };
  try {
    await run(elements);
  } finally {
    cleanup();
    main.remove();
    if (originalFocus?.isConnected && typeof originalFocus.focus === "function") originalFocus.focus();
  }
}

function submit(form) {
  const event = new Event("submit", { bubbles: true, cancelable: true });
  form.dispatchEvent(event);
  return event;
}

// Await the local request promise and the view's async continuation, without a
// timer or network dependency.
async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

testAsync("[sign-in] email form has a label, native validation, and delivery guidance", async (t) => {
  await withSignIn({}, async ({ main, form, email, send, retry, status }) => {
    t.equal(email.type, "email");
    t.assert(email.required, "email must be required");
    t.equal(email.autocomplete, "email");
    t.equal(email.getAttribute("inputmode"), "email");
    t.equal(main.querySelector("label").htmlFor, email.id);
    for (const id of email.getAttribute("aria-describedby").split(" ")) {
      t.assert(main.querySelector(`[id="${id}"]`), "input description must exist");
    }
    t.equal(form.getAttribute("aria-busy"), "false");
    t.equal(status.getAttribute("role"), "status");
    t.equal(status.getAttribute("aria-live"), "polite");
    t.assert(!send.disabled);
    t.assert(retry.hidden);
    t.assert(main.textContent.includes("same browser and on the same device"));
    t.assert(main.textContent.includes("Use only the latest link"));
    t.assert(main.textContent.includes("used once and expires"));
    t.assert(main.textContent.includes("one minute"));
    t.assert(!main.querySelector('input[type="password"]'));
  });
});

testAsync("[sign-in] missing and malformed emails never request a link", async (t) => {
  let calls = 0;
  await withSignIn({ requestLink: async () => { calls += 1; } }, async ({ form, email, send }) => {
    for (const value of ["", "not-an-email", "member@example.com other@example.com"]) {
      email.value = value;
      t.assert(!email.checkValidity());
      t.assert(submit(form).defaultPrevented, "the form must not navigate");
      await settle();
    }
    t.equal(calls, 0);
    t.assert(!send.disabled, "a validation error must not leave the form busy");
    t.equal(form.getAttribute("aria-busy"), "false");
  });
});

testAsync("[sign-in] one pending request disables duplicates and then announces generic success", async (t) => {
  const calls = [];
  let release;
  await withSignIn({ requestLink: (email) => {
    calls.push(email);
    return new Promise((resolve) => { release = resolve; });
  } }, async ({ form, email, send, retry, status }) => {
    email.value = "  demo.member@example.com  ";
    t.assert(submit(form).defaultPrevented);
    submit(form);
    t.equal(calls.length, 1);
    t.equal(calls[0], "demo.member@example.com");
    t.equal(form.getAttribute("aria-busy"), "true");
    t.assert(send.disabled);
    t.assert(email.readOnly);
    t.assert(retry.hidden);
    release({ sent: true, message: "PRIVATE ACCOUNT EXISTS" });
    await settle();
    t.equal(form.getAttribute("aria-busy"), "false");
    t.assert(send.disabled, "success requires deliberate retry before sending again");
    t.assert(!retry.hidden);
    t.assert(status.textContent.includes("If this email address can receive"));
    t.assert(!status.textContent.includes("PRIVATE ACCOUNT EXISTS"));
    t.assert(!status.textContent.includes("demo.member@example.com"));
    t.equal(document.activeElement, status, "success must have a focused accessible message");
    submit(form);
    t.equal(calls.length, 1, "submitting again after success must not auto-resend");
  });
});

testAsync("[sign-in] request-another restores the email field without automatically resending", async (t) => {
  let calls = 0;
  await withSignIn({ requestLink: async () => { calls += 1; return { sent: true }; } }, async ({ form, email, send, retry, status }) => {
    email.value = "first@example.com";
    submit(form);
    await settle();
    retry.click();
    t.equal(calls, 1);
    t.equal(email.value, "first@example.com");
    t.assert(!email.readOnly);
    t.assert(!send.disabled);
    t.assert(retry.hidden);
    t.equal(status.textContent, "");
    t.equal(document.activeElement, email);
    email.value = "second@example.com";
    submit(form);
    await settle();
    t.equal(calls, 2, "a deliberate submit may ask the service to resend");
  });
});

testAsync("[sign-in] raw request errors are not displayed and a retry remains possible", async (t) => {
  let calls = 0;
  const privateDetail = '<img src=x onerror="alert(1)"> account already exists: secret@example.com';
  await withSignIn({ requestLink: async () => {
    calls += 1;
    if (calls === 1) throw new Error(privateDetail);
    return { sent: true };
  } }, async ({ main, form, email, send, error, status }) => {
    email.value = "demo@example.com";
    submit(form);
    await settle();
    t.assert(!error.hidden);
    t.equal(error.getAttribute("role"), "alert");
    t.assert(error.textContent.includes("wait at least one minute"));
    t.assert(!main.textContent.includes(privateDetail));
    t.assert(!main.textContent.includes("secret@example.com"));
    t.equal(main.querySelector("img"), null);
    t.equal(document.activeElement, error);
    t.assert(!send.disabled);
    t.assert(!email.readOnly);
    t.equal(form.getAttribute("aria-busy"), "false");
    submit(form);
    await settle();
    t.equal(calls, 2);
    t.assert(error.hidden);
    t.equal(error.textContent, "");
    t.assert(status.textContent.includes("If this email address"));
  });
});

testAsync("[sign-in] recognized request codes select only fixed actionable guidance", async (t) => {
  const cases = [
    ["invalid_email", "Enter a valid email address"],
    ["storage_unavailable", "Allow browser storage"],
    ["unsupported_origin", "official CalBlue members app"],
    ["rate_limited", "wait at least one minute"],
    ["auth_busy", "Another sign-in request"],
    ["request_failed", "Check your connection"],
    ["unknown", "Check your connection"],
  ];
  for (const [code, expected] of cases) {
    await withSignIn({ requestLink: async () => { throw { code, message: "PRIVATE DETAIL" }; } }, async ({ form, email, error }) => {
      email.value = "demo@example.com";
      submit(form);
      await settle();
      t.assert(error.textContent.includes(expected), `${code} should give the expected recovery step`);
      t.assert(!error.textContent.includes("PRIVATE DETAIL"));
    });
  }
});

testAsync("[sign-in] returned error objects are failures, not false success", async (t) => {
  await withSignIn({ requestLink: async () => ({ error: { message: "PRIVATE", code: "rate_limited" } }) }, async ({ form, email, error, status, retry }) => {
    email.value = "demo@example.com";
    submit(form);
    await settle();
    t.assert(!error.hidden);
    t.assert(error.textContent.includes("wait at least one minute"));
    t.equal(status.textContent, "");
    t.assert(retry.hidden);
  });
});

testAsync("[sign-in] unavailable clients disable the form and cannot request email", async (t) => {
  let calls = 0;
  for (const options of [
    { available: false, requestLink: async () => { calls += 1; } },
    { available: true, requestLink: undefined },
  ]) {
    await withSignIn(options, async ({ main, form, email, send }) => {
      t.assert(email.disabled);
      t.assert(send.disabled);
      t.assert(main.textContent.includes("Sign-in is temporarily unavailable"));
      email.value = "demo@example.com";
      submit(form);
      await settle();
    });
  }
  t.equal(calls, 0);
});

testAsync("[sign-in] signed-out and callback failure notices use code-owned text", async (t) => {
  const rawError = '<script>alert(1)</script> PRIVATE CALLBACK TOKEN';
  await withSignIn({ signedOut: true, callbackError: rawError }, async ({ main, form }) => {
    t.assert(main.textContent.includes("signed out on this device"));
    t.assert(main.textContent.includes("That sign-in link could not be used"));
    t.assert(main.textContent.includes("Request a new link below"));
    t.assert(!main.textContent.includes("PRIVATE CALLBACK TOKEN"));
    t.equal(main.querySelector("script"), null);
    t.assert(form, "the failure state must still offer a new link");
  });
  for (const [code, expected] of [
    ["storage_unavailable", "Allow browser storage"],
    ["unsupported_origin", "official CalBlue members app"],
    ["callback_failed", "That sign-in link could not be used"],
  ]) {
    await withSignIn({ callbackError: { code, message: rawError } }, async ({ main }) => {
      t.assert(main.textContent.includes(expected));
      t.assert(!main.textContent.includes("PRIVATE CALLBACK TOKEN"));
    });
  }
});

testAsync("[sign-in] authenticated users get a continue link instead of an email form", async (t) => {
  await withSignIn({ authenticated: true, signedOut: true, returnTo: "#/games/demo?tab=details" }, async ({ main, form }) => {
    t.equal(form, null);
    t.assert(main.textContent.includes("already signed in"));
    t.assert(!main.textContent.includes("signed out on this device"));
    t.equal(main.querySelector("a").getAttribute("href"), "#/games/demo?tab=details");
  });
});

testAsync("[sign-in] a failed callback remains visible when an existing account is signed in", async (t) => {
  await withSignIn({ authenticated: true, callbackError: { code: "callback_failed", message: "PRIVATE CALLBACK TOKEN" }, returnTo: "#/identity" }, async ({ main, form }) => {
    const notice = main.querySelector('[role="alert"]');
    t.assert(notice.textContent.includes("That sign-in link could not be used"));
    t.assert(notice.textContent.includes("existing account is still signed in"));
    t.assert(!notice.textContent.includes("PRIVATE CALLBACK TOKEN"));
    t.assert(!notice.textContent.includes("below"), "an authenticated route does not have an email form below");
    t.equal(notice.querySelector("a").getAttribute("href"), "#/sign-out");
    t.equal(main.querySelector(".app-link-primary").getAttribute("href"), "#/identity");
    t.equal(form, null, "the failed link must not silently replace or resubmit the existing session");
  });
});

testAsync("[sign-in] continue rendering cannot turn untrusted destinations into external URLs", async (t) => {
  for (const returnTo of ["https://example.com", "//example.com", "javascript:alert(1)", "#//example.com", "#/bad\\path", "#/bad\npath", null]) {
    await withSignIn({ authenticated: true, returnTo }, async ({ main }) => {
      t.equal(main.querySelector("a").getAttribute("href"), "#/", "invalid destination must fall back to members home");
    });
  }
  const returnTo = '#/games?text=" onclick="alert(1)';
  await withSignIn({ authenticated: true, returnTo }, async ({ main }) => {
    const link = main.querySelector("a");
    t.equal(link.getAttribute("href"), returnTo);
    t.equal(link.getAttribute("onclick"), null, "fragment contents must remain escaped attributes");
  });
});

testAsync("[sign-in] leaving a pending request ignores success and never focuses another route", async (t) => {
  let current = true;
  let release;
  await withSignIn({ context: { isCurrent: () => current }, requestLink: () => new Promise((resolve) => { release = resolve; }) }, async ({ main, form, email, status }) => {
    email.value = "demo@example.com";
    submit(form);
    current = false;
    const nextView = document.createElement("button");
    nextView.textContent = "Next route";
    main.replaceChildren(nextView);
    nextView.focus();
    release({ sent: true });
    await settle();
    t.equal(main.textContent, "Next route");
    t.equal(document.activeElement, nextView);
    t.equal(status.textContent, "Requesting your sign-in link...", "stale status must not be updated");
  });
});

testAsync("[sign-in] replaced content also fences errors without a router context", async (t) => {
  let rejectRequest;
  await withSignIn({ requestLink: () => new Promise((_resolve, reject) => { rejectRequest = reject; }) }, async ({ main, form, email, error }) => {
    email.value = "demo@example.com";
    submit(form);
    main.textContent = "Replacement view";
    rejectRequest(new Error("PRIVATE DETAIL"));
    await settle();
    t.equal(main.textContent, "Replacement view");
    t.assert(error.hidden, "detached error state must not receive a late response");
  });
});

testAsync("[sign-in] cleanup is idempotent and ignores a pending response", async (t) => {
  let release;
  let calls = 0;
  await withSignIn({ requestLink: () => {
    calls += 1;
    return new Promise((resolve) => { release = resolve; });
  } }, async ({ cleanup, form, email, send, retry, status }) => {
    email.value = "demo@example.com";
    submit(form);
    cleanup();
    cleanup();
    t.assert(email.disabled);
    t.assert(send.disabled);
    t.assert(retry.disabled);
    t.assert(!submit(form).defaultPrevented, "cleanup must remove its submit listener");
    release({ sent: true });
    await settle();
    t.equal(calls, 1);
    t.equal(status.textContent, "Requesting your sign-in link...");
    t.assert(retry.hidden);
  });
});

testAsync("[sign-in] abort removes listeners and suppresses a delayed rejection", async (t) => {
  const controller = new AbortController();
  let rejectRequest;
  await withSignIn({ context: { signal: controller.signal, isCurrent: () => true }, requestLink: () => new Promise((_resolve, reject) => { rejectRequest = reject; }) }, async ({ form, email, send, error }) => {
    email.value = "demo@example.com";
    submit(form);
    controller.abort();
    t.assert(send.disabled);
    t.assert(!submit(form).defaultPrevented);
    rejectRequest(new Error("PRIVATE DETAIL"));
    await settle();
    t.assert(error.hidden);
  });
});

testAsync("[sign-in] an already-stale view does not replace existing content", async (t) => {
  const main = document.createElement("main");
  main.textContent = "Current route";
  const controller = new AbortController();
  controller.abort();
  for (const context of [{ isCurrent: () => false }, { signal: controller.signal }]) {
    const cleanup = signInView(main, { context });
    t.equal(main.textContent, "Current route");
    cleanup();
  }
});

testAsync("[sign-in] a 360px form fits its container with touch-sized controls", async (t) => {
  await withSignIn({}, async ({ main, email, send }) => {
    main.style.width = "360px";
    t.assert(main.scrollWidth <= 360, `sign-in form overflowed: ${main.scrollWidth}px`);
    t.assert(parseFloat(getComputedStyle(email).minHeight) >= 44);
    t.assert(parseFloat(getComputedStyle(send).minHeight) >= 44);
    t.assert(parseFloat(getComputedStyle(email).fontSize) >= 16, "mobile email input should not trigger text zoom");
  });
});
