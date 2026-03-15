/**
 * alert_types.js — LogicPals Enterprise Alert Registry
 * Single source of truth for every alert type.
 *
 * Add a webhook for each channel in Vercel env vars:
 *   SLACK_WEBHOOK_ALERTS         → #alerts
 *   SLACK_WEBHOOK_AI_MONITORING  → #ai-monitoring
 *   SLACK_WEBHOOK_DEV            → #dev
 *   SLACK_WEBHOOK_OPS            → #ops
 *   SLACK_WEBHOOK_ALL            → #all-logicpals
 *   SLACK_WEBHOOK_PRODUCT        → #product-feedback
 *   SLACK_WEBHOOK_DEVELOPMENT    → #development
 *   SLACK_WEBHOOK_SOCIAL         → #social
 */

export const CHANNELS = {
  ALERTS:      "SLACK_WEBHOOK_ALERTS",
  AI_MON:      "SLACK_WEBHOOK_AI_MONITORING",
  DEV:         "SLACK_WEBHOOK_DEV",
  OPS:         "SLACK_WEBHOOK_OPS",
  ALL:         "SLACK_WEBHOOK_ALL",
  PRODUCT:     "SLACK_WEBHOOK_PRODUCT",
  DEVELOPMENT: "SLACK_WEBHOOK_DEVELOPMENT",
  SOCIAL:      "SLACK_WEBHOOK_SOCIAL",
};

export const SEVERITY = {
  CRITICAL: "critical",
  HIGH:     "high",
  WARNING:  "warning",
  INFO:     "info",
};

