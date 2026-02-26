// api/experiment/flags.js — Experiment & kill-switch flags
// Returns feature flags that control client behavior.
//
// Env vars (all optional):
//   PRACTICE_DISABLED    — set to "true" to kill-switch all practice sessions
//   MAINTENANCE_MESSAGE  — custom message shown when practice is disabled
//   CLIENT_FALLBACK      — set to "false" to prevent direct Supabase inserts from client

module.exports = async function handler(req, res) {
  const origin = process.env.ALLOWED_ORIGIN || 'https://logicpals-frontend.vercel.app';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();

  // No auth required for flags — they're not sensitive
  // (but we accept the header so the client doesn't need special logic)

  const flags = {
    practice_disabled: process.env.PRACTICE_DISABLED === 'true',
    maintenance_message: process.env.MAINTENANCE_MESSAGE || null,
    client_fallback_allowed: process.env.CLIENT_FALLBACK !== 'false',
    timestamp: new Date().toISOString()
  };

  // Cache for 60s to avoid hammering on every page load
  res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60');
  return res.status(200).json(flags);
};
