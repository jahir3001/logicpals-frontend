// api/attempt/log.js — Secure server-side attempt logging
// Vercel Serverless Function (Node.js runtime)
//
// Required env vars in Vercel dashboard:
//   SUPABASE_URL          — your Supabase project URL
//   SUPABASE_SERVICE_KEY   — service_role key (NOT the anon key)
//   SUPABASE_ANON_KEY      — anon key (for JWT verification)
//
// The service_role key bypasses RLS and lets us insert with full control.
// The anon key is used only to verify the JWT sent by the client.

const { createClient } = require('@supabase/supabase-js');

// --- Best-effort in-memory rate limiting (per lambda instance) ---
// NOTE: Serverless instances can scale horizontally, so this is not a perfect global limiter.
// It still protects against accidental floods and basic abuse.
// For strict global rate limiting, back with Redis/Upstash or a DB-based limiter.
const ATTEMPT_LOG_RATE_LIMIT_PER_MIN = Number.parseInt(process.env.ATTEMPT_LOG_RATE_LIMIT_PER_MIN || "60", 10);
const _rl = new Map(); // key -> { windowStartMs, count }

function checkRateLimit(key) {
  if (!Number.isFinite(ATTEMPT_LOG_RATE_LIMIT_PER_MIN) || ATTEMPT_LOG_RATE_LIMIT_PER_MIN <= 0) return { ok: true };

  const now = Date.now();
  const windowMs = 60_000;

  const cur = _rl.get(key);
  if (!cur || (now - cur.windowStartMs) >= windowMs) {
    _rl.set(key, { windowStartMs: now, count: 1 });
    return { ok: true, remaining: ATTEMPT_LOG_RATE_LIMIT_PER_MIN - 1 };
  }

  if (cur.count >= ATTEMPT_LOG_RATE_LIMIT_PER_MIN) {
    const retryAfterSec = Math.max(1, Math.ceil((windowMs - (now - cur.windowStartMs)) / 1000));
    return { ok: false, retryAfterSec };
  }

  cur.count += 1;
  return { ok: true, remaining: Math.max(0, ATTEMPT_LOG_RATE_LIMIT_PER_MIN - cur.count) };
}

// UUID validation
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUUID(v) { return typeof v === 'string' && UUID_RE.test(v); }

// Allowed fields and their types for sanitization
const ALLOWED_FIELDS = {
  problem_id:                 'uuid',
  solved_correctly:           'boolean',
  is_correct:                 'boolean',
  hints_used:                 'integer',
  questions_asked:            'integer',
  attempt_number:             'integer',
  submitted_answer:           'string',
  ai_conversation:            'json',
  time_spent_seconds:         'integer',
  time_to_first_input_seconds:'integer',
  started_at:                 'timestamp',
  completed_at:               'timestamp',
  session_id:                 'uuid',
  mode:                       'string',
  difficulty_tier:            'string',
  attempt_state:              'string'
};

function sanitizeRow(body) {
  const clean = {};
  for (const [key, type] of Object.entries(ALLOWED_FIELDS)) {
    const val = body[key];
    if (val === undefined || val === null) continue;
    switch (type) {
      case 'uuid':
        if (isUUID(val)) clean[key] = val;
        break;
      case 'boolean':
        clean[key] = !!val;
        break;
      case 'integer':
        const n = parseInt(val, 10);
        if (!isNaN(n) && n >= 0 && n < 100000) clean[key] = n;
        break;
      case 'string':
        if (typeof val === 'string' && val.length < 10000) clean[key] = val.slice(0, 10000);
        break;
      case 'json':
        if (Array.isArray(val) && val.length < 200) clean[key] = val;
        break;
      case 'timestamp':
        if (typeof val === 'string' && !isNaN(Date.parse(val))) clean[key] = val;
        break;
    }
  }
  return clean;
}

