// ============================================================
// LogicPals Enterprise Roadmap v2 — Phase 1.3
// Edge Function: rate-limit-check
// ============================================================
// Deploy to: supabase/functions/rate-limit-check/index.ts
//
// USAGE (called by session composer before every AI request):
//   POST /functions/v1/rate-limit-check
//   Body: { child_id, counter_type?, increment? }
//
// RESPONSE (allowed):
//   { allowed: true, remaining: 42, warning: false, tier: "scholar" }
//
// RESPONSE (blocked):
//   { allowed: false, reason: "daily_limit_reached", remaining: 0,
//     reset_at: "2026-03-06", friendly_msg: "আজকের জন্য..." }
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ── Config cache (avoids DB round-trip on every call) ────────
let configCache: Record<string, { daily_limit: number; hard_block: boolean; warning_pct: number }> = {};
let configCachedAt = 0;
const CONFIG_TTL_MS = 5 * 60 * 1000; // 5 minutes

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // ── Auth ────────────────────────────────────────────────
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return json({ error: "missing_authorization" }, 401);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const serviceClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Verify caller is authenticated
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return json({ error: "unauthorized" }, 401);
    }

    // ── Parse request ───────────────────────────────────────
    const body = await req.json();
    const {
      child_id,
      counter_type = "ai_interactions",
      increment = false,   // true = also increment (call AFTER AI success)
    } = body;

    if (!child_id) {
      return json({ error: "child_id_required" }, 400);
    }

    // Validate counter_type
    const validCounters = ["ai_interactions", "hints_requested", "problems_attempted"];
    if (!validCounters.includes(counter_type)) {
      return json({ error: "invalid_counter_type", valid: validCounters }, 400);
    }

    // ── Refresh config cache if stale ───────────────────────
    if (Date.now() - configCachedAt > CONFIG_TTL_MS) {
      const { data: configs } = await serviceClient
        .from("rate_limit_config")
        .select("tier, counter_type, daily_limit, hard_block, warning_pct")
        .eq("is_active", true);

      if (configs) {
        configCache = {};
        for (const c of configs) {
          configCache[`${c.tier}:${c.counter_type}`] = {
            daily_limit: c.daily_limit,
            hard_block: c.hard_block,
            warning_pct: c.warning_pct,
          };
        }
        configCachedAt = Date.now();
      }
    }

    // ── Call DB RPC: check_rate_limit ───────────────────────
    const { data, error } = await serviceClient.rpc("check_rate_limit", {
      p_child_id:     child_id,
      p_counter_type: counter_type,
      p_increment:    increment,
    });

    if (error) {
      console.error("[rate-limit-check] RPC error:", error);
      // On RPC failure: FAIL OPEN with logging (don't block students on infra issues)
      // Log the failure but allow the request through
      await logFailOpen(serviceClient, child_id, user.id, error.message);
      return json({
        allowed:    true,
        reason:     "fail_open_rpc_error",
        warning:    true,
        infra_note: "Rate limit check failed; allowed as fail-open. Incident logged.",
      });
    }

    // ── If blocked: return friendly denial ──────────────────
    if (!data.allowed) {
      return json({
        allowed:      false,
        reason:       data.reason,
        count:        data.count,
        daily_limit:  data.daily_limit,
        remaining:    0,
        tier:         data.tier,
        reset_at:     data.reset_at,
        friendly_msg: data.friendly_msg,
      }, 429); // HTTP 429 Too Many Requests
    }

    // ── Allowed: return state ───────────────────────────────
    return json({
      allowed:     true,
      count:       data.count,
      daily_limit: data.daily_limit,
      remaining:   data.remaining,
      warning:     data.warning,
      tier:        data.tier,
      reset_at:    data.reset_at,
    });

  } catch (err) {
    console.error("[rate-limit-check] Unexpected error:", err);
    // Fail open on unexpected errors — never block students on our infra bugs
    return json({
      allowed:    true,
      reason:     "fail_open_unexpected_error",
      warning:    true,
    });
  }
});

// ── Helpers ─────────────────────────────────────────────────

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function logFailOpen(
  client: ReturnType<typeof createClient>,
  child_id: string,
  user_id: string,
  error_msg: string
) {
  try {
    await client.from("boundary_violations").insert({
      child_id,
      user_id,
      violation_type: "rate_limit_bypass",
      counter_type:   "ai_interactions",
      metadata: {
        reason:     "fail_open_rpc_error",
        error:      error_msg,
        detected_by: "edge_function",
        incident:   false, // Not a bypass — infra issue
        note:       "Rate limit RPC failed; request allowed as fail-open policy.",
      },
      detected_by: "edge_function",
    });
  } catch (e) {
    // Don't throw — logging failure should never block the request
    console.error("[rate-limit-check] Failed to log fail-open event:", e);
  }
}

// ============================================================
// INTEGRATION GUIDE for session composer
// ============================================================
//
// BEFORE AI call (check):
//   const { allowed, remaining, warning } = await fetch(
//     `${SUPABASE_URL}/functions/v1/rate-limit-check`,
//     { method: "POST",
//       headers: { Authorization: `Bearer ${token}` },
//       body: JSON.stringify({ child_id, counter_type: "ai_interactions" })
//     }
//   ).then(r => r.json());
//
//   if (!allowed) {
//     return showFriendlyDenial(friendly_msg, reset_at);
//   }
//   if (warning) {
//     showWarningBanner(`Only ${remaining} questions left today!`);
//   }
//
// AFTER successful AI call (increment):
//   await fetch(`${SUPABASE_URL}/functions/v1/rate-limit-check`, {
//     method: "POST",
//     headers: { Authorization: `Bearer ${token}` },
//     body: JSON.stringify({
//       child_id,
//       counter_type: "ai_interactions",
//       increment: true   // ← increments the counter
//     })
//   });
//
// NOTE: Call increment=true ONLY after the AI call succeeds.
// On AI error/timeout: do NOT increment (no cost, no count).
// ============================================================
