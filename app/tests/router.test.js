import * as router from "../js/router.js";
import { routerLogicTests } from "./router.logic.js";
import { test, testAsync, equal, assert } from "./runner.js";
routerLogicTests(router, { test, equal, assert });
test("[router] buildHash handles empty params", () => {
  equal(router.buildHash("/games"), "#/games");
});

testAsync("[router] live router renders, guards, reports errors, and falls back to 404", async (t) => {
  const originalHash = window.location.hash;
  const originalTitle = document.title;
  const mountPoint = document.createElement("main");
  mountPoint.tabIndex = -1;
  document.body.appendChild(mountPoint);
  let authenticated = false;
  let lastError = "";
  let loadingCount = 0;
  let releaseSlow = null;
  let slowWasAborted = false;

  const routes = [
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
  ];
  const instance = router.createRouter({
    routes,
    mountPoint,
    getAccess: () => ({ authenticated, roles: [] }),
    onLoading: () => { loadingCount += 1; },
    onError: (error) => { lastError = error.message; },
    onUnauthorized: () => { mountPoint.textContent = "denied"; },
  });

  history.replaceState(null, "", "#/known");
  await instance.render();
  t.equal(mountPoint.textContent, "known");
  t.equal(document.title, "Known — CalBlue members");

  history.replaceState(null, "", "#/missing");
  await instance.render();
  t.equal(mountPoint.textContent, "not found");

  history.replaceState(null, "", "#/private");
  await instance.render();
  t.equal(mountPoint.textContent, "denied");
  authenticated = true;
  await instance.render();
  t.equal(mountPoint.textContent, "private");

  history.replaceState(null, "", "#/broken");
  await instance.render();
  t.equal(lastError, "broken route");

  history.replaceState(null, "", "#/slow");
  const slowRender = instance.render();
  history.replaceState(null, "", "#/fast");
  await instance.render();
  releaseSlow();
  await slowRender;
  t.assert(slowWasAborted, "navigation should abort the previous route context");
  t.equal(mountPoint.textContent, "fast", "a stale route must not overwrite the current screen");
  t.assert(loadingCount >= 7, "each route render should enter the shared loading state");

  instance.destroy();
  history.replaceState(null, "", originalHash || "#/");
  document.title = originalTitle;
  mountPoint.remove();
});
