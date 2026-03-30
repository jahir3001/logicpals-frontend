const { createClient } = require("@supabase/supabase-js");

function getBearer(req) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

function sbForJwt(jwt) {
  const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false },
  });
}

async function requireAdmin(supabase) {
  const gate = await supabase.rpc("ab_require_admin", {});
  if (gate.error) throw new Error(gate.error.message || "admin_required");
}

module.exports = async (req, res) => {
  if (req.method !== "GET") return res.status(405).json({ error: "method_not_allowed" });
  const jwt = getBearer(req); if (!jwt) return res.status(401).json({ error: "missing_bearer_token" });
  const severity = String(req.query.severity || 'all');
  try {
    const supabase = sbForJwt(jwt);
    await requireAdmin(supabase);
    let q = supabase.from('alert_log').select('created_at, alert_type, severity, source, summary, payload').order('created_at', { ascending: false }).limit(50);
    if (severity !== 'all') q = q.eq('severity', severity);
    const { data, error } = await q;
    if (error) throw error;
    return res.status(200).json({ ok: true, rows: data || [] });
  } catch (err) {
    return res.status(403).json({ error: 'telemetry_alerts_failed', details: err.message });
  }
};
