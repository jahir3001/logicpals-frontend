/**
 * ============================================================================
 *  LogicPals Operations Platform — ops-gateway.js
 *  Path:          api/ops/ops-gateway.js
 *  Version:       ops_platform_v1.2.0 (2026.04.19)
 *  Purpose:       Single Vercel serverless function exposing all Operations
 *                 Platform actions via ?action= query parameter routing.
 *                 Follows the same merged-gateway pattern as telemetry.js
 *                 and admin-ops.js to stay under Vercel's 12-function limit.
 *
 *  Actions:
 *    POST ?action=ingest_event       → ops_core.ingest_event (service role)
 *    POST ?action=create_command     → ops_core.create_command (user JWT)
 *    POST ?action=incident_action    → routes to create_command with
 *                                      incident.acknowledge|assign|resolve
 *    GET  ?action=get_command        → ops_core.get_command
 *    GET  ?action=list_incidents     → ops_incident.list_incidents
 *    GET  ?action=get_incident       → ops_incident.get_incident
 *    GET  ?action=get_timeline       → ops_incident.get_timeline
 *
 *  Auth:          Bearer JWT on every request. Admin role enforced via
 *                 ab_require_admin (same gate as telemetry.js).
 *  Response:      { ok: true, ...payload }  OR  { ok: false, error, details }
 *
 *  When Vercel Pro is available: split actions into individual files under
 *  api/ops/* with zero logic changes. This file is a deployment wrapper.
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
  if (!SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("missing_service_role_key");
  }
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
    try {
      return JSON.parse(req.body);
    } catch (_) {
      return null; // signal invalid JSON
    }
  }
  if (typeof req.body === "object") return req.body;
  return {};
}

function getAction(req, body) {
  return String(req.query.action || (body && body.action) || "")
    .trim()
    .toLowerCase();
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
  // comma-separated string from query params
  const arr = String(value)
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
  return arr.length === 0 ? null : arr;
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
   Handler: ingest_event  (POST, service role)
--------------------------------------------------------- */

async function handleIngestEvent(userSb, body, adminUserId) {
  const event_name = requireString(body.event_name, "event_name");
  const source_key = requireString(body.source_key, "source_key");

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
    p_tenant_key:      optionalString(body.tenant_key) || "logicpals",
    p_workspace_key:   optionalString(body.workspace_key) || "primary",
    p_environment_key: optionalString(body.environment_key) || "production",
  };

  // ingest_event is granted to service_role only. The admin gate has already
  // been passed (requireAdmin at the top), so escalating is safe.
  const svcSb = sbForService();
  const { data, error } = await svcSb.rpc("ingest_event", params, {
    // schema() targets the RPC's schema when it's not `public`
  });

  // supabase-js v2 needs .schema() scoping for non-public schemas
  // If the call above fails with "function not found", fall back with schema-scoped call:
  if (error && /function .* does not exist/i.test(error.message || "")) {
    const scoped = await svcSb.schema("ops_core").rpc("ingest_event", params);
    if (scoped.error) throw new Error(scoped.error.message);
    return { event_id: scoped.data };
  }

  if (error) throw new Error(error.message);
  return { event_id: data };
}

/* ---------------------------------------------------------
   Handler: create_command  (POST, user JWT)
--------------------------------------------------------- */

async function handleCreateCommand(userSb, body) {
  const command_type = requireString(body.command_type, "command_type");
  const target_type  = requireString(body.target_type,  "target_type");
  const target_id    = requireString(body.target_id,    "target_id");

  const params = {
    p_command_type:     command_type,
    p_target_type:      target_type,
    p_target_id:        target_id,
    p_reason:           optionalString(body.reason),
    p_payload:          body.payload && typeof body.payload === "object" ? body.payload : {},
    p_idempotency_key:  optionalString(body.idempotency_key),
    p_tenant_key:       optionalString(body.tenant_key) || "logicpals",
    p_workspace_key:    optionalString(body.workspace_key) || "primary",
    p_environment_key:  optionalString(body.environment_key) || "production",
  };

  const { data, error } = await userSb.schema("ops_core").rpc("create_command", params);
  if (error) throw new Error(error.message);
  return { result: data };
}

/* ---------------------------------------------------------
   Handler: incident_action  (POST, user JWT)
   Routes to create_command with the appropriate command_type.
   Body shape:
     { sub_action: "acknowledge" | "assign" | "resolve",
       incident_id, reason?, assignee_id?, assignee_type?, idempotency_key? }
--------------------------------------------------------- */

