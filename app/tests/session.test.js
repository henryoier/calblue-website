import * as session from "../js/session.js";
import { sessionLogicTests } from "./session.logic.js";
import { test, equal, assert } from "./runner.js";
sessionLogicTests(session, { test, equal, assert });
test("[session] getRoles returns array when no profile", () => {
  const roles = session.getRoles();
  assert(Array.isArray(roles));
});
