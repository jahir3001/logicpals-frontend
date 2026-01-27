export const MIN_ATTEMPTS_LOCKED = 6;

export const PROMOTION_RULES = {
  warmup_to_standard: {
    from: "warmup",
    to: "standard",
    accuracyMin: 0.70,
    hintRateMax: 0.40,
  },
  standard_to_challenge: {
    from: "standard",
    to: "challenge",
    accuracyMin: 0.65,
    avgTimeRatioMax: 1.2,
    bruteForceRateMax: 0.20,
  },
  challenge_to_contest: {
    from: "challenge",
    to: "contest",
    accuracyMin: 0.60,
    hintRateMax: 0.15,
    avgTimeRatioMax: 1.1,
  },
  contest_to_elite: {
    from: "contest",
    to: "elite",
    accuracyMin: 0.50,
    hintRateMax: 0.0, // NO hints allowed
    avgTimeRatioMax: 1.0,
    contestArchetypesRequired: 2,
  },
} as const;

export const BREADTH_REQUIREMENTS = {
  standard: 3,
  challenge: 5,
  contest: 7,
  elite: 10,
} as const;

/**
 * Entry point for cron runner
 * Called by /api/cron/run-mastery.ts
 */
export async function runMasteryWorkerOnce(supabase: any) {
  // 1. pick ONE queued job from mastery_jobs (FOR UPDATE SKIP LOCKED)
  // 2. compute mastery metrics per (level, tier, archetype)
  // 3. apply promotion + breadth rules
  // 4. update mastery_unit_metrics + mastery_unit_state
  // 5. mark job done or failed

  return { processed: 1 };
}
