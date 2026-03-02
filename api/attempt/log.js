// api/attempt/log.js
// Enterprise-safe attempt logging endpoint for LogicPals (Step 8H)
// - Validates Supabase JWT (access token) from Authorization: Bearer <token>
// - Enforces parent -> child ownership using public.children(parent_id)
// - Rate limit guard via public.rpc_rate_limit_check(...)
// - Uses atomic SECURITY DEFINER RPC: public.rpc_attempt_log_atomic(...) (NO direct writes)
// - Returns explicit 429 payload + Retry-After + X-RateLimit-* headers

import { createClient } from '@supabase/supabase-js';

function sendJson(res, status, obj, headers = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, String(v));
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

async function getUserId(supabase, token) {
  // supabase-js versions vary; support both signatures
  try {
    if (supabase?.auth?.getUser) {
      const r = await supabase.auth.getUser(token);
      if (r?.data?.user?.id) return r.data.user.id;
    }
  } catch (_) {}
  try {
    if (supabase?.auth?.getSession) {
      const r2 = await supabase.auth.getSession();
      if (r2?.data?.session?.user?.id) return r2.data.session.user.id;
    }
  } catch (_) {}
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return sendJson(res, 500, {
      error: 'missing_supabase_config',
      hint: 'Set SUPABASE_URL and SUPABASE_ANON_KEY in Vercel Environment Variables.',
    });
  }

  const token = getBearerToken(req);
  if (!token) return sendJson(res, 401, { error: 'missing_bearer_token' });

  // Use the USER JWT so RLS applies for the ownership check.
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const userId = await getUserId(supabase, token);
  if (!userId) {
    return sendJson(res, 401, {
      error: 'invalid_or_expired_token',
      hint: 'Authorization Bearer token must be the Supabase access_token (JWT) for the signed-in user.',
    });
  }

  // Parse body (Vercel sometimes passes string)
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
    return sendJson(res, 400, { error: 'invalid_track', hint: 'track must be "regular" or "olympiad"' });
  }
  if (!childId || !problemId) {
    return sendJson(res, 400, { error: 'missing_ids', hint: 'Provide child_id and problem_id (UUIDs).' });
  }

  // Ownership check: child must belong to current parent (auth user)
  const { data: childRow, error: childErr } = await supabase
    .from('children')
    .select('id, parent_id')
    .eq('id', childId)
    .maybeSingle();

  if (childErr) return sendJson(res, 500, { error: 'child_lookup_failed', detail: childErr.message });
  if (!childRow) return sendJson(res, 404, { error: 'child_not_found' });
  if (childRow.parent_id !== userId) {
    return sendJson(res, 403, {
      error: 'child_not_owned',
      hint: 'Use the access_token (JWT) for the SAME parent user as children.parent_id.',
    });
  }

  // ✅ Rate limit guard (DB-backed)
  const LIMIT = 20;
  const WINDOW_SECONDS = 60;

  const { data: allow, error: rlErr } = await supabase.rpc('rpc_rate_limit_check', {
    p_route: 'attempt_log',
    p_limit: LIMIT,
    p_window_seconds: WINDOW_SECONDS,
  });

  if (rlErr) {
    return sendJson(res, 500, {
      error: 'rate_limit_failed',
      detail: rlErr.message,
      hint: 'Check rpc_rate_limit_check signature + grants. Also confirm rate_limits PK is correct.',
    });
  }

  if (allow === false) {
    // Best-practice headers + explicit payload
    return sendJson(
      res,
      429,
      {
        error: 'rate_limited',
        retry_after_seconds: WINDOW_SECONDS,
        limit: LIMIT,
        window_seconds: WINDOW_SECONDS,
      },
      {
        'Retry-After': WINDOW_SECONDS,
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

    // keep mode aligned with your attempts schema; default to track
    p_mode: body.mode ?? track,

    p_difficulty_tier: body.difficulty_tier ?? null,
    p_attempt_state: body.attempt_state ?? 'SUBMITTED',

    // support both columns you may have had historically
    p_solved_correctly: solvedCorrectly,
    p_is_correct: solvedCorrectly,

    p_hints_used: toInt(body.hints_used, 0),
    p_questions_asked: toInt(body.questions_asked, 0),
    p_time_spent_seconds: toInt(body.time_spent_sec ?? body.time_spent_seconds, null),
    p_time_to_first_input_seconds: toInt(body.time_to_first_input_seconds, null),
    p_submitted_answer: body.submitted_answer ?? null,
    p_session_id: body.session_id ?? null,
    p_session_item_id: body.session_item_id ?? null,
  };

  const { data: rpcData, error: rpcErr } = await supabase.rpc('rpc_attempt_log_atomic', rpcArgs);

  if (rpcErr) {
    return sendJson(res, 400, {
      error: 'rpc_failed',
      detail: rpcErr.message,
      hint: 'Verify rpc_attempt_log_atomic exists in public schema, parameter names match, and EXECUTE is granted to authenticated.',
    });
  }

  // rpcData may be array-of-rows OR single object depending on function RETURNS
  const row = Array.isArray(rpcData) ? rpcData[0] : rpcData;
  const attemptId = row?.attempt_id ?? null;
  const attemptNumber = row?.attempt_number ?? null;

  return sendJson(res, 200, { ok: true, attempt_id: attemptId, attempt_number: attemptNumber });
}