// api/ab/log-metric.js
// Enterprise-grade A/B metric event logger
// - Requires Bearer JWT (Supabase access_token)
// - Enforces POST-only
// - Forwards user JWT to Supabase RPC (so auth.uid() works)
// - Idempotent (RPC enforces unique constraint logic)
// - Deterministic + auditable: stores session_id, event_name, idempotency_key, properties

import { createClient } from '@supabase/supabase-js';

function json(res, status, payload) {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

function getBearerToken(req) {
  const h = req.headers?.authorization || req.headers?.Authorization;
  if (!h || typeof h !== 'string') return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

function isUUID(v) {
  return typeof v === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

function normalizeTrack(track) {
  if (!track) return null;
  const t = String(track).toLowerCase().trim();
  if (t === 'regular' || t === 'olympiad') return t;
  return null;
}

export default async function handler(req, res) {
  const requestId = req.headers['x-request-id'] || null;

  if (req.method !== 'POST') {
    return json(res, 405, { status: 'error', error: 'method_not_allowed', request_id: requestId });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return json(res, 500, { status: 'error', error: 'missing_env', request_id: requestId });
  }

  const token = getBearerToken(req);
  if (!token) {
    return json(res, 401, { status: 'error', error: 'missing_bearer_token', request_id: requestId });
  }

  // Parse body (Vercel usually already parses JSON; handle raw defensively)
  let body = req.body;
  try {
    if (typeof body === 'string') body = JSON.parse(body);
  } catch {
    return json(res, 400, { status: 'error', error: 'invalid_json', request_id: requestId });
  }

  const track = normalizeTrack(body?.track);
  const sessionId = body?.session_id;
  const eventName = body?.event_name;
  const idemKey = body?.idempotency_key;

  const properties = body?.properties ?? {};
  const experimentId = body?.experiment_id ?? null;
  const variantId = body?.variant_id ?? null;

  // Strict validation (enterprise-grade; no silent coercions)
  if (!track) {
    return json(res, 400, { status: 'error', error: 'invalid_track', request_id: requestId });
  }
  if (!isUUID(sessionId)) {
    return json(res, 400, { status: 'error', error: 'invalid_session_id', request_id: requestId });
  }
  if (!eventName || typeof eventName !== 'string' || eventName.length > 120) {
    return json(res, 400, { status: 'error', error: 'invalid_event_name', request_id: requestId });
  }
  if (!idemKey || typeof idemKey !== 'string' || idemKey.length > 200) {
    return json(res, 400, { status: 'error', error: 'invalid_idempotency_key', request_id: requestId });
  }
  if (typeof properties !== 'object' || Array.isArray(properties) || properties === null) {
    return json(res, 400, { status: 'error', error: 'invalid_properties', request_id: requestId });
  }
  if (experimentId !== null && !isUUID(experimentId)) {
    return json(res, 400, { status: 'error', error: 'invalid_experiment_id', request_id: requestId });
  }
  if (variantId !== null && !isUUID(variantId)) {
    return json(res, 400, { status: 'error', error: 'invalid_variant_id', request_id: requestId });
  }

  // Create supabase client using ANON + user JWT (critical for auth.uid())
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Call RPC exactly as your DB signature expects:
  // ab_log_metric_event(p_track, p_session_id, p_event_name, p_idempotency_key, p_properties, p_experiment_id, p_variant_id)
  const { data, error } = await supabase.rpc('ab_log_metric_event', {
    p_track: track,
    p_session_id: sessionId,
    p_event_name: eventName,
    p_idempotency_key: idemKey,
    p_properties: properties,
    p_experiment_id: experimentId,
    p_variant_id: variantId,
  });

  if (error) {
    // Never leak secrets; return structured error
    return json(res, 400, {
      status: 'error',
      error: 'rpc_failed',
      details: error.message,
      request_id: requestId,
    });
  }

  return json(res, 200, {
    status: 'ok',
    result: data ?? null,
    request_id: requestId,
  });
}