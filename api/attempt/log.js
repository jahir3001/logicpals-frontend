// api/attempt/log.js
import { createClient } from '@supabase/supabase-js';

function send(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
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
  const s = String(v).toLowerCase().trim();
  if (['true', '1', 'yes', 'y'].includes(s)) return true;
  if (['false', '0', 'no', 'n'].includes(s)) return false;
  return def;
}

async function getUserId(supabase, token) {
  try {
    const r = await supabase.auth.getUser(token);
    return r?.data?.user?.id || null;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return send(res, 500, {
      error: 'missing_supabase_config',
      hint: 'Set SUPABASE_URL and SUPABASE_ANON_KEY in Vercel Environment Variables.',
    });
  }

  const token = getBearerToken(req);
  if (!token) return send(res, 401, { error: 'missing_bearer_token' });

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const userId = await getUserId(supabase, token);
  if (!userId) {
    return send(res, 401, {
      error: 'invalid_or_expired_token',
      hint: 'Authorization Bearer token must be the Supabase access_token (JWT) for the signed-in user.',
    });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const track = String(body.track || '').toLowerCase().trim();
  const childId = body.child_id || body.childId;
  const problemId = body.problem_id || body.problemId;

  if (!track || !['regular', 'olympiad'].includes(track)) {
    return send(res, 400, { error: 'invalid_track', hint: 'track must be "regular" or "olympiad"' });
  }
  if (!childId || !problemId) {
    return send(res, 400, { error: 'missing_ids', hint: 'Provide child_id and problem_id (UUIDs).' });
  }

  // Ownership check: child must belong to current parent
  const { data: childRow, error: childErr } = await supabase
    .from('children')
    .select('id, parent_id')
    .eq('id', childId)
    .maybeSingle();

  if (childErr) return send(res, 500, { error: 'child_lookup_failed', detail: childErr.message });
  if (!childRow) return send(res, 404, { error: 'child_not_found', hint: 'Check child_id UUID (common typo like 42a6 vs 42e6).' });
  if (childRow.parent_id !== userId) return send(res, 403, { error: 'child_not_owned' });

  // ✅ DB-backed rate limit (20 req / 60 sec per parent for this route)
  const { data: allow, error: rlErr } = await supabase.rpc('rpc_rate_limit_check', {
    p_route: 'attempt_log',
    p_limit: 20,
    p_window_seconds: 60,
  });

  if (rlErr) return send(res, 500, { error: 'rate_limit_failed', detail: rlErr.message });
  if (allow === false) return send(res, 429, { error: 'rate_limited', retry_after_seconds: 60 });

  // Atomic attempt logging via SECURITY DEFINER RPC
  const solvedCorrectly = toBool(body.solved_correctly ?? body.is_correct, null);

  const rpcArgs = {
    p_child_id: childId,
    p_problem_id: problemId,
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
  };

  const { data: out, error: rpcErr } = await supabase.rpc('rpc_attempt_log_atomic', rpcArgs);

  if (rpcErr) {
    return send(res, 400, { error: 'rpc_failed', detail: rpcErr.message });
  }

  return send(res, 200, {
    ok: true,
    attempt_id: out?.[0]?.attempt_id ?? null,
    attempt_number: out?.[0]?.attempt_number ?? null,
  });
}