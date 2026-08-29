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
}
