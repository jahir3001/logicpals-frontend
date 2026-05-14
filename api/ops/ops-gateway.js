/**
 * ============================================================================
 *  LogicPals Operations Platform — ops-gateway.js
 *  Path:          api/ops/ops-gateway.js
 *  Version:       ops_platform_v1.4.0
 *
 *  Base:
 *    - ops_platform_v1.3.0 (Path C — 2026.04.19)
 *
 *  Path C rules preserved:
 *    - Accepts tenant_uuid (uuid) instead of tenant_key (text)
 *    - tenant_uuid is REQUIRED on all tenanted operations
 *    - No hardcoded 'logicpals' default
 *    - Admin client supplies tenant_uuid from bootstrap config
 *
 *  8M.11.6.7F additions:
 *    - Protected Incident Command Execution Gateway
 *    - Execution summary read
 *    - Execution audit get/list
 *    - Latest execution list
 *    - Approved command execution through DB executor only
 *
 *  Boundary rule:
 *    - Browser/admin UI sends Supabase user JWT
 *    - Gateway verifies admin user
 *    - Gateway uses service_role only server-side
 *    - actor_id is derived from verified JWT user
 *    - Browser-supplied actor_id is rejected for execution
 *    - Database remains final authorization owner
 *
 *  Future split targets after Vercel upgrade:
 *    - api/ops/events/ingest-event.js
 *    - api/ops/commands/create-command.js
 *    - api/ops/incidents/list-incidents.js
 *    - api/ops/incidents/get-incident.js
 *    - api/ops/incidents/get-timeline.js
 *    - api/ops/incidents/execute-approved-command.js
 *    - api/ops/incidents/execution-summary.js
 *    - api/ops/incidents/execution-audit.js
 * ============================================================================
 */

const { createClient } = require("@supabase/supabase-js");

/* ---------------------------------------------------------
   1. Environment
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

  return {
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY,
  };
}

function sbForJwt(jwt) {
  const { SUPABASE_URL, SUPABASE_ANON_KEY } = getSupabaseEnv();

  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: {
      headers: {
        Authorization: `Bearer ${jwt}`,
      },
    },
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

function sbForService() {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = getSupabaseEnv();

  if (!SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("missing_service_role_key");
  }

  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    global: {
      headers: {
        "X-LogicPals-Gateway": "ops-gateway",
        "X-LogicPals-Step": "8M.11.6.7F",
      },
    },
  });
}

/* ---------------------------------------------------------
   2. Constants
--------------------------------------------------------- */

const GATEWAY_NAME = "api/ops/ops-gateway.js";
const GATEWAY_VERSION = "ops_platform_v1.4.0";
const GATEWAY_STEP = "8M.11.6.7F";
const GATEWAY_BOUNDARY = "protected_incident_command_execution";

const INCIDENT_COMMAND_EXECUTOR_WORKER_ID =
  "api-ops-gateway-incident-command-executor";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const POST_ACTIONS = Object.freeze({
  INGEST_EVENT: "ingest_event",
  CREATE_COMMAND: "create_command",
  INCIDENT_ACTION: "incident_action",

  INCIDENT_COMMAND_EXECUTE_APPROVED:
    "incident_command_execute_approved",

  SLA_EVALUATE_BREACHES:
    "sla_evaluate_breaches",

  SLA_GENERATE_CANDIDATE_COMMANDS:
    "sla_generate_candidate_commands",

  SLA_RUN_GOVERNANCE_CYCLE:
    "sla_run_governance_cycle",

  EVALUATE_COMMAND_EXECUTION_POLICY:
    "evaluate_command_execution_policy",
  GENERATE_NOTIFICATION_CONTRACT_REQUESTS:
    "generate_notification_contract_requests",
  RUN_EXECUTION_GOVERNANCE_CYCLE:
    "run_execution_governance_cycle",
});

const GET_ACTIONS = Object.freeze({
  GET_COMMAND: "get_command",
  LIST_INCIDENTS: "list_incidents",
  GET_INCIDENT: "get_incident",
  GET_TIMELINE: "get_timeline",

  HEALTH: "health",

  INCIDENT_COMMAND_EXECUTION_SUMMARY:
    "incident_command_execution_summary",

  INCIDENT_COMMAND_EXECUTION_AUDIT_GET:
    "incident_command_execution_audit_get",

  INCIDENT_COMMAND_EXECUTION_AUDIT_LIST:
    "incident_command_execution_audit_list",

  INCIDENT_COMMAND_EXECUTION_LATEST:
    "incident_command_execution_latest",

  CRON_SLA_GOVERNANCE_CYCLE:
    "cron_sla_governance_cycle",

  SLA_GOVERNANCE_SNAPSHOT:
    "sla_governance_snapshot",
});

/* ---------------------------------------------------------
   3. HTTP Helpers
--------------------------------------------------------- */

function setSecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
}

function jsonOk(res, payload) {
  return res.status(200).json({
    ok: true,
    ...payload,
  });
}

function jsonErr(res, status, code, details) {
  return res.status(status).json({
    ok: false,
    error: code,
    details,
  });
}

