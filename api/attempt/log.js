// api/attempt/log.js
// Enterprise Attempt Logging Endpoint (LogicPals)
// - Enforces parent->child ownership
// - DB-backed rate limiting via RPC (rpc_rate_limit_check)
// - Atomic attempt logging via RPC (rpc_attempt_log_atomic)
// - Explicit 429 payload + best-practice rate limit headers

import { createClient } from '@supabase/supabase-js';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(res, status, body, extraHeaders = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  Object.entries({ ...corsHeaders, ...extraHeaders }).forEach(([k, v]) => res.setHeader(k, v));
  res.end(JSON.stringify(body));
}

function getBearerToken(req) {
  const h = req.headers?.authorization || req.headers?.Authorization || '';
  const m = String(h).match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

function safeInt(v, fallback = 0) {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

// IMPORTANT: Do NOT send extra keys to PostgREST RPC.
// PostgREST matches by parameter set; extra keys => "function ... not found".
function buildAttemptRpcArgs(body) {
  const solved_correctly = !!body.solved_correctly;
  // Some callers send solved_correctly but not is_correct.
  const is_correct =
    body.is_correct === undefined || body.is_correct === null ? solved_correctly : !!body.is_correct;

  const args = {
    // matches your screenshot: function args start with p_child_id, p_problem_id, p_mode, ...
    p_child_id: body.child_id,
    p_problem_id: body.problem_id,
    p_mode: body.track || body.mode || 'regular',
    p_difficulty_tier: body.difficulty_tier || null,
    p_attempt_state: body.attempt_state || (body.submitted_answer ? 'SUBMITTED' : 'PRACTICING'),
    p_solved_correctly: solved_correctly,
    p_is_correct: is_correct,
    p_hints_used: safeInt(body.hints_used, 0),
    p_questions_asked: safeInt(body.questions_asked, 0),
    p_time_spent_seconds: safeInt(body.time_spent_sec ?? body.time_spent_seconds, 0),
    p_time_to_first_input_seconds: safeInt(body.time_to_first_input_seconds, 0),
    p_submitted_answer: body.submitted_answer ?? null,
  };

  // Remove undefined (don’t let undefined keys appear in RPC call)
  Object.keys(args).forEach((k) => args[k] === undefined && delete args[k]);
  return args;
}

export default async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') {
      Object.entries(corsHeaders).forEach(([k, v]) => res.setHeader(k, v));
      res.statusCode = 204;
      return res.end();
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; // optional but recommended

    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      return json(res, 500, { error: 'missing_supabase_config' });
    }

    const token = getBearerToken(req);
    if (!token) return json(res, 401, { error: 'missing_authorization' });

    // Enterprise: prefer service role server-side (bypass RLS and enforce manually)
    const supabase = createClient(
      SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY,
      {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { headers: { Authorization: `Bearer ${token}` } },
      }
    );

    // Validate session
    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user) {
      return json(res, 401, {
        error: 'invalid_or_expired_token',
        hint: 'Authorization Bearer token must be the Supabase access_token (JWT) of the signed-in user.',
      });
    }
    const userId = userData.user.id;

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const child_id = body.child_id;
    const problem_id = body.problem_id;

    if (!child_id || !problem_id) {
      return json(res, 400, { error: 'missing_fields', required: ['child_id', 'problem_id'] });
    }

    // Ownership check: child must belong to this parent
    const { data: childRow, error: childErr } = await supabase
      .from('children')
      .select('id,parent_id')
      .eq('id', child_id)
      .maybeSingle();

    if (childErr) return json(res, 500, { error: 'db_error', detail: childErr.message });
    if (!childRow || childRow.parent_id !== userId) {
      return json(res, 404, { error: 'child_not_found' });
    }

    // DB-backed rate limit
    const LIMIT = safeInt(process.env.ATTEMPT_LOG_RATE_LIMIT, 20);
    const WINDOW = safeInt(process.env.ATTEMPT_LOG_RATE_WINDOW_SECONDS, 60);
    const routeKey = 'attempt_log';

    const { data: allowed, error: rlErr } = await supabase.rpc('rpc_rate_limit_check', {
      p_route: routeKey,
      p_limit: LIMIT,
      p_window_seconds: WINDOW,
    });

    if (rlErr) {
      return json(res, 500, { error: 'rate_limit_check_failed', detail: rlErr.message });
    }

    if (!allowed) {
      const retryAfter = WINDOW;
      return json(
        res,
        429,
        {
          error: 'rate_limited',
          route: routeKey,
          limit: LIMIT,
          window_seconds: WINDOW,
          retry_after_seconds: retryAfter,
        },
        {
          'Retry-After': String(retryAfter),
          'X-RateLimit-Limit': String(LIMIT),
          'X-RateLimit-Window': String(WINDOW),
        }
      );
    }

    // Atomic attempt log via RPC (NO extra params!)
    const rpcArgs = buildAttemptRpcArgs({
      ...body,
      track: body.track || body.mode || 'regular',
    });

    const { data: out, error: rpcErr } = await supabase.rpc('rpc_attempt_log_atomic', rpcArgs);

    if (rpcErr) {
      return json(res, 400, {
        error: 'rpc_failed',
        detail: rpcErr.message,
        hint:
          "If this mentions 'schema cache' or 'could not find the function', run: select pg_notify('pgrst','reload schema'); and ensure GRANT EXECUTE on rpc_attempt_log_atomic to authenticated.",
        rpc_args_sent: Object.keys(rpcArgs),
      });
    }

    const row = Array.isArray(out) ? out[0] : out;
    const attempt_id = row?.attempt_id || row?.id || null;
    const attempt_number = row?.attempt_number ?? null;

    return json(res, 200, { ok: true, attempt_id, attempt_number });
  } catch (e) {
    return json(res, 500, { error: 'server_error', detail: String(e?.message || e) });
  }
}