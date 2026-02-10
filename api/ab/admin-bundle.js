// api/ab/admin-bundle.js
// Vercel Function (Node) — returns admin AB experiment bundle (no Next.js imports)

import { createClient } from "@supabase/supabase-js";

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "method_not_allowed" });

  try {
    const { experiment_key, track = null, days = 14 } = req.body || {};
    if (!experiment_key) return json(res, 400, { error: "missing_experiment_key" });

    const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL) return json(res, 500, { error: "missing_SUPABASE_URL" });
    if (!SERVICE_ROLE) return json(res, 500, { error: "missing_SUPABASE_SERVICE_ROLE_KEY" });

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
      auth: { persistSession: false },
    });

    // --- Fetch experiment definition (active variant list + ramp, etc.)
    // Expected table name: public.ab_experiments (adjust if yours differs)
    const expQ = supabase
      .from("ab_experiments")
      .select("*")
      .eq("experiment_key", experiment_key)
      .limit(1)
      .single();

    const { data: experiment, error: expErr } = await expQ;
    if (expErr || !experiment) return json(res, 404, { error: "experiment_not_found" });

    // --- Fetch recent variant stats (optional)
    // Expected table name: public.ab_events (adjust if yours differs)
    const since = new Date(Date.now() - Math.max(1, Number(days)) * 86400000).toISOString();

    let eventsQ = supabase
      .from("ab_events")
      .select("variant, event_type, created_at")
      .eq("experiment_key", experiment_key)
      .gte("created_at", since);

    if (track === "regular" || track === "olympiad") {
      eventsQ = eventsQ.eq("track", track);
    }

    const { data: events, error: evErr } = await eventsQ;
    if (evErr) return json(res, 500, { error: "events_query_failed", details: evErr.message });

    // Aggregate light stats
    const totals = {};
    for (const e of events || []) {
      const v = e.variant || "unknown";
      if (!totals[v]) totals[v] = { events: 0 };
      totals[v].events += 1;
    }

    return json(res, 200, {
      ok: true,
      experiment_key,
      track,
      days,
      experiment,
      totals,
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    return json(res, 500, { error: "server_error", details: String(err?.message || err) });
  }
}