/* ---------------------------------------------------------
   4. Request + Input Helpers
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
      return null;
    }
  }

  if (typeof req.body === "object") {
    return req.body;
  }

  return {};
}

function getAction(req, body) {
  return String(req.query.action || (body && body.action) || "")
    .trim()
    .toLowerCase();
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

function optionalLimit(value, fallback = 50) {
  const n = optionalInt(value, fallback);
  return Math.max(1, Math.min(n, 100));
}

function optionalArray(value) {
  if (value == null || value === "") return null;

  if (Array.isArray(value)) {
    const arr = value
      .filter((v) => typeof v === "string" && v.trim().length > 0)
      .map((v) => v.trim());

    return arr.length === 0 ? null : arr;
  }

  const arr = String(value)
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);

  return arr.length === 0 ? null : arr;
}

function requireUuid(value, name) {
  if (!value || typeof value !== "string" || !UUID_RE.test(value)) {
    throw new Error(`invalid_${name}`);
  }

  return value;
}

function optionalUuid(value, name) {
  if (value == null || value === "") return null;

  const text = String(value).trim();

  if (!UUID_RE.test(text)) {
    throw new Error(`invalid_${name}`);
  }

  return text;
}

function safeObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value;
}

/**
 * Resolve tenant UUID from body or query. REQUIRED.
 * Path C: no default tenant. Caller must supply.
 */
function resolveTenantUuid(body, queryParams) {
  const fromBody = optionalString(body?.tenant_uuid);
  const fromQuery = optionalString(queryParams?.tenant_uuid);
  const tenantUuid = fromBody || fromQuery;

  if (!tenantUuid) {
    throw new Error("missing_tenant_uuid");
  }

  return requireUuid(tenantUuid, "tenant_uuid");
}

function resolveWorkspaceKey(body, queryParams) {
  return (
    optionalString(body?.workspace_key) ||
    optionalString(queryParams?.workspace_key) ||
    "primary"
  );
}

function resolveEnvironmentKey(body, queryParams) {
  return (
    optionalString(body?.environment_key) ||
    optionalString(queryParams?.environment_key) ||
    "production"
  );
}

function rejectBrowserSuppliedActorId(body) {
  if (
    body &&
    Object.prototype.hasOwnProperty.call(body, "actor_id")
  ) {
    throw new Error("actor_id_must_not_be_supplied_by_client");
  }
}

/* ---------------------------------------------------------
   5. Auth Helpers
--------------------------------------------------------- */

async function requireAdmin(userSb) {
  const { error } = await userSb.rpc("ab_require_admin", {});

  if (error) {
    throw new Error("admin_required");
  }
}

async function getAuthedUserId(userSb) {
  const { data, error } = await userSb.auth.getUser();

  if (error || !data?.user?.id) {
    throw new Error("invalid_jwt");
  }

  return data.user.id;
}

/* ---------------------------------------------------------
   6. RPC Helper
--------------------------------------------------------- */

async function callRpc(client, schemaName, rpcName, params) {
  const { data, error } = await client
    .schema(schemaName)
    .rpc(rpcName, params);

  if (error) {
    const err = new Error(error.message || `${rpcName}_failed`);
    err.rpcName = rpcName;
    err.rpcCode = error.code || null;
    throw err;
  }

  return data;
}

/* ---------------------------------------------------------
   7. Metadata Helpers
--------------------------------------------------------- */

function buildIncidentCommandExecutionMetadata(body, adminUserId, commandId) {
  const clientMetadata = safeObject(body.metadata);

  return {
    ...clientMetadata,

    gateway: GATEWAY_NAME,
    gateway_version: GATEWAY_VERSION,
    gateway_step: GATEWAY_STEP,
    gateway_boundary: GATEWAY_BOUNDARY,

    action: POST_ACTIONS.INCIDENT_COMMAND_EXECUTE_APPROVED,

    adapter_command_id: commandId,

    actor_source: "verified_supabase_jwt",
    actor_id: adminUserId,
    actor_id_source_locked: true,
    client_actor_id_accepted: false,

    executor_type: "api_gateway",
    executor_identity: "vercel_ops_gateway",
    executor_worker_id: INCIDENT_COMMAND_EXECUTOR_WORKER_ID,

    authorization_owner: "ops_incident",
    authorization_mode: "actor_based_db_authorization",

    service_role_scope: "server_side_only",

    generated_at: new Date().toISOString(),
  };
}

/* ---------------------------------------------------------
   8. POST Handler: ingest_event
--------------------------------------------------------- */


function rejectActorIdInMetadata(metadata) {
  if (!metadata) return;

  const safe = safeObject(metadata);
  const serialized = JSON.stringify(safe).toLowerCase();

  if (serialized.includes("actor_id")) {
    throw new Error("metadata_must_not_contain_actor_id");
  }
}


function requireCronSecret(req) {
  const expected = process.env.CRON_SECRET;

  if (!expected || String(expected).trim().length < 16) {
    throw new Error("missing_or_weak_cron_secret");
  }

  const auth = req.headers.authorization || "";
  const expectedBearer = "Bearer " + expected;

  if (auth !== expectedBearer) {
    throw new Error("invalid_cron_secret");
  }

  return true;
}

