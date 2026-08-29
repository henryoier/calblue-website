import * as m from "../js/identity.js";
import { identityLogicTests } from "./identity.logic.js";
import { test, equal, assert } from "./runner.js";
identityLogicTests(m, { test, equal, assert });
