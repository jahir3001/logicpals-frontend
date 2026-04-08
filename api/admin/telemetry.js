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
    .select("id,created_at, alert_type, severity, message, metadata, resolved_at")
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

async function upsertAutomationWatchdogRuntimeState(userSb, payload = {}) {
  return await rpcOrThrow(userSb, "rpc_upsert_automation_watchdog_runtime_state", {
    p_automation_key: payload.automation_key || "escalation_automation",
    p_automation_enabled: payload.automation_enabled ?? null,
    p_cron_enabled: payload.cron_enabled ?? null,
    p_last_cron_seen_at: payload.last_cron_seen_at ?? null,
    p_reported_backlog_count: payload.reported_backlog_count ?? null,
    p_last_run_id: payload.last_run_id ?? null,
    p_last_run_started_at: payload.last_run_started_at ?? null,
    p_last_run_finished_at: payload.last_run_finished_at ?? null,
    p_last_run_status: payload.last_run_status ?? null,
    p_last_run_error_count: payload.last_run_error_count ?? null,
    p_source: payload.source || "telemetry",
    p_updated_by: payload.updated_by ?? null
  });
}

async function evalAutomationWatchdog(userSb, triggerSource = "telemetry") {
  return await rpcOrThrow(userSb, "rpc_eval_automation_watchdog", {
    p_automation_key: "escalation_automation",
    p_trigger_source: triggerSource
  });
}

async function handleAutomationWatchdog(userSb) {
  const { data, error } = await userSb
    .from("v_automation_watchdog_health")
    .select("*")
    .eq("automation_key", "escalation_automation")
    .maybeSingle();

  if (error) throw error;
  return data || {};
}

