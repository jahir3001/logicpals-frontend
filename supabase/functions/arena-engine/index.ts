// ============================================================
// LogicPals P5.4: Arena Edge Function
// supabase/functions/arena-engine/index.ts
//
// Endpoints:
//   POST /arena/join     — request a match
//   GET  /arena/status   — poll match state
//   POST /arena/submit   — submit answer to a problem
//   POST /arena/forfeit  — leave match early
//
// Match lifecycle:
//   waiting  → (opponent joins or 15s ghost fallback) → active
//   active   → (timer expires or both finish)         → completed
//   active   → (player forfeits)                      → cancelled
//
// Non-negotiable:
//   • arena_ratings NEVER feeds session composer
//   • Ghost matches award HALF Elo (K-factor halved here)
//   • Ghost matches excluded from leaderboards
//   • Realtime primary / 2s polling fallback for BD mobile
// ============================================================

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

// ── Types ────────────────────────────────────────────────────

interface ArenaMatch {
  id: string;
  track: string;
  match_type: "live" | "ghost";
  status: "waiting" | "active" | "completed" | "cancelled" | "expired";
  player_a_id: string;
  player_b_id: string | null;
  ghost_session_id: string | null;
  problem_ids: string[];
  problem_count: number;
  time_limit_seconds: number;
  player_a_score: number;
  player_b_score: number;
  player_a_time_ms: number | null;
  player_b_time_ms: number | null;
  winner_id: string | null;
  rating_change_a: number | null;
  rating_change_b: number | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

interface JoinRequest {
  track: "regular" | "olympiad";
  problem_count?: number;
}

interface SubmitRequest {
  match_id: string;
  problem_id: string;
  answer: string;
  time_ms: number;        // ms elapsed since match started for this problem
}

interface ForfeitRequest {
  match_id: string;
}

interface EloResult {
  delta: number;          // Elo change (pre-halving for ghost)
  result: "win" | "loss" | "draw";
}

// ── Constants ────────────────────────────────────────────────

const GHOST_TIMEOUT_MS   = 15_000;   // 15 s before ghost fallback
const POLL_INTERVAL_MS   =  2_000;   // 2 s polling fallback
const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ── Helpers ──────────────────────────────────────────────────

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function err(message: string, status = 400): Response {
  return json({ error: message }, status);
}

/**
 * Standard Elo update.
 * K-factor: 32 for <30 matches, 24 for 30–100, 16 for 100+
 * For ghost matches the caller halves the returned delta.
 */
function computeEloDelta(
  ratingA: number,
  ratingB: number,
  scoreA: number,       // 1 = win, 0 = loss, 0.5 = draw
  matchesPlayed: number
): number {
  const K =
    matchesPlayed < 30  ? 32 :
    matchesPlayed < 100 ? 24 : 16;
  const expected = 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
  return Math.round(K * (scoreA - expected));
}

/**
 * Resolve match outcome from scores + times.
 * Tiebreaker: lower total time wins.
 */
function resolveOutcome(
  scoreA: number, timeA: number | null,
  scoreB: number, timeB: number | null,
  timeLimitMs: number
): { winnerSlot: "a" | "b" | "draw"; scoreA: number; scoreB: number } {
  const tA = timeA ?? timeLimitMs;
  const tB = timeB ?? timeLimitMs;

  if (scoreA > scoreB) return { winnerSlot: "a",    scoreA, scoreB };
  if (scoreB > scoreA) return { winnerSlot: "b",    scoreA, scoreB };
  if (tA < tB)         return { winnerSlot: "a",    scoreA, scoreB };
  if (tB < tA)         return { winnerSlot: "b",    scoreA, scoreB };
  return               { winnerSlot: "draw", scoreA, scoreB };
}

// ── Auth ─────────────────────────────────────────────────────

async function getAuthenticatedUser(
  req: Request,
  supabase: ReturnType<typeof createClient>
): Promise<{ userId: string } | null> {
  const auth = req.headers.get("authorization");
  if (!auth) return null;

  const { data: { user }, error } = await supabase.auth.getUser(
    auth.replace("Bearer ", "")
  );
  if (error || !user) return null;
  return { userId: user.id };
}

// ── Handler: POST /arena/join ────────────────────────────────
//
// 1. Call find_or_create_arena_match (P5.2)
// 2. If status='active'  → return match immediately
// 3. If status='waiting' → poll up to 15s for activation
//    a. Poll every 2s for opponent to join
//    b. If still waiting after 15s → call create_ghost_match (P5.3)
//    c. Return ghost match or unavailable
// 4. If status='rejected' → return rate-limit / cooldown error

async function handleJoin(
  req: Request,
  supabase: ReturnType<typeof createClient>,
  userId: string
): Promise<Response> {
  let body: JoinRequest;
  try {
    body = await req.json();
  } catch {
    return err("Invalid JSON body");
  }

  const { track, problem_count = 3 } = body;
  if (!["regular", "olympiad"].includes(track)) {
    return err("track must be 'regular' or 'olympiad'");
  }

  // Step 1: Call matchmaking RPC
  const { data: matchRows, error: matchErr } = await supabase
    .rpc("find_or_create_arena_match", {
      p_user_id:       userId,
      p_track:         track,
      p_problem_count: problem_count,
    });

  if (matchErr) {
    console.error("[arena/join] find_or_create_arena_match error:", matchErr);
    return err("Matchmaking failed", 500);
  }

  const matchResult = matchRows?.[0];
  if (!matchResult) return err("No match result returned", 500);

  // Rejected by rate limit or cooldown
  if (matchResult.status === "rejected") {
    return json({ status: "rejected", message: matchResult.message }, 429);
  }

  // Match found immediately — return to client
  if (matchResult.status === "active") {
    return json({
      status:             "active",
      match_id:           matchResult.match_id,
      match_type:         matchResult.match_type,
      track,
      problem_ids:        matchResult.problem_ids,
      time_limit_seconds: matchResult.time_limit_seconds,
      opponent_rating:    matchResult.rating_a,   // rating_a = opponent (player A)
      your_rating:        matchResult.rating_b,
      poll_interval_ms:   POLL_INTERVAL_MS,
      message:            matchResult.message,
    });
  }

  // status = 'waiting' — poll for 15s for a live opponent
  if (matchResult.status === "waiting") {
    const waitingMatchId: string = matchResult.match_id;
    const deadline = Date.now() + GHOST_TIMEOUT_MS;

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

      const { data: polled } = await supabase
        .from("arena_matches")
        .select("id, status, player_b_id, problem_ids, time_limit_seconds, started_at")
        .eq("id", waitingMatchId)
        .single();

      if (polled?.status === "active") {
        // Opponent joined — fetch their rating
        const { data: oppRating } = await supabase
          .rpc("get_arena_rating", {
            p_user_id: polled.player_b_id,
            p_track:   track,
          });

        return json({
          status:             "active",
          match_id:           waitingMatchId,
          match_type:         "live",
          track,
          problem_ids:        polled.problem_ids,
          time_limit_seconds: polled.time_limit_seconds,
          opponent_rating:    oppRating?.[0]?.rating ?? 1200,
          your_rating:        matchResult.rating_a,
          poll_interval_ms:   POLL_INTERVAL_MS,
          message:            "Opponent found — good luck!",
        });
      }

      // expired/cancelled — stop polling
      if (["expired", "cancelled"].includes(polled?.status ?? "")) break;
    }

    // 15s elapsed — trigger ghost fallback
    const { data: ghostRows, error: ghostErr } = await supabase
      .rpc("create_ghost_match", {
        p_user_id:          userId,
        p_track:            track,
        p_waiting_match_id: waitingMatchId,
      });

    if (ghostErr) {
      console.error("[arena/join] create_ghost_match error:", ghostErr);
      return err("Ghost match creation failed", 500);
    }

    const ghost = ghostRows?.[0];
    if (!ghost || ghost.status === "unavailable") {
      return json({
        status:  "unavailable",
        message: ghost?.message ?? "No opponents available — try again shortly",
      }, 503);
    }

    return json({
      status:             "active",
      match_id:           ghost.match_id,
      match_type:         "ghost",
      track,
      problem_ids:        ghost.problem_ids,
      time_limit_seconds: ghost.time_limit_seconds,
      opponent_rating:    ghost.ghost_opponent_rating,
      your_rating:        matchResult.rating_a,
      poll_interval_ms:   POLL_INTERVAL_MS,
      is_ghost:           true,
      opponent_label:     "Practice Partner",
      message:            ghost.message,
    });
  }

