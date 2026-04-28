/**
 * ============================================================================
 *  LogicPals Operations Platform — ops-gateway.js
 *  Path:          api/ops/ops-gateway.js
 *  Version:       ops_platform_v1.3.0 (Path C — 2026.04.19)
 *
 *  Path C tweaks vs v1.2.0:
 *    - Accepts tenant_uuid (uuid) instead of tenant_key (text)
 *    - tenant_uuid is REQUIRED on all tenanted operations
 *    - No hardcoded 'logicpals' default — admin client supplies UUID
 *      from bootstrap config
 * ============================================================================
 */

const { createClient } = require("@supabase/supabase-js");

/* ---------------------------------------------------------
   Environment
--------------------------------------------------------- */

function getSupabaseEnv() {
  const SUPABASE_URL =
    process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const SUPABASE_ANON_KEY =
    process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error("missing_supabase_env");
  }
  return { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY };
}

function sbForJwt(jwt) {
  const { SUPABASE_URL, SUPABASE_ANON_KEY } = getSupabaseEnv();
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function sbForService() {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = getSupabaseEnv();
  if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error("missing_service_role_key");
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/* ---------------------------------------------------------
   Helpers
--------------------------------------------------------- */

function getBearer(req) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); }
    catch (_) { return null; }
  }
  if (typeof req.body === "object") return req.body;
  return {};
}

function getAction(req, body) {
  return String(req.query.action || (body && body.action) || "").trim().toLowerCase();
}

function jsonOk(res, payload) {
  return res.status(200).json({ ok: true, ...payload });
}

function jsonErr(res, status, code, details) {
  return res.status(status).json({ ok: false, error: code, details });
}

function requireString(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`missing_${name}`);
  }
  return value.trim();
}

function optionalString(value) {
  if (value == null) return null;
  const s = String(value).trim();
  return s.length === 0 ? null : s;
}

