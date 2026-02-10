// /api/ab/refresh-dashboards.js
// Enterprise Dashboard Refresh (Step 8)
// - POST only
// - Requires user JWT (Bearer)
// - Enforces admin role via DB RPC ab_require_admin()
// - Then calls RPC ab_refresh_dashboards()

const { createClient } = require("@supabase/supabase-js");

function getBearer(req) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

function safeJson(body) {
  if (body == null) return {};
  if (typeof body === "object") return body;
  if (typeof body !== "string") return null;
  const s = body.trim();
  if (!s) return {};
  try { return JSON.parse(s); } catch { return null; }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  const jwt = getBearer(req);
  if (!jwt) return res.status(401).json({ error: "missing_bearer_token" });

  const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!SUPABASE_URL) return res.status(500).json({ error: "missing_SUPABASE_URL" });
  if (!SUPABASE_ANON_KEY) return res.status(500).json({ error: "missing_SUPABASE_ANON_KEY" });

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false },
  });

  // 1) hard gate: must be admin
  const gate = await supabase.rpc("ab_require_admin", {});
  if (gate.error) return res.status(403).json({ error: "admin_required", details: gate.error.message });

  // 2) do refresh
  const body = safeJson(req.body);
  if (body === null) return res.status(400).json({ error: "invalid_json" });

  const { data, error } = await supabase.rpc("ab_refresh_dashboards", {});
  if (error) return res.status(500).json({ error: "refresh_failed", details: error.message });

  return res.status(200).json({ ok: true, result: data ?? null, refreshed_at: new Date().toISOString() });
};