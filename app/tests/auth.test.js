import * as m from "../js/auth.js";
import { authLogicTests } from "./auth.logic.js";
import { test, equal, assert } from "./runner.js";
authLogicTests(m, { test, equal, assert });
