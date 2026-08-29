import * as router from "../js/router.js";
import { routerLogicTests } from "./router.logic.js";
import { test, equal, assert } from "./runner.js";
routerLogicTests(router, { test, equal, assert });
test("[router] buildHash handles empty params", () => {
  equal(router.buildHash("/games"), "#/games");
});
