// LogicPals env + Supabase bootstrap (ES module)
// Contract:
//  - Provides a single, consistent Supabase client across ALL pages.
//  - Uses a fixed storageKey so auth persists across pages.
//  - Exposes: window.supabaseClient, window.lpGetClient(), window.lpGetEnv()
//  - BFCache hardening: reload on pageshow persisted

function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(label + ' timed out after ' + ms + 'ms')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

async function fetchEnv() {
  const res = await withTimeout(fetch('/api/env', {
    method: 'GET',
    headers: { 'Accept': 'application/json' },
    cache: 'no-store',
    credentials: 'omit'
  }), 8000, 'GET /api/env');

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error('Env fetch failed (' + res.status + '): ' + text.slice(0, 200));
  }

  const j = await res.json();
  const supabaseUrl = j.supabaseUrl || j.SUPABASE_URL || j.url;
  const supabaseAnonKey = j.supabaseAnonKey || j.SUPABASE_ANON_KEY || j.anonKey;

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('Env missing supabaseUrl/supabaseAnonKey');
  }
  return { supabaseUrl, supabaseAnonKey };
}

async function getCreateClient() {
  if (window.supabase && typeof window.supabase.createClient === 'function') {
    return window.supabase.createClient;
  }
  // Fallback to ESM import if CDN global isn't present.
  const mod = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
  return mod.createClient;
}

async function init() {
  const env = await fetchEnv();
  const createClient = await getCreateClient();

  const client = createClient(env.supabaseUrl, env.supabaseAnonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storageKey: 'logicpals.auth'
    }
  });

  // Expose globally for all pages
  window.__lpEnv = env;
  window.supabaseClient = client;

  return client;
}

// Single shared init promise
window.__lpClientPromise = window.__lpClientPromise || init();

window.lpGetClient = function lpGetClient() {
  return window.__lpClientPromise;
};

window.lpGetEnv = function lpGetEnv() {
  return window.__lpEnv || null;
};

// BFCache hardening: on Back button restore, ensure scripts re-run and auth handlers are alive.
window.addEventListener('pageshow', (e) => {
  if (e.persisted) window.location.reload();
});
