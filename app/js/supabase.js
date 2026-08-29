// Supabase client singleton — the app's only external browser dependency.
//
// An unconfigured checkout deliberately returns null and runs in offline mode.
// A configured checkout that cannot load Supabase throws: connection failures
// must be visible instead of masquerading as a signed-out session.

import { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_CLIENT_VERSION } from "../config.js";

let client = null;
let loadPromise = null;

export function configurationIsUsable(url, anonKey) {
  const candidateUrl = String(url || "").trim();
  const candidateKey = String(anonKey || "").trim();
  const placeholder = /placeholder|your_project|your_supabase|replace/i;
  return /^https:\/\/[^/]+/.test(candidateUrl)
    && candidateKey.length > 0
    && !placeholder.test(candidateUrl)
    && !placeholder.test(candidateKey);
}

export function isConfigured() {
  return configurationIsUsable(SUPABASE_URL, SUPABASE_ANON_KEY);
}

async function loadLibrary() {
  if (!loadPromise) {
    const url = `https://cdn.jsdelivr.net/npm/@supabase/supabase-js@${SUPABASE_CLIENT_VERSION}/+esm`;
    loadPromise = import(url);
  }
  return loadPromise;
}

export async function getClient() {
  if (!isConfigured()) return null;
  if (client) return client;

  try {
    const module = await loadLibrary();
    const createClient = module.createClient || module.default?.createClient;
    if (!createClient) throw new Error("createClient export was not found");
    client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        flowType: "pkce",
      },
    });
    return client;
  } catch (cause) {
    loadPromise = null;
    const error = new Error("Unable to load the Supabase client. Check the network and try again.");
    error.cause = cause;
    throw error;
  }
}

export function _resetForTests() {
  client = null;
  loadPromise = null;
}