async function handleMonitoringAction(userSb, body, action) {
  switch (action) {
    case "monitoring_dashboard_bundle":
      return { result: await rpcOrThrow(userSb, "admin_monitoring_dashboard_bundle") };

    case "monitoring_evaluate_alerts":
      return { result: await rpcOrThrow(userSb, "internal_monitoring_evaluate_alerts") };

	    case "system_health_score_run":
      return {
        result: await rpcOrThrow(userSb, "rpc_compute_system_health_score", {
          p_trigger_source: String(body.trigger_source || "admin").trim().toLowerCase(),
        }),
      };

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

	    case "evaluate_auto_protection":
      return {
        result: await rpcOrThrow(userSb, "rpc_evaluate_auto_protection_rules", {
          p_trigger_source: String(body.trigger_source || "admin").trim().toLowerCase(),
          p_created_by: body.created_by || null,
        }),
      };

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

async function handleIncidentAction(userSb, body, action) {
  switch (action) {
    case "incident_acknowledge": {
      const incidentId = String(body.incident_id || "").trim();
      if (!incidentId) {
        throw new Error("missing_incident_id");
      }

      return {
        result: await rpcOrThrow(userSb, "admin_incident_acknowledge", {
          p_incident_id: incidentId,
        }),
      };
    }

    case "incident_resolve": {
      const incidentId = String(body.incident_id || "").trim();
      if (!incidentId) {
        throw new Error("missing_incident_id");
      }

      return {
        result: await rpcOrThrow(userSb, "admin_incident_resolve", {
          p_incident_id: incidentId,
        }),
      };
    }

    case "incident_add_note": {
      const incidentId = String(body.incident_id || "").trim();
      const message = String(body.message || "").trim();

      if (!incidentId) {
        throw new Error("missing_incident_id");
      }
      if (!message) {
        throw new Error("missing_note_message");
      }
      if (message.length > 4000) {
        throw new Error("note_message_too_long");
      }

      return {
        result: await rpcOrThrow(userSb, "admin_incident_add_note", {
          p_incident_id: incidentId,
          p_message: message,
        }),
      };
    }

    case "monitoring_sync_incidents":
      return {
        result: await rpcOrThrow(userSb, "admin_monitoring_sync_incidents"),
      };

    default:
      throw new Error(`unsupported_incident_action:${action || "unknown"}`);
  }
}

async function handleIncidents(supabase, statusFilter) {
  let q = supabase
    .from("incidents")
    .select(`
      id,
      incident_key,
      title,
      source,
      severity,
      status,
      summary,
      first_seen_at,
      last_seen_at,
      acknowledged_at,
      acknowledged_by,
      resolved_at,
      resolved_by,
      auto_opened,
      metadata,
      created_at,
      updated_at
    `)
    .order("updated_at", { ascending: false })
    .limit(100);

  const normalizedStatus = String(statusFilter || "open")
    .trim()
    .toLowerCase();

  if (normalizedStatus === "open") {
    q = q.in("status", ["open", "acknowledged"]);
  } else if (normalizedStatus === "resolved") {
    q = q.eq("status", "resolved");
  } else if (normalizedStatus !== "all") {
    q = q.eq("status", normalizedStatus);
  }

  const { data, error } = await q;
  if (error) throw error;

  const rows = (data || []).map((r) => ({
    id: r.id,
    incident_key: r.incident_key,
    title: r.title || "",
    source: r.source || "system",
    severity: r.severity || "warning",
    status: r.status || "open",
    summary: r.summary || "",
    first_seen_at: r.first_seen_at || null,
    last_seen_at: r.last_seen_at || null,
    acknowledged_at: r.acknowledged_at || null,
    acknowledged_by: r.acknowledged_by || null,
    resolved_at: r.resolved_at || null,
    resolved_by: r.resolved_by || null,
    auto_opened: !!r.auto_opened,
    metadata: r.metadata || {},
    created_at: r.created_at || null,
    updated_at: r.updated_at || null,
  }));

  return { rows };
}


async function handleIncidentEvents(supabase, incidentId) {
  const id = String(incidentId || "").trim();
  if (!id) throw new Error("missing_incident_id");

  const { data, error } = await supabase
    .from("incident_events")
    .select(`
      incident_id,
      event_type,
      actor_type,
      actor_user_id,
      message,
      metadata,
      occurred_at
    `)
    .eq("incident_id", id)
    .order("occurred_at", { ascending: false })
    .limit(100);

  if (error) throw error;

  return {
    rows: (data || []).map((r) => ({
      incident_id: r.incident_id,
      event_type: r.event_type || "incident_note",
      actor_type: r.actor_type || "system",
      actor_user_id: r.actor_user_id || null,
      message: r.message || "",
      metadata: r.metadata || {},
      occurred_at: r.occurred_at || null,
    })),
  };
}

async function handleNotificationTargets(supabase) {
  const { data, error } = await supabase
    .from("v_notification_targets_active")
    .select(`
      id,
      target_key,
      channel,
      name,
      destination,
      enabled,
      severity_filter,
      source_filter,
      is_default,
      metadata,
      created_at,
      updated_at
    `)
    .order("channel", { ascending: true })
    .order("target_key", { ascending: true });

  if (error) throw error;

  return {
    rows: (data || []).map((r) => ({
      id: r.id,
      target_key: r.target_key || "",
      channel: r.channel || "dashboard",
      name: r.name || "",
      destination: r.destination || "",
      enabled: !!r.enabled,
      severity_filter: Array.isArray(r.severity_filter) ? r.severity_filter : [],
      source_filter: Array.isArray(r.source_filter) ? r.source_filter : [],
      is_default: !!r.is_default,
      metadata: r.metadata || {},
      created_at: r.created_at || null,
      updated_at: r.updated_at || null,
    })),
  };
}

async function handleNotificationLogRecent(supabase) {
  const { data, error } = await supabase
    .from("v_notification_log_recent")
    .select(`
      id,
      incident_id,
      incident_key,
      incident_title,
      alert_rule_id,
      rule_key,
      channel,
      target,
      status,
      attempted_at,
      delivered_at,
      error_message,
      payload
    `)
    .order("attempted_at", { ascending: false })
    .limit(100);

  if (error) throw error;

  return {
    rows: (data || []).map((r) => ({
      id: r.id,
      incident_id: r.incident_id || null,
      incident_key: r.incident_key || null,
      incident_title: r.incident_title || null,
      alert_rule_id: r.alert_rule_id || null,
      rule_key: r.rule_key || null,
      channel: r.channel || "dashboard",
      target: r.target || "",
      status: r.status || "queued",
      attempted_at: r.attempted_at || null,
      delivered_at: r.delivered_at || null,
      error_message: r.error_message || null,
      payload: r.payload || {},
    })),
  };
}

function isUuid(v) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(v || "").trim()
  );
}

function safePositiveInt(v, fallback, max = 500) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