function resolveCronTenantUuid() {
  const tenantUuid = process.env.OPS_CRON_TENANT_UUID;

  if (!tenantUuid) {
    throw new Error("missing_ops_cron_tenant_uuid");
  }

  return requireUuid(tenantUuid, "ops_cron_tenant_uuid");
}

function buildCronGovernanceMetadata(req) {
  return {
    gateway: GATEWAY_NAME,
    gateway_version: GATEWAY_VERSION,
    gateway_step: "8M.11.7H",
    gateway_boundary: "cron_time_based_operational_governance",

    action: GET_ACTIONS.CRON_SLA_GOVERNANCE_CYCLE,

    trigger_source: "vercel_cron",
    user_agent: req.headers["user-agent"] || null,

    identity_policy: "cron_secret_only_no_user_actor",
    client_identity_accepted: false,

    executor_type: "vercel_cron_gateway",
    executor_identity: "vercel_cron_ops_gateway",

    service_role_scope: "server_side_only",

    no_direct_incident_mutation: true,
    no_incident_event_write: true,
    no_raw_event_write: true,
    no_protected_execution: true,

    generated_at: new Date().toISOString(),
  };
}

async function runSlaGovernanceCycleFromCron(req) {
  requireCronSecret(req);

  const tenantUuid = resolveCronTenantUuid();
  const limit = optionalLimit(process.env.OPS_CRON_SLA_LIMIT || 50, 50);

  const runKey =
    "8M.11.7H-cron-cycle-" +
    new Date().toISOString().slice(0, 10);

  const metadata = buildCronGovernanceMetadata(req);

  const svcSb = sbForService();

  const evaluateResult = await callRpc(
    svcSb,
    "public",
    "ops_adapter_evaluate_sla_breaches",
    {
      p_tenant_uuid: tenantUuid,
      p_trigger_source: "vercel_cron",
      p_run_key: runKey,
      p_now: new Date().toISOString(),
      p_metadata: {
        ...metadata,
        cycle_phase: "evaluate_sla_breaches",
        cycle_action: GET_ACTIONS.CRON_SLA_GOVERNANCE_CYCLE,
      },
    }
  );

  const generateResult = await callRpc(
    svcSb,
    "public",
    "ops_adapter_generate_sla_candidate_commands",
    {
      p_tenant_uuid: tenantUuid,
      p_limit: limit,
      p_worker_id: "api-ops-gateway-vercel-cron-sla-governance",
      p_metadata: {
        ...metadata,
        cycle_phase: "generate_candidate_commands",
        cycle_action: GET_ACTIONS.CRON_SLA_GOVERNANCE_CYCLE,
        evaluation_run_key: runKey,
      },
    }
  );

  return {
    ok: true,
    step: "8M.11.7H",
    action: GET_ACTIONS.CRON_SLA_GOVERNANCE_CYCLE,
    tenant_uuid: tenantUuid,
    run_key: runKey,
    boundary: "cron_gateway_cycle_no_execution",
    no_direct_incident_mutation: true,
    no_incident_event_write: true,
    no_raw_event_write: true,
    no_protected_execution: true,
    evaluate_result: evaluateResult,
    generate_result: generateResult,
  };
}

function buildSlaGovernanceMetadata(body, adminUserId, action) {
  const clientMetadata = safeObject(body.metadata);
  rejectActorIdInMetadata(clientMetadata);

  return {
    ...clientMetadata,

    gateway: GATEWAY_NAME,
    gateway_version: GATEWAY_VERSION,
    gateway_step: "8M.11.7G",
    gateway_boundary: "time_based_operational_governance_gateway",

    action,

    trigger_source: "ops_gateway_admin_manual",
    admin_user_uuid: adminUserId,

    identity_policy: "server_derived_admin_context_only",
    client_identity_accepted: false,

    executor_type: "api_gateway",
    executor_identity: "vercel_ops_gateway",
    service_role_scope: "server_side_only",

    no_direct_incident_mutation: true,
    no_incident_event_write: true,
    no_raw_event_write: true,

    generated_at: new Date().toISOString(),
  };
}

/* ---------------------------------------------------------
   8A. POST Handler: SLA governance metadata helpers inserted
--------------------------------------------------------- */

async function handleIngestEvent(userSb, body, adminUserId) {
  const event_name = requireString(body.event_name, "event_name");
  const source_key = requireString(body.source_key, "source_key");
  const tenantUuid = resolveTenantUuid(body);

  const params = {
    p_event_name: event_name,
    p_source_key: source_key,
    p_title: optionalString(body.title),
    p_summary: optionalString(body.summary),
    p_payload:
      body.payload && typeof body.payload === "object" ? body.payload : {},
    p_severity_hint: optionalString(body.severity_hint),
    p_correlation_key: optionalString(body.correlation_key),
    p_dedupe_key: optionalString(body.dedupe_key),
    p_tags: Array.isArray(body.tags) ? body.tags : [],
    p_actor_id: adminUserId,
    p_actor_type: "user",
    p_request_id: optionalString(body.request_id),
    p_trace_id: optionalString(body.trace_id),
    p_raw_event: body.raw_event || null,
    p_tenant_uuid: tenantUuid,
    p_workspace_key: resolveWorkspaceKey(body),
    p_environment_key: resolveEnvironmentKey(body),
  };

  const svcSb = sbForService();
  const data = await callRpc(svcSb, "ops_core", "ingest_event", params);

  return {
    event_id: data,
  };
}

