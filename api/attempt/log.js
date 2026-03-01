// api/attempt/log.js
// Enterprise-safe attempt logging endpoint for LogicPals
// - Validates Supabase JWT (access token) from Authorization: Bearer <token>
// - Enforces parent -> child ownership using public.children(parent_id)
// - Inserts into public.attempts using REAL schema columns (no phantom fields like skill_track)
// - Writes immutable audit event into public.audit_log (if table exists)

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

async function getUserId(supabase, token) {
  // supabase-js versions vary; support both signatures
  try {
    if (supabase?.auth?.getUser) {
      const r = await supabase.auth.getUser(token);
      if (r?.data?.user?.id) return r.data.user.id;
      if (r?.data?.user?.user_metadata?.sub) return r.data.user.user_metadata.sub;
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

  // IMPORTANT: Use the USER's JWT as Authorization so RLS applies correctly.
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const userId = await getUserId(supabase, token);
  if (!userId) {
    return json(res, 401, {
      error: 'invalid_or_expired_token',
      hint: 'Your Authorization Bearer token must be the Supabase access_token (JWT) for the signed-in user.',
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

  if (childErr) {
    return json(res, 500, { error: 'child_lookup_failed', detail: childErr.message });
  }
  if (!childRow) {
    return json(res, 404, { error: 'child_not_found' });
  }
  if (childRow.parent_id !== userId) {
    return json(res, 403, {
      error: 'child_id does not belong to this parent',
      hint: 'Use the access_token (JWT) for the SAME parent user as children.parent_id, then pick a child id where children.parent_id = auth user id.',
    });
  }

  // Map payload -> real attempts schema
  const solvedCorrectly = toBool(body.solved_correctly ?? body.is_correct, false);

  // Use provided attempt_number if valid, else compute next.
  let attemptNumber = toInt(body.attempt_number, null);
  if (!attemptNumber || attemptNumber < 1) {
    attemptNumber = await computeNextAttemptNumber(supabase, childId, problemId);
  }

  const row = {
    child_id: childId,
    problem_id: problemId,

    // REQUIRED in your schema
    attempt_number: attemptNumber,

    // Keep both fields for compatibility (your table has BOTH)
    solved_correctly: solvedCorrectly,
    is_correct: solvedCorrectly,

    // Optional analytics fields (all exist in your schema)
    hints_used: toInt(body.hints_used, 0),
    questions_asked: toInt(body.questions_asked, 0),
    time_spent_seconds: toInt(body.time_spent_sec ?? body.time_spent_seconds, null),
    time_to_first_input_seconds: toInt(body.time_to_first_input_seconds, null),

    submitted_answer: body.submitted_answer ?? null,
    ai_conversation: body.ai_conversation ?? null,

    mode: body.mode ?? track,               // e.g. 'regular' or 'olympiad'
    difficulty_tier: body.difficulty_tier ?? null,
    attempt_state: body.attempt_state ?? 'SUBMITTED',

    session_id: body.session_id ?? null,
    session_item_id: body.session_item_id ?? null,

    started_at: body.started_at ?? null,
    submitted_at: body.submitted_at ?? null,
    completed_at: body.completed_at ?? null,

    user_id: userId,
    active: true,
  };

  // Insert attempt
  const { data: inserted, error: insErr } = await supabase
    .from('attempts')
    .insert(row)
    .select('id, created_at, attempt_number')
    .maybeSingle();

  if (insErr) {
    return json(res, 500, {
      error: 'insert_failed',
      detail: insErr.message,
      hint: 'Verify attempts table columns match row keys; if you recently changed schema, redeploy Vercel.',
    });
  }

  // Best-effort immutable audit log
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
  } catch (_) {
    // ignore if audit_log not present or RLS blocks it
  }

  return json(res, 200, {
    ok: true,
    attempt_id: inserted?.id,
    attempt_number: inserted?.attempt_number ?? attemptNumber,
    created_at: inserted?.created_at,
  });
}
