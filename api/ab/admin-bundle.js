// api/ab/admin-bundle.js
// Enterprise Admin A/B Bundle
// - POST only
// - Requires Bearer JWT (Supabase access token)
// - Enforces admin guard (ab_require_admin() preferred; fallback require_admin())
// - Returns bundle for one track or BOTH tracks (regular + olympiad)
// - No .single() assumptions on RPC results
// - Shape: { ok: true, result: {...} }

const { createClient } = require("@supabase/supabase-js");

function getBearer(req) {
  const h = req.headers?.authorization || req.headers?.Authorization || "";
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

async function rpcSingleJson(supabase, fn, params) {
  // Works whether PostgREST returns object or array (depending on function)
  const { data, error } = await supabase.rpc(fn, params || {});
  if (error) return { error };

  if (data == null) return { data: null };
  if (Array.isArray(data)) return { data: data[0] ?? null };
  return { data };
}

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "method_not_allowed" });
    }

    const jwt = getBearer(req);
    if (!jwt) return res.status(401).json({ error: "missing_bearer_token" });

    const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    const SUPABASE_ANON_KEY =
      process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (!SUPABASE_URL) return res.status(500).json({ error: "missing_SUPABASE_URL" });
    if (!SUPABASE_ANON_KEY) return res.status(500).json({ error: "missing_SUPABASE_ANON_KEY" });

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
      auth: { persistSession: false },
    });

    // Parse body
    const body = safeJson(req.body);
    if (body === null) return res.status(400).json({ error: "invalid_json" });

    const experiment_key = body.experiment_key;
    const days = Number.isFinite(Number(body.days)) ? Math.max(1, Number(body.days)) : 7;
    const track = body.track ?? null; // "regular" | "olympiad" | null

    if (!experiment_key) return res.status(400).json({ error: "missing_experiment_key" });

    // Admin gate (preferred: ab_require_admin; fallback: require_admin)
    let gate = await supabase.rpc("ab_require_admin", {});
    if (gate?.error) {
      const gate2 = await supabase.rpc("require_admin", {});
      if (gate2?.error) {
        return res.status(403).json({
          error: "admin_required",
          details: gate.error.message || gate2.error.message,
        });
      }
    }

    // Verify experiment exists (for the requested tracks)
    // We allow same experiment_key across tracks; if your schema is different, still safe.
    const expQ = supabase
      .from("ab_experiments")
      .select("id, experiment_key, track, status, created_at")
      .eq("experiment_key", experiment_key);

    const { data: expRows, error: expErr } = await expQ;
    if (expErr) {
      return res.status(500).json({ error: "experiment_query_failed", details: expErr.message });
    }

    // If caller asks one track, require it exists.
    if (track === "regular" || track === "olympiad") {
      const found = (expRows || []).some((r) => r.track === track);
      if (!found) {
        return res.status(404).json({
          error: "experiment_not_found_for_track",
          experiment_key,
          track,
          known_tracks: (expRows || []).map((r) => r.track),
        });
      }
    } else {
      // If caller wants both tracks, at least one must exist (otherwise the key is wrong)
      if (!expRows || expRows.length === 0) {
        return res.status(404).json({ error: "experiment_not_found", experiment_key });
      }
    }

    // Helper to fetch one track bundle using DB RPC
    async function fetchTrackBundle(t) {
      // expects: ab_dash_admin_bundle(p_experiment_key text, p_track lp_track, p_days integer) -> jsonb
      const { data, error } = await rpcSingleJson(supabase, "ab_dash_admin_bundle", {
        p_experiment_key: experiment_key,
        p_track: t,
        p_days: days,
      });
      if (error) {
        return { ok: false, error: error.message };
      }
      return { ok: true, bundle: data ?? null };
    }

    // If a single track was requested
    if (track === "regular" || track === "olympiad") {
      const out = await fetchTrackBundle(track);
      if (!out.ok) {
        return res.status(500).json({ error: "bundle_failed", details: out.error });
      }
      return res.status(200).json({
        ok: true,
        result: {
          experiment_key,
          days,
          track,
          bundle: out.bundle,
        },
      });
    }

    // Otherwise return BOTH tracks
    const reg = await fetchTrackBundle("regular");
    const oly = await fetchTrackBundle("olympiad");

    if (!reg.ok || !oly.ok) {
      return res.status(500).json({
        error: "bundle_failed",
        details: { regular: reg.ok ? null : reg.error, olympiad: oly.ok ? null : oly.error },
      });
    }

    return res.status(200).json({
      ok: true,
      result: {
        experiment_key,
        days,
        tracks: {
          regular: reg.bundle,
          olympiad: oly.bundle,
        },
      },
    });
  } catch (e) {
    return res.status(500).json({ error: "server_error", details: String(e?.message || e) });
  }
};