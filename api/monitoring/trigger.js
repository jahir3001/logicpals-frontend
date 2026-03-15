/**
 * api/monitoring/trigger.js — Universal Alert Bridge
 * ─────────────────────────────────────────────────────────────
 * Phase 0B · Steps 5 + Boundary Wiring
 *
 * WHY THIS EXISTS:
 *   Supabase Edge Functions (Deno/TypeScript) cannot import
 *   Node.js modules. This thin HTTP endpoint bridges the gap —
 *   any Edge Function POSTs here, and this endpoint calls the
 *   appropriate monitoring.js function.
 *
 * SUPPORTED:
 *   All 31 alert types — not just synthetic monitor.
 *   Any Edge Function (v1-router, rate-limit-check, etc.)
 *   can fire alerts through this single endpoint.
 *
 * SECURITY:
 *   Authenticated via x-internal-key header.
 *
 * DEPLOYMENT:
 *   1. Save as:  api/monitoring/trigger.js
 *   2. Add INTERNAL_MONITORING_KEY to Vercel + Supabase secrets
 *   3. Add VERCEL_APP_URL to Supabase Edge Function secrets
 *   4. Push — Vercel auto-creates: POST /api/monitoring/trigger
 * ─────────────────────────────────────────────────────────────
 */

// ── Import every monitoring function ────────────────────────
import {
  // Boundary & Security
  recordBoundaryViolation,
  recordUnauthorizedOlympiadAccess,
  recordSecretRotationRequired,
  // AI Provider
  recordAiProviderFailover,
  recordCircuitBreakerTripped,
  recordCircuitBreakerRecovered,
  recordAiLatencyHigh,
  recordAiErrorSpike,
  recordPromptInjectionDetected,
  // Cost
  recordDailyCostExceeded,
  recordCostSpike,
  // Synthetic Monitor
  recordSyntheticMonitorFailed,
  recordSyntheticMonitorRecovered,
  recordSyntheticMonitorHeartbeat,
  // Platform Health
  recordHighLatency,
  recordErrorSpike,
  recordSessionComposerFailure,
  recordProviderDown,
  recordSchemaDrift,
  // Deployments
  recordDeploymentEvent,
  recordDeploymentFailed,
  recordEdgeFunctionError,
  recordQcSuiteFailure,
  // Admin
  recordAdminRoleChange,
  recordManualCircuitBreakerReset,
  recordSchemaRollback,
  // Product & Growth
  recordStudentMilestone,
  recordSchoolOnboarded,
  recordStudentFeedback,
  recordSubscriptionUpgraded,
  recordSocialMilestone,
} from '../../backend/alerts/monitoring.js';

// ── Alert type → handler map (all 31) ───────────────────────
const HANDLERS = {
  // Boundary & Security
  boundary_violation:           recordBoundaryViolation,
  unauthorized_olympiad_access: recordUnauthorizedOlympiadAccess,
  secret_rotation_required:     recordSecretRotationRequired,
  // AI Provider
  ai_provider_failover:         recordAiProviderFailover,
  circuit_breaker_tripped:      recordCircuitBreakerTripped,
  circuit_breaker_recovered:    recordCircuitBreakerRecovered,
  ai_latency_high:              recordAiLatencyHigh,
  ai_error_spike:               recordAiErrorSpike,
  prompt_injection_detected:    recordPromptInjectionDetected,
  // Cost
  daily_cost_exceeded:          recordDailyCostExceeded,
  cost_spike_detected:          recordCostSpike,
  // Synthetic Monitor
  synthetic_monitor_failed:     recordSyntheticMonitorFailed,
  synthetic_monitor_recovered:  recordSyntheticMonitorRecovered,
  synthetic_monitor_heartbeat:  recordSyntheticMonitorHeartbeat,
  // Platform Health
  high_latency:                 recordHighLatency,
  error_spike:                  recordErrorSpike,
  session_composer_failure:     recordSessionComposerFailure,
  provider_down:                recordProviderDown,
  schema_drift_detected:        recordSchemaDrift,
  // Deployments
  deployment_event:             recordDeploymentEvent,
  deployment_failed:            recordDeploymentFailed,
  edge_function_error:          recordEdgeFunctionError,
  qc_suite_failure:             recordQcSuiteFailure,
  // Admin
  admin_role_change:            recordAdminRoleChange,
  manual_circuit_breaker_reset: recordManualCircuitBreakerReset,
  schema_rollback:              recordSchemaRollback,
  // Product & Growth
  student_milestone:            recordStudentMilestone,
  school_onboarded:             recordSchoolOnboarded,
  student_feedback_received:    recordStudentFeedback,
  subscription_upgraded:        recordSubscriptionUpgraded,
  social_milestone:             recordSocialMilestone,
};

export default async function handler(req, res) {
  // ── Method check ─────────────────────────────────────────
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── Auth check ───────────────────────────────────────────
  const key      = req.headers['x-internal-key'];
  const expected = process.env.INTERNAL_MONITORING_KEY;

  if (!expected) {
    console.error('[monitoring/trigger] INTERNAL_MONITORING_KEY not configured');
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  if (!key || key !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // ── Parse body ───────────────────────────────────────────
  const { alert_type, ...payload } = req.body || {};

  if (!alert_type) {
    return res.status(400).json({
      error:       'Missing alert_type',
      valid_types: Object.keys(HANDLERS),
    });
  }

  const handlerFn = HANDLERS[alert_type];
  if (!handlerFn) {
    return res.status(400).json({
      error:       `Unknown alert_type: "${alert_type}"`,
      valid_types: Object.keys(HANDLERS),
    });
  }

  // ── Fire alert ───────────────────────────────────────────
  try {
    const result = await handlerFn(payload);
    return res.status(200).json({ ok: true, alert_type, ...result });
  } catch (err) {
    console.error(`[monitoring/trigger] Error firing ${alert_type}:`, err);
    return res.status(500).json({
      ok:         false,
      alert_type,
      error:      err.message,
    });
  }
}
