/**
 * monitoring.js — LogicPals Enterprise Monitoring API
 *
 * Usage:
 *   import { recordCircuitBreakerTripped } from "./monitoring.js";
 *   await recordCircuitBreakerTripped({ provider: "openai", failures: 5 });
 *
 * Every function:
 *  1. Adds standard metadata (timestamp, source)
 *  2. Calls routeAlert() which handles dedup + Slack + DB logging
 *
 * Pass { supabase } in options to also write to alert_log table.
 */

import { routeAlert } from "./alert_router.js";

function nowIso() {
  return new Date().toISOString();
}

function withMeta(payload = {}) {
  return {
    timestamp: nowIso(),
    source: "logicpals-monitoring",
    ...payload,
  };
}

// ─────────────────────────────────────────────────────────────
// BOUNDARY & SECURITY
// ─────────────────────────────────────────────────────────────

export async function recordBoundaryViolation({
  user_id, track, attempted_track, endpoint, reason, request_id = null
}, options = {}) {
  return routeAlert("boundary_violation", withMeta({
    user_id, track, attempted_track, endpoint, reason, request_id,
  }), options);
}

export async function recordUnauthorizedOlympiadAccess({
  user_id, subscription_tier, attempted_route,
}, options = {}) {
  return routeAlert("unauthorized_olympiad_access", withMeta({
    user_id, subscription_tier, attempted_route,
  }), options);
}

export async function recordSecretRotationRequired({
  secret_name, detected_by, details = null,
}, options = {}) {
  return routeAlert("secret_rotation_required", withMeta({
    secret_name, detected_by, details,
  }), { ...options, forceSend: true });
}

// ─────────────────────────────────────────────────────────────
// AI PROVIDER
// ─────────────────────────────────────────────────────────────

export async function recordAiProviderFailover({
  provider, fallback_provider, error_count, window_minutes = 2, request_type = null,
}, options = {}) {
  return routeAlert("ai_provider_failover", withMeta({
    provider, fallback_provider, error_count, window_minutes, request_type,
  }), options);
}

export async function recordCircuitBreakerTripped({
  provider, consecutive_failures, threshold, tripped_at = null,
}, options = {}) {
  return routeAlert("circuit_breaker_tripped", withMeta({
    provider, consecutive_failures, threshold,
    tripped_at: tripped_at || nowIso(),
  }), { ...options, forceSend: true }); // always send, never dedup
}

export async function recordCircuitBreakerRecovered({
  provider, recovered_after_s = null,
}, options = {}) {
  return routeAlert("circuit_breaker_recovered", withMeta({
    provider, recovered_after_s,
  }), { ...options, forceSend: true });
}

export async function recordAiLatencyHigh({
  provider, p95_latency_ms, threshold_ms = 4000, request_type = null, sample_size = null,
}, options = {}) {
  return routeAlert("ai_latency_high", withMeta({
    provider, p95_latency_ms, threshold_ms, request_type, sample_size,
  }), options);
}

export async function recordAiErrorSpike({
  provider, error_rate, threshold = 0.05, window_minutes = 10, sample_size = null,
}, options = {}) {
  return routeAlert("ai_error_spike", withMeta({
    provider, error_rate: `${(error_rate * 100).toFixed(1)}%`,
    threshold: `${(threshold * 100).toFixed(1)}%`,
    window_minutes, sample_size,
  }), options);
}

export async function recordPromptInjectionDetected({
  user_id, prompt_snippet, validator_rule, session_id = null,
}, options = {}) {
  return routeAlert("prompt_injection_detected", withMeta({
    user_id,
    prompt_snippet: String(prompt_snippet).slice(0, 100) + "...",
    validator_rule, session_id,
  }), options);
}

// ─────────────────────────────────────────────────────────────
// COST & BILLING
// ─────────────────────────────────────────────────────────────

export async function recordDailyCostExceeded({
  cost_today_usd, threshold_usd, track = null, tier = null,
}, options = {}) {
  return routeAlert("daily_cost_exceeded", withMeta({
    cost_today_usd: `$${cost_today_usd.toFixed(4)}`,
    threshold_usd:  `$${threshold_usd.toFixed(4)}`,
    overage_pct:    `${(((cost_today_usd / threshold_usd) - 1) * 100).toFixed(0)}% over`,
    track, tier,
  }), options);
}

export async function recordCostSpike({
  cost_today_usd, daily_average_usd, spike_pct,
}, options = {}) {
  return routeAlert("cost_spike_detected", withMeta({
    cost_today_usd:   `$${cost_today_usd.toFixed(4)}`,
    daily_average_usd:`$${daily_average_usd.toFixed(4)}`,
    spike_pct:        `${spike_pct.toFixed(0)}% above average`,
  }), options);
}

// ─────────────────────────────────────────────────────────────
// SYNTHETIC MONITOR
// ─────────────────────────────────────────────────────────────

export async function recordSyntheticMonitorFailed({
  monitor_name, failed_step, steps_passed, steps_failed,
  environment = "production", details = null,
}, options = {}) {
  return routeAlert("synthetic_monitor_failed", withMeta({
    monitor_name, failed_step,
    steps_passed, steps_failed,
    environment, details,
  }), options);
}

export async function recordSyntheticMonitorRecovered({
  monitor_name, steps_passed,
}, options = {}) {
  return routeAlert("synthetic_monitor_recovered", withMeta({
    monitor_name, steps_passed,
  }), { ...options, forceSend: true });
}