/* ---------------------------------------------------------
   9. POST Handler: create_command
--------------------------------------------------------- */

async function handleCreateCommand(userSb, body) {
  const command_type = requireString(body.command_type, "command_type");
  const target_type = requireString(body.target_type, "target_type");
  const target_id = requireString(body.target_id, "target_id");
  const tenantUuid = resolveTenantUuid(body);

  const params = {
    p_command_type: command_type,
    p_target_type: target_type,
    p_target_id: target_id,
    p_reason: optionalString(body.reason),
    p_payload:
      body.payload && typeof body.payload === "object" ? body.payload : {},
    p_idempotency_key: optionalString(body.idempotency_key),
    p_tenant_uuid: tenantUuid,
    p_workspace_key: resolveWorkspaceKey(body),
    p_environment_key: resolveEnvironmentKey(body),
  };

  const data = await callRpc(userSb, "ops_core", "create_command", params);

  return {
    result: data,
  };
}

/* ---------------------------------------------------------
   10. POST Handler: incident_action
--------------------------------------------------------- */

async function handleIncidentAction(userSb, body) {
  const sub_action = requireString(body.sub_action, "sub_action").toLowerCase();
  const incident_id = requireString(body.incident_id, "incident_id");
  const tenantUuid = resolveTenantUuid(body);

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

      if (!["user", "team"].includes(assignee_type)) {
        throw new Error("invalid_assignee_type");
      }

      payload.assignee_id = assignee_id;
      payload.assignee_type = assignee_type;
      break;
    }

    case "resolve":
      command_type = "incident.resolve";

      if (!optionalString(body.reason)) {
        throw new Error("missing_reason");
      }

      break;

    default:
      throw new Error("invalid_sub_action");
  }

  const params = {
    p_command_type: command_type,
    p_target_type: "incident",
    p_target_id: incident_id,
    p_reason: optionalString(body.reason),
    p_payload: payload,
    p_idempotency_key: optionalString(body.idempotency_key),
    p_tenant_uuid: tenantUuid,
    p_workspace_key: resolveWorkspaceKey(body),
    p_environment_key: resolveEnvironmentKey(body),
  };

  const data = await callRpc(userSb, "ops_core", "create_command", params);

  return {
    result: data,
  };
}

/* ---------------------------------------------------------
   11. POST Handler: incident_command_execute_approved
   8M.11.6.7F Protected Execution Gateway
--------------------------------------------------------- */

async function handleIncidentCommandExecuteApproved(body, adminUserId) {
  rejectBrowserSuppliedActorId(body);

  const commandId = requireUuid(body.command_id, "command_id");

  const metadata = buildIncidentCommandExecutionMetadata(
    body,
    adminUserId,
    commandId
  );

  const svcSb = sbForService();

 const data = await callRpc(
  svcSb,
  "public",
  "ops_adapter_execute_approved_incident_command",
    {
      p_command_id: commandId,
      p_actor_id: adminUserId,
      p_worker_id: INCIDENT_COMMAND_EXECUTOR_WORKER_ID,
      p_metadata: metadata,
    }
  );

  return {
    result: data,
  };
}

/* ---------------------------------------------------------
   12. GET Handler: health
--------------------------------------------------------- */


/* ---------------------------------------------------------
   11A. POST Handler: sla_evaluate_breaches
   8M.11.7G Time-Based Operational Governance Gateway
--------------------------------------------------------- */

async function handleSlaEvaluateBreaches(body, adminUserId) {
  rejectBrowserSuppliedActorId(body);

  const tenantUuid = resolveTenantUuid(body);
  const runKey = optionalString(body.run_key);
  const nowValue = optionalString(body.now) || new Date().toISOString();

  const metadata = buildSlaGovernanceMetadata(
    body,
    adminUserId,
    POST_ACTIONS.SLA_EVALUATE_BREACHES
  );

  const svcSb = sbForService();

  const data = await callRpc(
    svcSb,
    "public",
    "ops_adapter_evaluate_sla_breaches",
    {
      p_tenant_uuid: tenantUuid,
      p_trigger_source: "admin_manual",
      p_run_key: runKey,
      p_now: nowValue,
      p_metadata: metadata,
    }
  );

  return {
    result: data,
  };
}

/* ---------------------------------------------------------
   11B. POST Handler: sla_generate_candidate_commands
   8M.11.7G Time-Based Operational Governance Gateway
--------------------------------------------------------- */

async function handleSlaGenerateCandidateCommands(body, adminUserId) {
  rejectBrowserSuppliedActorId(body);

  const tenantUuid = resolveTenantUuid(body);
  const limit = optionalLimit(body.limit, 50);

  const metadata = buildSlaGovernanceMetadata(
    body,
    adminUserId,
    POST_ACTIONS.SLA_GENERATE_CANDIDATE_COMMANDS
  );

  const svcSb = sbForService();

  const data = await callRpc(
    svcSb,
    "public",
    "ops_adapter_generate_sla_candidate_commands",
    {
      p_tenant_uuid: tenantUuid,
      p_limit: limit,
      p_worker_id: "api-ops-gateway-sla-candidate-command-generator",
      p_metadata: metadata,
    }
  );

  return {
    result: data,
  };
}


