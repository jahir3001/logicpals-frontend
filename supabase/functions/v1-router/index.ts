// ============================================================
// P0.6: /v1/ API Router Edge Function
// LogicPals Phase 0 — Week 2
// 
// Routes: POST /functions/v1/v1-router/rpc/{function_name}
// Adds X-API-Version header to all responses.
// Existing direct supabase.rpc() calls continue working (backward compat).
//
// PHASE 0B ADDITIONS:
//   - Slack alerts on boundary violations (track/subscription)
//   - Slack alerts on RPC errors (edge_function_error)
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { notifySlack } from '../_shared/slack_alert.ts';

const SUPABASE_URL     = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const API_VERSION      = 'v1';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE);

// Standard response headers — added to EVERY response
const baseHeaders = {
  'Content-Type':  'application/json',
  'X-API-Version': API_VERSION,
  'X-Powered-By':  'LogicPals-API',
};

// ── Phase 0B: Boundary violation keywords ────────────────────
// If an RPC error contains these patterns, it's likely a
// subscription/track boundary violation — fire an alert.
const BOUNDARY_PATTERNS = [
  'olympiad',
  'unauthorized',
  'subscription',
  'tier',
  'boundary',
  'access denied',
  'upgrade required',
];

function looksLikeBoundaryViolation(errorMsg: string): boolean {
  const lower = errorMsg.toLowerCase();
  return BOUNDARY_PATTERNS.some(p => lower.includes(p));
}

Deno.serve(async (req) => {

  // ── CORS preflight ────────────────────────────────────────
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        ...baseHeaders,
        'Access-Control-Allow-Origin':  '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      },
    });
  }

  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed', version: API_VERSION }),
      { status: 405, headers: baseHeaders }
    );
  }

  // ── Parse route: /v1-router/rpc/{function_name} ──────────
  const url      = new URL(req.url);
  const segments = url.pathname.split('/').filter(Boolean);
  // segments: ['functions', 'v1', 'v1-router', 'rpc', '{function_name}']
  const rpcIndex = segments.indexOf('rpc');

  if (rpcIndex === -1 || !segments[rpcIndex + 1]) {
    return new Response(
      JSON.stringify({
        error:   'INVALID_ROUTE',
        message: 'Route must be /v1-router/rpc/{function_name}',
        version: API_VERSION,
      }),
      { status: 400, headers: baseHeaders }
    );
  }

  const functionName = segments[rpcIndex + 1];

  // ── Parse request body ────────────────────────────────────
  let args: Record<string, unknown> = {};
  try {
    const body = await req.text();
    if (body) args = JSON.parse(body);
  } catch {
    return new Response(
      JSON.stringify({ error: 'INVALID_JSON', version: API_VERSION }),
      { status: 400, headers: baseHeaders }
    );
  }

  // ── Forward JWT from caller for RLS ──────────────────────
  const authHeader = req.headers.get('Authorization');
  const callerClient = authHeader
    ? createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY')!, {
        global: { headers: { Authorization: authHeader } }
      })
    : supabase;

  // ── Extract user ID from JWT for alerting context ─────────
  let callerId = 'anonymous';
  if (authHeader) {
    try {
      const tokenParts = authHeader.replace('Bearer ', '').split('.');
      if (tokenParts[1]) {
        const payload = JSON.parse(atob(tokenParts[1]));
        callerId = payload.sub || 'unknown';
      }
    } catch {
      // Non-fatal — just use anonymous
    }
  }

  // ── Check v1 registry ────────────────────────────────────
  const { data: registry } = await supabase
    .from('api_version_registry')
    .select('deprecated')
    .eq('version', API_VERSION)
    .eq('function_name', functionName)
    .single();

  if (!registry) {
    return new Response(
      JSON.stringify({
        error:   'NOT_IN_V1_CONTRACT',
        message: `Function '${functionName}' is not registered in the v1 API contract`,
        version: API_VERSION,
      }),
      { status: 404, headers: baseHeaders }
    );
  }

  if (registry.deprecated) {
    return new Response(
      JSON.stringify({
        error:   'DEPRECATED',
        message: `Function '${functionName}' is deprecated. Migrate to v2.`,
        version: API_VERSION,
      }),
      { status: 410, headers: baseHeaders }
    );
  }

  // ── Execute RPC ──────────────────────────────────────────
  const start = Date.now();
  const { data, error } = await callerClient.rpc(functionName, args);
  const latencyMs = Date.now() - start;

  if (error) {
    console.error(`[v1-router] RPC error: ${functionName}`, error);

    // ── Phase 0B: Fire Slack alerts on RPC errors ────────
    const errorMsg = error.message || '';

    if (looksLikeBoundaryViolation(errorMsg)) {
      // Track/subscription boundary violation detected at server layer
      notifySlack('boundary_violation', {
        user_id:         callerId,
        track:           String(args.p_intended_track || args.p_track || 'unknown'),
        attempted_track: String(args.p_intended_track || args.p_track || 'unknown'),
        endpoint:        `v1-router/rpc/${functionName}`,
        reason:          errorMsg.slice(0, 200),
      });
    } else {
      // General RPC error — fire edge_function_error
      notifySlack('edge_function_error', {
        function_name: `v1-router/rpc/${functionName}`,
        error_msg:     errorMsg.slice(0, 200),
        invocation_id: callerId,
      });
    }

    return new Response(
      JSON.stringify({
        error:      error.code ?? 'RPC_ERROR',
        message:    error.message,
        function:   functionName,
        version:    API_VERSION,
        latency_ms: latencyMs,
      }),
      { status: 500, headers: baseHeaders }
    );
  }

  return new Response(
    JSON.stringify({
      data,
      version:    API_VERSION,
      function:   functionName,
      latency_ms: latencyMs,
    }),
    { status: 200, headers: baseHeaders }
  );
});