export async function recordSyntheticMonitorHeartbeat({
  runs_last_24h, success_rate_pct, avg_run_ms, monitor_alive,
}, options = {}) {
  return routeAlert("synthetic_monitor_heartbeat", withMeta({
    runs_last_24h,
    success_rate: `${success_rate_pct}%`,
    avg_run_ms:   `${avg_run_ms}ms`,
    status:       monitor_alive ? "✅ healthy" : "❌ dead",
  }), options);
}

// ─────────────────────────────────────────────────────────────
// PLATFORM HEALTH
// ─────────────────────────────────────────────────────────────

export async function recordHighLatency({
  endpoint, p95_ms, threshold_ms, sample_size = null,
}, options = {}) {
  return routeAlert("high_latency", withMeta({
    endpoint, p95_ms: `${p95_ms}ms`, threshold_ms: `${threshold_ms}ms`, sample_size,
  }), options);
}

export async function recordErrorSpike({
  error_rate, window_minutes, total_errors, total_requests,
}, options = {}) {
  return routeAlert("error_spike", withMeta({
    error_rate: `${(error_rate * 100).toFixed(1)}%`,
    window_minutes, total_errors, total_requests,
  }), options);
}

export async function recordSessionComposerFailure({
  error_msg, user_id = null, skill_track = null,
}, options = {}) {
  return routeAlert("session_composer_failure", withMeta({
    error_msg, user_id, skill_track,
  }), options);
}

export async function recordProviderDown({
  provider, detected_by, details = null,
}, options = {}) {
  return routeAlert("provider_down", withMeta({
    provider, detected_by, details,
  }), options);
}

export async function recordSchemaDrift({
  last_hash, current_hash, column_count, last_snapshot_at,
}, options = {}) {
  return routeAlert("schema_drift_detected", withMeta({
    last_hash:       last_hash?.slice(0, 12),
    current_hash:    current_hash?.slice(0, 12),
    column_count,
    last_snapshot_at,
  }), options);
}

// ─────────────────────────────────────────────────────────────
// DEPLOYMENTS
// ─────────────────────────────────────────────────────────────

export async function recordDeploymentEvent({
  environment, status, version, commit_sha = null, actor = null,
}, options = {}) {
  return routeAlert("deployment_event", withMeta({
    environment, status, version,
    commit_sha: commit_sha?.slice(0, 8),
    actor,
  }), options);
}

export async function recordDeploymentFailed({
  environment, version, error_msg, commit_sha = null,
}, options = {}) {
  return routeAlert("deployment_failed", withMeta({
    environment, version, error_msg,
    commit_sha: commit_sha?.slice(0, 8),
  }), { ...options, forceSend: true });
}

export async function recordEdgeFunctionError({
  function_name, error_msg, invocation_id = null,
}, options = {}) {
  return routeAlert("edge_function_error", withMeta({
    function_name, error_msg, invocation_id,
  }), options);
}

export async function recordQcSuiteFailure({
  tests_failed, tests_passed, failed_steps, commit_sha = null,
}, options = {}) {
  return routeAlert("qc_suite_failure", withMeta({
    tests_failed, tests_passed,
    failed_steps: Array.isArray(failed_steps) ? failed_steps.join(", ") : failed_steps,
    commit_sha: commit_sha?.slice(0, 8),
  }), { ...options, forceSend: true });
}

// ─────────────────────────────────────────────────────────────
// ADMIN ACTIONS
// ─────────────────────────────────────────────────────────────

export async function recordAdminRoleChange({
  changed_by, target_user, old_role, new_role, reason = null,
}, options = {}) {
  return routeAlert("admin_role_change", withMeta({
    changed_by, target_user, old_role, new_role, reason,
  }), { ...options, forceSend: true });
}

export async function recordManualCircuitBreakerReset({
  reset_by, provider, from_state, reason,
}, options = {}) {
  return routeAlert("manual_circuit_breaker_reset", withMeta({
    reset_by, provider, from_state, reason,
  }), { ...options, forceSend: true });
}

export async function recordSchemaRollback({
  migration_rolled_back, rolled_back_by, reason,
}, options = {}) {
  return routeAlert("schema_rollback", withMeta({
    migration_rolled_back, rolled_back_by, reason,
  }), { ...options, forceSend: true });
}

// ─────────────────────────────────────────────────────────────
// PRODUCT & GROWTH
// ─────────────────────────────────────────────────────────────

export async function recordStudentMilestone({
  milestone, count, description,
}, options = {}) {
  return routeAlert("student_milestone", withMeta({
    milestone, count, description,
  }), options);
}

export async function recordSchoolOnboarded({
  school_name, org_id, student_count, plan,
}, options = {}) {
  return routeAlert("school_onboarded", withMeta({
    school_name, org_id, student_count, plan,
  }), options);
}

export async function recordStudentFeedback({
  user_id, feedback_type, message_snippet = null,
}, options = {}) {
  return routeAlert("student_feedback_received", withMeta({
    user_id, feedback_type,
    message_snippet: message_snippet?.slice(0, 200),
  }), options);
}

export async function recordSubscriptionUpgraded({
  user_id, old_tier, new_tier,
}, options = {}) {
  return routeAlert("subscription_upgraded", withMeta({
    user_id, old_tier, new_tier,
  }), options);
}

export async function recordSocialMilestone({
  milestone, count, suggested_caption = null,
}, options = {}) {
  return routeAlert("social_milestone", withMeta({
    milestone, count, suggested_caption,
  }), options);
}
