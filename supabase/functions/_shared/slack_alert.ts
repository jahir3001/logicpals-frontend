/**
 * slack_alert.ts — Reusable Slack Alert Helper for Edge Functions
 * ─────────────────────────────────────────────────────────────
 * Phase 0B · Shared by all Edge Functions
 *
 * USAGE:
 *   import { notifySlack } from '../_shared/slack_alert.ts';
 *
 *   await notifySlack('boundary_violation', {
 *     user_id: userId,
 *     track: 'regular',
 *     attempted_track: 'olympiad',
 *     endpoint: '/learn?track=olympiad',
 *     reason: 'subscription tier does not include olympiad access',
 *   });
 *
 * LOCATION: supabase/functions/_shared/slack_alert.ts
 * ─────────────────────────────────────────────────────────────
 */

export async function notifySlack(
  alertType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const baseUrl = Deno.env.get('VERCEL_APP_URL');
  const key     = Deno.env.get('INTERNAL_MONITORING_KEY');

  if (!baseUrl || !key) {
    console.warn(
      `[slack_alert] Missing VERCEL_APP_URL or INTERNAL_MONITORING_KEY — skipping ${alertType}`
    );
    return;
  }

  try {
    const resp = await fetch(`${baseUrl}/api/monitoring/trigger`, {
      method: 'POST',
      headers: {
        'Content-Type':   'application/json',
        'x-internal-key': key,
      },
      body: JSON.stringify({ alert_type: alertType, ...payload }),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      console.warn(`[slack_alert] ${alertType} → ${resp.status}: ${body}`);
    }
  } catch (err) {
    // Fire-and-forget — never block the Edge Function
    console.warn(`[slack_alert] ${alertType} failed:`, (err as Error).message);
  }
}
