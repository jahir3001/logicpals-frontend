/**
 * P0.12: AI Provider Circuit Breaker
 * LogicPals Phase 0 — Final gate
 * File: ai/circuit_breaker.js
 *
 * USAGE:
 *   const cb = require('./circuit_breaker');
 *
 *   // Before every OpenAI call:
 *   const gate = await cb.check();
 *   if (!gate.allowed) {
 *     return cb.fallbackResponse(gate);
 *   }
 *
 *   // After every OpenAI call:
 *   await cb.recordSuccess(latencyMs);
 *   // or on failure:
 *   await cb.recordFailure(latencyMs, error.message);
 */

const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const PROVIDER = 'openai';

// ── Check: call before every OpenAI request ──────────────────
async function check() {
  try {
    const { data, error } = await supabase
      .rpc('rpc_circuit_breaker_check', { p_provider: PROVIDER });

    if (error) {
      // If circuit breaker DB call fails, FAIL OPEN (allow the call)
      // — better to try OpenAI than to block all AI for a DB hiccup
      console.warn('[circuit-breaker] check() DB error — failing open:', error.message);
      return { allowed: true, state: 'UNKNOWN', reason: 'db_error_fail_open' };
    }

    return data; // { allowed, state, reason, retry_after_s? }

  } catch (e) {
    console.warn('[circuit-breaker] check() threw — failing open:', e.message);
    return { allowed: true, state: 'UNKNOWN', reason: 'exception_fail_open' };
  }
}

// ── Record success after OpenAI call completes ───────────────
async function recordSuccess(latencyMs = null) {
  try {
    await supabase.rpc('rpc_circuit_breaker_record', {
      p_provider:   PROVIDER,
      p_success:    true,
      p_latency_ms: latencyMs,
      p_error_msg:  null
    });
  } catch (e) {
    // Non-fatal — don't throw, just log
    console.warn('[circuit-breaker] recordSuccess() failed:', e.message);
  }
}

// ── Record failure after OpenAI call fails ───────────────────
async function recordFailure(latencyMs = null, errorMsg = null) {
  try {
    await supabase.rpc('rpc_circuit_breaker_record', {
      p_provider:   PROVIDER,
      p_success:    false,
      p_latency_ms: latencyMs,
      p_error_msg:  errorMsg ? String(errorMsg).slice(0, 200) : null
    });
  } catch (e) {
    console.warn('[circuit-breaker] recordFailure() failed:', e.message);
  }
}

// ── Fallback response when circuit is OPEN ───────────────────
// Returns a safe, student-friendly degraded response
function fallbackResponse(gate) {
  const retryAfter = gate.retry_after_s ?? 60;
  return {
    degraded:     true,
    circuit_open: true,
    retry_after_s: retryAfter,
    // Student-facing message (used by session composer)
    student_message:
      "Our AI tutor is taking a short break. " +
      "You can still work through the problem — " +
      "hints will be back in a moment!",
    // Admin-facing detail
    detail: `Circuit breaker OPEN for provider '${PROVIDER}'. ` +
            `Retry after ${retryAfter}s.`,
  };
}

// ── Convenience wrapper: execute an OpenAI call with CB ──────
// Use this to wrap any OpenAI fetch call automatically.
//
// Example:
//   const result = await cb.withBreaker(
//     () => openai.chat.completions.create({...}),
//     { context: 'hint_generation' }
//   );
//
async function withBreaker(fn, options = {}) {
  const { context = 'unknown' } = options;
  const start = Date.now();

  // 1. Check circuit
  const gate = await check();
  if (!gate.allowed) {
    console.warn(`[circuit-breaker] Call blocked (${context}) — state: ${gate.state}`);
    return { ok: false, fallback: fallbackResponse(gate) };
  }

  // 2. Execute the call
  try {
    const result = await fn();
    const latencyMs = Date.now() - start;

    // 3a. Record success
    await recordSuccess(latencyMs);

    return { ok: true, data: result, latency_ms: latencyMs };

  } catch (e) {
    const latencyMs = Date.now() - start;
    const errorMsg  = e?.message || String(e);

    console.error(`[circuit-breaker] Call failed (${context}) in ${latencyMs}ms:`, errorMsg);

    // 3b. Record failure
    await recordFailure(latencyMs, errorMsg);

    return {
      ok:      false,
      error:   errorMsg,
      latency_ms: latencyMs,
      fallback: fallbackResponse({ retry_after_s: 60 })
    };
  }
}

// ── Get current breaker status (for admin dashboard) ─────────
async function getStatus() {
  try {
    const { data, error } = await supabase
      .from('v_circuit_breaker_health')
      .select('*')
      .eq('provider', PROVIDER)
      .single();

    if (error) return { error: error.message };
    return data;
  } catch (e) {
    return { error: e.message };
  }
}

// ── Manual reset (super_admin only, use in emergencies) ──────
async function manualReset(reason = 'admin reset') {
  const { data, error } = await supabase
    .rpc('rpc_circuit_breaker_reset', {
      p_provider: PROVIDER,
      p_reason:   reason
    });

  if (error) throw new Error(`Circuit breaker reset failed: ${error.message}`);
  return data;
}

module.exports = {
  check,
  recordSuccess,
  recordFailure,
  fallbackResponse,
  withBreaker,
  getStatus,
  manualReset,
  PROVIDER
};