module.exports = async function handler(req, res) {
  // CORS — locked to your domain (set ALLOWED_ORIGIN in Vercel env)
  const origin = process.env.ALLOWED_ORIGIN || 'https://logicpals-frontend.vercel.app';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Check env — ALL THREE required, no fallbacks
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
  // Vercel env uses SUPABASE_SERVICE_ROLE_KEY (recommended). We also accept legacy SUPABASE_SERVICE_KEY.
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !SUPABASE_ANON_KEY) {
    console.error('[attempt/log] Missing env:', { url: !!SUPABASE_URL, service: !!SUPABASE_SERVICE_KEY, anon: !!SUPABASE_ANON_KEY });
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  // Extract JWT from Authorization header
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'Missing authorization token' });

  // Verify JWT using ANON key only (never service key for auth verification)
  const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const { data: { user }, error: authError } = await anonClient.auth.getUser(token);

  // Rate limit per authenticated parent/user
  const rlKey = `attempt_log:${user.id}`;
  const rlRes = checkRateLimit(rlKey);
  if (!rlRes.ok) {
    res.setHeader('Retry-After', String(rlRes.retryAfterSec));
    return res.status(429).json({ error: 'Rate limit exceeded' });
  }
  if (authError || !user) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  // Parse body
  const body = req.body;

  // Backward-compatible aliases from older clients
  // - track -> mode
  // - time_spent_sec -> time_spent_seconds
  if (body && body.data && typeof body.data === 'object') {
    if (body.data.track && !body.data.mode) body.data.mode = body.data.track;
    if (typeof body.data.time_spent_sec !== 'undefined' && typeof body.data.time_spent_seconds === 'undefined') {
      body.data.time_spent_seconds = body.data.time_spent_sec;
    }
  }

  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'Invalid body' });

  // Validate problem_id is a real UUID
  if (!isUUID(body.problem_id)) {
    return res.status(400).json({ error: 'Invalid problem_id' });
  }

  // Create service-role client (bypasses RLS)
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  // Resolve child_id: verify this child belongs to this parent
  let childId = null;
  if (isUUID(body.child_id)) {
    const { data: child } = await sb
      .from('children')
      .select('id, parent_id')
      .eq('id', body.child_id)
      .single();

    if (child && child.parent_id === user.id) {
      childId = child.id;
    } else {
      // Enterprise-grade: never silently accept a mismatched child_id.
      return res.status(403).json({ error: 'child_id does not belong to this parent' });
    }
  }

  // Fallback: look up child by parent_id
  if (!childId) {
    const { data: child } = await sb
      .from('children')
      .select('id')
      .eq('parent_id', user.id)
      .single();
    if (child) childId = child.id;
  }

  // Sanitize the row — only allow known fields with validated types
  const row = sanitizeRow(body);
  row.user_id = user.id;
  if (childId) row.child_id = childId;

  // Ensure required fields
  if (!row.problem_id) return res.status(400).json({ error: 'problem_id required' });
  if (row.attempt_number === undefined) row.attempt_number = 1;

  // ═══ Track verification: confirm problem matches claimed mode ═══
  if (row.mode) {
    const { data: problem } = await sb
      .from('problems')
      .select('olympiad_level')
      .eq('id', row.problem_id)
      .single();

    if (problem) {
      const expectedLevel = row.mode === 'olympiad' ? 'olympiad' : 'regular';
      if (problem.olympiad_level && problem.olympiad_level !== expectedLevel) {
        console.warn('[attempt/log] Track mismatch:', { claimed: row.mode, actual: problem.olympiad_level });
        // Auto-correct to the real track instead of rejecting
        row.mode = problem.olympiad_level === 'olympiad' ? 'olympiad' : 'regular';
      }
    }
  }

  // ═══ Insert attempt ═══
  const { data, error } = await sb.from('attempts').insert([row]).select('id');
  if (error) {
    console.error('[attempt/log] Insert error:', error.message, error.code);
    return res.status(500).json({ error: 'Failed to save attempt', detail: error.message });
  }

  const attemptId = data?.[0]?.id || null;

  // ═══ Audit log — record who wrote what and when ═══
  try {
    await sb.from('audit_log').insert([{
      action: 'attempt_created',
      user_id: user.id,
      child_id: childId || null,
      resource_id: attemptId,
      resource_type: 'attempt',
      metadata: {
        problem_id: row.problem_id,
        is_correct: row.is_correct,
        mode: row.mode || null,
        ip: req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || null,
        user_agent: (req.headers['user-agent'] || '').slice(0, 200)
      }
    }]);
  } catch (auditErr) {
    // Audit failure must never block the attempt save
    console.warn('[attempt/log] Audit log failed:', auditErr.message);
  }

  return res.status(200).json({
    ok: true,
    id: attemptId,
    child_id: childId
  });
};