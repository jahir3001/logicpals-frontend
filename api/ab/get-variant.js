const { createClient } = require("@supabase/supabase-js");

function getAuthHeader(req) {
  return (
    req.headers?.authorization ||
    req.headers?.Authorization ||
    (req.headers?.get ? req.headers.get("authorization") : null) ||
    (req.headers?.get ? req.headers.get("Authorization") : null)
  );
}

module.exports = async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

    const url = process.env.SUPABASE_URL;
    const anonKey = process.env.SUPABASE_ANON_KEY;
    if (!url) return res.status(500).json({ error: "missing_env", detail: "SUPABASE_URL" });
    if (!anonKey) return res.status(500).json({ error: "missing_env", detail: "SUPABASE_ANON_KEY" });

    const auth = getAuthHeader(req);
    if (!auth || !/^Bearer\s+/i.test(auth)) return res.status(401).json({ error: "missing_auth" });

    const { experiment_key, track, session_id, debug } = req.body || {};
    if (!experiment_key) return res.status(400).json({ error: "missing_experiment_key" });
    if (!track) return res.status(400).json({ error: "missing_track" });

    // ANON + user JWT so RLS/auth.uid() applies
    const supabase = createClient(url, anonKey, { global: { headers: { Authorization: auth } } });

    // ✅ Enterprise gate: status + kill-switch
    // (Read is allowed by RLS; if not, make a SECURITY DEFINER RPC later.)
    const { data: exp, error: expErr } = await supabase
      .from("ab_experiments")
      .select("id, status, is_killswitched")
      .eq("experiment_key", experiment_key)
      .eq("track", track)
      .maybeSingle();

    if (expErr) {
      return res.status(500).json({ error: "experiment_lookup_failed", ...(debug ? { detail: expErr.message } : {}) });
    }
    if (!exp?.id) return res.status(404).json({ error: "experiment_not_found" });

    if (exp.is_killswitched) return res.status(403).json({ error: "experiment_killswitched" });
    if (exp.status !== "running") return res.status(403).json({ error: "experiment_not_running", status: exp.status });

    // 1) Assign or fetch variant (deterministic)
    const { data, error } = await supabase.rpc("ab_get_or_assign_variant", {
      p_experiment_key: experiment_key,
      p_track: track,
      p_session_id: session_id || null,
    });

    if (error) {
      return res.status(500).json({ error: "rpc_failed", ...(debug ? { detail: error.message } : {}) });
    }

    const row = Array.isArray(data) ? data[0] : data;

    // 2) Exposure logging (best-effort; MUST NOT block)
    let exposure_log = { attempted: false, ok: false };

    if (row && row.experiment_id && row.variant_id) {
      exposure_log.attempted = true;
      const { error: logErr } = await supabase.rpc("ab_log_exposure", {
        p_experiment_id: row.experiment_id,
        p_variant_id: row.variant_id,
        p_track: track,
        p_session_id: session_id || null,
        p_bucket: row.bucket ?? 0,
        p_reason: row.reason || "ok",
        p_source: "api",
      });

      if (logErr) {
        exposure_log.ok = false;
        if (debug) exposure_log.detail = logErr.message;
      } else {
        exposure_log.ok = true;
      }
    }

    const resp = { ok: true, result: row || null };
    if (debug) resp.exposure_log = exposure_log;

    return res.status(200).json(resp);
  } catch (e) {
    return res.status(500).json({ error: "function_invocation_failed" });
  }
};