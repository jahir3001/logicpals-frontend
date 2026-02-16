import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function getBearer(req) {
  const h =
    req.headers?.authorization ||
    req.headers?.Authorization ||
    (req.headers?.get ? req.headers.get("authorization") : null) ||
    (req.headers?.get ? req.headers.get("Authorization") : null);

  if (!h) return null;
  const m = String(h).match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

function stableHash(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "method_not_allowed" });

  try {
    const url = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const anonKey = process.env.SUPABASE_ANON_KEY;

    if (!url || !serviceKey || !anonKey) {
      return json(res, 500, {
        error: "missing_env",
        detail: "Need SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY",
      });
    }

    const token = getBearer(req);
    if (!token) return json(res, 401, { error: "missing_auth" });

    const supabaseAdmin = createClient(url, serviceKey, { auth: { persistSession: false } });
    const supabaseAuth = createClient(url, anonKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    });

    // Verify JWT with Supabase
    const { data: userData, error: userErr } = await supabaseAuth.auth.getUser();
    if (userErr || !userData?.user?.id) {
      return json(res, 401, { error: "invalid_auth" });
    }
    const user_id = userData.user.id;

    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});

    // Accept both formats:
    // NEW: { experiment_key, track, variant_id, event_name, properties, session_id, idempotency_key, value }
    // OLD: { experiment_key, track, variant_id, metric_key, value }
    const experiment_key = body.experiment_key;
    const track = body.track;
    const variant_id = body.variant_id;

    const event_name = body.event_name || body.metric_key;

    // Fix B: always preserve numeric value if provided
    let properties = body.properties || {};
    if (properties && typeof properties === "object") {
      if (body.value !== undefined && properties.value === undefined) {
        properties.value = body.value;
      }
    }

    if (!experiment_key) return json(res, 400, { error: "missing_experiment_key" });
    if (!track) return json(res, 400, { error: "missing_track" });
    if (!variant_id) return json(res, 400, { error: "missing_variant_id" });
    if (!event_name) return json(res, 400, { error: "missing_event_name" });

    // Resolve experiment_id by (experiment_key, track) — and enforce status/killswitch later in Step 8
    const { data: exp, error: expErr } = await supabaseAdmin
      .from("ab_experiments")
      .select("id")
      .eq("experiment_key", experiment_key)
      .eq("track", track)
      .maybeSingle();

    if (expErr) return json(res, 500, { error: "experiment_lookup_failed" });
    if (!exp?.id) return json(res, 404, { error: "experiment_not_found" });

    const experiment_id = exp.id;

    // Validate variant belongs to this experiment
    const { data: vrow, error: vErr } = await supabaseAdmin
      .from("ab_variants")
      .select("id")
      .eq("id", variant_id)
      .eq("experiment_id", experiment_id)
      .maybeSingle();

    if (vErr) return json(res, 500, { error: "variant_lookup_failed" });
    if (!vrow?.id) {
      return json(res, 400, { error: "missing_variant", detail: "variant_id does not belong to (experiment_key, track)" });
    }

    const session_id = body.session_id || null;

    // Idempotency key
    const idem =
      body.idempotency_key ||
      stableHash([
        experiment_id,
        variant_id,
        user_id,
        track,
        event_name,
        JSON.stringify(properties),
        session_id || "",
        new Date().toISOString().slice(0, 16),
      ].join("|"));

    const row = {
      experiment_id,
      variant_id,
      user_id,
      track,
      session_id,
      event_name,
      properties,
      idempotency_key: idem,
      occurred_at: new Date().toISOString(),
    };

    const { error: insErr } = await supabaseAdmin.from("ab_metric_events").insert(row);

    if (insErr) {
      const msg = String(insErr.message || "").toLowerCase();

      // Enterprise idempotency: treat duplicates as success
      if (msg.includes("duplicate key") || msg.includes("unique constraint")) {
        return json(res, 200, {
          ok: true,
          deduped: true,
          result: { experiment_id, variant_id, track, event_name, user_id, idempotency_key: idem },
        });
      }

      return json(res, 500, { ok: false, error: "insert_failed" });
    }

    return json(res, 200, {
      ok: true,
      result: { experiment_id, variant_id, track, event_name, user_id, idempotency_key: idem },
    });
  } catch (e) {
    return json(res, 500, { error: "server_error" });
  }
}