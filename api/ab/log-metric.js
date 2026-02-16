import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

function bad(msg, code = 400) {
  return new Response(JSON.stringify({ ok: false, error: msg }), {
    status: code,
    headers: { "content-type": "application/json" },
  });
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.status(405).json({ ok: false, error: "method_not_allowed" });
      return;
    }

    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;

    // Accept either:
    // A) experiment_key + track
    // B) experiment_id directly
    const experiment_key = body.experiment_key || null;
    const experiment_id_input = body.experiment_id || null;
    const track = body.track || null;

    // Metric/event name
    const event_name = body.event_name || body.metric_key || null;

    // Variant: allow variant_id, otherwise allow variant_key
    const variant_id_input = body.variant_id || null;
    const variant_key = body.variant_key || null;

    // Value stored in properties
    const value = body.value ?? 1;

    // Optional extra dimensions
    const user_id = body.user_id || null;
    const session_id = body.session_id || null;
    const occurred_at = body.occurred_at || new Date().toISOString();

    if (!event_name) return res.status(400).json({ ok: false, error: "missing_event_name" });

    // Resolve experiment_id
    let experiment_id = experiment_id_input;

    if (!experiment_id) {
      if (!experiment_key) return res.status(400).json({ ok: false, error: "missing_experiment_key" });
      if (!track) return res.status(400).json({ ok: false, error: "missing_track" });

      const { data: exp, error: expErr } = await supabase
        .from("ab_experiments")
        .select("id")
        .eq("experiment_key", experiment_key)
        .eq("track", track)
        .maybeSingle();

      if (expErr) return res.status(500).json({ ok: false, error: "experiment_lookup_failed", detail: expErr.message });
      if (!exp?.id) return res.status(404).json({ ok: false, error: "experiment_not_found" });

      experiment_id = exp.id;
    }

    // Resolve variant_id (optional but recommended)
    let variant_id = variant_id_input;

    if (!variant_id && variant_key) {
      const { data: v, error: vErr } = await supabase
        .from("ab_variants")
        .select("id")
        .eq("experiment_id", experiment_id)
        .eq("variant_key", variant_key)
        .maybeSingle();

      if (vErr) return res.status(500).json({ ok: false, error: "variant_lookup_failed", detail: vErr.message });
      if (!v?.id) return res.status(404).json({ ok: false, error: "variant_not_found" });

      variant_id = v.id;
    }

    // If caller sent neither variant_id nor variant_key, we allow logging at experiment level
    // But if they sent variant_id/variant_key and it couldn't be resolved, we already returned error above.

    // Idempotency key (stable per event instance)
    const idempotency_key =
      body.idempotency_key ||
      `${experiment_id}:${track || "na"}:${variant_id || "na"}:${event_name}:${session_id || "na"}:${user_id || "na"}:${occurred_at}`;

    const properties = {
      value,
      ...(body.properties || {}),
    };

    const insertRow = {
      experiment_id,
      variant_id: variant_id || null,
      user_id,
      track: track || body.track || null,
      session_id,
      event_name,
      occurred_at,
      idempotency_key,
      properties,
    };

    const { data: ins, error: insErr } = await supabase
      .from("ab_metric_events")
      .insert(insertRow)
      .select("id")
      .maybeSingle();

    if (insErr) {
      // If you later add a unique constraint on idempotency_key, you can treat conflicts as ok.
      return res.status(500).json({ ok: false, error: "insert_failed", detail: insErr.message });
    }

    res.status(200).json({ ok: true, result: { id: ins?.id, experiment_id, variant_id, event_name } });
  } catch (e) {
    res.status(500).json({ ok: false, error: "server_error", detail: String(e?.message || e) });
  }
}