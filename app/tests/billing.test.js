import * as m from "../js/billing.js";
import { billingLogicTests } from "./billing.logic.js";
import { test, equal, assert } from "./runner.js";
billingLogicTests(m, { test, equal, assert });