/* ---------------------------------------------------------
   11C. POST Handler: sla_run_governance_cycle
   8M.11.7G.5 Combined SLA Governance Cycle
--------------------------------------------------------- */

async function handleSlaRunGovernanceCycle(body, adminUserId) {
  rejectBrowserSuppliedActorId(body);

  const tenantUuid = resolveTenantUuid(body);
  const limit = optionalLimit(body.limit, 50);
  const runKey =
    optionalString(body.run_key) ||
    `8M.11.7G5-gateway-cycle-${Date.now()}`;

  const baseMetadata = buildSlaGovernanceMetadata(
    body,
    adminUserId,
    POST_ACTIONS.SLA_RUN_GOVERNANCE_CYCLE
  );

  const svcSb = sbForService();

  const evaluateResult = await callRpc(
    svcSb,
    "public",
    "ops_adapter_evaluate_sla_breaches",
    {
      p_tenant_uuid: tenantUuid,
      p_trigger_source: "admin_manual",
      p_run_key: runKey,
      p_now: new Date().toISOString(),
      p_metadata: {
        ...baseMetadata,
        cycle_phase: "evaluate_sla_breaches",
        cycle_action: POST_ACTIONS.SLA_RUN_GOVERNANCE_CYCLE,
      },
    }
  );

  const generateResult = await callRpc(
    svcSb,
    "public",
    "ops_adapter_generate_sla_candidate_commands",
    {
      p_tenant_uuid: tenantUuid,
      p_limit: limit,
      p_worker_id: "api-ops-gateway-sla-governance-cycle",
      p_metadata: {
        ...baseMetadata,
        cycle_phase: "generate_candidate_commands",
        cycle_action: POST_ACTIONS.SLA_RUN_GOVERNANCE_CYCLE,
        evaluation_run_key: runKey,
      },
    }
  );

  return {
    result: {
      ok: true,
      step: "8M.11.7G.5",
      action: POST_ACTIONS.SLA_RUN_GOVERNANCE_CYCLE,
      tenant_uuid: tenantUuid,
      run_key: runKey,
      boundary: "combined_gateway_cycle_no_execution",
      no_direct_incident_mutation: true,
      no_incident_event_write: true,
      no_raw_event_write: true,
      evaluate_result: evaluateResult,
      generate_result: generateResult,
    },
  };
}

async function handleHealth(adminUserId) {
  return {
    gateway: GATEWAY_NAME,
    version: GATEWAY_VERSION,
    step: GATEWAY_STEP,
    boundary: GATEWAY_BOUNDARY,
    authenticated_user_id: adminUserId,
    status: "ok",
  };
}

/* ---------------------------------------------------------
   13. GET Handler: get_command
--------------------------------------------------------- */

async function handleGetCommand(userSb, req) {
  const command_id = requireString(req.query.command_id, "command_id");

  const data = await callRpc(userSb, "ops_core", "get_command", {
    p_command_id: command_id,
  });

  return {
    result: data,
  };
}

/* ---------------------------------------------------------
   14. GET Handler: list_incidents
--------------------------------------------------------- */

async function handleListIncidents(userSb, req) {
  const tenantUuid = resolveTenantUuid(null, req.query);

  const params = {
    p_lifecycle_status: optionalArray(req.query.lifecycle_status),
    p_severity: optionalArray(req.query.severity),
    p_search: optionalString(req.query.search),
    p_limit: optionalInt(req.query.limit, 50),
    p_offset: optionalInt(req.query.offset, 0),
    p_tenant_uuid: tenantUuid,
    p_environment_key: resolveEnvironmentKey(null, req.query),
  };

  const data = await callRpc(userSb, "ops_incident", "list_incidents", params);

  return {
    result: data,
  };
}

/* ---------------------------------------------------------
   15. GET Handler: get_incident
--------------------------------------------------------- */

async function handleGetIncident(userSb, req) {
  const incident_id = requireString(req.query.incident_id, "incident_id");

  const data = await callRpc(userSb, "ops_incident", "get_incident", {
    p_incident_id: incident_id,
  });

  return {
    result: data,
  };
}

/* ---------------------------------------------------------
   16. GET Handler: get_timeline
--------------------------------------------------------- */

async function handleGetTimeline(userSb, req) {
  const incident_id = requireString(req.query.incident_id, "incident_id");
  const limit = optionalInt(req.query.limit, 100);

  const data = await callRpc(userSb, "ops_incident", "get_timeline", {
    p_incident_id: incident_id,
    p_limit: limit,
  });

  return {
    result: data,
  };
}

/* ---------------------------------------------------------
   17. GET Handler: incident_command_execution_summary
--------------------------------------------------------- */


/* ---------------------------------------------------------
   16A. GET Handler: sla_governance_snapshot
   8M.11.7I Read-Only SLA Governance Admin Panel
--------------------------------------------------------- */

