export function supabaseLogicTests(supabase, t) {
  const { configurationIsUsable } = supabase;

  t.test("configuration rejects empty and documented placeholder values", () => {
    t.assert(!configurationIsUsable("", ""));
    t.assert(!configurationIsUsable(
      "https://YOUR_PROJECT_REF.supabase.co",
      "YOUR_SUPABASE_ANON_KEY",
    ));
    t.assert(!configurationIsUsable(
      "https://placeholder.supabase.co",
      "placeholder-anon-key",
    ));
  });

  t.test("configuration accepts an HTTPS project URL and public key", () => {
    t.assert(configurationIsUsable(
      "https://example.supabase.co",
      "sb_publishable_example",
    ));
  });

  t.test("configuration rejects credentials, paths, fragments and non-string values", () => {
    for (const url of ["http://example.supabase.co", "https://user:password@example.supabase.co",
      "https://example.supabase.co/rest/v1", "https://example.supabase.co?project=1",
      "https://example.supabase.co#access_token=test", "https://example.supabase.co bad", {}]) {
      t.assert(!configurationIsUsable(url, "sb_publishable_example"));
    }
    t.assert(!configurationIsUsable("https://example.supabase.co", {}));
    t.assert(!configurationIsUsable("https://example.supabase.co", "key with whitespace"));
  });
}