  return err("Unexpected match status", 500);
}

// ── Handler: GET /arena/status ───────────────────────────────
//
// Polling fallback for Realtime connection drops.
// Returns current match state + elapsed time.
// Also handles timer expiry — if time_limit_seconds has elapsed
// since started_at and match is still active, resolves it.

async function handleStatus(
  req: Request,
  supabase: ReturnType<typeof createClient>,
  userId: string
): Promise<Response> {
  const url      = new URL(req.url);
  const matchId  = url.searchParams.get("match_id");
  if (!matchId) return err("match_id required");

  const { data: match, error } = await supabase
    .from("arena_matches")
    .select("*")
    .eq("id", matchId)
    .single<ArenaMatch>();

  if (error || !match) return err("Match not found", 404);

  // Verify caller is a participant
  if (match.player_a_id !== userId && match.player_b_id !== userId) {
    return err("Not a participant in this match", 403);
  }

  // Check timer expiry for active matches
  if (match.status === "active" && match.started_at) {
    const elapsedMs = Date.now() - new Date(match.started_at).getTime();
    const limitMs   = match.time_limit_seconds * 1000;

    if (elapsedMs >= limitMs) {
      // Timer expired — resolve match
      const resolved = await resolveAndSealMatch(supabase, match);
      return json({ ...resolved, elapsed_ms: elapsedMs, timer_expired: true });
    }

    const remainingMs = Math.max(0, limitMs - elapsedMs);
    return json({
      match_id:           match.id,
      status:             match.status,
      match_type:         match.match_type,
      player_a_score:     match.player_a_score,
      player_b_score:     match.player_b_score,
      elapsed_ms:         elapsedMs,
      remaining_ms:       remainingMs,
      problem_ids:        match.problem_ids,
      poll_interval_ms:   POLL_INTERVAL_MS,
    });
  }

  return json({
    match_id:       match.id,
    status:         match.status,
    match_type:     match.match_type,
    player_a_score: match.player_a_score,
    player_b_score: match.player_b_score,
    winner_id:      match.winner_id,
    rating_change_a: match.rating_change_a,
    rating_change_b: match.rating_change_b,
    completed_at:   match.completed_at,
  });
}

