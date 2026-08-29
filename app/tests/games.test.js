import * as games from "../js/games.js";
import { gamesLogicTests } from "./games.logic.js";
import { test, equal, assert } from "./runner.js";
gamesLogicTests(games, { test, equal, assert });
