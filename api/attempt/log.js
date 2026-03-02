// api/attempt/log.js
// LogicPals — Attempt logging endpoint (enterprise-grade):
// - Auth required (Supabase JWT)
// - Enforces parent -> child ownership
// - DB-backed per-route rate limit (durable, multi-instance safe)
// - Atomic attempt logging via RPC (no duplicate "active" attempts)

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

// Defaults are conservative. You can override in Vercel Env:
// ATTEMPT_LOG_RATE_LIMIT=20
// ATTEMPT_LOG_RATE_WINDOW_SECONDS=60
const RATE_LIMIT = Number(process.env.ATTEMPT_LOG_RATE_LIMIT ?? 20);
const RATE_WINDOW_SECONDS = Number(process.env.ATTEMPT_LOG_RATE_WINDOW_SECONDS ?? 60);

function json(res, status, body, extraHeaders = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  // CORS (adjust origin in production if needed)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  // Prevent caching (important for auth + rate-limit endpoints)
  res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}

function parseBearer(req) {
  const h = req.headers?.authorization || req.headers?.Authorization || '';
  const m = String(h).match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

function toInt(v, dflt) {
  if (v === null || v === undefined || v === '') return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : dflt;
}

function toBool(v, dflt) {
  if (v === null || v === undefined) return dflt;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(s)) return true;
  if (['false', '0', 'no', 'n'].includes(s)) return false;
  return dflt;
}

async function readJson(req) {
  return await new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
  });
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });

  if (req.method !== 'POST') {
    return json(res, 405, { error: 'method_not_allowed' }, { Allow: 'POST, OPTIONS' });
  }

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return json(res, 500, { error: 'missing_supabase_config' });
  }

  const jwt = parseBearer(req);
  if (!jwt) return json(res, 401, { error: 'missing_bearer_token' });

  let body;
  try {
    body = await readJson(req);
  } catch {
    return json(res, 400, { error: 'invalid_json' });
  }

  const track = String(body.track ?? 'regular').toLowerCase();
  if (!['regular', 'olympiad'].includes(track)) {
    return json(res, 400, { error: 'invalid_track' });
  }

  const childId = body.child_id;
  const problemId = body.problem_id;

  if (!childId || !problemId) {
    return json(res, 400, { error: 'missing_required_fields', required: ['child_id', 'problem_id'] });
  }

  // Supabase client scoped to the user's JWT
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  // Validate JWT and capture user id
  const { data: u, error: uErr } = await supabase.auth.getUser();
  if (uErr || !u?.user?.id) return json(res, 401, { error: 'invalid_token' });
  const userId = u.user.id;

  // Enforce that this user owns the child (parent -> child)
  const { data: childRow, error: childErr } = await supabase
    .from('children')
    .select('id,parent_id')
    .eq('id', childId)
    .maybeSingle();

  if (childErr) return json(res, 500, { error: 'child_lookup_failed', detail: childErr.message });
  if (!childRow) return json(res, 404, { error: 'child_not_found' });
  if (childRow.parent_id !== userId) return json(res, 403, { error: 'forbidden_child' });

  // DB-backed per-route rate limit (durable, multi-instance safe)
  const { data: allow, error: rlErr } = await supabase.rpc('rpc_rate_limit_check', {
    p_route: 'attempt_log',
    p_limit: RATE_LIMIT,
    p_window_seconds: RATE_WINDOW_SECONDS,
  });

  if (rlErr) return json(res, 500, { error: 'rate_limit_failed', detail: rlErr.message });

  if (allow === false) {
    // Enterprise best practice: explicit payload + standard header
    return json(
      res,
      429,
      {
        error: 'rate_limited',
        route: 'attempt_log',
        limit: RATE_LIMIT,
        window_seconds: RATE_WINDOW_SECONDS,
        retry_after_seconds: RATE_WINDOW_SECONDS,
      },
      {
        'Retry-After': String(RATE_WINDOW_SECONDS),
        'X-RateLimit-Limit': String(RATE_LIMIT),
        'X-RateLimit-Window': String(RATE_WINDOW_SECONDS),
      },
    );
  }

  // Map payload -> RPC params (atomic attempt logging path)
  const solvedCorrectly = toBool(body.solved_correctly ?? body.is_correct, null);

  const rpcArgs = {
    // ✅ MUST match your DB function signature (your pg_proc lookup)
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

  const { data: rpcData, error: rpcErr } = await supabase.rpc('rpc_attempt_log_atomic', rpcArgs);

  if (rpcErr) {
    return json(res, 400, {
      error: 'rpc_failed',
      detail: rpcErr.message,
      hint: 'Check (1) pg_proc args for rpc_attempt_log_atomic, (2) problem_id exists in public.problems, (3) PostgREST schema cache reload.',
    });
  }

  const attemptId = rpcData?.[0]?.attempt_id ?? null;
  const attemptNumber = rpcData?.[0]?.attempt_number ?? null;

  // Best-effort immutable audit log (ignore if missing or blocked by RLS)
  try {
    await supabase.from('audit_log').insert({
      actor_user_id: userId,
      action: 'attempt_logged',
      entity: 'attempts',
      entity_id: attemptId,
      details: { track, child_id: childId, problem_id: problemId, attempt_number: attemptNumber },
    });
  } catch (_) {}

  return json(res, 200, { ok: true, attempt_id: attemptId, attempt_number: attemptNumber });
}