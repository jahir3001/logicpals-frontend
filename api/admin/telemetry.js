const { createClient } = require("@supabase/supabase-js");

function getBearer(req) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

function getSupabaseEnv() {
  const SUPABASE_URL =
    process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const SUPABASE_ANON_KEY =
    process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error("missing_supabase_env");
  }

  return {
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY,
  };
}

function sbForJwt(jwt) {
  const { SUPABASE_URL, SUPABASE_ANON_KEY } = getSupabaseEnv();

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
  return String(req.query.type || req.body?.type || "summary")
    .trim()
    .toLowerCase();
}

function getAction(req) {
  return String(req.query.action || req.body?.action || "")
    .trim()
    .toLowerCase();
}

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch (_) {
      return {};
    }
  }
  if (typeof req.body === "object") return req.body;
  return {};
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

  return data || {};
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

  const rows = (data || []).map((r) => {
  const metadata = r.metadata || {};
  const acknowledgedAt =
    metadata.acknowledged_at ||
    metadata.ack_at ||
    null;

  const status = r.resolved_at
    ? "resolved"
    : acknowledgedAt
      ? "acknowledged"
      : "open";

  return {
    id: r.id || metadata.alert_id || null,
    created_at: r.created_at,
    alert_type: r.alert_type,
    severity: r.severity,
    message: r.message || "",
    source: inferSource(metadata),
    metadata,
    acknowledged_at: acknowledgedAt,
    resolved_at: r.resolved_at || null,
    status,
  };
});

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

async function rpcOrThrow(supabase, fnName, params = {}) {
  const { data, error } = await supabase.rpc(fnName, params);
  if (error) throw error;
  return data;
}

async function handleMonitoringAction(userSb, body, action) {
  switch (action) {
    case "monitoring_dashboard_bundle":
      return { result: await rpcOrThrow(userSb, "admin_monitoring_dashboard_bundle") };

    case "monitoring_evaluate_alerts":
      return { result: await rpcOrThrow(userSb, "admin_monitoring_evaluate_alerts") };

    case "monitoring_ack_alert": {
      const alertId = String(body.alert_id || "").trim();
      if (!alertId) {
        throw new Error("missing_alert_id");
      }
      return {
        result: await rpcOrThrow(userSb, "admin_monitoring_ack_alert", {
          p_alert_id: alertId,
        }),
      };
    }

    case "monitoring_resolve_alert": {
      const alertId = String(body.alert_id || "").trim();
      if (!alertId) {
        throw new Error("missing_alert_id");
      }
      return {
        result: await rpcOrThrow(userSb, "admin_monitoring_resolve_alert", {
          p_alert_id: alertId,
        }),
      };
    }

    default:
      throw new Error(`unsupported_monitoring_action:${action || "unknown"}`);
  }
}

async function handleSystemHealth(supabase) {
  const { data, error } = await supabase
    .from("v_platform_health_live")
    .select("*")
    .limit(1)
    .single();

  if (error) throw error;

  const health = data || {};

  const services = [
    {
      key: "attempt_api",
      label: "Attempt API",
      status: health.attempt_api_status || "unknown",
      detail: health.attempt_api_detail || ""
    },
    {
      key: "ai_provider",
      label: "AI Provider",
      status: health.ai_provider_status || "unknown",
      detail: health.ai_provider_detail || ""
    },
    {
      key: "supabase",
      label: "Supabase",
      status: health.supabase_status || "unknown",
      detail: health.supabase_detail || ""
    },
    {
      key: "worker",
      label: "Worker",
      status: health.worker_status || "unknown",
      detail: health.worker_detail || ""
    },
    {
      key: "cron",
      label: "Cron",
      status: health.cron_status || "unknown",
      detail: health.cron_detail || ""
    },
    {
      key: "experiments",
      label: "Experiments",
      status: health.experiment_status || "unknown",
      detail: health.experiment_detail || ""
    }
  ];

  return { services };
}

module.exports = async (req, res) => {
  if (!["GET", "POST"].includes(req.method)) {
    return jsonErr(res, 405, "method_not_allowed", null);
  }

  const jwt = getBearer(req);
  if (!jwt) {
    return jsonErr(res, 401, "missing_bearer_token", null);
  }

  const body = parseBody(req);
  const type = getType(req);
  const action = getAction(req);
  const severity = String(req.query.severity || body.severity || "all")
    .trim()
    .toLowerCase();

  try {
    const userSb = sbForJwt(jwt);
    await requireAdmin(userSb);

    if (req.method === "POST") {
      const payload = await handleMonitoringAction(userSb, body, action);
      return jsonOk(res, payload);
    }

    switch (type) {
      case "summary":
        return jsonOk(res, await handleSummary(userSb));

      case "alerts":
        return jsonOk(res, await handleAlerts(userSb, severity));

      case "boundary":
        return jsonOk(res, await handleBoundary(userSb));

      case "costs":
        return jsonOk(res, await handleCosts(userSb));

      case "providers":
        return jsonOk(res, await handleProviders(userSb));

      case "monitoring":
        return jsonOk(res, {
          result: await rpcOrThrow(userSb, "admin_monitoring_dashboard_bundle"),
        });
      case "system_health":
 	 return jsonOk(res, await handleSystemHealth(userSb));

      default:
        return jsonErr(
          res,
          400,
          "invalid_telemetry_type",
          `Unsupported type: ${type}`
        );
    }
  } catch (err) {
    const message = err?.message || String(err);
    const status =
      message === "missing_bearer_token"
        ? 401
        : message === "admin_required" || /admin access required/i.test(message)
          ? 403
          : 400;

    return jsonErr(res, status, "telemetry_failed", message);
  }
};