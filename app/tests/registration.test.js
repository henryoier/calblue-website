import * as m from "../js/registration.js";
import { registrationLogicTests } from "./registration.logic.js";
import { test, equal, assert } from "./runner.js";
registrationLogicTests(m, { test, equal, assert });