// ── Handler: POST /arena/submit ──────────────────────────────
//
// Records a player's answer to a problem.
// Checks correctness against the problems table.
// Updates player score on the match row.
// If both players have answered all problems → resolve match.

async function handleSubmit(
  req: Request,
  supabase: ReturnType<typeof createClient>,
  userId: string
): Promise<Response> {
  let body: SubmitRequest;
  try {
    body = await req.json();
  } catch {
    return err("Invalid JSON body");
  }

  const { match_id, problem_id, answer, time_ms } = body;
  if (!match_id || !problem_id || answer === undefined || time_ms === undefined) {
    return err("match_id, problem_id, answer, time_ms required");
  }

  // Fetch match
  const { data: match, error: matchErr } = await supabase
    .from("arena_matches")
    .select("*")
    .eq("id", match_id)
    .single<ArenaMatch>();

  if (matchErr || !match) return err("Match not found", 404);
  if (match.status !== "active")  return err("Match is not active");

  const isPlayerA = match.player_a_id === userId;
  const isPlayerB = match.player_b_id === userId;
  if (!isPlayerA && !isPlayerB) return err("Not a participant", 403);

  // Timer check
  if (match.started_at) {
    const elapsedMs = Date.now() - new Date(match.started_at).getTime();
    if (elapsedMs > match.time_limit_seconds * 1000 + 2000) { // 2s grace
      return err("Match timer has expired");
    }
  }

  // Validate problem belongs to this match
  if (!match.problem_ids.includes(problem_id)) {
    return err("Problem not in this match");
  }

  // Check correctness against problems table
  const { data: problem } = await supabase
    .from("problems")
    .select("correct_answer, solution_type")
    .eq("id", problem_id)
    .single();

  const isCorrect = problem
    ? normaliseAnswer(answer) === normaliseAnswer(problem.correct_answer ?? "")
    : false;

  if (!isCorrect) {
    return json({ correct: false, match_id, problem_id });
  }

  // Increment score for the correct player
  const scoreField  = isPlayerA ? "player_a_score" : "player_b_score";
  const timeField   = isPlayerA ? "player_a_time_ms" : "player_b_time_ms";
  const newScore    = (isPlayerA ? match.player_a_score : match.player_b_score) + 1;

  const { data: updated, error: updateErr } = await supabase
    .from("arena_matches")
    .update({
      [scoreField]: newScore,
      [timeField]:  time_ms,
    })
    .eq("id", match_id)
    .eq("status", "active")
    .select("*")
    .single<ArenaMatch>();

  if (updateErr || !updated) {
    return err("Failed to update score", 500);
  }

  // Check if both players have solved all problems → resolve
  const bothDone =
    updated.player_a_score === updated.problem_count &&
    (updated.match_type === "ghost" || updated.player_b_score === updated.problem_count);

  if (bothDone) {
    const resolved = await resolveAndSealMatch(supabase, updated);
    return json({ correct: true, match_id, problem_id, ...resolved });
  }

  return json({
    correct:            true,
    match_id,
    problem_id,
    your_score:         newScore,
    opponent_score:     isPlayerA ? updated.player_b_score : updated.player_a_score,
    problems_remaining: updated.problem_count - newScore,
  });
}

