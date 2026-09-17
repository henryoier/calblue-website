import * as router from "../js/router.js";
import { routerLogicTests } from "./router.logic.js";
import { test, testAsync, equal, assert } from "./runner.js";
routerLogicTests(router, { test, equal, assert });
test("[router] buildHash handles empty params", () => {
  equal(router.buildHash("/games"), "#/games");
});

// These tests share location.hash/title/focus, so run their browser work serially.
let routerTests = Promise.resolve();
function liveTest(name, fn) {
  testAsync(name, (t) => {
    const result = routerTests.then(() => fn(t));
    routerTests = result.catch(() => {});
    return result;
  });
}

async function withRouter(options, run) {
  const originalHash = window.location.hash;
  const originalTitle = document.title;
  const originalFocus = document.activeElement;
  const mountPoint = document.createElement("main");
  mountPoint.tabIndex = -1;
  document.body.appendChild(mountPoint);
  let focusCount = 0;
  const focus = mountPoint.focus.bind(mountPoint);
  mountPoint.focus = (settings) => { focusCount += 1; focus(settings); };
  const details = options(mountPoint);
  const instance = router.createRouter({ ...details, mountPoint });
  try {
    await run(instance, mountPoint, () => focusCount);
  } finally {
    instance.destroy();
    history.replaceState(null, "", originalHash || "#/");
    document.title = originalTitle;
    mountPoint.remove();
    if (originalFocus?.isConnected && typeof originalFocus.focus === "function") originalFocus.focus();
  }
}

liveTest("[router] live router renders, guards, reports errors, and falls back to 404", async (t) => {
  let authenticated = false;
  let lastError = "";
  let loadingCount = 0;
  let releaseSlow = null;
  let slowWasAborted = false;

  await withRouter((mountPoint) => ({ routes: [
    { pattern: "/known", title: "Known", view: () => { mountPoint.textContent = "known"; } },
    { pattern: "/private", auth: true, view: () => { mountPoint.textContent = "private"; } },
    { pattern: "/broken", view: () => { throw new Error("broken route"); } },
    {
      pattern: "/slow",
      view: (_params, _query, context) => new Promise((resolve) => {
        context.signal.addEventListener("abort", () => { slowWasAborted = true; });
        releaseSlow = () => {
          if (context.isCurrent()) mountPoint.textContent = "stale";
          resolve();
        };
      }),
    },
    { pattern: "/fast", view: () => { mountPoint.textContent = "fast"; } },
    { pattern: "*", title: "Missing", view: () => { mountPoint.textContent = "not found"; } },
  ],
    getAccess: () => ({ authenticated, roles: [] }),
    onLoading: () => { loadingCount += 1; },
    onError: (error) => { lastError = error.message; mountPoint.textContent = "error"; },
    onUnauthorized: () => { mountPoint.textContent = "denied"; },
  }), async (instance, mountPoint, focusCount) => {
    history.replaceState(null, "", "#/known");
    await instance.render();
    t.equal(mountPoint.textContent, "known");
    t.equal(document.title, "Known — CalBlue members");
    t.equal(document.activeElement, mountPoint);
    t.equal(mountPoint.getAttribute("aria-busy"), "false");

    history.replaceState(null, "", "#/missing");
    await instance.render();
    t.equal(mountPoint.textContent, "not found");
    history.replaceState(null, "", "#/known?invalid=%FF");
    await instance.render();
    t.equal(mountPoint.textContent, "not found", "malformed query must use 404, not the known view");

    history.replaceState(null, "", "#/private");
    const beforeDenied = focusCount();
    await instance.render();
    t.equal(mountPoint.textContent, "denied");
    t.equal(focusCount(), beforeDenied + 1, "denied navigation must focus its rendered state");
    t.equal(mountPoint.getAttribute("aria-busy"), "false");
    authenticated = true;
    await instance.render();
    t.equal(mountPoint.textContent, "private");

    history.replaceState(null, "", "#/broken");
    const beforeError = focusCount();
    await instance.render();
    t.equal(lastError, "broken route");
    t.equal(mountPoint.textContent, "error");
    t.equal(focusCount(), beforeError + 1, "handled errors must receive the same focus treatment");

    history.replaceState(null, "", "#/slow");
    const slowRender = instance.render();
    t.equal(mountPoint.getAttribute("aria-busy"), "true");
    history.replaceState(null, "", "#/fast");
    await instance.render();
    releaseSlow();
    await slowRender;
    t.assert(slowWasAborted, "navigation should abort the previous route context");
    t.equal(mountPoint.textContent, "fast", "a stale route must not overwrite the current screen");
    t.assert(loadingCount >= 7, "each route render should enter the shared loading state");
  });
});

