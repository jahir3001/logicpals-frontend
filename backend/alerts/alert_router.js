/**
 * alert_router.js — LogicPals Enterprise Alert Router
 *
 * Features:
 *  - Looks up alert config from ALERT_TYPES registry
 *  - In-process deduplication (dedup_minutes window)
 *  - Routes to correct Slack channel automatically
 *  - Writes to Supabase alert_log (when supabase client provided)
 *  - Critical alerts also mirror to #alerts (cross-post)
 */

import { ALERT_TYPES, CHANNELS, SEVERITY } from "./alert_types.js";
import { sendSlackAlert, sendSlackAlertMulti } from "./slack_notifier.js";

// ── In-process dedup cache ────────────────────────────────────
// key: `${alertType}:${dedupKey}` → last_sent timestamp
const dedupCache = new Map();

function isDuplicate(alertType, dedupKey, dedupMinutes) {
  if (!dedupMinutes || dedupMinutes === 0) return false;
  const key  = `${alertType}:${dedupKey}`;
  const last = dedupCache.get(key);
  if (!last) return false;
  const ageMs = Date.now() - last;
  return ageMs < dedupMinutes * 60 * 1000;
}

function markSent(alertType, dedupKey) {
  const key = `${alertType}:${dedupKey}`;
  dedupCache.set(key, Date.now());
}

// ── Optional: write to Supabase alert_log ────────────────────
// Pass in a Supabase client to enable DB logging.
// If not provided, alert is Slack-only (fine for Edge Functions
// that already write to DB themselves).
async function writeToAlertLog(supabase, alertType, severity, payload) {
  if (!supabase) return;
  try {
    await supabase.from("alert_log").insert({
      alert_type: alertType,
      severity,
      message:    payload.description || alertType,
      metadata:   payload,
    });
  } catch (e) {
    // Non-fatal — Slack is the primary channel
    console.warn("[alert_router] Failed to write alert_log:", e.message);
  }
}

// ── Main routing function ─────────────────────────────────────
export async function routeAlert(alertType, payload = {}, options = {}) {
  const {
    supabase   = null,    // optional Supabase client for DB logging
    dedupKey   = "default", // override dedup key for user-specific dedup
    environment = process.env.NODE_ENV || "production",
    forceSend  = false,   // bypass dedup (use for circuit breaker trips)
  } = options;

  // 1. Look up alert config
  const config = ALERT_TYPES[alertType];
  if (!config) {
    throw new Error(`Unknown alert type: "${alertType}". Add it to alert_types.js first.`);
  }

  const { severity, icon, description, channel, dedup_minutes, runbook } = config;

  // 2. Deduplication check
  if (!forceSend && isDuplicate(alertType, dedupKey, dedup_minutes)) {
    console.log(`[alert_router] Suppressed duplicate: ${alertType} (dedup: ${dedup_minutes}m)`);
    return { ok: true, alertType, severity, suppressed: true };
  }

  // 3. Write to Supabase alert_log (non-blocking)
  writeToAlertLog(supabase, alertType, severity, payload).catch(() => {});

  // 4. Determine channels to notify
  const channels = [channel];

  // Critical alerts also cross-post to #alerts (unless already going there)
  if (severity === SEVERITY.CRITICAL && channel !== CHANNELS.ALERTS) {
    channels.push(CHANNELS.ALERTS);
  }

  // 5. Send to Slack
  const slackOptions = {
    alertType,
    severity,
    icon,
    description,
    payload,
    runbook,
    environment,
  };

  let slackResult;
  if (channels.length > 1) {
    slackResult = await sendSlackAlertMulti(channels, slackOptions);
  } else {
    await sendSlackAlert({ ...slackOptions, channel: channels[0] });
    slackResult = { ok: true };
  }

  // 6. Mark sent in dedup cache
  markSent(alertType, dedupKey);

  console.log(`[alert_router] Sent: ${alertType} (${severity}) → ${channels.join(", ")}`);

  return {
    ok:        true,
    alertType,
    severity,
    channels,
    suppressed: false,
  };
}
