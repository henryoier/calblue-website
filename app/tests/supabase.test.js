import * as supabase from "../js/supabase.js";
import { supabaseLogicTests } from "./supabase.logic.js";
import { test, equal, assert } from "./runner.js";

supabaseLogicTests(supabase, { test, equal, assert });