async function handleSystemHealthScoreLatest(supabase) {
  const { data, error } = await supabase
    .from("v_system_health_score_latest")
    .select("*")
    .limit(1)
    .single();

  if (error) throw error;
  return data || {};
}

async function handleSystemHealthScoreRecent(supabase, limit = 50) {
  const safeLimit = safePositiveInt(limit, 20, 100);

  const { data, error } = await supabase
    .from("v_system_health_score_recent")
    .select("*")
    .order("score_at", { ascending: false })
    .limit(safeLimit);

  if (error) throw error;
  return { rows: data || [] };
}

async function handleAutoProtectionRules(supabase) {
  const { data, error } = await supabase
    .from("v_auto_protection_rules_active")
    .select("*")
    .order("rule_key", { ascending: true });

  if (error) throw error;
  return { rows: data || [] };
}

async function handleAutoProtectionActionLogLatestByRule(supabase) {
  const { data, error } = await supabase
    .from("v_auto_protection_action_log_latest_by_rule")
    .select("*")
    .order("rule_key", { ascending: true });

  if (error) throw error;
  return { rows: data || [] };
}

async function handleAutoProtectionActionLogRecent(supabase, limit = 50) {
  const safeLimit = safePositiveInt(limit, 20, 100);

  const { data, error } = await supabase
    .from("v_auto_protection_action_log_recent")
    .select("*")
    .order("occurred_at", { ascending: false })
    .limit(safeLimit);

  if (error) throw error;
  return { rows: data || [] };
}

async function handleAutoProtectionOpsSummary(supabase) {
  const { data, error } = await supabase
    .from("v_auto_protection_ops_summary")
    .select("*")
    .limit(1)
    .single();

  if (error) throw error;
  return data || {};
}

async function handleEscalationRules(supabase) {
  const { data, error } = await supabase
    .from("incident_escalation_rules")
    .select(`
      id,
      rule_key,
      name,
      description,
      enabled,
      severity,
      source_filter,
      trigger_mode,
      trigger_threshold_minutes,
      notification_target_id,
      dispatch_notifications,
      add_timeline_event,
      cooldown_minutes,
      max_escalations_per_incident,
      created_at,
      updated_at
    `)
    .order("rule_key", { ascending: true })
    .limit(100);

  if (error) throw error;

  return {
    rows: (data || []).map((r) => ({
      id: r.id,
      rule_key: r.rule_key || "",
      name: r.name || "",
      description: r.description || "",
      enabled: !!r.enabled,
      severity: r.severity || null,
      source_filter: Array.isArray(r.source_filter) ? r.source_filter : [],
      trigger_mode: r.trigger_mode || null,
      trigger_threshold_minutes: safeNum(r.trigger_threshold_minutes),
      notification_target_id: r.notification_target_id || null,
      dispatch_notifications: !!r.dispatch_notifications,
      add_timeline_event: !!r.add_timeline_event,
      cooldown_minutes: safeNum(r.cooldown_minutes),
      max_escalations_per_incident: safeNum(r.max_escalations_per_incident),
      created_at: r.created_at || null,
      updated_at: r.updated_at || null,
    })),
  };
}

async function handleEscalationLogRecent(supabase, incidentId) {
  let q = supabase
    .from("incident_escalation_log")
    .select(`
      id,
      incident_id,
      escalation_rule_id,
      action,
      decision,
      escalation_number,
      incident_status,
      incident_severity,
      notification_log_id,
      message,
      metadata,
      occurred_at
    `)
    .order("occurred_at", { ascending: false })
    .limit(100);

  const id = String(incidentId || "").trim();
  if (id) {
    if (!isUuid(id)) {
      throw new Error("invalid_incident_id");
    }
    q = q.eq("incident_id", id);
  }

  const { data, error } = await q;
  if (error) throw error;

  return {
    rows: (data || []).map((r) => ({
      id: r.id,
      incident_id: r.incident_id || null,
      escalation_rule_id: r.escalation_rule_id || null,
      action: r.action || "",
      decision: r.decision || "",
      escalation_number: safeNum(r.escalation_number),
      incident_status: r.incident_status || "",
      incident_severity: r.incident_severity || "",
      notification_log_id: r.notification_log_id || null,
      message: r.message || "",
      metadata: r.metadata || {},
      occurred_at: r.occurred_at || null,
    })),
  };
}

