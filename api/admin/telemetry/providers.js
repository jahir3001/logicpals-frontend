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
    const { data, error } = await supabase.from('alert_log').select('created_at, alert_type, payload').in('alert_type', ['ai_provider_failover','ai_latency_high','ai_error_spike']).order('created_at', { ascending:false }).limit(100);
    if (error) throw error;
    const state = new Map();
    for (const row of (data || [])) {
      const payload = row.payload || {};
      const provider = payload.provider || 'unknown';
      if (!state.has(provider)) state.set(provider, { provider, breaker_state:'closed', fallback_active:false, p95_latency_ms:0, error_rate:0, last_event_at: row.created_at });
      const s = state.get(provider);
      s.last_event_at = s.last_event_at || row.created_at;
      if (row.alert_type === 'ai_provider_failover') { s.breaker_state = 'open'; s.fallback_active = true; }
      if (row.alert_type === 'ai_latency_high') s.p95_latency_ms = Number(payload.p95_latency_ms || 0);
      if (row.alert_type === 'ai_error_spike') s.error_rate = Number(payload.error_rate || 0);
    }
    return res.status(200).json({ ok: true, rows: Array.from(state.values()) });
  } catch (err) {
    return res.status(403).json({ error: 'telemetry_providers_failed', details: err.message });
  }
};
