// api/ab/log-metric.js
// Enterprise A/B metric logger
// - POST only
// - Requires Bearer JWT (Supabase access token)
// - Calls RPC ab_log_event(...) so DB owns integrity + idempotency

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

  const body = safeJson(req.body);
  if (body === null) return res.status(400).json({ error: "invalid_json" });

  // expected fields (align to your RPC signature)
  const {
    experiment_key,
    variant,
    event_name,
    session_id = null,
    track = null,
    idempotency_key = null,
    properties = {},
  } = body;

  if (!experiment_key) return res.status(400).json({ error: "missing_experiment_key" });
  if (!variant) return res.status(400).json({ error: "missing_variant" });
  if (!event_name) return res.status(400).json({ error: "missing_event_name" });

  const { data, error } = await supabase.rpc("ab_log_event", {
    p_experiment_key: experiment_key,
    p_variant: variant,
    p_event_name: event_name,
    p_session_id: session_id,
    p_track: track,
    p_idempotency_key: idempotency_key,
    p_properties: properties,
  });

  if (error) return res.status(500).json({ error: "rpc_failed", details: error.message });

  return res.status(200).json({ ok: true, result: data ?? null, logged_at: new Date().toISOString() });
};