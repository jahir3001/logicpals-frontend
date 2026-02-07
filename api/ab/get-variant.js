import { createClient } from "@supabase/supabase-js";

function json(res, status, payload) {
  res.status(status).setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return json(res, 405, { status: "error", error: "Method not allowed" });
  }

  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

    if (!token) {
      return json(res, 401, { status: "error", error: "Missing Bearer token" });
    }

    const { experiment_key, track, session_id } = req.body || {};

    if (!experiment_key || !track) {
      return json(res, 400, {
        status: "error",
        error: "Missing required fields: experiment_key, track",
      });
    }

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY,
      {
        global: { headers: { Authorization: `Bearer ${token}` } },
      }
    );

    // 1) Get / assign variant (your existing working RPC)
    const { data: variantRows, error: variantErr } = await supabase.rpc(
      "ab_get_or_assign_variant",
      {
        p_experiment_key: experiment_key,
        p_track: track,
        p_session_id: session_id || null,
      }
    );

    if (variantErr) {
      return json(res, 500, { status: "error", error: variantErr.message });
    }

    const result = Array.isArray(variantRows) ? variantRows[0] : variantRows;

    if (!result) {
      return json(res, 500, { status: "error", error: "No result from RPC" });
    }

    // 2) Best-effort exposure logging (DO NOT break main request if it fails)
    let exposure_logged = false;
    let exposure_error = null;

    // Only log if we actually have an experiment_id (no_experiment returns null)
    if (result.experiment_id) {
      const { error: expErr } = await supabase.rpc("ab_log_exposure", {
        p_experiment_id: result.experiment_id,
        p_variant_id: result.variant_id || null,
        p_track: track,
        p_session_id: session_id || null,
        p_bucket: Number.isFinite(result.bucket) ? result.bucket : 0,
        p_reason: result.reason || "ok",
        p_source: "api:get-variant",
      });

      if (expErr) {
        exposure_error = expErr.message;
      } else {
        exposure_logged = true;
      }
    }

    return json(res, 200, {
      status: "ok",
      result,
      exposure_logged,
      exposure_error,
    });
  } catch (e) {
    return json(res, 500, { status: "error", error: e?.message || String(e) });
  }
}