async function handleIncidentAction(userSb, body) {
  const sub_action  = requireString(body.sub_action, "sub_action").toLowerCase();
  const incident_id = requireString(body.incident_id, "incident_id");

  let command_type;
  const payload = {};

  switch (sub_action) {
    case "acknowledge":
      command_type = "incident.acknowledge";
      break;

    case "assign": {
      command_type = "incident.assign";
      const assignee_id   = requireString(body.assignee_id,   "assignee_id");
      const assignee_type = optionalString(body.assignee_type) || "user";
      if (!["user", "team"].includes(assignee_type)) {
        throw new Error("invalid_assignee_type");
      }
      payload.assignee_id   = assignee_id;
      payload.assignee_type = assignee_type;
      break;
    }

    case "resolve":
      command_type = "incident.resolve";
      // reason carries the resolution note for incident.resolve
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
    p_tenant_key:      optionalString(body.tenant_key) || "logicpals",
    p_workspace_key:   optionalString(body.workspace_key) || "primary",
    p_environment_key: optionalString(body.environment_key) || "production",
  };

  const { data, error } = await userSb.schema("ops_core").rpc("create_command", params);
  if (error) throw new Error(error.message);
  return { result: data };
}

/* ---------------------------------------------------------
   Handler: get_command  (GET, user JWT)
--------------------------------------------------------- */

async function handleGetCommand(userSb, req) {
  const command_id = requireString(req.query.command_id, "command_id");

  const { data, error } = await userSb
    .schema("ops_core")
    .rpc("get_command", { p_command_id: command_id });

  if (error) throw new Error(error.message);
  return { result: data };
}

/* ---------------------------------------------------------
   Handler: list_incidents  (GET, user JWT)
--------------------------------------------------------- */

async function handleListIncidents(userSb, req) {
  const params = {
    p_lifecycle_status: optionalArray(req.query.lifecycle_status),
    p_severity:         optionalArray(req.query.severity),
    p_search:           optionalString(req.query.search),
    p_limit:            optionalInt(req.query.limit, 50),
    p_offset:           optionalInt(req.query.offset, 0),
    p_tenant_key:       optionalString(req.query.tenant_key) || "logicpals",
    p_environment_key:  optionalString(req.query.environment_key) || "production",
  };

  const { data, error } = await userSb
    .schema("ops_incident")
    .rpc("list_incidents", params);

  if (error) throw new Error(error.message);
  return { result: data };
}

/* ---------------------------------------------------------
   Handler: get_incident  (GET, user JWT)
--------------------------------------------------------- */

async function handleGetIncident(userSb, req) {
  const incident_id = requireString(req.query.incident_id, "incident_id");

  const { data, error } = await userSb
    .schema("ops_incident")
    .rpc("get_incident", { p_incident_id: incident_id });

  if (error) throw new Error(error.message);
  return { result: data };
}

/* ---------------------------------------------------------
   Handler: get_timeline  (GET, user JWT)
--------------------------------------------------------- */

async function handleGetTimeline(userSb, req) {
  const incident_id = requireString(req.query.incident_id, "incident_id");
  const limit = optionalInt(req.query.limit, 100);

  const { data, error } = await userSb
    .schema("ops_incident")
    .rpc("get_timeline", { p_incident_id: incident_id, p_limit: limit });

  if (error) throw new Error(error.message);
  return { result: data };
}

/* ---------------------------------------------------------
   MAIN HANDLER
--------------------------------------------------------- */

module.exports = async (req, res) => {
  // Method allow-list
  if (!["GET", "POST"].includes(req.method)) {
    return jsonErr(res, 405, "method_not_allowed", null);
  }

  // Parse body early (rejects malformed JSON on POST)
  const body = parseBody(req);
  if (body === null) {
    return jsonErr(res, 400, "invalid_json", null);
  }

  const action = getAction(req, body);
  if (!action) {
    return jsonErr(res, 400, "missing_action", "Provide ?action= or body.action");
  }

  // Auth
  const jwt = getBearer(req);
  if (!jwt) {
    return jsonErr(res, 401, "missing_bearer_token", null);
  }

  try {
    const userSb = sbForJwt(jwt);

    // Admin gate (shared across all actions)
    await requireAdmin(userSb);

    // Admin user id for actor attribution in ingest_event
    const adminUserId = await getAuthedUserId(userSb);

    // Method-scoped dispatch
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

    // GET
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

    // Error → HTTP status mapping
    const status =
      message === "missing_bearer_token" || message === "invalid_jwt"
        ? 401
        : message === "admin_required" ||
          /admin access required/i.test(message) ||
          /unauthorized/i.test(message)
        ? 403
        : message.startsWith("missing_") ||
          message.startsWith("invalid_") ||
          message === "unknown_event_name" ||
          /unknown_event_name:/i.test(message) ||
          /unknown_source_key:/i.test(message) ||
          /unknown_command_type:/i.test(message) ||
          /target_type_mismatch:/i.test(message) ||
          /reason_required_for_/i.test(message) ||
          /resolution_note_required/i.test(message) ||
          /invalid_transition:/i.test(message) ||
          /payload_missing_/i.test(message) ||
          /invalid_assignee_type:/i.test(message)
        ? 400
        : /not_found/i.test(message) || /incident_not_found:/i.test(message) || /command_not_found:/i.test(message)
        ? 404
        : 500;

    return jsonErr(res, status, "ops_gateway_failed", message);
  }
};