async function handleSlaGovernanceSnapshot(req) {
  const tenantUuid = resolveTenantUuid(null, req.query);
  const limit = optionalLimit(req.query.limit, 20);

  const svcSb = sbForService();

  const data = await callRpc(
    svcSb,
    "public",
    "ops_sla_governance_admin_snapshot",
    {
      p_tenant_uuid: tenantUuid,
      p_limit: limit,
    }
  );

  return {
    result: data,
  };
}

async function handleIncidentCommandExecutionSummary(req) {
  const commandId = requireUuid(req.query.command_id, "command_id");

  const svcSb = sbForService();

  const data = await callRpc(
  svcSb,
  "public",
  "ops_adapter_get_incident_command_execution_summary",
    {
      p_command_id: commandId,
    }
  );

  return {
    result: data,
  };
}

/* ---------------------------------------------------------
   18. GET Handler: incident_command_execution_audit_get
--------------------------------------------------------- */

async function handleIncidentCommandExecutionAuditGet(req) {
  const auditId = requireUuid(req.query.audit_id, "audit_id");

  const svcSb = sbForService();

  const data = await callRpc(
  svcSb,
  "public",
  "ops_adapter_get_incident_command_execution_audit",
    {
      p_audit_id: auditId,
    }
  );

  return {
    result: data,
  };
}

/* ---------------------------------------------------------
   19. GET Handler: incident_command_execution_audit_list
--------------------------------------------------------- */

async function handleIncidentCommandExecutionAuditList(req) {
  const commandId = optionalUuid(req.query.command_id, "command_id");
  const candidateId = optionalUuid(req.query.candidate_id, "candidate_id");
  const sourceEventId = optionalUuid(req.query.source_event_id, "source_event_id");
  const executionStatus = optionalString(req.query.execution_status);
  const limit = optionalLimit(req.query.limit, 50);

  const svcSb = sbForService();

  const data = await callRpc(
  svcSb,
  "public",
  "ops_adapter_list_incident_command_execution_audit",
    {
      p_command_id: commandId,
      p_candidate_id: candidateId,
      p_source_event_id: sourceEventId,
      p_execution_status: executionStatus,
      p_limit: limit,
    }
  );

  return {
    result: data,
  };
}

/* ---------------------------------------------------------
   20. GET Handler: incident_command_execution_latest
--------------------------------------------------------- */

async function handleIncidentCommandExecutionLatest(req) {
  const executionStatus = optionalString(req.query.execution_status);
  const limit = optionalLimit(req.query.limit, 50);

  const svcSb = sbForService();

  const data = await callRpc(
  svcSb,
  "public",
  "ops_adapter_list_latest_incident_command_executions",
    {
      p_execution_status: executionStatus,
      p_limit: limit,
    }
  );

  return {
    result: data,
  };
}

/* ---------------------------------------------------------
   21. POST Router
--------------------------------------------------------- */



/* ---------------------------------------------------------
   8M.11.8D Handler: evaluate_command_execution_policy
   Policy evaluation only. No execution. No notification dispatch.
--------------------------------------------------------- */

async function handleEvaluateCommandExecutionPolicy(body) {
  const tenantUuid = requireUuid(body.tenant_uuid, "tenant_uuid");
  const commandId = body.command_id ? requireUuid(body.command_id, "command_id") : null;
  const limit = optionalLimit(body.limit, 50);
  const environment = optionalString(body.environment, "production");
  const evaluatorKey = optionalString(
    body.evaluator_key,
    "ops_gateway.8M.11.8D.execution_policy_evaluator"
  );

  const metadata = rejectBrowserSuppliedActorId({
    ...(body.metadata || {}),
    gateway: "api/ops/ops-gateway.js",
    gateway_step: "8M.11.8D",
    gateway_boundary: "execution_policy_evaluation_only_no_execution",
    no_direct_incident_mutation: true,
    no_incident_event_write: true,
    no_raw_event_write: true,
    no_notification_dispatch: true,
    no_command_execution: true,
  });

  const svcSb = sbForService();

  const result = await callRpc(
    svcSb,
    "public",
    "ops_adapter_evaluate_command_execution_policy",
    {
      p_tenant_uuid: tenantUuid,
      p_command_id: commandId,
      p_limit: limit,
      p_environment: environment,
      p_evaluator_key: evaluatorKey,
      p_metadata: metadata,
    }
  );

  return { result };
}


/* ---------------------------------------------------------
   8M.11.8D Handler: generate_notification_contract_requests
   Creates pending notification/action contracts only.
   No dispatch. No command execution.
--------------------------------------------------------- */

