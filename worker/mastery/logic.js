/**
 * LogicPals — Mastery Worker + A/B Variant Resolver Helper (Enterprise-safe)
 * Step 4B: production worker integration
 *
 * Guarantees:
 * - Never breaks worker if AB system fails
 * - Deterministic variant selection happens in DB (RPC)
 * - Hard fallback to control
 * - Optional exposure logging (best-effort)
 */

function isUuid(x) {
  return typeof x === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x);
}

function safeJsonObject(x) {
  if (!x || typeof x !== "object" || Array.isArray(x)) return {};
  return x;
}

/**
 * Enterprise-safe AB variant resolver.
 *
 * Expected DB RPC (recommended): public.ab_get_or_assign_variant(p_experiment_key text, p_track lp_track, p_session_id uuid)
 * If your RPC signature differs, adjust the `rpcName` + params below.
 *
 * Returns:
 * {
 *   experiment_key, variant_key, config, reason, bucket, exposure_id
 * }
 */
async function resolveAbVariant(supabase, {
  experiment_key,
  track,
  session_id,     // preferred for freezing per session (deterministic)
  user_id,        // optional, only if your RPC uses user_id
  rpcName = "ab_get_or_assign_variant",
  defaultVariant = "control",
  defaultConfig = {},
}) {
  try {
    if (!experiment_key || typeof experiment_key !== "string") {
      return { experiment_key, variant_key: defaultVariant, config: defaultConfig, reason: "invalid_experiment_key" };
    }
    if (!track || (track !== "regular" && track !== "olympiad")) {
      return { experiment_key, variant_key: defaultVariant, config: defaultConfig, reason: "invalid_track" };
    }

    // Most enterprise-safe: freeze by session_id (NOT by user_id alone)
    if (session_id && !isUuid(session_id)) {
      return { experiment_key, variant_key: defaultVariant, config: defaultConfig, reason: "invalid_session_id" };
    }
    if (user_id && !isUuid(user_id)) {
      return { experiment_key, variant_key: defaultVariant, config: defaultConfig, reason: "invalid_user_id" };
    }

    // ---- Call RPC
    // Your project screenshots show: ab_get_or_assign_variant(text, lp_track, uuid)
    // => (experiment_key, track, session_id)
    const params = {
      p_experiment_key: experiment_key,
      p_track: track,
      p_session_id: session_id || null,
      // If your RPC uses user_id instead of session_id, swap accordingly.
      // p_user_id: user_id || null,
    };

    const { data, error } = await supabase.rpc(rpcName, params);

    if (error) {
      // Hard fallback
      return {
        experiment_key,
        variant_key: defaultVariant,
        config: defaultConfig,
        reason: `rpc_error:${error.code || "unknown"}`,
      };
    }

    // Supabase RPC sometimes returns array rows for table-returning functions
    const row = Array.isArray(data) ? data[0] : data;

    const variant_key = row?.variant_key || defaultVariant;
    const config = safeJsonObject(row?.config) || defaultConfig;
    const reason = row?.reason || "ok";
    const bucket = typeof row?.bucket === "number" ? row.bucket : null;
    const exposure_id = row?.exposure_id || null;

    return { experiment_key, variant_key, config, reason, bucket, exposure_id };
  } catch (e) {
    return {
      experiment_key,
      variant_key: defaultVariant,
      config: defaultConfig,
      reason: "resolver_exception",
    };
  }
}

/**
 * OPTIONAL: Best-effort exposure log (don’t fail worker if this fails)
 * If your DB already logs exposure inside ab_get_or_assign_variant, you can skip this entirely.
 */
async function recordExposureBestEffort(supabase, {
  experiment_key,
  track,
  session_id,
  variant_key,
  meta = {},
  rpcName = "ab_record_exposure",
}) {
  try {
    // If your ab_get_or_assign_variant already returns exposure_id, you may not need this.
    if (!experiment_key || !variant_key) return null;

    // Your earlier screenshots showed signature confusion — so keep this best-effort.
    // Adjust params to match your real RPC signature if needed.
    const params = {
      p_experiment_key: experiment_key,
      p_track: track,
      p_session_id: session_id || null,
      p_variant_key: variant_key,
      p_meta: meta,
    };

    const { data, error } = await supabase.rpc(rpcName, params);
    if (error) return null;

    const row = Array.isArray(data) ? data[0] : data;
    return row?.exposure_id || null;
  } catch {
    return null;
  }
}

/**
 * Your mastery worker entrypoint called by /api/cron/run-mastery.js
 * Keep it stable. It can run mastery jobs + also do AB sanity checks if you want.
 */
async function runMasteryWorkerOnce(supabase) {
  // ✅ Replace this body with your real mastery processing pipeline.
  // For Step 4B we keep it safe + testable.

  // Example: AB sanity call (does NOT affect mastery)
  // You can remove this once verified in prod.
  const ab = await resolveAbVariant(supabase, {
    experiment_key: "reg_home_tutor_hint_v1",
    track: "regular",
    session_id: null, // if you have a session_id, pass it
  });

  // Return a stable shape for your cron route
  return {
    processed: 0,
    ab_check: ab,
  };
}

module.exports = {
  runMasteryWorkerOnce,
  resolveAbVariant,
  recordExposureBestEffort,
};