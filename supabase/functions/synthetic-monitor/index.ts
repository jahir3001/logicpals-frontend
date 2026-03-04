// ============================================================
// P0.10: Synthetic Session Monitor
// LogicPals Phase 0 — Week 2
// File: supabase/functions/synthetic-monitor/index.ts
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL     = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const OPENAI_API_KEY   = Deno.env.get('OPENAI_API_KEY')!;

const SYNTHETIC_USER_ID = '00000000-0000-0000-0000-000000000001';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE);

interface StepResult {
  step:       string;
  passed:     boolean;
  latency_ms: number;
  detail:     string;
  error?:     string;
}

// ── Step 1: DB Connectivity ───────────────────────────────────
async function checkDBConnectivity(): Promise<StepResult> {
  const start = Date.now();
  try {
    const { error } = await supabase.from('profiles').select('id').limit(1);
    const latency_ms = Date.now() - start;
    if (error) return { step: 'db_connectivity', passed: false, latency_ms, detail: 'DB query failed', error: error.message };
    return { step: 'db_connectivity', passed: true, latency_ms, detail: `DB responsive in ${latency_ms}ms` };
  } catch (e) {
    return { step: 'db_connectivity', passed: false, latency_ms: Date.now() - start, detail: 'DB threw', error: String(e) };
  }
}

// ── Step 2: Problem Fetch ─────────────────────────────────────
// Uses correct column names: title, problem_text (not statement)
async function checkProblemFetch(): Promise<StepResult> {
  const start = Date.now();
  try {
    const { data: regular, error: regErr } = await supabase
      .from('problems')
      .select('id, title, problem_text, section')
      .eq('section', 'regular')
      .eq('is_active', true)
      .eq('publish_state', 'published')
      .limit(1)
      .single();

    const latency_ms = Date.now() - start;

    if (regErr) return {
      step: 'problem_fetch', passed: false, latency_ms,
      detail: 'Regular problem fetch failed', error: regErr.message
    };
    if (!regular) return {
      step: 'problem_fetch', passed: false, latency_ms,
      detail: 'No active regular problems found', error: 'empty result'
    };

    const { data: olympiad } = await supabase
      .from('problems')
      .select('id')
      .eq('section', 'olympiad')
      .eq('is_active', true)
      .limit(1);

    return {
      step: 'problem_fetch',
      passed: true,
      latency_ms,
      detail: `Regular: "${regular.title?.slice(0, 30)}..." | Olympiad: ${olympiad?.length ?? 0} found`
    };
  } catch (e) {
    return { step: 'problem_fetch', passed: false, latency_ms: Date.now() - start, detail: 'Problem fetch threw', error: String(e) };
  }
}

// ── Step 3: Prompt Assembly ───────────────────────────────────
async function checkPromptAssembly(): Promise<StepResult> {
  const start = Date.now();
  try {
    const { data, error } = await supabase
      .from('lp_policy_versions')
      .select('policy_version')
      .limit(1);

    const latency_ms = Date.now() - start;
    if (error) return { step: 'prompt_assembly', passed: false, latency_ms, detail: 'lp_policy_versions unreachable', error: error.message };
    if (!data || data.length === 0) return { step: 'prompt_assembly', passed: false, latency_ms, detail: 'No policy versions found', error: 'empty' };

    const { data: tierCheck } = await supabase.from('tier_features').select('tier').limit(4);

    return {
      step: 'prompt_assembly',
      passed: true,
      latency_ms,
      detail: `Policy: ${data[0].policy_version} | Tier features: ${tierCheck?.length ?? 0}`
    };
  } catch (e) {
    return { step: 'prompt_assembly', passed: false, latency_ms: Date.now() - start, detail: 'Prompt assembly threw', error: String(e) };
  }
}

