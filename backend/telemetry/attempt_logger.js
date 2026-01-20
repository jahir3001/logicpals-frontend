// backend/telemetry/attempt_logger.js
// STEP 5.0.3 — Minimal Attempt Telemetry Logger
// NOTE: This file will be MOVED later when backend structure is finalized

export async function logAttemptEvent({
  supabase,
  attempt_id,
  user_id,
  problem,
  attempt_state,
  hints_used = 0,
  time_spent_sec = 0,
  validator_result,
  ai_repair_count = 0
}) {
  if (!supabase) throw new Error("supabase client missing");
  if (!attempt_id || !user_id || !problem) {
    throw new Error("Missing required attempt logging fields");
  }

  return await supabase
    .from("attempt_events")
    .insert({
      attempt_id: attempt_id,
      user_id: user_id,
      problem_id: problem.id,
      archetype: problem.archetype,
      tier: problem.tier,

      attempt_state: attempt_state,
      hints_used: hints_used,
      time_spent_sec: time_spent_sec,

      validator_pass: validator_result?.pass ?? false,
      validator_fail_reason: validator_result?.reason ?? null,

      ai_repair_count: ai_repair_count
    });
}

