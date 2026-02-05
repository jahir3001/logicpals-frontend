/**
 * LogicPals — Worker / Mastery — logic.js (Enterprise Safe)
 *
 * - Keeps your existing constants intact.
 * - Adds an "AB Variant Resolver Helper" that calls DB RPCs safely.
 * - Does NOT break your current cron handler (run-mastery.js) which calls runMasteryWorkerOnce(supabase) with no extra args.
 */

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

/**
 * Small utility: normalize any "truthy" config values.
 */
function toBool(v) {
  if (v === true) return true;
  if (v === false) return false;
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "y";
}

/**
 * Enterprise-safe AB Variant Resolver Helper
 *
 * Preferred (authoritative): ab_get_or_assign_variant(p_experiment_key, p_track, p_session_id)
 * Fallback: ab_choose_variant(p_experiment_key, p_user_id)
 *
 * This helper never throws; it returns a structured object with reason + safe defaults.
 */
async function resolveAbVariant(supabase, {
  experimentKey,
  track = "regular",
  sessionId = null,
  userId = null,
} = {}) {
  const safe = {
    experiment_key: experimentKey || null,
    variant_key: "control",
    config: {},
    bucket: null,
    reason: "default_control",
    exposure_id: null,
  };

  if (!supabase) return { ...safe, reason: "missing_supabase_client" };
  if (!experimentKey) return { ...safe, reason: "missing_experiment_key" };

  // 1) Try the session-based authoritative RPC (best for “freeze per session” systems)
  if (sessionId) {
    try {
      const { data, error } = await supabase.rpc("ab_get_or_assign_variant", {
        p_experiment_key: experimentKey,
        p_track: track,
        p_session_id: sessionId,
      });

      if (!error && data) {
        const row = Array.isArray(data) ? data[0] : data;
        return {
          experiment_key: row.experiment_key || experimentKey,
          variant_key: row.variant_key || "control",
          config: row.config || {},
          bucket: row.bucket ?? null,
          reason: row.reason || "ok",
          exposure_id: row.exposure_id ?? null,
        };
      }
    } catch (e) {
      // swallow and fallback
    }
  }

  // 2) Fallback to user-based deterministic chooser
  if (userId) {
    try {
      const { data, error } = await supabase.rpc("ab_choose_variant", {
        p_experiment_key: experimentKey,
        p_user_id: userId,
      });

      if (!error && data) {
        const row = Array.isArray(data) ? data[0] : data;
        return {
          experiment_key: row.experiment_key || experimentKey,
          variant_key: row.variant_key || "control",
          config: row.config || {},
          bucket: row.bucket ?? null,
          reason: row.reason || "ok",
          exposure_id: row.exposure_id ?? null,
        };
      }
    } catch (e) {
      // swallow and return safe default
    }
  }

  // 3) No sessionId and no userId => cannot resolve deterministically
  return { ...safe, reason: sessionId ? "rpc_failed_fallback_no_user" : "missing_session_and_user" };
}

/**
 * OPTIONAL: record a metric (safe wrapper). Never throws.
 * Uses ab_record_metric(experiment_key, track, session_id, value_numeric, meta_jsonb)
 */
async function recordAbMetric(supabase, { experimentKey, track = "regular", sessionId, value, meta = {} } = {}) {
  if (!supabase || !experimentKey || !sessionId) return { ok: false, reason: "missing_inputs" };
  try {
    const { data, error } = await supabase.rpc("ab_record_metric", {
      p_experiment_key: experimentKey,
      p_track: track,
      p_session_id: sessionId,
      p_value_num: value,
      p_meta: meta,
    });
    if (error) return { ok: false, reason: "rpc_error", error };
    return { ok: true, data };
  } catch (e) {
    return { ok: false, reason: "exception", error: e };
  }
}

/**
 * Mastery worker entry point
 *
 * IMPORTANT:
 * Your cron handler currently calls: runMasteryWorkerOnce(supabase) :contentReference[oaicite:2]{index=2}
 * So this function must work even with no extra args.
 *
 * For Step 4A ("Edge Worker Must Call Variant RPC"), you can pass { userId, sessionId } when you are ready,
 * but cron will still work without it.
 */
async function runMasteryWorkerOnce(supabase, opts = {}) {
  // Keep cron safe: do nothing destructive by default.
  // If you pass in A/B context, we will resolve it and return it for verification.

  const result = {
    processed: 0,
    ab: null,
  };

  // Optional A/B resolution check (only if caller provides context)
  if (opts && opts.experimentKey && (opts.sessionId || opts.userId)) {
    const ab = await resolveAbVariant(supabase, {
      experimentKey: opts.experimentKey,
      track: opts.track || "regular",
      sessionId: opts.sessionId || null,
      userId: opts.userId || null,
    });

    // Example: compute a convenience boolean flag for this experiment
    // (for reg_home_tutor_hint_v1, treatment config uses { "hint_card": true })
    const showHintCard = toBool(ab.config && ab.config.hint_card);

    result.ab = {
      ...ab,
      show_hint_card: showHintCard,
    };
  }

  return result;
}

module.exports = {
  MIN_ATTEMPTS_LOCKED,
  PROMOTION_RULES,
  BREADTH_REQUIREMENTS,

  // new helpers
  resolveAbVariant,
  recordAbMetric,

  // entrypoint
  runMasteryWorkerOnce,
};