async function handleGenerateNotificationContractRequests(body) {
  const tenantUuid = requireUuid(body.tenant_uuid, "tenant_uuid");
  const policyEvaluationId = body.policy_evaluation_id
    ? requireUuid(body.policy_evaluation_id, "policy_evaluation_id")
    : null;
  const commandId = body.command_id ? requireUuid(body.command_id, "command_id") : null;
  const limit = optionalLimit(body.limit, 50);
  const workerId = optionalString(
    body.worker_id,
    "ops_gateway.8M.11.8D.notification_contract_generator"
  );

  const metadata = rejectBrowserSuppliedActorId({
    ...(body.metadata || {}),
    gateway: "api/ops/ops-gateway.js",
    gateway_step: "8M.11.8D",
    gateway_boundary: "notification_contract_request_only_no_dispatch",
    no_direct_incident_mutation: true,
    no_incident_event_write: true,
    no_raw_event_write: true,
    no_notification_dispatch: true,
    no_command_execution: true,
  });

  const svcSb = sbForService();

  const result = await callRpc(
    svcSb,
    "public",
    "ops_notify_generate_notification_dispatch_requests",
    {
      p_tenant_uuid: tenantUuid,
      p_policy_evaluation_id: policyEvaluationId,
      p_command_id: commandId,
      p_limit: limit,
      p_worker_id: workerId,
      p_metadata: metadata,
    }
  );

  return { result };
}


/* ---------------------------------------------------------
   8M.11.8D Handler: run_execution_governance_cycle
   Combined gateway action:
   1. evaluate execution policy
   2. create pending notification/action request contracts
   Still no dispatch and no command execution.
--------------------------------------------------------- */

async function handleRunExecutionGovernanceCycle(body) {
  const tenantUuid = requireUuid(body.tenant_uuid, "tenant_uuid");
  const commandId = body.command_id ? requireUuid(body.command_id, "command_id") : null;
  const limit = optionalLimit(body.limit, 50);
  const environment = optionalString(body.environment, "production");

  const baseMetadata = rejectBrowserSuppliedActorId({
    ...(body.metadata || {}),
    gateway: "api/ops/ops-gateway.js",
    gateway_step: "8M.11.8D",
    gateway_boundary: "combined_execution_governance_cycle_no_execution_no_dispatch",
    no_direct_incident_mutation: true,
    no_incident_event_write: true,
    no_raw_event_write: true,
    no_notification_dispatch: true,
    no_command_execution: true,
  });

  const svcSb = sbForService();

  const evaluateResult = await callRpc(
    svcSb,
    "public",
    "ops_adapter_evaluate_command_execution_policy",
    {
      p_tenant_uuid: tenantUuid,
      p_command_id: commandId,
      p_limit: limit,
      p_environment: environment,
      p_evaluator_key: "ops_gateway.8M.11.8D.combined_cycle.evaluate",
      p_metadata: {
        ...baseMetadata,
        cycle_phase: "evaluate_command_execution_policy",
      },
    }
  );

  const notifyResult = await callRpc(
    svcSb,
    "public",
    "ops_notify_generate_notification_dispatch_requests",
    {
      p_tenant_uuid: tenantUuid,
      p_policy_evaluation_id: null,
      p_command_id: commandId,
      p_limit: limit,
      p_worker_id: "ops_gateway.8M.11.8D.combined_cycle.notification_contract",
      p_metadata: {
        ...baseMetadata,
        cycle_phase: "generate_notification_contract_requests",
      },
    }
  );

  return {
    result: {
      ok: true,
      step: "8M.11.8D",
      action: "run_execution_governance_cycle",
      boundary: "combined_execution_governance_cycle_no_execution_no_dispatch",
      tenant_uuid: tenantUuid,
      environment,
      no_direct_incident_mutation: true,
      no_incident_event_write: true,
      no_raw_event_write: true,
      no_notification_dispatch: true,
      no_command_execution: true,
      evaluate_result: evaluateResult,
      notification_contract_result: notifyResult,
    },
  };
}

async function routePostAction(action, userSb, body, adminUserId) {
  switch (action) {
    case POST_ACTIONS.INGEST_EVENT:
      return handleIngestEvent(userSb, body, adminUserId);

    case POST_ACTIONS.CREATE_COMMAND:
      return handleCreateCommand(userSb, body);

    case POST_ACTIONS.INCIDENT_ACTION:
      return handleIncidentAction(userSb, body);

    case POST_ACTIONS.INCIDENT_COMMAND_EXECUTE_APPROVED:
      return handleIncidentCommandExecuteApproved(body, adminUserId);

    
    case POST_ACTIONS.SLA_EVALUATE_BREACHES:
      return handleSlaEvaluateBreaches(body, adminUserId);

    case POST_ACTIONS.SLA_GENERATE_CANDIDATE_COMMANDS:
      return handleSlaGenerateCandidateCommands(body, adminUserId);


    case POST_ACTIONS.SLA_RUN_GOVERNANCE_CYCLE:
      return handleSlaRunGovernanceCycle(body, adminUserId);


    case POST_ACTIONS.EVALUATE_COMMAND_EXECUTION_POLICY:
      return handleEvaluateCommandExecutionPolicy(body);

    case POST_ACTIONS.GENERATE_NOTIFICATION_CONTRACT_REQUESTS:
      return handleGenerateNotificationContractRequests(body);

    case POST_ACTIONS.RUN_EXECUTION_GOVERNANCE_CYCLE:
      return handleRunExecutionGovernanceCycle(body);

default:
      throw new Error(`unknown_post_action:${action}`);
  }
}

/* ---------------------------------------------------------
   22. GET Router
--------------------------------------------------------- */

