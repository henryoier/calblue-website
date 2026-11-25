// Shared pure logic and RPC doubles, with no external service dependencies.
import * as pickup from "../js/pickup.js";
import { pickupLogicTests } from "./pickup.logic.js";
import { pickupDataTests } from "./pickup.data.test.js";
import { test, assert, equal, testAsync } from "./runner.js";

pickupLogicTests(pickup, { test, assert, equal });
pickupDataTests(pickup, { testAsync });