// ── Handler: POST /arena/forfeit ─────────────────────────────
//
// Player leaves early. Opponent wins by forfeit.
// Elo updated: forfeiter loses, opponent wins.

async function handleForfeit(
  req: Request,
  supabase: ReturnType<typeof createClient>,
  userId: string
): Promise<Response> {
  let body: ForfeitRequest;
  try {
    body = await req.json();
  } catch {
    return err("Invalid JSON body");
  }

  const { match_id } = body;
  if (!match_id) return err("match_id required");

  const { data: match, error } = await supabase
    .from("arena_matches")
    .select("*")
    .eq("id", match_id)
    .single<ArenaMatch>();

  if (error || !match) return err("Match not found", 404);
  if (match.status !== "active") return err("Match is not active");

  const isPlayerA = match.player_a_id === userId;
  const isPlayerB = match.player_b_id === userId;
  if (!isPlayerA && !isPlayerB) return err("Not a participant", 403);

  // Ghost match forfeit: no opponent to win, just cancel
  if (match.match_type === "ghost") {
    await supabase
      .from("arena_matches")
      .update({ status: "cancelled", completed_at: new Date().toISOString() })
      .eq("id", match_id);

    return json({ status: "cancelled", match_id, message: "Practice match cancelled" });
  }

  // Live match forfeit: opponent wins
  // Treat forfeiter as scoring 0, opponent keeps their current score
  const forfeitedA    = isPlayerA;
  const fakeScoreA    = forfeitedA ? 0 : match.problem_count;
  const fakeScoreB    = forfeitedA ? match.problem_count : 0;
  const fakeTimeA     = forfeitedA ? match.time_limit_seconds * 1000 : match.player_a_time_ms;
  const fakeTimeB     = forfeitedA ? match.player_b_time_ms : match.time_limit_seconds * 1000;

  const modifiedMatch: ArenaMatch = {
    ...match,
    player_a_score:   fakeScoreA,
    player_b_score:   fakeScoreB,
    player_a_time_ms: fakeTimeA,
    player_b_time_ms: fakeTimeB,
  };

  const resolved = await resolveAndSealMatch(supabase, modifiedMatch);
  return json({ ...resolved, forfeited: true, match_id });
}

// ── Core: resolveAndSealMatch ────────────────────────────────
//
// Called when timer expires, both finish, or forfeit.
// 1. Determines winner from scores + time tiebreaker
// 2. Computes Elo deltas (halved for ghost)
// 3. Seals the arena_matches row (status → completed)
// 4. Calls upsert_arena_rating for each player

