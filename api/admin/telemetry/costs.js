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
  try {
    const supabase = sbForJwt(jwt);
    await requireAdmin(supabase);
    const { data, error } = await supabase.from('ai_cost_ledger').select('model_id, request_type, track, tier, cost_usd, latency_ms').order('created_at', { ascending: false }).limit(250);
    if (error) throw error;
    const grouped = new Map();
    for (const r of (data || [])) {
      const key = [r.model_id, r.request_type, r.track, r.tier].join('|');
      const cur = grouped.get(key) || { model_id:r.model_id, request_type:r.request_type, track:r.track, tier:r.tier, calls:0, total_cost_usd:0, total_latency_ms:0 };
      cur.calls += 1; cur.total_cost_usd += Number(r.cost_usd || 0); cur.total_latency_ms += Number(r.latency_ms || 0); grouped.set(key, cur);
    }
    const rows = Array.from(grouped.values()).map(r => ({ ...r, avg_latency_ms: r.calls ? r.total_latency_ms / r.calls : 0 }));
    return res.status(200).json({ ok: true, rows });
  } catch (err) {
    return res.status(403).json({ error: 'telemetry_costs_failed', details: err.message });
  }
};