// ── Step 4: OpenAI Reachability ───────────────────────────────
async function checkOpenAIReachability(): Promise<StepResult> {
  const start = Date.now();
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model:      'gpt-4o-mini',
        max_tokens: 1,
        messages:   [{ role: 'user', content: 'Reply with just: 1' }]
      }),
      signal: AbortSignal.timeout(6000)
    });

    const latency_ms = Date.now() - start;

    if (!response.ok) {
      const body = await response.text();
      return { step: 'openai_reachability', passed: false, latency_ms, detail: `OpenAI HTTP ${response.status}`, error: body.slice(0, 100) };
    }

    const json = await response.json();
    return {
      step: 'openai_reachability',
      passed: true,
      latency_ms,
      detail: `OpenAI OK in ${latency_ms}ms | tokens: ${json.usage?.total_tokens ?? 0}`
    };
  } catch (e) {
    const latency_ms = Date.now() - start;
    const isTimeout = String(e).includes('TimeoutError') || String(e).includes('timeout');
    return { step: 'openai_reachability', passed: false, latency_ms, detail: isTimeout ? 'OpenAI timed out' : 'OpenAI threw', error: String(e).slice(0, 100) };
  }
}

// ── Step 5: Cost Ledger Write ─────────────────────────────────
async function checkCostLedgerWrite(): Promise<StepResult> {
  const start = Date.now();
  try {
    const { error } = await supabase.from('ai_cost_ledger').insert({
      user_id:      SYNTHETIC_USER_ID,
      session_id:   null,
      track:        'regular',
      tier:         'free_trial',
      model_id:     'gpt-4o-mini',
      request_type: 'synthetic_monitor',
      tokens_in:    1,
      tokens_out:   1,
      cost_usd:     0.000000,
      latency_ms:   50,
      route:        'primary',
      error:        false
    });

    const latency_ms = Date.now() - start;
    if (error) return { step: 'cost_ledger_write', passed: false, latency_ms, detail: 'ai_cost_ledger insert failed', error: error.message };
    return { step: 'cost_ledger_write', passed: true, latency_ms, detail: `Cost entry written in ${latency_ms}ms` };
  } catch (e) {
    return { step: 'cost_ledger_write', passed: false, latency_ms: Date.now() - start, detail: 'Cost ledger threw', error: String(e) };
  }
}

// ── Step 6: Rate Limit RPC ────────────────────────────────────
// Correct params: p_route text, p_limit integer, p_window_seconds integer
async function checkRateLimitRPC(): Promise<StepResult> {
  const start = Date.now();
  try {
    const { error } = await supabase.rpc('rpc_rate_limit_check', {
      p_route:          'synthetic_monitor',
      p_limit:          100,
      p_window_seconds: 60
    });
    const latency_ms = Date.now() - start;

    if (error && (error.message.includes('does not exist') || error.code === 'PGRST202')) {
      return { step: 'rate_limit_rpc', passed: false, latency_ms, detail: 'rpc_rate_limit_check not found', error: error.message };
    }
    return { step: 'rate_limit_rpc', passed: true, latency_ms, detail: `rpc_rate_limit_check OK in ${latency_ms}ms` };
  } catch (e) {
    return { step: 'rate_limit_rpc', passed: false, latency_ms: Date.now() - start, detail: 'Rate limit RPC threw', error: String(e) };
  }
}

// ── Step 7: Platform Health View ─────────────────────────────
async function checkPlatformHealthView(): Promise<StepResult> {
  const start = Date.now();
  try {
    const { data, error } = await supabase
      .from('v_platform_health_live')
      .select('snapshot_at, flag_high_latency, flag_error_spike, flag_circuit_breaker_trip')
      .single();

    const latency_ms = Date.now() - start;
    if (error) return { step: 'health_view', passed: false, latency_ms, detail: 'v_platform_health_live failed', error: error.message };
    if (!data)  return { step: 'health_view', passed: false, latency_ms, detail: 'Health view empty', error: 'no rows' };

    const flags = [
      data.flag_high_latency         ? '⚠️ high_latency'  : null,
      data.flag_error_spike          ? '⚠️ error_spike'   : null,
      data.flag_circuit_breaker_trip ? '⚠️ circuit_break' : null,
    ].filter(Boolean).join(', ') || 'all clear';

    return { step: 'health_view', passed: true, latency_ms, detail: `Health OK | flags: ${flags}` };
  } catch (e) {
    return { step: 'health_view', passed: false, latency_ms: Date.now() - start, detail: 'Health view threw', error: String(e) };
  }
}

