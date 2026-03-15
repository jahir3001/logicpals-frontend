/**
 * slack_notifier.js — LogicPals Enterprise Slack Notifier
 *
 * Features:
 *  - Multi-channel routing (one webhook per channel)
 *  - Rich Block Kit messages (not plain text)
 *  - Severity colour bars
 *  - Runbook links inline
 *  - Graceful fallback to plain text if Block Kit fails
 */

import { CHANNELS } from "./alert_types.js";

// ── Severity → Slack color sidebar ───────────────────────────
const SEVERITY_COLORS = {
  critical: "#FF0000",
  high:     "#FF6B00",
  warning:  "#FFD700",
  info:     "#36A64F",
};

// ── Severity → emoji label ────────────────────────────────────
const SEVERITY_LABELS = {
  critical: "🔴 CRITICAL",
  high:     "🟠 HIGH",
  warning:  "🟡 WARNING",
  info:     "🟢 INFO",
};

// ── Resolve webhook URL from env var name ────────────────────
function getWebhookUrl(channelEnvKey) {
  const url = process.env[channelEnvKey];
  if (!url) {
    // Fallback to the original single webhook if specific channel not configured
    const fallback = process.env.SLACK_WEBHOOK_URL;
    if (!fallback) {
      throw new Error(
        `Missing Slack webhook: ${channelEnvKey} (and no SLACK_WEBHOOK_URL fallback)`
      );
    }
    console.warn(
      `[slack] ${channelEnvKey} not configured — falling back to SLACK_WEBHOOK_URL`
    );
    return fallback;
  }
  return url;
}

// ── Format payload fields as Block Kit section ───────────────
function buildPayloadBlocks(payload = {}) {
  // Exclude internal meta fields
  const skip = new Set(["timestamp", "source"]);
  const entries = Object.entries(payload).filter(
    ([k, v]) => !skip.has(k) && v !== null && v !== undefined
  );

  if (entries.length === 0) return [];

  const fields = entries.map(([key, value]) => ({
    type: "mrkdwn",
    text: `*${key}*\n${String(value).slice(0, 300)}`,
  }));

  // Slack allows max 10 fields per section block
  const chunks = [];
  for (let i = 0; i < fields.length; i += 10) {
    chunks.push({
      type: "section",
      fields: fields.slice(i, i + 10),
    });
  }
  return chunks;
}

// ── Build full Block Kit message ─────────────────────────────
function buildBlockKitMessage({
  alertType,
  severity,
  icon,
  description,
  payload,
  runbook,
  environment,
}) {
  const color      = SEVERITY_COLORS[severity] || "#888888";
  const sevLabel   = SEVERITY_LABELS[severity]  || severity.toUpperCase();
  const ts         = payload.timestamp || new Date().toISOString();
  const env        = environment || process.env.NODE_ENV || "production";
  const envBadge   = env === "production" ? "🟣 prod" : "🔵 dev";

  const blocks = [
    // Header
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `${icon} ${description}`,
        emoji: true,
      },
    },
    // Meta row
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Severity*\n${sevLabel}` },
        { type: "mrkdwn", text: `*Alert Type*\n\`${alertType}\`` },
        { type: "mrkdwn", text: `*Environment*\n${envBadge}` },
        { type: "mrkdwn", text: `*Time*\n<!date^${Math.floor(new Date(ts).getTime() / 1000)}^{date_short_pretty} {time_secs}|${ts}>` },
      ],
    },
    { type: "divider" },
    // Payload fields
    ...buildPayloadBlocks(payload),
  ];

  // Runbook link
  if (runbook) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `📖 *Runbook:* ${runbook}`,
      },
    });
  }

  // Footer
  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `LogicPals Monitoring · ${ts} · source: ${payload.source || "unknown"}`,
      },
    ],
  });

  return {
    // Fallback plain text (for notifications + search)
    text: `${icon} ${sevLabel}: ${description} [${alertType}]`,
    attachments: [
      {
        color,
        blocks,
      },
    ],
  };
}

// ── Main send function ────────────────────────────────────────
export async function sendSlackAlert({
  alertType,
  severity,
  icon,
  description,
  channel,   // CHANNELS.* env key
  payload,
  runbook,
  environment,
  // Legacy: allow plain { text } passthrough for backward compat
  text,
}) {
  // Legacy plain-text passthrough (keeps old code working)
  if (text && !alertType) {
    return sendRaw({ text }, process.env.SLACK_WEBHOOK_URL);
  }

  const webhookUrl = getWebhookUrl(channel || CHANNELS.ALERTS);

  const message = buildBlockKitMessage({
    alertType,
    severity,
    icon,
    description,
    payload: payload || {},
    runbook,
    environment,
  });

  return sendRaw(message, webhookUrl);
}

// ── Low-level HTTP send ───────────────────────────────────────
async function sendRaw(body, webhookUrl) {
  if (!webhookUrl) throw new Error("Missing Slack webhook URL");

  const response = await fetch(webhookUrl, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    throw new Error(
      `Slack webhook failed: ${response.status} ${response.statusText} — ${bodyText}`
    );
  }

  return true;
}

// ── Send to multiple channels at once ────────────────────────
export async function sendSlackAlertMulti(channelKeys, options) {
  const results = await Promise.allSettled(
    channelKeys.map((channel) => sendSlackAlert({ ...options, channel }))
  );
  const failed = results.filter((r) => r.status === "rejected");
  if (failed.length > 0) {
    console.error("[slack] Some channels failed:", failed.map((f) => f.reason?.message));
  }
  return results;
}
