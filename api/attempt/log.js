// api/attempt/log.js
// LogicPals — Enterprise Attempt Logging Endpoint (FINAL)
// Version: 1.0.0
//
// Guarantees:
// - Requires Supabase access_token (JWT) in Authorization: Bearer <token>
// - Enforces parent -> child ownership via public.children(parent_id)
// - Inserts ONLY real columns that exist in public.attempts (per your schema screenshots)
// - Best-effort immutable logging into public.audit_log (your DB has audit_log + triggers)
//
// Notes:
// - "PASTE_YOUR_ACCESS_TOKEN_HERE" = Supabase access_token (JWT). Same thing for our purposes.
// - If your RLS blocks access to children/attempts, this endpoint will fail (by design).

import { createClient } from '@supabase/supabase-js';

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
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

// Safe fallback: decode JWT payload and read `sub`
// (No signature verification here; we only use it as a fallback if supabase-js method is unavailable)
function decodeJwtSub(token) {
  try {
    const parts = String(token).split('.');
    if (parts.length < 2) return null;
    const payloadB64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = payloadB64 + '='.repeat((4 - (payloadB64.length % 4)) % 4);
    const jsonStr = Buffer.from(padded, 'base64').toString('utf8');
    const payload = JSON.parse(jsonStr);
    return payload?.sub || null;
  } catch {
    return null;
  }
}

async function getUserId(supabase, token) {
  // Prefer official method first
  try {
    if (supabase?.auth?.getUser) {
      // supabase-js v2 expects no token if Authorization header is already set globally
      const r = await supabase.auth.getUser();
      if (r?.data?.user?.id) return r.data.user.id;
    }
  } catch {
    // ignore and fallback
  }

  // Fallback to JWT sub
  return decodeJwtSub(token);
}

async function computeNextAttemptNumber(supabase, childId, problemId) {
  const { data, error } = await supabase
    .from('attempts')
    .select('attempt_number')
    .eq('child_id', childId)
    .eq('problem_id', problemId)
    .order('attempt_number', { ascending: false })
    .limit(1);

  if (error) return 1;
  const last = data?.[0]?.attempt_number;
  const n = Number(last);
  return Number.isFinite(n) ? n + 1 : 1;
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

  // IMPORTANT: Use the user JWT in global headers so RLS is enforced.
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const userId = await getUserId(supabase, token);
  if (!userId) {
    return json(res, 401, {
      error: 'invalid_or_expired_token',
      hint: 'Authorization must be the Supabase access_token (JWT) for the signed-in user.',
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

  if (childErr) return json(res, 500, { error: 'child_lookup_failed', detail: childErr.message });
  if (!childRow) return json(res, 404, { error: 'child_not_found' });

  if (childRow.parent_id !== userId) {
    return json(res, 403, {
      error: 'child_id does not belong to this parent',
      hint: 'Use the access_token (JWT) for the SAME parent user as children.parent_id, then choose a child where children.parent_id = your auth user id.',
    });
  }

  // attempts table schema (your screenshots show these columns exist):
  // id, child_id, problem_id, attempt_number (NOT NULL), solved_correctly, is_correct,
  // hints_used, questions_asked, ai_conversation, created_at, completed_at, user_id,
  // attempt_state, difficulty_tier, mode, started_at, submitted_at, review_started_at,
  // score_delta, active, time_spent_seconds, time_to_first_input_seconds, submitted_answer,
  // session_id, session_item_id

  const solvedCorrectly = toBool(body.solved_correctly ?? body.is_correct, false);

  let attemptNumber = toInt(body.attempt_number, null);
  if (!attemptNumber || attemptNumber < 1) {
    attemptNumber = await computeNextAttemptNumber(supabase, childId, problemId);
  }

  const row = {
    child_id: childId,
    problem_id: problemId,
    attempt_number: attemptNumber,

    solved_correctly: solvedCorrectly,
    is_correct: solvedCorrectly,

    hints_used: toInt(body.hints_used, 0),
    questions_asked: toInt(body.questions_asked, 0),

    time_spent_seconds: toInt(body.time_spent_sec ?? body.time_spent_seconds, null),
    time_to_first_input_seconds: toInt(body.time_to_first_input_seconds, null),

    submitted_answer: body.submitted_answer ?? null,
    ai_conversation: body.ai_conversation ?? null,

    mode: body.mode ?? track, // 'regular' or 'olympiad'
    difficulty_tier: body.difficulty_tier ?? null,
    attempt_state: body.attempt_state ?? 'SUBMITTED',

    session_id: body.session_id ?? null,
    session_item_id: body.session_item_id ?? null,

    started_at: body.started_at ?? null,
    submitted_at: body.submitted_at ?? null,
    review_started_at: body.review_started_at ?? null,
    completed_at: body.completed_at ?? null,

    user_id: userId,
    active: true,
  };

  const { data: inserted, error: insErr } = await supabase
    .from('attempts')
    .insert(row)
    .select('id, created_at, attempt_number')
    .maybeSingle();

  if (insErr) {
    return json(res, 500, {
      error: 'insert_failed',
      detail: insErr.message,
      hint: 'If schema recently changed, redeploy Vercel. Also confirm RLS permits inserts for this user.',
    });
  }

  // Best-effort immutable audit log into public.audit_log
  // (You already have triggers: no_update / no_delete)
  try {
    await supabase.from('audit_log').insert({
      actor_user_id: userId,
      action: 'attempt_logged',
      entity: 'attempts',
      entity_id: inserted?.id ?? null,
      details: {
        track,
        child_id: childId,
        problem_id: problemId,
        attempt_number: inserted?.attempt_number ?? attemptNumber,
      },
    });
  } catch {
    // ignore if audit_log is missing or blocked by RLS
  }

  return json(res, 200, {
    ok: true,
    attempt_id: inserted?.id,
    attempt_number: inserted?.attempt_number ?? attemptNumber,
    created_at: inserted?.created_at,
  });
}