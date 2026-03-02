// api/attempt/log.js
// Enterprise-safe attempt logging endpoint for LogicPals (Step 8H)
// - Validates Supabase JWT (access token) from Authorization: Bearer <token>
// - Enforces parent -> child ownership using public.children(parent_id)
// - Rate limit guard via public.rpc_rate_limit_check(...)
// - Uses atomic SECURITY DEFINER RPC: public.rpc_attempt_log_atomic(...) (NO direct writes)
// - Returns explicit 429 payload + headers (Retry-After, X-RateLimit-*)
// - Best-effort immutable audit event into public.audit_log (if table exists)

import { createClient } from '@supabase/supabase-js';

function json(res, status, obj, extraHeaders = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, String(v));
  res.end(JSON.stringify(obj));
}

function getBearerToken(req) {
  const h = req.headers?.authorization || req.headers?.Authorization || '';
  const m = /^Bearer\s+(.+)$/.exec(String(h).trim());
  return m ? m[1] : null;
}

function toInt(v, def = null) {
  if (v === undefined || v === null || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : def;
}

function toBool(v, def = null) {
  if (v === undefined || v === null) return def;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const s = String(v).toLowerCase().trim();
  if (['true', '1', 'yes', 'y'].includes(s)) return true;
  if (['false', '0', 'no', 'n'].includes(s)) return false;
  return def;
}

async function getUserId(supabase) {
  // supabase-js v2: auth.getUser() reads from Authorization header
  const { data, error } = await supabase.auth.getUser();
  if (error || !data?.user?.id) return null;
  return data.user.id;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return json(res, 500, {
      error: 'missing_supabase_config',
      hint: 'Set SUPABASE_URL and SUPABASE_ANON_KEY in Vercel Environment Variables.',
    });
  }

  const token = getBearerToken(req);
  if (!token) return json(res, 401, { error: 'missing_bearer_token' });

  // Use USER JWT so ownership checks respect RLS
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const userId = await getUserId(supabase);
  if (!userId) {
    return json(res, 401, {
      error: 'invalid_or_expired_token',
      hint: 'Authorization Bearer token must be the Supabase access_token (JWT) for the signed-in user.',
    });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }
  body = body || {};

  const track = String(body.track || '').toLowerCase().trim();
  const childId = body.child_id || body.childId;
  const problemId = body.problem_id || body.problemId;

  if (!track || !['regular', 'olympiad'].includes(track)) {
    return json(res, 400, { error: 'invalid_track', hint: 'track must be "regular" or "olympiad"' });
  }
  if (!childId || !problemId) {
    return json(res, 400, { error: 'missing_ids', hint: 'Provide child_id and problem_id (UUIDs).' });
  }

  // Ownership check: child must belong to current parent (auth user)
  const { data: childRow, error: childErr } = await supabase
    .from('children')
    .select('id, parent_id')
    .eq('id', childId)
    .maybeSingle();

  if (childErr) {
    return json(res, 500, { error: 'child_lookup_failed', detail: childErr.message });
  }
  if (!childRow) {
    return json(res, 404, { error: 'child_not_found', hint: 'child_id does not exist or is not visible under RLS.' });
  }
  if (childRow.parent_id !== userId) {
    return json(res, 403, {
      error: 'child_not_owned',
      hint: 'Use the access_token (JWT) for the SAME parent user as children.parent_id.',
    });
  }

  // === Rate limit (DB-backed) ===
  const ROUTE_KEY = 'attempt_log';
  const LIMIT = 20;
  const WINDOW_SECONDS = 60;
  const RETRY_AFTER_SECONDS = WINDOW_SECONDS;

  const { data: allow, error: rlErr } = await supabase.rpc('rpc_rate_limit_check', {
    p_route: ROUTE_KEY,
    p_limit: LIMIT,
    p_window_seconds: WINDOW_SECONDS,
  });

  if (rlErr) {
    return json(res, 500, { error: 'rate_limit_failed', detail: rlErr.message });
  }

  if (allow === false) {
    // Enterprise-grade 429: explicit body + headers
    return json(
      res,
      429,
      {
        error: 'rate_limited',
        route: ROUTE_KEY,
        limit: LIMIT,
        window_seconds: WINDOW_SECONDS,
        retry_after_seconds: RETRY_AFTER_SECONDS,
      },
      {
        'Retry-After': RETRY_AFTER_SECONDS,
        'X-RateLimit-Limit': LIMIT,
        'X-RateLimit-Window': WINDOW_SECONDS,
      }
    );
  }

  // Map payload -> RPC params (atomic write path)
  const solvedCorrectly = toBool(body.solved_correctly ?? body.is_correct, null);

  const rpcArgs = {
    p_child_id: childId,
    p_problem_id: problemId,

    // store track into mode (compatible with your schema)
    p_mode: body.mode ?? track,

    p_difficulty_tier: body.difficulty_tier ?? null,
    p_attempt_state: body.attempt_state ?? 'SUBMITTED',

    p_solved_correctly: solvedCorrectly,
    p_is_correct: solvedCorrectly,

    p_hints_used: toInt(body.hints_used, 0),
    p_questions_asked: toInt(body.questions_asked, 0),

    p_time_spent_seconds: toInt(body.time_spent_sec ?? body.time_spent_seconds, null),
    p_time_to_first_input_seconds: toInt(body.time_to_first_input_seconds, null),

    p_submitted_answer: body.submitted_answer ?? null,
    p_ai_conversation: body.ai_conversation ?? null,
    p_score_delta: toInt(body.score_delta, null),

    // keep attempt_number if provided, else RPC can compute
    p_attempt_number: toInt(body.attempt_number, null),

    // session ids if present
    p_session_id: body.session_id ?? null,
    p_session_item_id: body.session_item_id ?? null,
  };

  const { data: rpcData, error: rpcErr } = await supabase.rpc('rpc_attempt_log_atomic', rpcArgs);

  if (rpcErr) {
    return json(res, 400, {
      error: 'rpc_failed',
      detail: rpcErr.message,
      hint: 'Ensure public.rpc_attempt_log_atomic(...) exists and is granted to authenticated.',
    });
  }

  const attemptId = rpcData?.[0]?.attempt_id ?? null;
  const attemptNumber = rpcData?.[0]?.attempt_number ?? null;

  // Best-effort immutable audit log
  try {
    await supabase.from('audit_log').insert({
      actor_user_id: userId,
      action: 'attempt_logged',
      entity: 'attempts',
      entity_id: attemptId,
      details: { track, child_id: childId, problem_id: problemId, attempt_number: attemptNumber },
    });
  } catch (_) {
    // ignore if audit_log not present or RLS blocks it
  }

  return json(res, 200, { ok: true, attempt_id: attemptId, attempt_number: attemptNumber });
}