// api/ab/admin-bundle.js
// Enterprise Admin A/B Bundle
// - POST only
// - Requires Bearer JWT
// - Enforces admin via ab_require_admin()
// - Reads experiment from DB under RLS

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

  // 1) hard gate
  const gate = await supabase.rpc("ab_require_admin", {});
  if (gate.error) return res.status(403).json({ error: "admin_required", details: gate.error.message });

  // 2) parse body
  const body = safeJson(req.body);
  if (body === null) return res.status(400).json({ error: "invalid_json" });

  const { experiment_key, days = 14, track = null } = body;
  if (!experiment_key) return res.status(400).json({ error: "missing_experiment_key" });

  // 3) read experiment definition
  const { data: experiment, error: expErr } = await supabase
    .from("ab_experiments")
    .select("*")
    .eq("experiment_key", experiment_key)
    .limit(1)
    .single();

  if (expErr) return res.status(500).json({ error: "experiment_query_failed", details: expErr.message });
  if (!experiment) return res.status(404).json({ error: "experiment_not_found" });

  // 4) optional: show recent event counts
  const since = new Date(Date.now() - Math.max(1, Number(days)) * 86400000).toISOString();

  let q = supabase
    .from("ab_events")
    .select("variant, event_type, created_at")
    .eq("experiment_key", experiment_key)
    .gte("created_at", since);

  if (track === "regular" || track === "olympiad") q = q.eq("track", track);

  const { data: events, error: evErr } = await q;
  if (evErr) return res.status(500).json({ error: "events_query_failed", details: evErr.message });

  const totals = {};
  for (const e of events || []) {
    const v = e.variant || "unknown";
    totals[v] = totals[v] || { events: 0 };
    totals[v].events += 1;
  }

  return res.status(200).json({
    ok: true,
    experiment_key,
    track,
    days,
    experiment,
    totals,
    generated_at: new Date().toISOString(),
  });
};