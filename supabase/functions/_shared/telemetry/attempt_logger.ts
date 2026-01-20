// supabase/functions/_shared/telemetry/attempt_logger.ts
// STEP 5.0.3 — Minimal Attempt Telemetry Logger (TypeScript)

type ValidatorResult = { pass: boolean; reason?: string | null };

type ProblemMeta = {
  id: string;
  archetype: string;
  tier: string;
};

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
}: {
  supabase: any;
  attempt_id: string;
  user_id: string;
  problem: ProblemMeta;
  attempt_state: "active" | "submitted" | "review";
  hints_used?: number;
  time_spent_sec?: number;
  validator_result: ValidatorResult;
  ai_repair_count?: number;
}) {
  if (!supabase) throw new Error("supabase client missing");
  if (!attempt_id || !user_id || !problem?.id) {
    throw new Error("Missing required attempt logging fields");
  }

  return await supabase.from("attempt_events").insert({
    attempt_id,
    user_id,
    problem_id: problem.id,
    archetype: problem.archetype,
    tier: problem.tier,

    attempt_state,
    hints_used,
    time_spent_sec,

    validator_pass: validator_result?.pass ?? false,
    validator_fail_reason: validator_result?.reason ?? null,

    ai_repair_count
  });
}