async function routeGetAction(action, userSb, req, adminUserId) {
  switch (action) {
    case GET_ACTIONS.HEALTH:
      return handleHealth(adminUserId);

    case GET_ACTIONS.GET_COMMAND:
      return handleGetCommand(userSb, req);

    case GET_ACTIONS.LIST_INCIDENTS:
      return handleListIncidents(userSb, req);

    case GET_ACTIONS.GET_INCIDENT:
      return handleGetIncident(userSb, req);

    case GET_ACTIONS.GET_TIMELINE:
      return handleGetTimeline(userSb, req);

        case GET_ACTIONS.SLA_GOVERNANCE_SNAPSHOT:
      return handleSlaGovernanceSnapshot(req);

    case GET_ACTIONS.INCIDENT_COMMAND_EXECUTION_SUMMARY:
      return handleIncidentCommandExecutionSummary(req);

    case GET_ACTIONS.INCIDENT_COMMAND_EXECUTION_AUDIT_GET:
      return handleIncidentCommandExecutionAuditGet(req);

    case GET_ACTIONS.INCIDENT_COMMAND_EXECUTION_AUDIT_LIST:
      return handleIncidentCommandExecutionAuditList(req);

    case GET_ACTIONS.INCIDENT_COMMAND_EXECUTION_LATEST:
      return handleIncidentCommandExecutionLatest(req);

    default:
      throw new Error(`unknown_get_action:${action}`);
  }
}

/* ---------------------------------------------------------
   23. Error Mapping
--------------------------------------------------------- */

function statusFromErrorMessage(message) {
  if (
    message === "missing_bearer_token" ||
    message === "invalid_jwt"
  ) {
    return 401;
  }

  if (
    message === "invalid_cron_secret" ||
    message === "admin_required" ||
    /admin access required/i.test(message) ||
    /unauthorized/i.test(message) ||
    /not authorized/i.test(message) ||
    /insufficient_privilege/i.test(message)
  ) {
    return 403;
  }

  if (
    message.startsWith("missing_") ||
    message.startsWith("invalid_") ||
    message.startsWith("unknown_post_action:") ||
    message.startsWith("unknown_get_action:") ||
    message === "actor_id_must_not_be_supplied_by_client" ||
    message === "metadata_must_not_contain_actor_id" ||
    /unknown_event_name:/i.test(message) ||
    /unknown_source_key:/i.test(message) ||
    /unknown_command_type:/i.test(message) ||
    /unknown_tenant:/i.test(message) ||
    /target_type_mismatch:/i.test(message) ||
    /reason_required_for_/i.test(message) ||
    /resolution_note_required/i.test(message) ||
    /invalid_transition:/i.test(message) ||
    /payload_missing_/i.test(message) ||
    /tenant_uuid_required/i.test(message)
  ) {
    return 400;
  }

  if (
    /not_found/i.test(message) ||
    /incident_not_found:/i.test(message) ||
    /command_not_found:/i.test(message)
  ) {
    return 404;
  }

  return 500;
}

/* ---------------------------------------------------------
   24. Main Handler
--------------------------------------------------------- */

module.exports = async (req, res) => {
  setSecurityHeaders(res);

  if (!["GET", "POST"].includes(req.method)) {
    return jsonErr(res, 405, "method_not_allowed", null);
  }

  const body = parseBody(req);

  if (body === null) {
    return jsonErr(res, 400, "invalid_json", null);
  }

  const action = getAction(req, body);

  if (!action) {
    return jsonErr(
      res,
      400,
      "missing_action",
      "Provide ?action= or body.action"
    );
  }

  // 8M.11.7H cron fast path.
  // Vercel Cron uses CRON_SECRET Authorization, not a Supabase user JWT.
  // This path must remain cron-only and must not support user actor execution.
  if (
    req.method === "GET" &&
    action === GET_ACTIONS.CRON_SLA_GOVERNANCE_CYCLE
  ) {
    try {
      const result = await runSlaGovernanceCycleFromCron(req);
      return jsonOk(res, { result });
    } catch (err) {
      const message = err?.message || String(err);
      const status = statusFromErrorMessage(message);

      return jsonErr(res, status, "ops_cron_gateway_failed", {
        message,
        gateway: GATEWAY_NAME,
        version: GATEWAY_VERSION,
        step: "8M.11.7H",
      });
    }
  }

const jwt = getBearer(req);

  if (!jwt) {
    return jsonErr(res, 401, "missing_bearer_token", null);
  }

  try {
    const userSb = sbForJwt(jwt);

    await requireAdmin(userSb);

    const adminUserId = await getAuthedUserId(userSb);

    if (req.method === "POST") {
      const result = await routePostAction(
        action,
        userSb,
        body,
        adminUserId
      );

      return jsonOk(res, result);
    }

    const result = await routeGetAction(
      action,
      userSb,
      req,
      adminUserId
    );

    return jsonOk(res, result);
  } catch (err) {
    const message = err?.message || String(err);
    const status = statusFromErrorMessage(message);

    return jsonErr(res, status, "ops_gateway_failed", {
      message,
      rpc_name: err?.rpcName || null,
      rpc_code: err?.rpcCode || null,
      gateway: GATEWAY_NAME,
      version: GATEWAY_VERSION,
      step: GATEWAY_STEP,
    });
  }
};