function optionalInt(value, fallback) {
  if (value == null || value === "") return fallback;
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function optionalArray(value) {
  if (value == null || value === "") return null;
  if (Array.isArray(value)) return value.filter((v) => typeof v === "string" && v.length > 0);
  const arr = String(value).split(",").map((v) => v.trim()).filter((v) => v.length > 0);
  return arr.length === 0 ? null : arr;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUuid(value, name) {
  if (!value || typeof value !== "string" || !UUID_RE.test(value)) {
    throw new Error(`invalid_${name}`);
  }
  return value;
}

/**
 * Resolve tenant UUID from body or query. REQUIRED.
 * Path C: no default tenant. Caller must supply.
 */
function resolveTenantUuid(body, queryParams) {
  const fromBody  = optionalString(body?.tenant_uuid);
  const fromQuery = optionalString(queryParams?.tenant_uuid);
  const tenantUuid = fromBody || fromQuery;
  if (!tenantUuid) throw new Error("missing_tenant_uuid");
  return requireUuid(tenantUuid, "tenant_uuid");
}

function resolveWorkspaceKey(body, queryParams) {
  return optionalString(body?.workspace_key) ||
         optionalString(queryParams?.workspace_key) ||
         "primary";
}

function resolveEnvironmentKey(body, queryParams) {
  return optionalString(body?.environment_key) ||
         optionalString(queryParams?.environment_key) ||
         "production";
}

async function requireAdmin(userSb) {
  const { error } = await userSb.rpc("ab_require_admin", {});
  if (error) throw new Error("admin_required");
}

async function getAuthedUserId(userSb) {
  const { data, error } = await userSb.auth.getUser();
  if (error || !data?.user?.id) throw new Error("invalid_jwt");
  return data.user.id;
}

/* ---------------------------------------------------------
   Handler: ingest_event
--------------------------------------------------------- */

async function handleIngestEvent(userSb, body, adminUserId) {
  const event_name = requireString(body.event_name, "event_name");
  const source_key = requireString(body.source_key, "source_key");
  const tenantUuid = resolveTenantUuid(body);

  const params = {
    p_event_name:      event_name,
    p_source_key:      source_key,
    p_title:           optionalString(body.title),
    p_summary:         optionalString(body.summary),
    p_payload:         body.payload && typeof body.payload === "object" ? body.payload : {},
    p_severity_hint:   optionalString(body.severity_hint),
    p_correlation_key: optionalString(body.correlation_key),
    p_dedupe_key:      optionalString(body.dedupe_key),
    p_tags:            Array.isArray(body.tags) ? body.tags : [],
    p_actor_id:        adminUserId,
    p_actor_type:      "user",
    p_request_id:      optionalString(body.request_id),
    p_trace_id:        optionalString(body.trace_id),
    p_raw_event:       body.raw_event || null,
    p_tenant_uuid:     tenantUuid,
    p_workspace_key:   resolveWorkspaceKey(body),
    p_environment_key: resolveEnvironmentKey(body),
  };

  const svcSb = sbForService();
  const { data, error } = await svcSb.schema("ops_core").rpc("ingest_event", params);
  if (error) throw new Error(error.message);
  return { event_id: data };
}

/* ---------------------------------------------------------
   Handler: create_command
--------------------------------------------------------- */

async function handleCreateCommand(userSb, body) {
  const command_type = requireString(body.command_type, "command_type");
  const target_type  = requireString(body.target_type,  "target_type");
  const target_id    = requireString(body.target_id,    "target_id");
  const tenantUuid   = resolveTenantUuid(body);

  const params = {
    p_command_type:    command_type,
    p_target_type:     target_type,
    p_target_id:       target_id,
    p_reason:          optionalString(body.reason),
    p_payload:         body.payload && typeof body.payload === "object" ? body.payload : {},
    p_idempotency_key: optionalString(body.idempotency_key),
    p_tenant_uuid:     tenantUuid,
    p_workspace_key:   resolveWorkspaceKey(body),
    p_environment_key: resolveEnvironmentKey(body),
  };

  const { data, error } = await userSb.schema("ops_core").rpc("create_command", params);
  if (error) throw new Error(error.message);
  return { result: data };
}

/* ---------------------------------------------------------
   Handler: incident_action
--------------------------------------------------------- */

async function handleIncidentAction(userSb, body) {
  const sub_action  = requireString(body.sub_action, "sub_action").toLowerCase();
  const incident_id = requireString(body.incident_id, "incident_id");
  const tenantUuid  = resolveTenantUuid(body);

  let command_type;
  const payload = {};

  switch (sub_action) {
    case "acknowledge":
      command_type = "incident.acknowledge";
      break;
    case "assign": {
      command_type = "incident.assign";
      const assignee_id = requireString(body.assignee_id, "assignee_id");
      const assignee_type = optionalString(body.assignee_type) || "user";
      if (!["user", "team"].includes(assignee_type)) throw new Error("invalid_assignee_type");
      payload.assignee_id = assignee_id;
      payload.assignee_type = assignee_type;
      break;
    }
    case "resolve":
      command_type = "incident.resolve";
      if (!optionalString(body.reason)) throw new Error("missing_reason");
      break;
    default:
      throw new Error("invalid_sub_action");
  }

  const params = {
    p_command_type:    command_type,
    p_target_type:     "incident",
    p_target_id:       incident_id,
    p_reason:          optionalString(body.reason),
    p_payload:         payload,
    p_idempotency_key: optionalString(body.idempotency_key),
    p_tenant_uuid:     tenantUuid,
    p_workspace_key:   resolveWorkspaceKey(body),
    p_environment_key: resolveEnvironmentKey(body),
  };

  const { data, error } = await userSb.schema("ops_core").rpc("create_command", params);
  if (error) throw new Error(error.message);
  return { result: data };
}

/* ---------------------------------------------------------
   GET handlers
--------------------------------------------------------- */

async function handleGetCommand(userSb, req) {
  const command_id = requireString(req.query.command_id, "command_id");
  const { data, error } = await userSb.schema("ops_core").rpc("get_command", { p_command_id: command_id });
  if (error) throw new Error(error.message);
  return { result: data };
}

async function handleListIncidents(userSb, req) {
  const tenantUuid = resolveTenantUuid(null, req.query);

  const params = {
    p_lifecycle_status: optionalArray(req.query.lifecycle_status),
    p_severity:         optionalArray(req.query.severity),
    p_search:           optionalString(req.query.search),
    p_limit:            optionalInt(req.query.limit, 50),
    p_offset:           optionalInt(req.query.offset, 0),
    p_tenant_uuid:      tenantUuid,
    p_environment_key:  resolveEnvironmentKey(null, req.query),
  };

  const { data, error } = await userSb.schema("ops_incident").rpc("list_incidents", params);
  if (error) throw new Error(error.message);
  return { result: data };
}

async function handleGetIncident(userSb, req) {
  const incident_id = requireString(req.query.incident_id, "incident_id");
  const { data, error } = await userSb.schema("ops_incident").rpc("get_incident", { p_incident_id: incident_id });
  if (error) throw new Error(error.message);
  return { result: data };
}

async function handleGetTimeline(userSb, req) {
  const incident_id = requireString(req.query.incident_id, "incident_id");
  const limit = optionalInt(req.query.limit, 100);
  const { data, error } = await userSb.schema("ops_incident").rpc("get_timeline", {
    p_incident_id: incident_id, p_limit: limit
  });
  if (error) throw new Error(error.message);
  return { result: data };
}

/* ---------------------------------------------------------
   MAIN
--------------------------------------------------------- */

module.exports = async (req, res) => {
  if (!["GET", "POST"].includes(req.method)) {
    return jsonErr(res, 405, "method_not_allowed", null);
  }

  const body = parseBody(req);
  if (body === null) return jsonErr(res, 400, "invalid_json", null);

  const action = getAction(req, body);
  if (!action) return jsonErr(res, 400, "missing_action", "Provide ?action= or body.action");

  const jwt = getBearer(req);
  if (!jwt) return jsonErr(res, 401, "missing_bearer_token", null);

  try {
    const userSb = sbForJwt(jwt);
    await requireAdmin(userSb);
    const adminUserId = await getAuthedUserId(userSb);

    if (req.method === "POST") {
      switch (action) {
        case "ingest_event":
          return jsonOk(res, await handleIngestEvent(userSb, body, adminUserId));
        case "create_command":
          return jsonOk(res, await handleCreateCommand(userSb, body));
        case "incident_action":
          return jsonOk(res, await handleIncidentAction(userSb, body));
        default:
          return jsonErr(res, 400, "unknown_post_action", action);
      }
    }

    switch (action) {
      case "get_command":
        return jsonOk(res, await handleGetCommand(userSb, req));
      case "list_incidents":
        return jsonOk(res, await handleListIncidents(userSb, req));
      case "get_incident":
        return jsonOk(res, await handleGetIncident(userSb, req));
      case "get_timeline":
        return jsonOk(res, await handleGetTimeline(userSb, req));
      default:
        return jsonErr(res, 400, "unknown_get_action", action);
    }
  } catch (err) {
    const message = err?.message || String(err);

    const status =
      message === "missing_bearer_token" || message === "invalid_jwt" ? 401
      : message === "admin_required" || /admin access required/i.test(message) || /unauthorized/i.test(message) ? 403
      : message.startsWith("missing_") || message.startsWith("invalid_") ||
        /unknown_event_name:/i.test(message) || /unknown_source_key:/i.test(message) ||
        /unknown_command_type:/i.test(message) || /unknown_tenant:/i.test(message) ||
        /target_type_mismatch:/i.test(message) || /reason_required_for_/i.test(message) ||
        /resolution_note_required/i.test(message) || /invalid_transition:/i.test(message) ||
        /payload_missing_/i.test(message) || /tenant_uuid_required/i.test(message) ? 400
      : /not_found/i.test(message) || /incident_not_found:/i.test(message) || /command_not_found:/i.test(message) ? 404
      : 500;

    return jsonErr(res, status, "ops_gateway_failed", message);
  }
};