// dedup_minutes: suppress repeated alerts within this window (0 = never suppress)
export const ALERT_TYPES = {

  // ── BOUNDARY & SECURITY ──────────────────────────────────
  boundary_violation: {
    severity: SEVERITY.CRITICAL, icon: "🚨",
    channel: CHANNELS.ALERTS,
    description: "Student attempted cross-track access",
    dedup_minutes: 5,
    runbook: "Check RLS policies + subscription guard on learn.html",
  },
  unauthorized_olympiad_access: {
    severity: SEVERITY.CRITICAL, icon: "🔒",
    channel: CHANNELS.ALERTS,
    description: "Non-eligible user accessed Olympiad content",
    dedup_minutes: 5,
    runbook: "Review subscription tier + olympiad.html route guard",
  },
  secret_rotation_required: {
    severity: SEVERITY.CRITICAL, icon: "🔑",
    channel: CHANNELS.ALERTS,
    description: "API key or secret needs rotation",
    dedup_minutes: 0,
    runbook: "Rotate key immediately, update Supabase + Vercel secrets",
  },

  // ── AI PROVIDER ──────────────────────────────────────────
  ai_provider_failover: {
    severity: SEVERITY.CRITICAL, icon: "🚨",
    channel: CHANNELS.AI_MON,
    description: "AI provider failover triggered",
    dedup_minutes: 10,
    runbook: "Check OpenAI status page + circuit breaker state",
  },
  circuit_breaker_tripped: {
    severity: SEVERITY.CRITICAL, icon: "⚡",
    channel: CHANNELS.AI_MON,
    description: "AI circuit breaker TRIPPED — calls blocked",
    dedup_minutes: 0,
    runbook: "SELECT * FROM v_circuit_breaker_health; await auto-recovery or call rpc_circuit_breaker_reset()",
  },
  circuit_breaker_recovered: {
    severity: SEVERITY.INFO, icon: "✅",
    channel: CHANNELS.AI_MON,
    description: "AI circuit breaker RECOVERED — calls resumed",
    dedup_minutes: 0,
    runbook: null,
  },
  ai_latency_high: {
    severity: SEVERITY.WARNING, icon: "⚠️",
    channel: CHANNELS.AI_MON,
    description: "AI response latency above threshold",
    dedup_minutes: 15,
    runbook: "Check OpenAI dashboard for model degradation",
  },
  ai_error_spike: {
    severity: SEVERITY.CRITICAL, icon: "🚨",
    channel: CHANNELS.AI_MON,
    description: "AI error rate spike detected",
    dedup_minutes: 10,
    runbook: "Check ai_cost_ledger error column + OpenAI status",
  },
  prompt_injection_detected: {
    severity: SEVERITY.HIGH, icon: "🛡️",
    channel: CHANNELS.AI_MON,
    description: "Prompt injection attempt detected",
    dedup_minutes: 5,
    runbook: "Review prompt_validator logs + block user if repeat offender",
  },

  // ── COST & BILLING ────────────────────────────────────────
  daily_cost_exceeded: {
    severity: SEVERITY.WARNING, icon: "💰",
    channel: CHANNELS.ALERTS,
    description: "Daily AI cost threshold exceeded",
    dedup_minutes: 60,
    runbook: "SELECT * FROM v_cost_per_tier_monthly; review heavy users",
  },
  cost_spike_detected: {
    severity: SEVERITY.HIGH, icon: "📈",
    channel: CHANNELS.ALERTS,
    description: "Sudden cost spike — >150% of daily average",
    dedup_minutes: 30,
    runbook: "SELECT * FROM v_cost_per_user_daily ORDER BY total_cost DESC LIMIT 10",
  },

  // ── SYNTHETIC MONITOR ─────────────────────────────────────
  synthetic_monitor_failed: {
    severity: SEVERITY.CRITICAL, icon: "🔴",
    channel: CHANNELS.AI_MON,
    description: "Synthetic monitor pipeline step failed",
    dedup_minutes: 10,
    runbook: "SELECT * FROM v_synthetic_health; check Edge Function logs",
  },
  synthetic_monitor_recovered: {
    severity: SEVERITY.INFO, icon: "🟢",
    channel: CHANNELS.AI_MON,
    description: "Synthetic monitor back to passing",
    dedup_minutes: 0,
    runbook: null,
  },
  synthetic_monitor_heartbeat: {
    severity: SEVERITY.INFO, icon: "💓",
    channel: CHANNELS.OPS,
    description: "Daily synthetic monitor summary",
    dedup_minutes: 0,
    runbook: null,
  },

  // ── PLATFORM HEALTH ───────────────────────────────────────
  high_latency: {
    severity: SEVERITY.HIGH, icon: "🐢",
    channel: CHANNELS.ALERTS,
    description: "Platform response latency breach",
    dedup_minutes: 15,
    runbook: "SELECT * FROM v_platform_health_live; check slow query log",
  },
  error_spike: {
    severity: SEVERITY.CRITICAL, icon: "🚨",
    channel: CHANNELS.ALERTS,
    description: "Platform error rate spike",
    dedup_minutes: 10,
    runbook: "Check Supabase logs + Vercel function logs",
  },
  session_composer_failure: {
    severity: SEVERITY.HIGH, icon: "🔧",
    channel: CHANNELS.ALERTS,
    description: "Session composer RPC failed",
    dedup_minutes: 10,
    runbook: "Test compose_session RPC directly; check BKT parameter tables",
  },
  provider_down: {
    severity: SEVERITY.CRITICAL, icon: "🔴",
    channel: CHANNELS.ALERTS,
    description: "External provider (Supabase/OpenAI/Vercel) down",
    dedup_minutes: 10,
    runbook: "Check: status.supabase.com / status.openai.com / vercel-status.com",
  },
  schema_drift_detected: {
    severity: SEVERITY.HIGH, icon: "⚠️",
    channel: CHANNELS.DEV,
    description: "Schema hash mismatch vs last snapshot",
    dedup_minutes: 60,
    runbook: "SELECT * FROM check_schema_drift(); run QC suite immediately",
  },

  // ── DEPLOYMENTS ───────────────────────────────────────────
  deployment_event: {
    severity: SEVERITY.INFO, icon: "🚀",
    channel: CHANNELS.DEVELOPMENT,
    description: "New deployment completed",
    dedup_minutes: 0,
    runbook: null,
  },
  deployment_failed: {
    severity: SEVERITY.CRITICAL, icon: "💥",
    channel: CHANNELS.DEVELOPMENT,
    description: "Deployment failed",
    dedup_minutes: 0,
    runbook: "Check Vercel deployment logs; rollback if needed",
  },
  edge_function_error: {
    severity: SEVERITY.HIGH, icon: "⚡",
    channel: CHANNELS.DEVELOPMENT,
    description: "Edge Function runtime error",
    dedup_minutes: 10,
    runbook: "Check Supabase Edge Function logs",
  },
  qc_suite_failure: {
    severity: SEVERITY.CRITICAL, icon: "❌",
    channel: CHANNELS.DEV,
    description: "QC test suite failure detected",
    dedup_minutes: 0,
    runbook: "Run: node ai/tests/qc_suite.js --verbose",
  },

  // ── ADMIN ACTIONS ─────────────────────────────────────────
  admin_role_change: {
    severity: SEVERITY.HIGH, icon: "👤",
    channel: CHANNELS.OPS,
    description: "Admin role granted or revoked",
    dedup_minutes: 0,
    runbook: "Verify change was intentional; check audit_log",
  },
  manual_circuit_breaker_reset: {
    severity: SEVERITY.WARNING, icon: "🔄",
    channel: CHANNELS.OPS,
    description: "Circuit breaker manually reset by admin",
    dedup_minutes: 0,
    runbook: null,
  },
  schema_rollback: {
    severity: SEVERITY.CRITICAL, icon: "⏪",
    channel: CHANNELS.OPS,
    description: "Schema rollback executed",
    dedup_minutes: 0,
    runbook: "Run full QC suite after rollback; notify team",
  },

  // ── PRODUCT & GROWTH ──────────────────────────────────────
  student_milestone: {
    severity: SEVERITY.INFO, icon: "🎉",
    channel: CHANNELS.ALL,
    description: "Platform student milestone reached",
    dedup_minutes: 0,
    runbook: null,
  },
  school_onboarded: {
    severity: SEVERITY.INFO, icon: "🏫",
    channel: CHANNELS.ALL,
    description: "New school/org onboarded",
    dedup_minutes: 0,
    runbook: null,
  },
  student_feedback_received: {
    severity: SEVERITY.INFO, icon: "💬",
    channel: CHANNELS.PRODUCT,
    description: "Student feedback or dispute submitted",
    dedup_minutes: 0,
    runbook: null,
  },
  subscription_upgraded: {
    severity: SEVERITY.INFO, icon: "⭐",
    channel: CHANNELS.PRODUCT,
    description: "Student upgraded subscription tier",
    dedup_minutes: 0,
    runbook: null,
  },
  social_milestone: {
    severity: SEVERITY.INFO, icon: "📣",
    channel: CHANNELS.SOCIAL,
    description: "Milestone suitable for social media post",
    dedup_minutes: 0,
    runbook: null,
  },
};
