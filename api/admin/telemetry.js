const { createClient } = require("@supabase/supabase-js");

function getBearer(req) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

function sbForJwt(jwt) {
  const SUPABASE_URL =
    process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const SUPABASE_ANON_KEY =
    process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error("missing_supabase_env");
  }

  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false },
  });
}

async function requireAdmin(supabase) {
  const gate = await supabase.rpc("ab_require_admin", {});
  if (gate.error) throw new Error(gate.error.message || "admin_required");
}

function getType(req) {
  return String(req.query.type || "summary").trim().toLowerCase();
}

function jsonOk(res, payload) {
  return res.status(200).json({ ok: true, ...payload });
}

function jsonErr(res, status, code, details) {
  return res.status(status).json({ ok: false, error: code, details });
}

function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function inferSource(metadata = {}) {
  return (
    metadata.source ||
    metadata.endpoint ||
    metadata.provider ||
    metadata.monitor_name ||
    metadata.request_type ||
    "system"
  );
}

function summarizeBoundary(metadata = {}) {
  return {
    user_id: metadata.user_id || null,
    track: metadata.track || null,
    attempted_track: metadata.attempted_track || null,
    endpoint: metadata.endpoint || null,
    reason: metadata.reason || null,
    request_id: metadata.request_id || null,
  };
}

async function handleSummary(supabase) {
  const { data, error } = await supabase
    .from("v_platform_health_live")
    .select("*")
    .limit(1)
    .single();

  if (error) throw error;

  return { result: data || {} };
}

async function handleAlerts(supabase, severity) {
  let q = supabase
    .from("alert_log")
    .select("created_at, alert_type, severity, message, metadata, resolved_at")
    .order("created_at", { ascending: false })
    .limit(50);

  if (severity && severity !== "all") {
    q = q.eq("severity", severity);
  }

  const { data, error } = await q;
  if (error) throw error;

  const rows = (data || []).map((r) => ({
    created_at: r.created_at,
    alert_type: r.alert_type,
    severity: r.severity,
    message: r.message || "",
    source: inferSource(r.metadata || {}),
    metadata: r.metadata || {},
    resolved_at: r.resolved_at || null,
  }));

  return { rows };
}

async function handleBoundary(supabase) {
  const { data, error } = await supabase
    .from("alert_log")
    .select("created_at, alert_type, severity, message, metadata, resolved_at")
    .eq("alert_type", "boundary_violation")
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) throw error;

  const rows = (data || []).map((r) => ({
    created_at: r.created_at,
    alert_type: r.alert_type,
    severity: r.severity,
    message: r.message || "",
    ...summarizeBoundary(r.metadata || {}),
    resolved_at: r.resolved_at || null,
    metadata: r.metadata || {},
  }));

  return { rows };
}

async function handleCosts(supabase) {
  const { data, error } = await supabase
    .from("ai_cost_ledger")
    .select("model_id, request_type, track, tier, cost_usd, latency_ms, created_at")
    .order("created_at", { ascending: false })
    .limit(250);

  if (error) throw error;

  const grouped = new Map();

  for (const r of data || []) {
    const key = [
      r.model_id || "unknown",
      r.request_type || "unknown",
      r.track || "unknown",
      r.tier || "unknown",
    ].join("|");

    const cur = grouped.get(key) || {
      model_id: r.model_id || "unknown",
      request_type: r.request_type || "unknown",
      track: r.track || "unknown",
      tier: r.tier || "unknown",
      calls: 0,
      total_cost_usd: 0,
      total_latency_ms: 0,
    };

    cur.calls += 1;
    cur.total_cost_usd += safeNum(r.cost_usd);
    cur.total_latency_ms += safeNum(r.latency_ms);
    grouped.set(key, cur);
  }

  const rows = Array.from(grouped.values()).map((r) => ({
    ...r,
    avg_latency_ms: r.calls ? r.total_latency_ms / r.calls : 0,
  }));

  rows.sort((a, b) => b.total_cost_usd - a.total_cost_usd);

  return { rows };
}

async function handleProviders(supabase) {
  const { data, error } = await supabase
    .from("alert_log")
    .select("created_at, alert_type, severity, message, metadata")
    .in("alert_type", [
      "ai_provider_failover",
      "ai_latency_high",
      "ai_error_spike",
      "circuit_breaker_tripped",
      "circuit_breaker_recovered",
    ])
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) throw error;

  const state = new Map();

  for (const row of data || []) {
    const metadata = row.metadata || {};
    const provider = metadata.provider || metadata.fallback_provider || "unknown";

    if (!state.has(provider)) {
      state.set(provider, {
        provider,
        breaker_state: "closed",
        fallback_active: false,
        p95_latency_ms: 0,
        error_rate: 0,
        last_event_at: row.created_at,
        last_alert_type: row.alert_type,
        last_message: row.message || "",
      });
    }

    const s = state.get(provider);

    if (!s.last_event_at || row.created_at > s.last_event_at) {
      s.last_event_at = row.created_at;
      s.last_alert_type = row.alert_type;
      s.last_message = row.message || "";
    }

    if (
      row.alert_type === "ai_provider_failover" ||
      row.alert_type === "circuit_breaker_tripped"
    ) {
      s.breaker_state = "open";
      s.fallback_active = true;
    }

    if (row.alert_type === "circuit_breaker_recovered") {
      s.breaker_state = "closed";
      s.fallback_active = false;
    }

    if (row.alert_type === "ai_latency_high") {
      s.p95_latency_ms = safeNum(metadata.p95_latency_ms);
    }

    if (row.alert_type === "ai_error_spike") {
      s.error_rate = safeNum(metadata.error_rate);
    }
  }

  return { rows: Array.from(state.values()) };
}

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    return jsonErr(res, 405, "method_not_allowed", null);
  }

  const jwt = getBearer(req);
  if (!jwt) {
    return jsonErr(res, 401, "missing_bearer_token", null);
  }

  const type = getType(req);
  const severity = String(req.query.severity || "all").trim().toLowerCase();

  try {
    const supabase = sbForJwt(jwt);
    await requireAdmin(supabase);

    switch (type) {
      case "summary":
        return jsonOk(res, await handleSummary(supabase));

      case "alerts":
        return jsonOk(res, await handleAlerts(supabase, severity));

      case "boundary":
        return jsonOk(res, await handleBoundary(supabase));

      case "costs":
        return jsonOk(res, await handleCosts(supabase));

      case "providers":
        return jsonOk(res, await handleProviders(supabase));

      default:
        return jsonErr(res, 400, "invalid_telemetry_type", `Unsupported type: ${type}`);
    }
  } catch (err) {
    return jsonErr(res, 403, "telemetry_failed", err.message || String(err));
  }
};