/**
 * LOGICPALS ADMIN GUARD (Enterprise)
 * - NO hardcoded Supabase URL/keys in public
 * - Uses current logged-in JWT context
 * - Enforces admin via DB RPC: ab_require_admin()
 * Version: 2.0
 */

(function () {
  // ---------- small helpers ----------
  function getBearerFromSession(session) {
    return session?.access_token || null;
  }

  async function fetchEnv() {
    const r = await fetch("/api/env", { method: "GET" });
    if (!r.ok) throw new Error("env_fetch_failed");
    const j = await r.json();

    const supabaseUrl = j.supabaseUrl || j.SUPABASE_URL || j.url || j.SUPABASE_URL;
    const supabaseAnonKey =
      j.supabaseAnonKey || j.SUPABASE_ANON_KEY || j.anonKey || j.SUPABASE_KEY;

    if (!supabaseUrl) throw new Error("missing_supabase_url_in_env");
    if (!supabaseAnonKey) throw new Error("missing_supabase_anon_key_in_env");

    return { supabaseUrl, supabaseAnonKey };
  }

  async function getSupabaseClient() {
    // Case A: page already created a client and stored it
    if (window.supabase && typeof window.supabase.auth?.getSession === "function") {
      return window.supabase;
    }
    if (window.sb && typeof window.sb.auth?.getSession === "function") {
      return window.sb;
    }

    // Case B: supabase-js loaded globally (window.supabase.createClient exists) -> bootstrap client using /api/env
    if (window.supabase && typeof window.supabase.createClient === "function") {
      if (!window.__lp_env_promise) window.__lp_env_promise = fetchEnv();
      const env = await window.__lp_env_promise;

      if (!window.__lp_sb) {
        window.__lp_sb = window.supabase.createClient(env.supabaseUrl, env.supabaseAnonKey);
      }
      return window.__lp_sb;
    }

    console.error("Supabase client not available (missing supabase-js).");
    return null;
  }

  // ---------- core ----------
  async function isAdmin() {
    const sb = await getSupabaseClient();
    if (!sb) return false;

    try {
      const { data: { session }, error: sessErr } = await sb.auth.getSession();
      if (sessErr || !session) return false;

      // Hard gate by DB (enterprise): RPC decides, not frontend email list
      const gate = await sb.rpc("ab_require_admin", {});
      if (gate.error) return false;

      return true;
    } catch (err) {
      console.error("Error checking admin:", err);
      return false;
    }
  }

  async function requireAdmin(options = {}) {
    const {
      redirectTo = "admin-login.html",
      denyReturnHref = "dashboard.html",
    } = options;

    const ok = await isAdmin();
    if (ok) return true;

    document.body.innerHTML = `
      <div style="
        display:flex; flex-direction:column; align-items:center; justify-content:center;
        height:100vh; font-family: Inter, system-ui, Arial; background: linear-gradient(135deg,#FEE2E2 0%,#FECACA 100%);
        padding:20px; text-align:center;">
        <div style="font-size:80px; margin-bottom:20px;">🚫</div>
        <h1 style="color:#991B1B; font-size:32px; margin-bottom:12px;">Access Denied</h1>
        <p style="color:#7F1D1D; font-size:16px; margin-bottom:26px; max-width:520px;">
          Admin access is required for this page.
        </p>
        <div style="display:flex; gap:12px; flex-wrap:wrap; justify-content:center;">
          <a href="${redirectTo}" style="
            background:#111827; color:white; padding:14px 20px; border-radius:10px; text-decoration:none; font-weight:700;">
            Admin Login
          </a>
          <a href="${denyReturnHref}" style="
            background:#DC2626; color:white; padding:14px 20px; border-radius:10px; text-decoration:none; font-weight:700;">
            Return
          </a>
        </div>
      </div>
    `;
    return false;
  }

  async function getAdminUser() {
    const sb = await getSupabaseClient();
    if (!sb) return null;

    try {
      const { data: { session } } = await sb.auth.getSession();
      if (!session) return null;

      return {
        id: session.user.id,
        email: session.user.email,
        name: session.user.user_metadata?.full_name || "Admin",
        access_token: getBearerFromSession(session),
      };
    } catch (err) {
      console.error("Error getting admin user:", err);
      return null;
    }
  }

  async function logAdminAction(action, details) {
    const adminUser = await getAdminUser();
    if (!adminUser) return null;

    const logEntry = {
      admin_email: adminUser.email,
      action,
      details: details ?? null,
      timestamp: new Date().toISOString(),
    };

    console.log("📝 Admin Action:", logEntry);
    return logEntry;
  }

  window.AdminGuard = {
    isAdmin,
    requireAdmin,
    getAdminUser,
    logAdminAction,
  };
})();