// The same validation and data-service doubles run in browsers and JavaScriptCore.
import * as identity from "../js/identity.js";
import { identityLogicTests } from "./identity.logic.js";
import { identityDataTests } from "./identity.data.test.js";
import { test, assert, equal, testAsync } from "./runner.js";

identityLogicTests(identity, { test, assert, equal });
identityDataTests(identity, { testAsync });
