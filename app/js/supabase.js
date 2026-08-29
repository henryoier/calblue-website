// Supabase client singleton — the only external dependency in the app.
//
// Pinned to a specific CDN version (see config.js). Upgrading is a one-line
// change in config.js, not a hunt through imports.
//
// If the placeholders in config.js are still present, getClient() returns
// null and every screen must degrade gracefully — the public site must never
// show a broken page because the database is unreachable (see #50).

import { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_CLIENT_VERSION } from "../config.js";

let client = null;
let loadPromise = null;

export function isConfigured() {
  return Boolean(
    SUPABASE_URL &&
    SUPABASE_ANON_KEY &&
    !SUPABASE_URL.includes("placeholder") &&
    !SUPABASE_ANON_KEY.includes("placeholder")
  );
}

async function loadLibrary() {
  if (loadPromise) return loadPromise;
  const url = `https://cdn.jsdelivr.net/npm/@supabase/supabase-js@${SUPABASE_CLIENT_VERSION}/+esm`;
  loadPromise = import(url);
  return loadPromise;
}

export async function getClient() {
  if (!isConfigured()) return null;
  if (client) return client;
  try {
    const mod = await loadLibrary();
    const createClient = mod.createClient || (mod.default && mod.default.createClient);
    if (!createClient) throw new Error("supabase-js: createClient not found in CDN module");
    client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
    return client;
  } catch (err) {
    console.warn("supabase client failed to load:", err);
    return null;
  }
}

export function _resetForTests() {
  client = null;
  loadPromise = null;
}
