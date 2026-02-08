const { createClient } = require("@supabase/supabase-js");

/**
 * Vercel API Route
 * POST /api/ab/get-variant
 *
 * Headers:
 *  - Authorization: Bearer <user_access_token>   (required)
 *
 * Body JSON:
 *  {
 *    "experiment_key": "reg_home_tutor_hint_v1",
 *    "track": "regular",
 *    "session_id": "<uuid>"   // optional but recommended
 *  }
 *
 * Env required:
 *  - SUPABASE_URL
 *  - SUPABASE_ANON_KEY
 */
module.exports = async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).send("METHOD_NOT_ALLOWED");

    if (!process.env.SUPABASE_URL) return res.status(500).send("Missing SUPABASE_URL");
    if (!process.env.SUPABASE_ANON_KEY) return res.status(500).send("Missing SUPABASE_ANON_KEY");

    const auth = req.headers["authorization"];
    if (!auth || !auth.startsWith("Bearer ")) return res.status(401).send("Unauthorized");

    const { experiment_key, track, session_id, debug } = req.body || {};
    if (!experiment_key) return res.status(400).send("Missing experiment_key");
    if (!track) return res.status(400).send("Missing track");

    // IMPORTANT: use ANON key + forward the user's JWT so auth.uid()/RLS applies
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: auth } },
    });

    // 1) Assign or fetch variant (deterministic)
    const { data, error } = await supabase.rpc("ab_get_or_assign_variant", {
      p_experiment_key: experiment_key,
      p_track: track,
      p_session_id: session_id || null,
    });

    if (error) {
      console.error("ab_get_or_assign_variant error:", error);
      return res.status(500).json({ error: "RPC_FAILED", detail: error.message });
    }

    const row = Array.isArray(data) ? data[0] : data;

    // 2) Exposure logging (best-effort; MUST NOT block variant assignment)
    // Your DB function signature:
    // ab_log_exposure(uuid, uuid, lp_track, uuid, int, text, text)
    let exposure_log = { attempted: false, ok: false };

    if (row && row.experiment_id && row.variant_id) {
      exposure_log.attempted = true;
      try {
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
          console.error("ab_log_exposure error (non-blocking):", logErr);
          exposure_log.ok = false;
          exposure_log.detail = logErr.message;
        } else {
          exposure_log.ok = true;
        }
      } catch (e) {
        console.error("ab_log_exposure exception (non-blocking):", e);
        exposure_log.ok = false;
        exposure_log.detail = String(e?.message || e);
      }
    }

    // Default response stays clean; debug can show exposure_log
    const resp = { status: "ok", result: row || null };
    if (debug) resp.exposure_log = exposure_log;

    return res.status(200).json(resp);
  } catch (e) {
    console.error("get-variant error:", e);
    return res.status(500).send("FUNCTION_INVOCATION_FAILED");
  }
};