async function handleEscalationState(supabase, incidentId) {
  let q = supabase
    .from("incident_escalation_state")
    .select(`
      id,
      incident_id,
      escalation_rule_id,
      escalation_count,
      cooldown_until,
      last_decision,
      last_checked_at,
      created_at,
      updated_at
    `)
    .order("updated_at", { ascending: false })
    .limit(100);

  const id = String(incidentId || "").trim();
  if (id) {
    if (!isUuid(id)) {
      throw new Error("invalid_incident_id");
    }
    q = q.eq("incident_id", id);
  }

  const { data, error } = await q;
  if (error) throw error;

  return {
    rows: (data || []).map((r) => ({
      id: r.id,
      incident_id: r.incident_id || null,
      escalation_rule_id: r.escalation_rule_id || null,
      escalation_count: safeNum(r.escalation_count),
      cooldown_until: r.cooldown_until || null,
      last_decision: r.last_decision || "",
      last_checked_at: r.last_checked_at || null,
      created_at: r.created_at || null,
      updated_at: r.updated_at || null,
    })),
  };
}

async function handleEscalationRunDashboard(supabase) {
  const data = await rpcOrThrow(supabase, "admin_incident_escalation_run_dashboard");
  return data || { ok: true, latest: {}, runs: [] };
}

async function handleEscalationAction(userSb, body, action) {
  switch (action) {
    case "evaluate_incident_escalation": {
      const incidentId = String(body.incident_id || "").trim();
      const ruleId = String(body.rule_id || "").trim();

      if (!incidentId) {
        throw new Error("missing_incident_id");
      }
      if (!ruleId) {
        throw new Error("missing_rule_id");
      }
      if (!isUuid(incidentId)) {
        throw new Error("invalid_incident_id");
      }
      if (!isUuid(ruleId)) {
        throw new Error("invalid_rule_id");
      }

      return {
        result: await rpcOrThrow(userSb, "admin_evaluate_incident_escalation", {
          p_incident_id: incidentId,
          p_rule_id: ruleId,
        }),
      };
    }

    case "execute_incident_escalation": {
      const incidentId = String(body.incident_id || "").trim();
      const ruleId = String(body.rule_id || "").trim();

      if (!incidentId) {
        throw new Error("missing_incident_id");
      }
      if (!ruleId) {
        throw new Error("missing_rule_id");
      }
      if (!isUuid(incidentId)) {
        throw new Error("invalid_incident_id");
      }
      if (!isUuid(ruleId)) {
        throw new Error("invalid_rule_id");
      }

      return {
        result: await rpcOrThrow(userSb, "admin_execute_incident_escalation", {
          p_incident_id: incidentId,
          p_rule_id: ruleId,
        }),
      };
    }

    case "evaluate_open_incident_escalations": {
      return {
        result: await rpcOrThrow(
          userSb,
          "admin_evaluate_open_incident_escalations"
        ),
      };
    }
    case "run_open_incident_escalations": {
      return {
        result: await rpcOrThrow(
          userSb,
          "admin_run_open_incident_escalations"
        ),
      };
    }

    default:
      throw new Error(`unsupported_escalation_action:${action || "unknown"}`);
  }
}

