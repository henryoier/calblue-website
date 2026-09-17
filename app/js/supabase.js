// One pinned Supabase SDK/client per app. Failed loads can be retried; a network
// failure must not silently masquerade as an unconfigured or signed-out app.

import { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_CLIENT_VERSION } from "../config.js";

export function configurationIsUsable(url, anonKey) {
  if (typeof url !== "string" || typeof anonKey !== "string") return false;
  const candidateUrl = url.trim();
  const candidateKey = anonKey.trim();
  const placeholder = /placeholder|your_project|your_supabase|replace/i;
  // A project origin only: no credentials, path, query, fragment or whitespace.
  return /^https:\/\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?\/?$/i.test(candidateUrl)
    && candidateKey.length > 0
    && !/\s/.test(candidateKey)
    && !placeholder.test(candidateUrl)
    && !placeholder.test(candidateKey);
}

export function createClientProvider({ url, anonKey, version, loadModule = (address) => import(address) }) {
  let client = null;
  let clientPromise = null;

  function isConfigured() {
    return configurationIsUsable(url, anonKey);
  }

  function getClient() {
    if (!isConfigured()) return Promise.resolve(null);
    if (client) return Promise.resolve(client);
    if (clientPromise) return clientPromise;
    // Memoize the whole createClient operation, not just the dynamic import:
    // concurrent callers must not create competing auth clients/storage listeners.
    clientPromise = Promise.resolve().then(async () => {
      if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("The SDK version must be pinned.");
      const module = await loadModule(
        `https://cdn.jsdelivr.net/npm/@supabase/supabase-js@${version}/+esm`,
      );
      const createClient = module.createClient || module.default?.createClient;
      if (typeof createClient !== "function") throw new Error("createClient export was not found");
      client = createClient(url.trim(), anonKey.trim(), {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: false,
          flowType: "pkce",
        },
      });
      return client;
    }).catch((cause) => {
      clientPromise = null;
      const error = new Error("Unable to load the Supabase client. Check the network and try again.");
      error.cause = cause;
      throw error;
    });
    return clientPromise;
  }

  return { getClient, isConfigured };
}

let provider = null;
function defaultProvider() {
  if (!provider) provider = createClientProvider({
    url: SUPABASE_URL,
    anonKey: SUPABASE_ANON_KEY,
    version: SUPABASE_CLIENT_VERSION,
  });
  return provider;
}
export function isConfigured() { return defaultProvider().isConfigured(); }
export function getClient() { return defaultProvider().getClient(); }
