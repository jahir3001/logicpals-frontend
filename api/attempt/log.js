// api/attempt/log.js
// Enterprise-safe attempt logging endpoint for LogicPals (Step 8H)
// - Validates Supabase JWT (access token) from Authorization: Bearer <token>
// - Enforces parent -> child ownership using public.children(parent_id)
// - Rate limit guard via public.rpc_rate_limit_check(...)
// - Uses atomic SECURITY DEFINER RPC: public.rpc_attempt_log_atomic(...) (NO direct writes)
// - Returns explicit 429 payload + best-practice headers

import { createClient } from '@supabase/supabase-js';

function sendJson(res, status, obj, headers = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  // security + caching hygiene
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

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

function isUuid(x) {
  return typeof x === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x);
}

async function getUserId(supabase, token) {
  // supabase-js versions vary; support both signatures
  try {
    const r = await supabase.auth.getUser(token);
    if (r?.data?.user?.id) return r.data.user.id;
  } catch (_) {}
  try {
    const r2 = await supabase.auth.getUser();
    if (r2?.data?.user?.id) return r2.data.user.id;
  } catch (_) {}
  return null;
}

export default async function handler(req, res) {
  // CORS (safe default for Vercel functions)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return sendJson(res, 200, { ok: true });
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

  // Use USER JWT so RLS applies for ownership checks
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

  // Parse body safely
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
    return sendJson(res, 400, { error: 'invalid_track', hint: 'track must be "regular" or "olympiad".' });
  }
  if (!childId || !problemId) {
    return sendJson(res, 400, { error: 'missing_ids', hint: 'Provide child_id and problem_id (UUIDs).' });
  }
  if (!isUuid(childId) || !isUuid(problemId)) {
    return sendJson(res, 400, { error: 'invalid_uuid', hint: 'child_id and problem_id must be valid UUIDs.' });
  }

  // Ownership check: child must belong to current parent
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

  // Rate limit (DB-backed)
  // Tune these to your product policy:
  const LIMIT = 20;
  const WINDOW_SECONDS = 60;
  const ROUTE = 'attempt_log';

  const { data: allow, error: rlErr } = await supabase.rpc('rpc_rate_limit_check', {
    p_route: ROUTE,
    p_limit: LIMIT,
    p_window_seconds: WINDOW_SECONDS,
  });

  if (rlErr) {
    return sendJson(res, 500, { error: 'rate_limit_failed', detail: rlErr.message });
  }

  if (allow === false) {
    // Best-practice: Retry-After header + explicit body
    return sendJson(
      res,
      429,
      {
        error: 'rate_limited',
        route: ROUTE,
        limit: LIMIT,
        window_seconds: WINDOW_SECONDS,
        retry_after_seconds: WINDOW_SECONDS,
      },
      {
        'Retry-After': WINDOW_SECONDS,
        'X-RateLimit-Limit': LIMIT,
      }
    );
  }

  // Map payload -> RPC params (atomic write path)
  const solvedCorrectly = toBool(body.solved_correctly ?? body.is_correct, null);

  const rpcArgs = {
    p_child_id: childId,
    p_problem_id: problemId,

    // keep these aligned with your attempts schema
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
    p_session_id: body.session_id ?? null,
    p_session_item_id: body.session_item_id ?? null,

    // optional
    p_ai_conversation: body.ai_conversation ?? null,
  };

  const { data: rpcData, error: rpcErr } = await supabase.rpc('rpc_attempt_log_atomic', rpcArgs);

  if (rpcErr) {
    // This is where "schema cache" / signature mismatch shows up
    return sendJson(res, 400, {
      error: 'rpc_failed',
      detail: rpcErr.message,
      hint: 'If this mentions "schema cache", reload PostgREST schema or restart Supabase API. Also re-check rpc_attempt_log_atomic signature and GRANT.',
    });
  }

  const attemptId = rpcData?.[0]?.attempt_id ?? null;
  const attemptNumber = rpcData?.[0]?.attempt_number ?? null;

  return sendJson(res, 200, {
    ok: true,
    attempt_id: attemptId,
    attempt_number: attemptNumber,
  });
}