async function handleNotificationAction(userSb, body, action) {
  switch (action) {
    case "send_test_notification": {
      const targetKey = String(body.target_key || "").trim();
      const message = String(body.message || "LogicPals test notification").trim();
      const channel = String(body.channel || "").trim() || null;

      if (!targetKey) {
        throw new Error("missing_target_key");
      }
      if (!message) {
        throw new Error("missing_notification_message");
      }
      if (message.length > 4000) {
        throw new Error("notification_message_too_long");
      }

      return {
        result: await rpcOrThrow(userSb, "admin_send_test_notification", {
          p_target_key: targetKey,
          p_message: message,
          p_channel: channel,
        }),
      };
    }

    case "dispatch_incident_notifications": {
      const incidentId = String(body.incident_id || "").trim();
      if (!incidentId) {
        throw new Error("missing_incident_id");
      }

      return {
        result: await rpcOrThrow(userSb, "admin_dispatch_incident_notifications", {
          p_incident_id: incidentId,
        }),
      };
    }

    default:
      throw new Error(`unsupported_notification_action:${action || "unknown"}`);
  }
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
      if (
        action === "incident_acknowledge" ||
        action === "incident_resolve" ||
        action === "incident_add_note" ||
        action === "monitoring_sync_incidents"
      ) {
        const payload = await handleIncidentAction(userSb, body, action);
        return jsonOk(res, payload);
      }

      if (
        action === "send_test_notification" ||
        action === "dispatch_incident_notifications"
      ) {
        const payload = await handleNotificationAction(userSb, body, action);
        return jsonOk(res, payload);
      }

            if (
        action === "evaluate_incident_escalation" ||
        action === "execute_incident_escalation" ||
        action === "evaluate_open_incident_escalations" ||
        action === "run_open_incident_escalations"
      ) {
        const payload = await handleEscalationAction(userSb, body, action);
        return jsonOk(res, payload);
      }

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

  case "system_health_score":
    return jsonOk(res, await handleSystemHealthScoreLatest(userSb));

  case "system_health_score_recent":
    return jsonOk(
      res,
      await handleSystemHealthScoreRecent(
        userSb,
        req.query.limit || body.limit || 20
      )
    );

	case "auto_protection_circuit_state":
  return jsonOk(res, await handleAutoProtectionCircuitState(userSb));

case "auto_protection_failures":
  return jsonOk(res, await handleAutoProtectionFailures(userSb));

case "auto_protection_blocked_actions":
  return jsonOk(res, await handleAutoProtectionBlockedActions(userSb));

case "auto_protection_circuit_ops_summary":
  return jsonOk(res, await handleAutoProtectionCircuitOpsSummary(userSb));

  case "incidents":
    return jsonOk(
      res,
      await handleIncidents(
        userSb,
        String(req.query.incident_status || body.incident_status || "open")
          .trim()
          .toLowerCase()
      )
    );

  case "incident_events":
    return jsonOk(
      res,
      await handleIncidentEvents(
        userSb,
        String(req.query.incident_id || body.incident_id || "").trim()
      )
    );
	case "notification_targets":
 	  return jsonOk(res, await handleNotificationTargets(userSb));

	case "notification_log_recent":
  	  return jsonOk(res, await handleNotificationLogRecent(userSb));

    case "escalation_rules":
      return jsonOk(res, await handleEscalationRules(userSb));

    case "escalation_log_recent":
      return jsonOk(
        res,
        await handleEscalationLogRecent(
          userSb,
          String(req.query.incident_id || body.incident_id || "").trim()
        )
      );

    case "escalation_state":
      return jsonOk(
        res,
        await handleEscalationState(
          userSb,
          String(req.query.incident_id || body.incident_id || "").trim()
        )
      );
  case "escalation_run_dashboard":
      return jsonOk(res, await handleEscalationRunDashboard(userSb));

     case "automation_watchdog":
  return jsonOk(res, await handleAutomationWatchdog(userSb));

  case "auto_protection_rules":
    return jsonOk(res, await handleAutoProtectionRules(userSb));

  case "auto_protection_action_log_recent":
    return jsonOk(
      res,
      await handleAutoProtectionActionLogRecent(
        userSb,
        req.query.limit || body.limit || 20
      )
    );

case "auto_protection_ops_summary":
  return jsonOk(res, await handleAutoProtectionOpsSummary(userSb));

case "automation_watchdog_run":
  return jsonOk(res, {
    result: await evalAutomationWatchdog(userSb, "admin")
  });

case "automation_watchdog_heartbeat": {
  const payload = {
    automation_key: "escalation_automation",
    automation_enabled: true,
    cron_enabled: true,
    last_cron_seen_at: new Date().toISOString(),
    source: "admin_heartbeat"
  };

  await upsertAutomationWatchdogRuntimeState(userSb, payload);

  return jsonOk(res, {
    result: await evalAutomationWatchdog(userSb, "heartbeat")
  });
}

case "auto_protection_action_log_latest_by_rule":
  return jsonOk(res, await handleAutoProtectionActionLogLatestByRule(userSb));

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
          : [
              "missing_incident_id",
              "missing_note_message",
              "note_message_too_long",
              "missing_alert_id",
              "missing_target_key",
              "missing_notification_message",
              "notification_message_too_long",
              "notification_channel_mismatch",
              "invalid_notification_channel",
              "invalid_notification_status",
              "missing_rule_id",
              "invalid_incident_id",
              "invalid_rule_id",
              "invalid_escalation_limit",
            ].includes(message)
            ? 400
            : /not_found/i.test(message)
              ? 404
              : 500;

    return jsonErr(res, status, "telemetry_failed", message);
  }
};