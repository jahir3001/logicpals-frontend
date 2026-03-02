// api/attempt/log.js
import { createClient } from "@supabase/supabase-js";

function json(res, status, body, extraHeaders = {}) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    // CORS (tighten origin later if you want)
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Cache-Control": "no-store",
    ...extraHeaders,
  };
  res.status(status).setHeader("Content-Type", headers["Content-Type"]);
  Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));
  res.status(status).send(JSON.stringify(body));
}

function getBearer(req) {
  const h = req.headers.authorization || req.headers.Authorization || "";
  const m = String(h).match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

function toInt(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function toBool(v, fallback = false) {
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return fallback;
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return json(res, 204, {});
  if (req.method !== "POST") return json(res, 405, { error: "method_not_allowed" });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return json(res, 500, { error: "missing_supabase_config" });
  }

  const token = getBearer(req);
  if (!token) return json(res, 401, { error: "missing_bearer_token" });

  // Auth-bound Supabase client (auth.uid() works inside RPC)
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  // 1) Validate JWT + get current user
  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData?.user?.id) {
    return json(res, 401, {
      error: "invalid_or_expired_token",
      hint: "Use a fresh Supabase access_token (JWT) for the signed-in user.",
    });
  }
  const parentUserId = userData.user.id;

  // 2) Parse input
  let body = {};
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
  } catch {
    return json(res, 400, { error: "invalid_json" });
  }

  const track = String(body.track || "regular"); // "regular" | "olympiad"
  const childId = body.child_id;
  const problemId = body.problem_id;

  if (!childId || !problemId) {
    return json(res, 400, { error: "missing_required_fields", required: ["child_id", "problem_id"] });
  }

  // 3) Rate limit (DB-backed, keyed by auth.uid + route + window)
  // Enterprise defaults (tune later):
  const ROUTE = "attempt_log";
  const LIMIT = 30; // requests
  const WINDOW_SECONDS = 60; // per minute

  const { data: allowed, error: rlErr } = await supabase.rpc("rpc_rate_limit_check", {
    p_route: ROUTE,
    p_limit: LIMIT,
    p_window_seconds: WINDOW_SECONDS,
  });

  if (rlErr) {
    // Don’t block learning if limiter has an issue; but do surface it
    return json(res, 500, { error: "rate_limit_check_failed", detail: rlErr.message });
  }

  if (allowed === false) {
    // Best practice headers for clients
    return json(
      res,
      429,
      {
        error: "rate_limited",
        route: ROUTE,
        limit: LIMIT,
        window_seconds: WINDOW_SECONDS,
        hint: "Slow down and retry after the window resets.",
      },
      {
        "Retry-After": String(WINDOW_SECONDS),
        "X-RateLimit-Limit": String(LIMIT),
        "X-RateLimit-Window": String(WINDOW_SECONDS),
      }
    );
  }

  // 4) Parent -> child ownership check (prevents “child not found” confusion)
  // This requires an RLS policy that lets a parent read their own child row.
  const { data: childRow, error: childErr } = await supabase
    .from("children")
    .select("id, parent_id")
    .eq("id", childId)
    .maybeSingle();

  if (childErr) return json(res, 500, { error: "child_lookup_failed", detail: childErr.message });
  if (!childRow) return json(res, 404, { error: "child_not_found" });
  if (childRow.parent_id !== parentUserId) {
    return json(res, 403, { error: "forbidden_child", hint: "child_id does not belong to this user" });
  }

  // 5) Call the atomic RPC (THIS is where your 400 happened when signature mismatched)
  // Adjust keys to match the exact signature from the SQL in Step 1.
  const rpcPayload = {
    p_child_id: childId,
    p_problem_id: problemId,
    p_mode: track,
    p_difficulty_tier: String(body.difficulty_tier || "standard"),
    p_attempt_state: String(body.attempt_state || "SUBMITTED"),
    p_solved_correctly: toBool(body.solved_correctly, false),
    p_is_correct: toBool(body.solved_correctly, false), // keep consistent
    p_hints_used: toInt(body.hints_used, 0),
    p_questions_asked: toInt(body.questions_asked, 0),
    p_time_spent_seconds: toInt(body.time_spent_sec, 0),
    p_time_to_first_input_seconds: toInt(body.time_to_first_input_sec, 0),
    // If your function includes these, add them:
    // p_submitted_answer: body.submitted_answer ?? null,
  };

  const { data: rpcOut, error: rpcErr } = await supabase.rpc("rpc_attempt_log_atomic", rpcPayload);

  if (rpcErr) {
    return json(res, 400, {
      error: "rpc_failed",
      detail: rpcErr.message,
      hint:
        "If this mentions 'schema cache' or 'could not find function', your log.js payload keys do NOT match the function signature. Re-run the args SQL and update rpcPayload.",
    });
  }

  // Some RPCs return a row, some return scalar. Normalize response.
  const attempt_id = rpcOut?.attempt_id || rpcOut?.id || null;
  const attempt_number = rpcOut?.attempt_number ?? null;

  return json(res, 200, { ok: true, attempt_id, attempt_number });
}