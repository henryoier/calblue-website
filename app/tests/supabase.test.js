import * as supabase from "../js/supabase.js";
import { supabaseLogicTests } from "./supabase.logic.js";
import { test, testAsync, equal, assert } from "./runner.js";

supabaseLogicTests(supabase, { test, equal, assert });

const settings = {
  url: "https://example.supabase.co",
  anonKey: "sb_publishable_example",
  version: "2.45.4",
};

testAsync("[supabase] concurrent callers create one SDK client with persistent PKCE options", async (t) => {
  let imports = 0;
  let creations = 0;
  let options;
  const fake = { auth: {} };
  const provider = supabase.createClientProvider({ ...settings,
    async loadModule(url) {
      imports += 1;
      t.equal(url, "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm");
      return { createClient(project, key, configuration) {
        creations += 1;
        t.equal(project, settings.url);
        t.equal(key, settings.anonKey);
        options = configuration;
        return fake;
      } };
    },
  });
  const clients = await Promise.all([provider.getClient(), provider.getClient(), provider.getClient()]);
  t.equal(imports, 1, "only one SDK module import");
  t.equal(creations, 1, "only one createClient invocation");
  t.assert(clients.every((client) => client === fake));
  t.equal(await provider.getClient(), fake);
  t.equal(creations, 1, "cached client does not invoke createClient again");
  t.equal(options.auth.persistSession, true);
  t.equal(options.auth.autoRefreshToken, true);
  t.equal(options.auth.flowType, "pkce");
  t.equal(options.auth.detectSessionInUrl, false, "auth.js owns callback capture and exchange");
});

testAsync("[supabase] failed SDK imports are visible and a later request can retry", async (t) => {
  let attempts = 0;
  const provider = supabase.createClientProvider({ ...settings,
    async loadModule() {
      attempts += 1;
      if (attempts === 1) throw new Error("network unavailable");
      return { default: { createClient: () => ({ auth: {} }) } };
    },
  });
  let failure;
  try { await provider.getClient(); } catch (error) { failure = error; }
  t.assert(Boolean(failure));
  t.equal(failure.cause.message, "network unavailable");
  t.assert(Boolean(await provider.getClient()));
  t.equal(attempts, 2);
});

testAsync("[supabase] missing SDK exports do not cache a broken client", async (t) => {
  let attempts = 0;
  const provider = supabase.createClientProvider({ ...settings,
    async loadModule() { attempts += 1; return {}; },
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let rejected = false;
    try { await provider.getClient(); } catch (_) { rejected = true; }
    t.assert(rejected);
  }
  t.equal(attempts, 2);
});

testAsync("[supabase] createClient failures are retryable and do not poison the singleton", async (t) => {
  let attempts = 0;
  const expected = { auth: {} };
  const provider = supabase.createClientProvider({ ...settings,
    async loadModule() {
      return { createClient() {
        attempts += 1;
        if (attempts === 1) throw new Error("client initialization failed");
        return expected;
      } };
    },
  });
  let rejected = false;
  try { await provider.getClient(); } catch (_) { rejected = true; }
  t.assert(rejected);
  t.equal(await provider.getClient(), expected);
  t.equal(attempts, 2);
});

testAsync("[supabase] unconfigured mode makes no CDN request and versions stay pinned", async (t) => {
  let imports = 0;
  const loadModule = async () => { imports += 1; return {}; };
  const offline = supabase.createClientProvider({ ...settings, url: "", loadModule });
  t.equal(await offline.getClient(), null);
  const unpinned = supabase.createClientProvider({ ...settings, version: "latest", loadModule });
  let rejected = false;
  try { await unpinned.getClient(); } catch (_) { rejected = true; }
  t.assert(rejected);
  t.equal(imports, 0);
});
