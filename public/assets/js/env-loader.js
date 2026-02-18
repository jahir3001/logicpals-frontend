/**
 * LogicPals env-loader (enterprise hardening)
 * - Single source of truth for browser config: GET /api/env
 * - Exposes:
 *    window.__LP_ENV_READY  -> Promise that resolves once env is loaded (or null on failure)
 *    window.__LP_ENV        -> { SUPABASE_URL, SUPABASE_ANON_KEY }
 *    window.__LP_GET_ENV()  -> helper to await and return env
 */
(function () {
  const CACHE_BUST = String(Date.now());

  async function loadEnv() {
    if (window.__LP_ENV && window.__LP_ENV.SUPABASE_URL && window.__LP_ENV.SUPABASE_ANON_KEY) {
      return window.__LP_ENV;
    }

    const res = await fetch('/api/env?cb=' + CACHE_BUST, {
      method: 'GET',
      cache: 'no-store',
      headers: { 'Accept': 'application/json' }
    });

    if (!res.ok) {
      throw new Error('Failed to load /api/env (' + res.status + ')');
    }

    const j = await res.json();

    const SUPABASE_URL = j.SUPABASE_URL || j.supabaseUrl || j.supabase_url || j.url || '';
    const SUPABASE_ANON_KEY = j.SUPABASE_ANON_KEY || j.supabaseAnonKey || j.supabase_anon_key || j.anonKey || '';

    window.__LP_ENV = { SUPABASE_URL, SUPABASE_ANON_KEY };

    return window.__LP_ENV;
  }

  // create/keep a single in-flight promise across BFCache navigations
  if (!window.__LP_ENV_READY) {
    window.__LP_ENV_READY = loadEnv()
      .catch((err) => {
        window.__LP_ENV_ERROR = err;
        console.error('[LogicPals] env-loader failed:', err);
        return null;
      });
  }

  window.__LP_GET_ENV = async function () {
    await (window.__LP_ENV_READY || Promise.resolve());
    return window.__LP_ENV || null;
  };
})();
