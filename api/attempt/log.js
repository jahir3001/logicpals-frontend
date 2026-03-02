// api/attempt/log.js
// LogicPals — Enterprise Attempt Logging
// - Requires Authorization: Bearer <Supabase access_token JWT>
// - Enforces parent -> child ownership via public.children
// - DB-backed rate limit via public.rpc_rate_limit_check(route, limit, window_seconds)
// - Atomic attempt log via public.rpc_attempt_log_atomic(...)
// - Returns explicit 429 payload + best-practice headers

import { createClient } from "@supabase/supabase-js";

function sendJson(res, status, obj, extraHeaders = {}) {
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

function isUuid(x) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(x || "")
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

async function getAuthUserId(supabase, jwt) {
  // supabase-js supports getUser(jwt) on newer versions
  try {
    const r = await supabase.auth.getUser(jwt);
    return r?.data?.user?.id || null;
  } catch {
    return null;
  }
}

function normalizeBody(req) {
  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }
  return body || {};
}

function mapPostgrestError(err) {
  const msg = err?.message || "unknown_error";
  const code = err?.code || err?.details || "";

  // Common Postgres / PostgREST cases we saw in your screenshots:
  // 22P02 = invalid input syntax (uuid etc)
  // 23503 = foreign key violation (problem_id not found etc)
  // 42501 = insufficient_privilege (GRANT missing)
  if (String(code).includes("22P02") || msg.toLowerCase().includes("invalid input syntax")) {
    return { http: 400, error: "invalid_input", detail: msg, hint: "Check UUIDs in child_id / problem_id." };
  }
  if (String(code).includes("23503") || msg.toLowerCase().includes("foreign key")) {
    return {
      http: 400,
      error: "fk_violation",
      detail: msg,
      hint: "Your problem_id must exist in public.problems (you previously accidentally sent child_id as problem_id).",
    };
  }
  if (String(code).includes("42501") || msg.toLowerCase().includes("permission")) {
    return {
      http: 403,
      error: "permission_denied",
      detail: msg,
      hint: "Check GRANT EXECUTE on RPC + RLS policies for authenticated users.",
    };
  }
  return { http: 500, error: "rpc_failed", detail: msg };
}

