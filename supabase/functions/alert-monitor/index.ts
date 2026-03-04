// ============================================================
// P0.5 Part B: Alert Monitor Edge Function
// LogicPals Phase 0 — Week 1
// Runs every 5 minutes via Supabase cron.
// Calls evaluate_platform_alerts() and fires Slack webhooks.
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL     = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SLACK_WEBHOOK    = Deno.env.get('SLACK_ALERT_WEBHOOK_URL')!;

// Slack channel overrides by severity
const SLACK_CRITICAL_WEBHOOK = Deno.env.get('SLACK_CRITICAL_WEBHOOK_URL')
  ?? SLACK_WEBHOOK;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE);

// ── Slack message formatter ───────────────────────────────────
function buildSlackMessage(
  alertType: string,
  severity: string,
  message: string,
  metadata: Record<string, unknown>
): object {
  const emoji   = severity === 'critical' ? '🚨' : '⚠️';
  const color   = severity === 'critical' ? '#FF0000' : '#FFA500';
  const typeMap: Record<string, string> = {
    high_latency:              'High AI Latency',
    error_spike:               'AI Error Spike',
    boundary_violation:        'Boundary Violation',
    daily_cost_exceeded:       'Daily Cost Exceeded',
    session_composer_failure:  'Session Composer Failure',
    provider_down:             'AI Provider Down',
  };

  return {
    text: `${emoji} *LogicPals Alert: ${typeMap[alertType] ?? alertType}*`,
    attachments: [
      {
        color,
        fields: [
          { title: 'Severity', value: severity.toUpperCase(), short: true },
          { title: 'Type',     value: alertType,              short: true },
          { title: 'Message',  value: message,                short: false },
          {
            title: 'Details',
            value: '```' + JSON.stringify(metadata, null, 2) + '```',
            short: false,
          },
          {
            title: 'Time (UTC)',
            value: new Date().toISOString(),
            short: true,
          },
        ],
        footer: 'LogicPals P0 Alert Monitor',
      },
    ],
  };
}

// ── Main handler ─────────────────────────────────────────────
Deno.serve(async (req) => {

  // Allow Supabase cron scheduler and manual POST triggers
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    // 1. Evaluate all alert conditions
    const { data: alerts, error: evalError } = await supabase
      .rpc('evaluate_platform_alerts');

    if (evalError) {
      console.error('[alert-monitor] evaluate_platform_alerts error:', evalError);
      return new Response(JSON.stringify({ error: evalError.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (!alerts || alerts.length === 0) {
      console.log('[alert-monitor] No alerts firing. Platform healthy.');
      return new Response(JSON.stringify({ status: 'healthy', alerts_fired: 0 }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 2. For each alert: log it (dedup) and fire Slack if new
    let fired = 0;
    const results = [];

    for (const alert of alerts) {
      const { alert_type, severity, message, metadata } = alert;

      // Deduplicated insert — returns false if fired in last 10 min
      const { data: isNew, error: logError } = await supabase
        .rpc('log_alert_if_new', {
          p_alert_type: alert_type,
          p_severity:   severity,
          p_message:    message,
          p_metadata:   metadata ?? {},
        });

      if (logError) {
        console.error('[alert-monitor] log_alert_if_new error:', logError);
        results.push({ alert_type, logged: false, slack_sent: false });
        continue;
      }

      if (!isNew) {
        console.log(`[alert-monitor] Suppressed duplicate: ${alert_type}`);
        results.push({ alert_type, logged: false, slack_sent: false, reason: 'duplicate' });
        continue;
      }

      // 3. Fire Slack — critical alerts go to critical channel
      const webhookUrl = severity === 'critical'
        ? SLACK_CRITICAL_WEBHOOK
        : SLACK_WEBHOOK;

      const slackPayload = buildSlackMessage(
        alert_type, severity, message, metadata ?? {}
      );

      const slackRes = await fetch(webhookUrl, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(slackPayload),
      });

      if (!slackRes.ok) {
        console.error(
          `[alert-monitor] Slack webhook failed for ${alert_type}:`,
          await slackRes.text()
        );
        results.push({ alert_type, logged: true, slack_sent: false });
      } else {
        console.log(`[alert-monitor] Alert fired + Slack sent: ${alert_type}`);
        results.push({ alert_type, logged: true, slack_sent: true });
        fired++;
      }
    }

    return new Response(
      JSON.stringify({ status: 'ok', alerts_fired: fired, results }),
      { headers: { 'Content-Type': 'application/json' } }
    );

  } catch (err) {
    console.error('[alert-monitor] Unexpected error:', err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});