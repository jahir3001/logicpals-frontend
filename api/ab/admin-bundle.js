// api/ab/admin-bundle.js
// Enterprise Admin A/B Dashboard Bundle (Step 8.7 QC-ready)
// - POST only
// - Requires Bearer JWT
// - Enforces admin via public.ab_require_admin()
// - Calls RPC dashboard functions (no .single() assumptions)
// - Supports BOTH tracks: regular + olympiad (or one track if provided)

const { createClient } = require("@supabase/supabase-js");

function getBearer(req) {
  const h = req.headers.authorization || req.headers.Authorization || "";
  const m = String(h).match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

function safeJson(body) {
  if (body == null) return {};
  if (typeof body === "object") return body;
  if (typeof body !== "string") return null;
  const s = body.trim();
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

async function rpcOrThrow(supabase, fn, args) {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) {
    const err = new Error(error.message || "rpc_failed");
    err.code = error.code;
    err.details = error.details;
    err.hint = error.hint;
    err.fn = fn;
    throw err;
  }
  return data;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  const jwt = getBearer(req);
  if (!jwt) return res.status(401).json({ error: "missing_bearer_token" });

  const SUPABASE_URL =
    process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const SUPABASE_ANON_KEY =
    process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!SUPABASE_URL) return res.status(500).json({ error: "missing_SUPABASE_URL" });
  if (!SUPABASE_ANON_KEY)
    return res.status(500).json({ error: "missing_SUPABASE_ANON_KEY" });

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false },
  });

  // 1) Hard gate (must be admin)
  try {
    await rpcOrThrow(supabase, "ab_require_admin", {});
  } catch (e) {
    return res.status(403).json({ error: "admin_required", details: e.message });
  }

  // 2) Parse body
  const body = safeJson(req.body);
  if (body === null) return res.status(400).json({ error: "invalid_json" });

  const experiment_key = body.experiment_key;
  const days = Number(body.days ?? 7);
  const requestedTrack = body.track ?? null; // "regular" | "olympiad" | null

  if (!experiment_key) {
    return res.status(400).json({ error: "missing_experiment_key" });
  }
  if (!Number.isFinite(days) || days <= 0 || days > 90) {
    return res.status(400).json({ error: "invalid_days", details: "days must be 1..90" });
  }
  if (
    requestedTrack !== null &&
    requestedTrack !== "regular" &&
    requestedTrack !== "olympiad"
  ) {
    return res.status(400).json({
      error: "invalid_track",
      details: 'track must be "regular", "olympiad", or omitted',
    });
  }

  // 3) Pull bundles (admin RPC)
  // Your DB signature (from your screenshot):
  // ab_dash_admin_bundle(p_experiment_key text, p_track lp_track, p_days integer) returns jsonb
  try {
    if (requestedTrack) {
      const bundle = await rpcOrThrow(supabase, "ab_dash_admin_bundle", {
        p_experiment_key: experiment_key,
        p_track: requestedTrack,
        p_days: days,
      });

      return res.status(200).json({
        ok: true,
        result: { experiment_key, days, track: requestedTrack, bundle },
      });
    }

    // BOTH tracks
    const [regular, olympiad] = await Promise.all([
      rpcOrThrow(supabase, "ab_dash_admin_bundle", {
        p_experiment_key: experiment_key,
        p_track: "regular",
        p_days: days,
      }),
      rpcOrThrow(supabase, "ab_dash_admin_bundle", {
        p_experiment_key: experiment_key,
        p_track: "olympiad",
        p_days: days,
      }),
    ]);

    return res.status(200).json({
      ok: true,
      result: {
        experiment_key,
        days,
        tracks: {
          regular,
          olympiad,
        },
      },
    });
  } catch (e) {
    return res.status(500).json({
      error: "experiment_query_failed",
      details: e.message,
      fn: e.fn,
      code: e.code,
    });
  }
};