// ── Step 8: Session Composer RPC ─────────────────────────────
async function checkSessionComposerRPC(): Promise<StepResult> {
  const start = Date.now();
  try {
    const { error } = await supabase.rpc('compose_session', {
      p_user_id:        SYNTHETIC_USER_ID,
      p_intended_track: 'regular',
      p_mode:           'bootcamp',
      p_problem_count:  1
    });

    const latency_ms = Date.now() - start;

    if (error && (error.message.includes('does not exist') || error.code === 'PGRST202')) {
      return { step: 'session_composer', passed: false, latency_ms, detail: 'compose_session not found', error: error.message };
    }
    return {
      step: 'session_composer',
      passed: true,
      latency_ms,
      detail: `compose_session reachable in ${latency_ms}ms${error ? ` (expected: ${error.message.slice(0, 40)})` : ' ✓'}`
    };
  } catch (e) {
    return { step: 'session_composer', passed: false, latency_ms: Date.now() - start, detail: 'Session composer threw', error: String(e) };
  }
}

// ── Log run to DB ─────────────────────────────────────────────
async function logSyntheticRun(runId: string, overallPassed: boolean, steps: StepResult[], totalMs: number) {
  const failedSteps = steps.filter(s => !s.passed).map(s => s.step);

  await supabase.from('synthetic_monitor_runs').insert({
    run_id:       runId,
    passed:       overallPassed,
    total_ms:     totalMs,
    steps_run:    steps.length,
    steps_failed: failedSteps.length,
    failed_steps: failedSteps,
    step_details: steps,
    created_at:   new Date().toISOString()
  });

  if (!overallPassed) {
    await supabase.from('alert_log').insert({
      alert_type: 'session_composer_failure',
      severity:   'critical',
      message:    `Synthetic monitor failed: ${failedSteps.join(', ')}`,
      metadata:   { run_id: runId, failed_steps: failedSteps, total_ms: totalMs }
    });
  }
}

// ── Main handler ──────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const runId    = crypto.randomUUID();
  const runStart = Date.now();

  console.log(`[synthetic-monitor] Starting run ${runId}`);

  const steps: StepResult[] = [];
  steps.push(await checkDBConnectivity());
  steps.push(await checkProblemFetch());
  steps.push(await checkPromptAssembly());
  steps.push(await checkOpenAIReachability());
  steps.push(await checkCostLedgerWrite());
  steps.push(await checkRateLimitRPC());
  steps.push(await checkPlatformHealthView());
  steps.push(await checkSessionComposerRPC());

  const totalMs       = Date.now() - runStart;
  const failedSteps   = steps.filter(s => !s.passed);
  const overallPassed = failedSteps.length === 0;

  await logSyntheticRun(runId, overallPassed, steps, totalMs);

  const summary = {
    run_id:         runId,
    passed:         overallPassed,
    total_ms:       totalMs,
    steps_passed:   steps.filter(s => s.passed).length,
    steps_failed:   failedSteps.length,
    failed_steps:   failedSteps.map(s => ({ step: s.step, error: s.error })),
    step_latencies: Object.fromEntries(steps.map(s => [s.step, s.latency_ms])),
  };

  console.log(`[synthetic-monitor] ${runId} ${overallPassed ? '✅ PASS' : '❌ FAIL'} ${totalMs}ms`);

  return new Response(JSON.stringify(summary), {
    status:  overallPassed ? 200 : 503,
    headers: { 'Content-Type': 'application/json', 'X-API-Version': 'v1', 'X-Run-ID': runId }
  });
});
