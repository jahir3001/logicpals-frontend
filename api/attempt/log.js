// api/attempt/log.js
// Enterprise attempt logging (LogicPals)
// - Auth: validates Supabase access_token (JWT)
// - Ownership: parent -> child enforcement (children.parent_id = auth.uid())
// - Rate limit: DB-backed (rpc_rate_limit_check)
// - Atomic write: rpc_attempt_log_atomic (deactivate previous active + insert new active)

import { createClient } from "@supabase/supabase-js";

function sendJson(res, status, payload, headers = {}) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, String(v));
  res.end(JSON.stringify(payload));
}

function getBearer(req) {
  const h = req.headers?.authorization || req.headers?.Authorization || "";
  const m = /^Bearer\s+(.+)$/.exec(String(h).trim());
  return m ? m[1] : null;
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

async function getAuthedUserId(supabase, token) {
  // v2 supports getUser() with the JWT from global headers, but we also pass token for compatibility
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user?.id) return null;
  return data.user.id;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return sendJson(res, 405, { error: "method_not_allowed" });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return sendJson(res, 500, {
      error: "missing_supabase_config",
      hint: "Set SUPABASE_URL and SUPABASE_ANON_KEY in Vercel Environment Variables.",
    });
  }

  const token = getBearer(req);
  if (!token) {
    return sendJson(res, 401, { error: "missing_bearer_token" });
  }

  // RLS must apply as the signed-in user
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const userId = await getAuthedUserId(supabase, token);
  if (!userId) {
    return sendJson(res, 401, {
      error: "invalid_or_expired_token",
      hint: "Use a fresh Supabase access_token (JWT) from the signed-in parent user. Tokens expire—re-login and copy a new one.",
    });
  }

  // Parse body
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
    return sendJson(res, 400, { error: "invalid_track", hint: 'track must be "regular" or "olympiad"' });
  }
  if (!childId || !problemId) {
    return sendJson(res, 400, { error: "missing_ids", hint: "Provide child_id and problem_id (UUIDs)." });
  }

  // Ownership check (parent -> child)
  // NOTE: If you later move this check inside rpc_attempt_log_atomic, you can remove this block.
  const { data: childRow, error: childErr } = await supabase
    .from("children")
    .select("id,parent_id")
    .eq("id", childId)
    .maybeSingle();

  if (childErr) {
    return sendJson(res, 500, { error: "child_lookup_failed", detail: childErr.message });
  }
  if (!childRow) {
    return sendJson(res, 404, { error: "child_not_found" });
  }
  if (childRow.parent_id !== userId) {
    return sendJson(res, 403, {
      error: "forbidden_child",
      hint: "This child_id does not belong to the authenticated parent (auth.uid).",
    });
  }

  // =========================
  // Rate limit (DB-backed)
  // =========================
  // Tune these as you want (enterprise defaults)
  const LIMIT = toInt(process.env.ATTEMPT_LOG_RATE_LIMIT, 25) ?? 25; // requests
  const WINDOW_SECONDS = toInt(process.env.ATTEMPT_LOG_RATE_WINDOW_SECONDS, 60) ?? 60;

  const { data: allowed, error: rlErr } = await supabase.rpc("rpc_rate_limit_check", {
    p_route: "attempt_log",
    p_limit: LIMIT,
    p_window_seconds: WINDOW_SECONDS,
  });

  if (rlErr) {
    return sendJson(res, 500, { error: "rate_limit_rpc_failed", detail: rlErr.message });
  }

  if (allowed === false) {
    // Best practice: explicit payload + Retry-After header
    const retryAfter = WINDOW_SECONDS; // simple + safe
    return sendJson(
      res,
      429,
      {
        error: "rate_limited",
        route: "attempt_log",
        limit: LIMIT,
        window_seconds: WINDOW_SECONDS,
        retry_after_seconds: retryAfter,
      },
      {
        "Retry-After": retryAfter,
        "X-RateLimit-Limit": LIMIT,
        "X-RateLimit-Window": WINDOW_SECONDS,
      }
    );
  }

  // =========================
  // Atomic attempt log RPC
  // =========================
  const solvedCorrectly = toBool(body.solved_correctly ?? body.is_correct, false);
  const attemptState = body.attempt_state ?? "SUBMITTED";
  const mode = body.mode ?? track;
  const difficultyTier = body.difficulty_tier ?? null;

  // Optional analytics fields
  const hintsUsed = toInt(body.hints_used, 0) ?? 0;
  const questionsAsked = toInt(body.questions_asked, 0) ?? 0;
  const timeSpentSeconds = toInt(body.time_spent_sec ?? body.time_spent_seconds, null);
  const timeToFirstInputSeconds = toInt(body.time_to_first_input_seconds, null);

  const rpcPayload = {
    // Must match your function signature (p_* params)
    p_child_id: childId,
    p_problem_id: problemId,
    p_mode: mode,
    p_difficulty_tier: difficultyTier,
    p_attempt_state: attemptState,
    p_solved_correctly: solvedCorrectly,
    p_is_correct: solvedCorrectly,
    p_hints_used: hintsUsed,
    p_questions_asked: questionsAsked,

    // If your RPC signature includes these, keep them; otherwise your function should have defaults.
    p_score_delta: toInt(body.score_delta, null),
    p_session_id: body.session_id ?? null,
    p_session_item_id: body.session_item_id ?? null,
    p_ai_conversation: body.ai_conversation ?? null,
    p_submitted_answer: body.submitted_answer ?? null,
    p_time_spent_seconds: timeSpentSeconds,
    p_time_to_first_input_seconds: timeToFirstInputSeconds,
  };

  const { data: rpcResult, error: rpcErr } = await supabase.rpc("rpc_attempt_log_atomic", rpcPayload);

  if (rpcErr) {
    return sendJson(res, 400, {
      error: "rpc_failed",
      detail: rpcErr.message,
      hint:
        "If this says the function cannot be found, wait 1–3 minutes after DB changes (schema cache), then retry. Also confirm your function parameters match the payload keys.",
    });
  }

  // Expecting rpcResult like: { attempt_id, attempt_number } OR a row
  const attemptId = rpcResult?.attempt_id ?? rpcResult?.id ?? null;
  const attemptNumber = rpcResult?.attempt_number ?? null;

  return sendJson(res, 200, {
    ok: true,
    attempt_id: attemptId,
    attempt_number: attemptNumber,
  });
}