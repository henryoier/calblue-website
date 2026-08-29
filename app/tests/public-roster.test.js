import * as m from "../js/public-roster.js";
import { publicRosterLogicTests } from "./public-roster.logic.js";
import { test, equal, assert } from "./runner.js";
publicRosterLogicTests(m, { test, equal, assert });