async function resolveAndSealMatch(
  supabase: ReturnType<typeof createClient>,
  match: ArenaMatch
): Promise<Record<string, unknown>> {
  const timeLimitMs = match.time_limit_seconds * 1000;

  const { winnerSlot } = resolveOutcome(
    match.player_a_score, match.player_a_time_ms,
    match.player_b_score, match.player_b_time_ms,
    timeLimitMs
  );

  const winnerId =
    winnerSlot === "a" ? match.player_a_id :
    winnerSlot === "b" ? match.player_b_id : null;

  // Fetch ratings for both players
  const [ratingARes, ratingBRes] = await Promise.all([
    supabase.rpc("get_arena_rating", { p_user_id: match.player_a_id, p_track: match.track }),
    match.player_b_id
      ? supabase.rpc("get_arena_rating", { p_user_id: match.player_b_id, p_track: match.track })
      : Promise.resolve({ data: null }),
  ]);

  const ratingA       = ratingARes.data?.[0]?.rating        ?? 1200;
  const matchesA      = ratingARes.data?.[0]?.matches_played ?? 0;
  const ratingB       = ratingBRes.data?.[0]?.rating        ?? 1200;
  const matchesB      = ratingBRes.data?.[0]?.matches_played ?? 0;

  // Score values for Elo
  const scoreValA =
    winnerSlot === "a" ? 1.0 :
    winnerSlot === "b" ? 0.0 : 0.5;
  const scoreValB = 1.0 - scoreValA + (winnerSlot === "draw" ? 0 : 0);

  // Raw Elo deltas
  let deltaA = computeEloDelta(ratingA, ratingB, scoreValA, matchesA);
  let deltaB = match.player_b_id
    ? computeEloDelta(ratingB, ratingA, scoreValB, matchesB)
    : null;

  // Ghost: halve delta, no player B update
  if (match.match_type === "ghost") {
    deltaA = Math.round(deltaA / 2);
    deltaB = null;
  }

  const resultA: "win" | "loss" | "draw" =
    winnerSlot === "a" ? "win" :
    winnerSlot === "b" ? "loss" : "draw";
  const resultB: "win" | "loss" | "draw" =
    winnerSlot === "b" ? "win" :
    winnerSlot === "a" ? "loss" : "draw";

  // Seal the match record
  await supabase
    .from("arena_matches")
    .update({
      status:          "completed",
      winner_id:       winnerId,
      rating_change_a: deltaA,
      rating_change_b: deltaB,
      player_a_score:  match.player_a_score,
      player_b_score:  match.player_b_score,
      player_a_time_ms: match.player_a_time_ms ?? timeLimitMs,
      player_b_time_ms: match.player_b_time_ms ?? timeLimitMs,
      completed_at:    new Date().toISOString(),
    })
    .eq("id", match.id)
    .eq("status", "active"); // guard: only seal if still active

  // Update Elo for player A
  await supabase.rpc("upsert_arena_rating", {
    p_user_id:        match.player_a_id,
    p_track:          match.track,
    p_rating_delta:   deltaA,
    p_new_rd:         Math.max(30, (ratingARes.data?.[0]?.rating_deviation ?? 350) - 10),
    p_new_volatility: 0.06,
    p_result:         resultA,
  });

  // Update Elo for player B (live matches only)
  if (match.player_b_id && deltaB !== null) {
    await supabase.rpc("upsert_arena_rating", {
      p_user_id:        match.player_b_id,
      p_track:          match.track,
      p_rating_delta:   deltaB,
      p_new_rd:         Math.max(30, (ratingBRes.data?.[0]?.rating_deviation ?? 350) - 10),
      p_new_volatility: 0.06,
      p_result:         resultB,
    });
  }

  return {
    status:          "completed",
    match_id:        match.id,
    match_type:      match.match_type,
    winner:          winnerSlot,
    winner_id:       winnerId,
    player_a_score:  match.player_a_score,
    player_b_score:  match.player_b_score,
    rating_change_a: deltaA,
    rating_change_b: deltaB,
    is_ghost:        match.match_type === "ghost",
    // Ghost label for UI
    opponent_label:  match.match_type === "ghost" ? "Practice Partner" : undefined,
  };
}

// ── Util: normalise answer for comparison ────────────────────

function normaliseAnswer(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

// ── Router ───────────────────────────────────────────────────

serve(async (req: Request) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  const url      = new URL(req.url);
  const pathname = url.pathname;

  // Build service-role client for all DB operations
  // (RLS policies allow service_role full access to arena tables)
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } }
  );

  // Auth check on all endpoints
  const authed = await getAuthenticatedUser(req, createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
  ));

  if (!authed) return err("Unauthorized", 401);
  const { userId } = authed;

  try {
    if (pathname.endsWith("/arena/join")    && req.method === "POST") return handleJoin(req, supabase, userId);
    if (pathname.endsWith("/arena/status")  && req.method === "GET")  return handleStatus(req, supabase, userId);
    if (pathname.endsWith("/arena/submit")  && req.method === "POST") return handleSubmit(req, supabase, userId);
    if (pathname.endsWith("/arena/forfeit") && req.method === "POST") return handleForfeit(req, supabase, userId);

    return err("Not found", 404);
  } catch (e) {
    console.error("[arena-engine] Unhandled error:", e);
    return err("Internal server error", 500);
  }
});
