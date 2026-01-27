const MIN_ATTEMPTS_LOCKED = 6;

const PROMOTION_RULES = {
  warmup_to_standard: { from: "warmup", to: "standard", accuracyMin: 0.70, hintRateMax: 0.40 },
  standard_to_challenge: { from: "standard", to: "challenge", accuracyMin: 0.65, avgTimeRatioMax: 1.2, bruteForceRateMax: 0.20 },
  challenge_to_contest: { from: "challenge", to: "contest", accuracyMin: 0.60, hintRateMax: 0.15, avgTimeRatioMax: 1.1 },
  contest_to_elite: { from: "contest", to: "elite", accuracyMin: 0.50, hintRateMax: 0.0, avgTimeRatioMax: 1.0, contestArchetypesRequired: 2 },
};

const BREADTH_REQUIREMENTS = {
  standard: 3,
  challenge: 5,
  contest: 7,
  elite: 10,
};

async function runMasteryWorkerOnce(supabase) {
  return { processed: 0 };
}

module.exports = {
  MIN_ATTEMPTS_LOCKED,
  PROMOTION_RULES,
  BREADTH_REQUIREMENTS,
  runMasteryWorkerOnce,
};