async function callAttemptRpcWithFallback(supabase, payloadV2, payloadLegacy) {
  // Try “minimal” / current signature first
  let r = await supabase.rpc("rpc_attempt_log_atomic", payloadV2);
  if (!r.error) return r;

  const msg = String(r.error?.message || "");
  const schemaCache = msg.toLowerCase().includes("schema cache") || msg.toLowerCase().includes("could not find the function");

  // If signature mismatch, retry with legacy payload
  if (schemaCache && payloadLegacy) {
    const r2 = await supabase.rpc("rpc_attempt_log_atomic", payloadLegacy);
    return r2;
  }
  return r;
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return sendJson(res, 204, {}, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Allow-Methods": "POST, OPTIONS" });
  if (req.method !== "POST") return sendJson(res, 405, { error: "method_not_allowed" });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return sendJson(res, 500, {
      error: "missing_supabase_config",
      hint: "Set SUPABASE_URL and SUPABASE_ANON_KEY in Vercel Environment Variables.",
    });
  }

  const jwt = getBearerToken(req);
  if (!jwt) return sendJson(res, 401, { error: "missing_bearer_token" });

  // RLS must apply => use user JWT on every request
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: {
      headers: {
        Authorization: `Bearer ${jwt}`,
      },
    },
  });

  const userId = await getAuthUserId(supabase, jwt);
  if (!userId) {
    return sendJson(res, 401, {
      error: "invalid_or_expired_token",
      hint: "Use the Supabase access_token (JWT) from a *fresh* signed-in session. Your $ACCESS_TOKEN often expires.",
    });
  }

  const body = normalizeBody(req);

  const track = String(body.track || "").toLowerCase().trim();
  const childId = body.child_id ?? body.childId;
  const problemId = body.problem_id ?? body.problemId;

  if (!["regular", "olympiad"].includes(track)) {
    return sendJson(res, 400, { error: "invalid_track", hint: 'track must be "regular" or "olympiad"' });
  }
  if (!isUuid(childId) || !isUuid(problemId)) {
    return sendJson(res, 400, {
      error: "invalid_ids",
      hint: "child_id and problem_id must be UUIDs (do not pass '...' or placeholders).",
    });
  }

  // 1) Enforce parent -> child ownership (this also catches your “child_not_found” case)
  const { data: childRow, error: childErr } = await supabase
    .from("children")
    .select("id,parent_id")
    .eq("id", childId)
    .maybeSingle();

  if (childErr) return sendJson(res, 500, { error: "child_lookup_failed", detail: childErr.message });
  if (!childRow) return sendJson(res, 404, { error: "child_not_found", hint: "That child_id does not exist in public.children." });
  if (childRow.parent_id !== userId) {
    return sendJson(res, 403, {
      error: "child_not_owned",
      hint: "Use the parent user’s access_token that matches children.parent_id.",
    });
  }

  // 2) DB-backed rate limit (route-scoped)
  // Tune these numbers as you like:
  const ROUTE = "attempt_log";
  const LIMIT = 25;          // max requests per window
  const WINDOW_SECONDS = 60; // 1 minute window

  const rl = await supabase.rpc("rpc_rate_limit_check", {
    p_route: ROUTE,
    p_limit: LIMIT,
    p_window_seconds: WINDOW_SECONDS,
  });

  if (rl.error) {
    // If rate limit RPC not ready / permissions missing
    const mapped = mapPostgrestError(rl.error);
    return sendJson(res, mapped.http, { error: "rate_limit_rpc_failed", detail: mapped.detail, hint: mapped.hint });
  }

  const allowed = !!rl.data;
  if (!allowed) {
    // ✅ Enterprise: explicit payload + headers
    return sendJson(
      res,
      429,
      {
        ok: false,
        error: "rate_limited",
        route: ROUTE,
        limit: LIMIT,
        window_seconds: WINDOW_SECONDS,
        hint: "Too many requests. Slow down and retry.",
      },
      {
        "Retry-After": String(WINDOW_SECONDS),
        "X-RateLimit-Limit": String(LIMIT),
        "X-RateLimit-Window": String(WINDOW_SECONDS),
      }
    );
  }

  // 3) Prepare fields for RPC
  const solvedCorrectly = toBool(body.solved_correctly ?? body.is_correct, false);

  const mode = String(body.mode ?? track);
  const difficultyTier = body.difficulty_tier ?? null;
  const attemptState = body.attempt_state ?? "SUBMITTED";

  const hintsUsed = toInt(body.hints_used, 0);
  const questionsAsked = toInt(body.questions_asked, 0);

  const timeSpentSeconds = toInt(body.time_spent_sec ?? body.time_spent_seconds, null);
  const timeToFirstInputSeconds = toInt(body.time_to_first_input_seconds, null);

  const submittedAnswer = body.submitted_answer ?? null;
  const aiConversation = body.ai_conversation ?? null;

  const sessionId = body.session_id ?? null;
  const sessionItemId = body.session_item_id ?? null;

  // 4) RPC payloads
  // V2 (minimal/current signature — matches your screenshot start)
  const payloadV2 = {
    p_child_id: childId,
    p_problem_id: problemId,
    p_mode: mode,
    p_difficulty_tier: difficultyTier,
    p_attempt_state: attemptState,
    p_solved_correctly: solvedCorrectly,
    p_is_correct: solvedCorrectly,
    p_hints_used: hintsUsed,
    // the rest may or may not exist in signature; if not, legacy fallback will handle
    p_questions_asked: questionsAsked,
    p_time_spent_seconds: timeSpentSeconds,
    p_time_to_first_input_seconds: timeToFirstInputSeconds,
    p_submitted_answer: submittedAnswer,
    p_ai_conversation: aiConversation,
    p_session_id: sessionId,
    p_session_item_id: sessionItemId,
  };

  // Legacy payload (covers your earlier “long signature” errors)
  const payloadLegacy = {
    // keep same core
    p_child_id: childId,
    p_problem_id: problemId,
    p_mode: mode,
    p_difficulty_tier: difficultyTier,
    p_attempt_state: attemptState,
    p_solved_correctly: solvedCorrectly,
    p_is_correct: solvedCorrectly,
    p_hints_used: hintsUsed,
    p_questions_asked: questionsAsked,
    p_time_spent_seconds: timeSpentSeconds,
    p_time_to_first_input_seconds: timeToFirstInputSeconds,
    p_submitted_answer: submittedAnswer,
    p_ai_conversation: aiConversation,
    p_session_id: sessionId,
    p_session_item_id: sessionItemId,

    // extra older fields (safe to include only on legacy retry)
    p_attempt_number: toInt(body.attempt_number, null),
    p_score_delta: body.score_delta ?? null,
  };

  // 5) Call atomic RPC with fallback
  const rpcRes = await callAttemptRpcWithFallback(supabase, payloadV2, payloadLegacy);

  if (rpcRes.error) {
    const mapped = mapPostgrestError(rpcRes.error);
    return sendJson(res, mapped.http, {
      error: mapped.error,
      detail: mapped.detail,
      hint:
        mapped.hint ||
        "If this mentions 'schema cache', your log.js args do not match the current rpc_attempt_log_atomic signature. Keep this file deployed and re-run notify pgrst reload schema.",
    });
  }

  // Expected: { attempt_id, attempt_number } OR similar
  const out = rpcRes.data || {};
  return sendJson(res, 200, {
    ok: true,
    attempt_id: out.attempt_id ?? out.id ?? null,
    attempt_number: out.attempt_number ?? null,
  });
}