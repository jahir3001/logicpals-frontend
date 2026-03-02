// api/attempt/log.js
// LogicPals — Enterprise Attempt Log Endpoint (Atomic RPC + DB rate-limit)
// - Requires Authorization: Bearer <Supabase access_token JWT>
// - Enforces DB rate limit via public.rpc_rate_limit_check()
// - Logs attempts via public.rpc_attempt_log_atomic() (ownership enforced inside RPC)
// - Returns explicit 429 payload + best-practice headers

import { createClient } from '@supabase/supabase-js';

function setCommonHeaders(res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
}

function json(res, status, obj, extraHeaders = {}) {
  setCommonHeaders(res);
  for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  res.statusCode = status;
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

// Basic UUID sanity check (helps catch accidental "..." or broken copy)
function looksLikeUuid(v) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(v || ''));
}

function normalizeBody(req) {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  return body || {};
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return json(res, 204, { ok: true });
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

  // RLS must apply: use the user JWT for all calls
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Validate token (JWT)
  const userResp = await supabase.auth.getUser(token);
  const userId = userResp?.data?.user?.id || null;
  if (!userId) {
    return json(res, 401, {
      error: 'invalid_or_expired_token',
      hint: 'Authorization Bearer token must be the Supabase access_token (JWT) for the signed-in user.',
    });
  }

  const body = normalizeBody(req);

  const track = String(body.track || body.mode || '').toLowerCase().trim();
  const childId = body.child_id || body.childId;
  const problemId = body.problem_id || body.problemId;

  if (!track || !['regular', 'olympiad'].includes(track)) {
    return json(res, 400, { error: 'invalid_track', hint: 'track must be "regular" or "olympiad".' });
  }
  if (!looksLikeUuid(childId) || !looksLikeUuid(problemId)) {
    return json(res, 400, {
      error: 'invalid_ids',
      hint: 'child_id and problem_id must be valid UUIDs.',
      received: { child_id: childId, problem_id: problemId },
    });
  }

  // -----------------------------
  // A) Rate-limit (DB-backed)
  // -----------------------------
  // Tune these as you like (enterprise defaults)
  const ROUTE_KEY = 'attempt_log';
  const LIMIT = 30;          // attempts
  const WINDOW_SECONDS = 60; // per minute

  const rl = await supabase.rpc('rpc_rate_limit_check', {
    p_route: ROUTE_KEY,
    p_limit: LIMIT,
    p_window_seconds: WINDOW_SECONDS,
  });

  if (rl.error) {
    return json(res, 500, {
      error: 'rate_limit_rpc_failed',
      detail: rl.error.message,
      hint: 'Confirm public.rpc_rate_limit_check(p_route text, p_limit int, p_window_seconds int) exists and EXECUTE is granted to authenticated.',
    });
  }

  const allowed = rl.data === true;
  if (!allowed) {
    // ✅ This is where you place “Return a more explicit payload on 429”
    // ✅ And best-practice headers (Retry-After + rate-limit hints)
    return json(
      res,
      429,
      {
        error: 'rate_limited',
        route: ROUTE_KEY,
        limit: LIMIT,
        window_seconds: WINDOW_SECONDS,
        hint: 'Too many requests. Please wait and retry.',
      },
      {
        'Retry-After': String(WINDOW_SECONDS),
        'X-RateLimit-Limit': String(LIMIT),
        // We do not know remaining/reset because the RPC returns boolean only.
        'X-RateLimit-Policy': `${LIMIT};w=${WINDOW_SECONDS}`,
      }
    );
  }

  // -----------------------------
  // B) Atomic attempt logging RPC
  // -----------------------------
  // IMPORTANT: pass only fields that are expected by your CURRENT RPC signature.
  // Your screenshot confirms these exist at least:
  // p_child_id uuid, p_problem_id uuid, p_mode text, p_difficulty_tier text, p_attempt_state text,
  // p_solved_correctly boolean, p_is_correct boolean, p_hints_used integer, ...

  const solvedCorrectly = toBool(body.solved_correctly ?? body.is_correct, false);

  const rpcPayload = {
    p_child_id: childId,
    p_problem_id: problemId,
    p_mode: track, // keep simple: 'regular' / 'olympiad'
    p_difficulty_tier: body.difficulty_tier ?? null,
    p_attempt_state: body.attempt_state ?? 'SUBMITTED',
    p_solved_correctly: solvedCorrectly,
    p_is_correct: solvedCorrectly,
    p_hints_used: toInt(body.hints_used, 0),
    // Common extras (only work if your RPC has defaults or includes these params)
    p_questions_asked: toInt(body.questions_asked, 0),
    p_time_spent_seconds: toInt(body.time_spent_sec ?? body.time_spent_seconds, null),
    p_time_to_first_input_seconds: toInt(body.time_to_first_input_seconds, null),
    p_submitted_answer: body.submitted_answer ?? null,
    p_session_id: body.session_id ?? null,
    p_session_item_id: body.session_item_id ?? null,
  };

  // Remove null/undefined keys so we don't accidentally mismatch signatures
  for (const k of Object.keys(rpcPayload)) {
    if (rpcPayload[k] === null || rpcPayload[k] === undefined) delete rpcPayload[k];
  }

  const r = await supabase.rpc('rpc_attempt_log_atomic', rpcPayload);

  if (r.error) {
    const msg = r.error.message || '';
    const hint = r.error.hint || '';

    // If signature mismatch / schema cache confusion, tell exactly what to do:
    if (
      msg.includes('Could not find the function') ||
      msg.toLowerCase().includes('schema cache')
    ) {
      return json(res, 400, {
        error: 'rpc_signature_mismatch',
        detail: msg,
        hint:
          'Your api/attempt/log.js is calling rpc_attempt_log_atomic with params that do NOT match the current function signature. Re-check the args list in Supabase (pg_get_function_identity_arguments) and ensure log.js rpcPayload matches. Then run: select pg_notify(\'pgrst\', \'reload schema\');',
      });
    }

    return json(res, 500, {
      error: 'rpc_failed',
      detail: msg,
      hint: hint || 'Check the RPC function logic + permissions (EXECUTE) and RLS ownership enforcement inside the function.',
    });
  }

  // r.data could be {attempt_id, attempt_number} or a row
  const out = r.data || {};
  const attemptId = out.attempt_id || out.id || null;
  const attemptNumber = out.attempt_number ?? out.attempt_no ?? null;

  return json(res, 200, {
    ok: true,
    attempt_id: attemptId,
    attempt_number: attemptNumber,
  });
}