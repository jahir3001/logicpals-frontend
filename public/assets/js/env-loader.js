(async () => {
  async function loadEnv() {
    try {
      const res = await fetch("/api/env", { cache: "no-store" });
      if (!res.ok) throw new Error(`env fetch failed: ${res.status}`);
      const env = await res.json();
      if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
        throw new Error("Missing SUPABASE_URL / SUPABASE_ANON_KEY");
      }
      return env;
    } catch (e) {
      console.error("ENV LOAD ERROR:", e);
      return null;
    }
  }
  window.loadEnv = loadEnv;
})();
