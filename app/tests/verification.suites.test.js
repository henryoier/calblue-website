// The exact same RPC doubles run in browsers and the offline CLI harnesses.
import * as verification from "../js/verification.js";
import { verificationLogicTests } from "./verification.logic.js";
import { verificationDataTests } from "./verification.data.test.js";
import { test, assert, equal, testAsync } from "./runner.js";

verificationLogicTests(verification, { test, assert, equal });
verificationDataTests(verification, { testAsync });