liveTest("[router] cleanup runs once after abort on navigation and destroy", async (t) => {
  const disposed = [];
  const contexts = [];
  await withRouter(() => ({ routes: [{ pattern: "/owned", view: (_params, _query, context) => {
    contexts.push(context);
    return () => { disposed.push(context.signal.aborted); };
  } }] }), async (instance) => {
    history.replaceState(null, "", "#/owned");
    await instance.render();
    await instance.render();
    t.equal(disposed.length, 1);
    t.equal(disposed[0], true, "abort precedes resource cleanup");
    t.assert(!contexts[0].isCurrent());
    t.assert(contexts[1].isCurrent());
    instance.destroy();
    instance.destroy();
    t.equal(disposed.length, 2);
    t.equal(disposed[1], true);
    await instance.render();
    window.dispatchEvent(new Event("hashchange"));
    t.equal(contexts.length, 2, "destroyed router cannot render or handle hashchange");
  });
});

liveTest("[router] late view cleanup is disposed and stale failures do not replace the new screen", async (t) => {
  let releaseCleanup;
  let rejectLate;
  let disposed = 0;
  let errors = 0;
  await withRouter((mountPoint) => ({ routes: [
    { pattern: "/late-cleanup", view: () => new Promise((resolve) => { releaseCleanup = resolve; }) },
    { pattern: "/late-error", view: () => new Promise((_resolve, reject) => { rejectLate = reject; }) },
    { pattern: "/fast", view: () => { mountPoint.textContent = "fast"; } },
  ], onError: () => { errors += 1; } }), async (instance, mountPoint, focusCount) => {
    history.replaceState(null, "", "#/late-cleanup");
    const first = instance.render();
    history.replaceState(null, "", "#/fast");
    await instance.render();
    const afterFast = focusCount();
    releaseCleanup(() => { disposed += 1; });
    await first;
    t.equal(disposed, 1);
    t.equal(focusCount(), afterFast, "stale completion must not refocus the screen");
    history.replaceState(null, "", "#/late-error");
    const second = instance.render();
    history.replaceState(null, "", "#/fast");
    await instance.render();
    rejectLate(new Error("stale failure"));
    await second;
    t.equal(errors, 0);
    t.equal(mountPoint.textContent, "fast");
  });
});

liveTest("[router] immediate hash redirects invalidate focus before hashchange dispatch", async (t) => {
  let redirectContext;
  await withRouter((mountPoint) => ({ routes: [
    { pattern: "/redirect", view: (_params, _query, context) => {
      redirectContext = context;
      history.replaceState(null, "", "#/destination");
    } },
    { pattern: "/destination", view: () => { mountPoint.textContent = "destination"; } },
  ] }), async (instance, mountPoint, focusCount) => {
    history.replaceState(null, "", "#/redirect");
    await instance.render();
    t.assert(!redirectContext.isCurrent());
    t.equal(focusCount(), 0);
    await instance.render();
    t.equal(mountPoint.textContent, "destination");
    t.equal(focusCount(), 1);
  });
});

