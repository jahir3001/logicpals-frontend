// api/ab/admin-bundle.js
// Enterprise Admin A/B Bundle (Step 8)
// - POST only
// - Requires Bearer JWT
// - Enforces admin via ab_require_admin()
// - Returns { ok: true, result: ... }
// - Supports BOTH tracks (regular + olympiad) when track is omitted
//
// Expected DB RPCs (already in your screenshots):
//   public.ab_require_admin() returns void (throws if not admin)
//   public.ab_dash_admin_bundle(p_experiment_key text, p_track lp_track, p_days int) returns json/jsonb

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

// RPC can return an object or an array depending on PostgREST + function return type.
// This makes the endpoint robust (no .single() assumptions).
function normalizeRpc(data) {
  if (Array.isArray(data)) {
    if (data.length === 1) return data[0];
    return data;
  }
  return data;
}

function firstIp(req) {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.trim()) {
    return xf.split(",")[0].trim();
  }
  return req.socket?.remoteAddress || "";
}

function buildMetaPayload(req, body) {
  return {
    data: [
      {
        event_name: body.event_name,
        event_time: Math.floor(Date.now() / 1000),
        event_id: body.event_id || `lp_${Date.now()}`,
        action_source: "website",
        event_source_url: req.headers.referer || body.event_source_url || "",
        user_data: {
          client_ip_address: firstIp(req),
          client_user_agent: req.headers["user-agent"] || "",
          ...(body.user_data || {}),
        },
        custom_data: body.custom_data || {},
      },
    ],
  };
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  // PUBLIC META CAPI FAST-PATH
  // Must stay BEFORE Bearer/admin checks because pricing/signup/dashboard pages are public app surfaces.
  const body = safeJson(req.body);
  if (body === null) return res.status(400).json({ error: "invalid_json" });

  if (body.op === "meta_track") {
    const allowedEvents = new Set([
      "InitiateCheckout",
      "AddPaymentInfo",
      "StartTrial",
      "CompleteRegistration",
      "Lead",
      "Login",
      "ViewContent",
    ]);

    const { event_name } = body;
    if (!allowedEvents.has(event_name)) {
      return res.status(400).json({ ok: false, error: "unsupported_event" });
    }

    const META_PIXEL_ID = process.env.META_PIXEL_ID;
    const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;

    if (!META_PIXEL_ID) {
      return res.status(500).json({ ok: false, error: "missing_META_PIXEL_ID" });
    }
    if (!META_ACCESS_TOKEN) {
      return res.status(500).json({ ok: false, error: "missing_META_ACCESS_TOKEN" });
    }

    const payload = buildMetaPayload(req, body);

    try {
      const fbRes = await fetch(
        `https://graph.facebook.com/v20.0/${META_PIXEL_ID}/events?access_token=${META_ACCESS_TOKEN}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );

      const fbJson = await fbRes.json();

      if (!fbRes.ok) {
        return res.status(502).json({
          ok: false,
          error: "meta_capi_failed",
          details: fbJson,
        });
      }

      return res.status(200).json({
        ok: true,
        result: fbJson,
      });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: "meta_capi_exception",
        details: err.message,
      });
    }
  }

  const jwt = getBearer(req);
  if (!jwt) {
    return res.status(401).json({ error: "missing_bearer_token" });
  }

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

  // 1) Hard admin gate
  const gate = await supabase.rpc("ab_require_admin");
  if (gate.error) {
    // common case: expired JWT or not admin
    return res.status(403).json({
      error: "admin_required",
      details: gate.error.message,
    });
  }

  // 2) Parse body
  
  const experiment_key = body.experiment_key;
  const days = Number.isFinite(Number(body.days)) ? Number(body.days) : 7;
  const track = body.track || null; // "regular" | "olympiad" | null

  if (!experiment_key) return res.status(400).json({ error: "missing_experiment_key" });

  // 3) Fetch bundle(s)
  // If track is provided, return ONLY that track bundle.
  // If track is omitted, return BOTH tracks (regular + olympiad) in one response.
  const wantSingle = track === "regular" || track === "olympiad";

  if (wantSingle) {
    const { data, error } = await supabase.rpc("ab_dash_admin_bundle", {
      p_experiment_key: experiment_key,
      p_track: track,
      p_days: Math.max(1, days),
    });

    if (error) {
      return res.status(500).json({
        error: "experiment_query_failed",
        details: error.message,
      });
    }

    return res.status(200).json({
      ok: true,
      result: normalizeRpc(data),
    });
  }

  // Both tracks
  const [reg, oly] = await Promise.all([
    supabase.rpc("ab_dash_admin_bundle", {
      p_experiment_key: experiment_key,
      p_track: "regular",
      p_days: Math.max(1, days),
    }),
    supabase.rpc("ab_dash_admin_bundle", {
      p_experiment_key: experiment_key,
      p_track: "olympiad",
      p_days: Math.max(1, days),
    }),
  ]);

  if (reg.error) {
    return res.status(500).json({
      error: "experiment_query_failed",
      details: `regular: ${reg.error.message}`,
    });
  }
  if (oly.error) {
    return res.status(500).json({
      error: "experiment_query_failed",
      details: `olympiad: ${oly.error.message}`,
    });
  }

  return res.status(200).json({
    ok: true,
    result: {
      experiment_key,
      days: Math.max(1, days),
      tracks: {
        regular: normalizeRpc(reg.data),
        olympiad: normalizeRpc(oly.data),
      },
    },
  });
};