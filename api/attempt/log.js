// api/attempt/log.js
// Enterprise-grade server-side attempt logging (JWT required)
// - Verifies caller is authenticated
// - Enforces child ownership (parent -> children relationship)
// - Optional durable rate limiting via Supabase RPC (fail-open if RPC missing)
// - Writes into public.attempts
//
// Expected env vars on Vercel:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY   (server-only)
//   SUPABASE_ANON_KEY           (optional; not used here)

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

const sb = (SUPABASE_URL && SERVICE_ROLE)
  ? createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } })
  : null;

// Rate-limit policy (per authenticated user)
const RL_LIMIT = 60;          // requests
const RL_WINDOW_SECONDS = 60; // per minute
const RL_RPC = "rate_limit_check_and_inc"; // optional RPC name in Supabase

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(obj));
}

function getBearerToken(req) {
  const auth = req.headers.authorization || req.headers.Authorization || "";
  const m = /^Bearer\s+(.+)$/.exec(auth);
  return m ? m[1] : null;
}

function asInt(v, d = null) {
  if (v === undefined || v === null || v === "") return d;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : d;
}

async function maybeRateLimit(userId) {
  if (!sb) return { ok: true, skipped: true, reason: "missing_supabase" };

  // Fail-open: if RPC doesn't exist / errors, we allow the request but log the warning.
  try {
    const key = `attempt_log:${userId}`;
    const { data, error } = await sb.rpc(RL_RPC, {
      p_key: key,
      p_limit: RL_LIMIT,
      p_window_seconds: RL_WINDOW_SECONDS,
    });

    if (error) {
      return { ok: true, skipped: true, reason: `rate_limit_rpc_error:${error.code || "unknown"}` };
    }

    // Expected data shape: { ok: boolean, remaining: int, reset_in: int }
    if (data && data.ok === false) {
      return { ok: false, reset_in: data.reset_in ?? null };
    }

    return { ok: true, remaining: data?.remaining ?? null, reset_in: data?.reset_in ?? null };
  } catch (e) {
    return { ok: true, skipped: true, reason: "rate_limit_exception" };
  }
}

async function resolveChildIdForParent(parentId, requestedChildId) {
  // Security-first:
  // - If requestedChildId exists but doesn't belong -> 403
  // - If not provided and parent has exactly 1 child -> use it
  // - If not provided and parent has 0 or >1 -> 400 (caller must specify)
  const base = sb.from("children").select("id").eq("parent_id", parentId);

  if (requestedChildId) {
    const { data, error } = await base.eq("id", requestedChildId).maybeSingle();
    if (error) throw error;
    if (!data?.id) return { ok: false, status: 403, code: "CHILD_NOT_OWNED" };
    return { ok: true, child_id: data.id };
  }

  const { data, error } = await base.order("created_at", { ascending: false }).limit(2);
  if (error) throw error;

  if (!data || data.length === 0) return { ok: false, status: 400, code: "NO_CHILD_FOUND" };
  if (data.length > 1) return { ok: false, status: 400, code: "MULTIPLE_CHILDREN" };
  return { ok: true, child_id: data[0].id };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { error: "Method Not Allowed" });
  }

  if (!SUPABASE_URL || !SERVICE_ROLE || !sb) {
    return json(res, 500, { error: "Server misconfigured", missing: { SUPABASE_URL: !SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: !SERVICE_ROLE } });
  }

  const token = getBearerToken(req);
  if (!token) return json(res, 401, { error: "Missing Authorization Bearer token" });

  // Validate JWT and extract parent user id
  const { data: userResp, error: userErr } = await sb.auth.getUser(token);
  if (userErr || !userResp?.user?.id) return json(res, 401, { error: "Invalid/expired token" });
  const parent_id = userResp.user.id;

  // Optional durable rate limiting
  const rl = await maybeRateLimit(parent_id);
  if (rl.ok === false) {
    res.setHeader("Retry-After", String(rl.reset_in ?? RL_WINDOW_SECONDS));
    return json(res, 429, { error: "Rate limit exceeded", reset_in: rl.reset_in ?? null });
  }

  // Parse body (Vercel gives req.body for JSON, but be defensive)
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  if (!body || typeof body !== "object") return json(res, 400, { error: "Invalid JSON body" });

  const track = (body.track === "olympiad") ? "olympiad" : "regular";
  const problem_id = body.problem_id || null;

  if (!problem_id) return json(res, 400, { error: "problem_id is required" });

  // Resolve child ownership
  const childRes = await resolveChildIdForParent(parent_id, body.child_id || null);
  if (!childRes.ok) {
    if (childRes.code === "CHILD_NOT_OWNED") {
      return json(res, 403, {
        error: "child_id does not belong to this parent",
        hint: "Use a child_id from public.children where parent_id = your auth user id",
      });
    }
    if (childRes.code === "NO_CHILD_FOUND") {
      return json(res, 400, {
        error: "No child profile found for this parent",
        hint: "Create a child record (public.children) linked to this parent_id, then retry.",
      });
    }
    if (childRes.code === "MULTIPLE_CHILDREN") {
      return json(res, 400, {
        error: "Multiple children found; child_id is required",
        hint: "Pick the correct child_id from public.children for this parent_id and include it in the request body.",
      });
    }
    return json(res, 400, { error: "Unable to resolve child_id" });
  }
  const child_id = childRes.child_id;

  // Fetch canonical attributes from problems table for consistency
  const { data: p, error: pErr } = await sb
    .from("problems")
    .select("difficulty_tier, skill_track, intended_track, olympiad_level")
    .eq("id", problem_id)
    .maybeSingle();

  if (pErr) return json(res, 500, { error: "Problem lookup failed", details: pErr.message });

  const difficulty_tier = p?.difficulty_tier ?? null;
  const skill_track = p?.skill_track ?? null;
  const intended_track = p?.intended_track ?? null;
  const mode = (track === "olympiad") ? (p?.olympiad_level ?? "OLYMPIAD") : "STANDARD";

  const payload = {
    child_id,
    user_id: parent_id,
    problem_id,
    attempt_state: track === "olympiad" ? "OLYMPIAD" : "PRACTICE",
    mode,
    difficulty_tier,
    skill_track,
    // v1 compatibility fields (accept both naming styles from clients)
    is_correct: body.is_correct ?? body.solved_correctly ?? null,
    solved_correctly: body.solved_correctly ?? body.is_correct ?? null,
    hints_used: asInt(body.hints_used, 0),
    questions_asked: asInt(body.questions_asked, 0),
    attempt_number: asInt(body.attempt_number, 1),
    time_spent_seconds: asInt(body.time_spent_seconds, asInt(body.time_spent_sec, null)),
    completed_at: new Date().toISOString(),
    // Optional fields
    session_id: body.session_id || null,
    session_item_id: body.session_item_id || null,
    submitted_answer: body.submitted_answer || null,
    submitted_at: body.submitted_at || null,
    started_at: body.started_at || null,
  };

  // Insert attempt
  const { data: ins, error: insErr } = await sb
    .from("attempts")
    .insert(payload)
    .select("id, child_id")
    .single();

  if (insErr) return json(res, 500, { error: "Insert failed", details: insErr.message });

  // If caller provided a mismatching child_id, emit a warning line in logs (no PII)
  if (body.child_id && body.child_id !== child_id) {
    console.warn("[attempt/log] child_id mismatch, enforced ownership");
  }
  if (rl?.skipped) {
    console.warn("[attempt/log] rate limit skipped:", rl.reason);
  }

  return json(res, 200, { ok: true, id: ins.id, child_id: ins.child_id });
}
