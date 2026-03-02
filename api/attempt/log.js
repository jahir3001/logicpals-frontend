// api/attempt/log.js
// LogicPals — Enterprise Attempt Logging Endpoint
// - Validates Supabase JWT (Authorization: Bearer <access_token>)
// - Enforces parent->child ownership via public.children
// - DB-backed rate limiting via public.rpc_rate_limit_check(p_route, p_limit, p_window_seconds)
// - Atomic write via public.rpc_attempt_log_atomic(...)
// - Returns proper 429 payload + RateLimit headers

import { createClient } from "@supabase/supabase-js";

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  // Let browser read rate limit headers
  res.setHeader(
    "Access-Control-Expose-Headers",
    "Retry-After, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset"
  );
}

function json(res, status, obj, extraHeaders = {}) {
  setCors(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  res.end(JSON.stringify(obj));
}

function getBearerToken(req) {
  const h = req.headers?.authorization || req.headers?.Authorization || "";
  const m = /^Bearer\s+(.+)$/.exec(String(h).trim());
  return m ? m[1] : null;
}

function isUuid(v) {
  if (!v) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(v).trim()
  );
}

function toInt(v, def = null) {
  if (v === undefined || v === null || v === "") return def;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : def;
}

function toBool(v, def = null) {
  if (v === undefined || v === null) return def;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  const s = String(v).toLowerCase().trim();
  if (["true", "1", "yes", "y"].includes(s)) return true;
  if (["false", "0", "no", "n"].includes(s)) return false;
  return def;
}

async function getUserId(supabase, token) {
  try {
    const r = await supabase.auth.getUser(token);
    return r?.data?.user?.id ?? null;
  } catch {
    return null;
  }
}

function computeRateLimitMeta(limit, windowSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const resetIn = windowSeconds - (now % windowSeconds);
  const reset = now + resetIn;
  return { now, resetIn, reset, limit };
}

export default async function handler(req, res) {
  // CORS preflight
  if (req.method === "OPTIONS") {
    setCors(res);
    res.statusCode = 204;
    res.end("");
    return;
  }

  if (req.method !== "POST") {
    return json(res, 405, { error: "method_not_allowed" });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return json(res, 500, {
      error: "missing_supabase_config",
      hint: "Set SUPABASE_URL and SUPABASE_ANON_KEY in Vercel Environment Variables.",
    });
  }

  const token = getBearerToken(req);
  if (!token) return json(res, 401, { error: "missing_bearer_token" });

  // Use the user's JWT so RLS applies for ownership checks
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const userId = await getUserId(supabase, token);
  if (!userId) {
    return json(res, 401, {
      error: "invalid_or_expired_token",
      hint: "Authorization Bearer token must be the Supabase access_token (JWT) for the signed-in user.",
    });
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }
  body = body || {};

  const track = String(body.track || "").toLowerCase().trim();
  const childId = body.child_id || body.childId;
  const problemId = body.problem_id || body.problemId;

  if (!track || !["regular", "olympiad"].includes(track)) {
    return json(res, 400, {
      error: "invalid_track",
      hint: 'track must be "regular" or "olympiad".',
    });
  }
  if (!isUuid(childId) || !isUuid(problemId)) {
    return json(res, 400, {
      error: "invalid_uuid",
      hint: "child_id and problem_id must be valid UUIDs.",
    });
  }

  // Ownership check: child must belong to current parent (auth user)
  const { data: childRow, error: childErr } = await supabase
    .from("children")
    .select("id, parent_id")
    .eq("id", childId)
    .maybeSingle();

  if (childErr) return json(res, 500, { error: "child_lookup_failed", detail: childErr.message });
  if (!childRow) return json(res, 404, { error: "child_not_found" });
  if (childRow.parent_id !== userId) {
    return json(res, 403, {
      error: "child_not_owned",
      hint: "Use the access_token (JWT) for the SAME parent user as children.parent_id.",
    });
  }

  // Rate limit (per parent per route)
  const LIMIT = 20;
  const WINDOW = 60;
  const meta = computeRateLimitMeta(LIMIT, WINDOW);

  const { data: allow, error: rlErr } = await supabase.rpc("rpc_rate_limit_check", {
    p_route: "attempt_log",
    p_limit: LIMIT,
    p_window_seconds: WINDOW,
  });

  if (rlErr) return json(res, 500, { error: "rate_limit_failed", detail: rlErr.message });

  if (allow === false) {
    return json(
      res,
      429,
      {
        error: "rate_limited",
        route: "attempt_log",
        limit: LIMIT,
        window_seconds: WINDOW,
        retry_after_seconds: meta.resetIn,
        reset_unix: meta.reset,
      },
      {
        "Retry-After": String(meta.resetIn),
        "RateLimit-Limit": String(LIMIT),
        "RateLimit-Remaining": "0",
        "RateLimit-Reset": String(meta.reset),
      }
    );
  }

  // Map payload -> RPC params (atomic write path)
  const solvedCorrectly = toBool(body.solved_correctly ?? body.is_correct, null);

  const rpcArgs = {
    p_child_id: childId,
    p_problem_id: problemId,
    p_mode: body.mode ?? track,
    p_difficulty_tier: body.difficulty_tier ?? null,
    p_attempt_state: body.attempt_state ?? "SUBMITTED",
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

  const { data: rpcData, error: rpcErr } = await supabase.rpc("rpc_attempt_log_atomic", rpcArgs);
  if (rpcErr) {
    return json(res, 400, {
      error: "rpc_failed",
      detail: rpcErr.message,
      hint:
        "If this mentions schema cache or signature mismatch: confirm function args match exactly, then run pg_notify('pgrst','reload schema').",
    });
  }

  const attemptId = rpcData?.[0]?.attempt_id ?? null;
  const attemptNumber = rpcData?.[0]?.attempt_number ?? null;

  return json(res, 200, {
    ok: true,
    attempt_id: attemptId,
    attempt_number: attemptNumber,
  });
}