liveTest("[router] revoking access aborts a pending private view immediately", async (t) => {
  let authenticated = true;
  let release;
  let privateContext;
  await withRouter((mountPoint) => ({ routes: [
    { pattern: "/private", auth: true, view: (_params, _query, context) => {
      privateContext = context;
      return new Promise((resolve) => { release = () => {
        if (context.isCurrent()) mountPoint.textContent = "private";
        resolve();
      }; });
    } },
  ], getAccess: () => ({ authenticated }), onUnauthorized: () => { mountPoint.textContent = "denied"; }
  }), async (instance, mountPoint, focusCount) => {
    history.replaceState(null, "", "#/private");
    const pending = instance.render();
    authenticated = false;
    await instance.render();
    t.assert(privateContext.signal.aborted);
    t.equal(mountPoint.textContent, "denied");
    const afterDenied = focusCount();
    release();
    await pending;
    t.equal(mountPoint.textContent, "denied");
    t.equal(focusCount(), afterDenied);
  });
});

liveTest("[router] destroying a pending render disposes late cleanup without focus", async (t) => {
  let release;
  let context;
  let cleaned = 0;
  await withRouter(() => ({ routes: [{ pattern: "/slow", view: (_params, _query, current) => {
    context = current;
    return new Promise((resolve) => { release = resolve; });
  } }] }), async (instance, mountPoint, focusCount) => {
    history.replaceState(null, "", "#/slow");
    const pending = instance.render();
    instance.destroy();
    t.assert(context.signal.aborted);
    t.equal(mountPoint.getAttribute("aria-busy"), "false");
    release(() => { cleaned += 1; });
    await pending;
    t.equal(cleaned, 1);
    t.equal(focusCount(), 0);
  });
});

liveTest("[router] reentrant cleanup cannot replace the newer controller", async (t) => {
  let instance;
  let nested;
  let fastContext;
  let fastCount = 0;
  let fastCleanups = 0;
  await withRouter(() => ({ routes: [
    { pattern: "/first", view: () => () => { nested = instance.render(); } },
    { pattern: "/fast", view: (_params, _query, context) => {
      fastContext = context;
      fastCount += 1;
      return () => { fastCleanups += 1; };
    } },
  ] }), async (created) => {
    instance = created;
    history.replaceState(null, "", "#/first");
    await instance.render();
    history.replaceState(null, "", "#/fast");
    await instance.render();
    await nested;
    t.equal(fastCount, 1);
    instance.destroy();
    t.assert(fastContext.signal.aborted);
    t.equal(fastCleanups, 1);
  });
});

liveTest("[router] stale denied handlers cannot refocus the active view", async (t) => {
  let release;
  let deniedContext;
  let cleanups = 0;
  await withRouter((mountPoint) => ({ routes: [
    { pattern: "/private", auth: true, view: () => { throw new Error("guard bypass"); } },
    { pattern: "/public", view: () => { mountPoint.textContent = "public"; } },
  ], onUnauthorized: (_target, _access, context) => {
    deniedContext = context;
    return new Promise((resolve) => { release = resolve; });
  } }), async (instance, mountPoint, focusCount) => {
    history.replaceState(null, "", "#/private");
    const denied = instance.render();
    history.replaceState(null, "", "#/public");
    await instance.render();
    const afterPublic = focusCount();
    release(() => { cleanups += 1; });
    await denied;
    t.assert(deniedContext.signal.aborted);
    t.equal(focusCount(), afterPublic);
    t.equal(mountPoint.textContent, "public");
    t.equal(cleanups, 1);
  });
});

liveTest("[router] a current AbortError renders an error instead of leaving loading content", async (t) => {
  await withRouter((mountPoint) => ({ routes: [{ pattern: "/aborted-request", view: () => {
    const error = new Error("request was cancelled independently");
    error.name = "AbortError";
    throw error;
  } }], onLoading: () => { mountPoint.textContent = "loading"; },
    onError: () => { mountPoint.textContent = "error"; },
  }), async (instance, mountPoint, focusCount) => {
    history.replaceState(null, "", "#/aborted-request");
    await instance.render();
    t.equal(mountPoint.textContent, "error");
    t.equal(mountPoint.getAttribute("aria-busy"), "false");
    t.equal(focusCount(), 1);
  });
});
