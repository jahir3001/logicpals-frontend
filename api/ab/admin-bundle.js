// api/ab/admin-bundle.js
// Enterprise Admin A/B Dashboard Bundle (tracks: regular + olympiad)
// - POST only
// - Requires Bearer JWT (admin user session)
// - Enforces admin via require_admin()
// - Returns { ok: true, result: ... } (no .single() assumptions)

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
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

module.exports = async (req, res) => {
  try {
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
    if (!SUPABASE_ANON_KEY) return res.status(500).json({ error: "missing_SUPABASE_ANON_KEY" });

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
      auth: { persistSession: false },
    });

    // 1) Hard gate (your DB has require_admin(), not ab_require_admin())
    const gate = await supabase.rpc("require_admin");
    if (gate.error) {
      return res.status(403).json({ error: "admin_required", details: gate.error.message });
    }

    // 2) Parse body
    const body = safeJson(req.body);
    if (body === null) return res.status(400).json({ error: "invalid_json" });

    const { experiment_key, days = 14, track = null } = body;
    if (!experiment_key) return res.status(400).json({ error: "missing_experiment_key" });

    const p_days = Math.max(1, Number(days) || 14);

    // 3) If track is provided => return one track
    //    If track is null/undefined => return BOTH tracks (enterprise default)
    const callBundle = async (t) => {
      // ab_dash_admin_bundle(p_experiment_key text, p_track lp_track, p_days integer) -> jsonb
      const r = await supabase.rpc("ab_dash_admin_bundle", {
        p_experiment_key: String(experiment_key),
        p_track: t, // "regular" | "olympiad"
        p_days,
      });
      if (r.error) {
        return { ok: false, error: r.error.message };
      }
      return { ok: true, data: r.data };
    };

    let result;

    if (track === "regular" || track === "olympiad") {
      const one = await callBundle(track);
      if (!one.ok) {
        return res.status(500).json({ error: "bundle_failed", details: one.error });
      }
      result = { track, bundle: one.data };
    } else {
      // Both tracks
      const [reg, oly] = await Promise.all([callBundle("regular"), callBundle("olympiad")]);

      if (!reg.ok || !oly.ok) {
        return res.status(500).json({
          error: "bundle_failed",
          details: {
            regular: reg.ok ? null : reg.error,
            olympiad: oly.ok ? null : oly.error,
          },
        });
      }

      result = {
        experiment_key,
        days: p_days,
        tracks: {
          regular: reg.data,
          olympiad: oly.data,
        },
      };
    }

    return res.status(200).json({ ok: true, result });
  } catch (e) {
    return res.status(500).json({ error: "unexpected_error", details: String(e?.message || e) });
  }
};