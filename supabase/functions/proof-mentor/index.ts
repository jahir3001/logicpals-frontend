// ============================================================
// proof-mentor Edge Function
// P6.2 (Brain A: structure verification) +
// P6.3 (Brain B: Socratic coaching)
// P6.4 (IMO 0-7 scoring — deterministic, no AI)
// P6.6 (Plagiarism detection — trigram similarity, no AI)
//
// NON-NEGOTIABLE contracts enforced here:
//  - Brain A receives: problem_text + proof_text
//  - Brain B receives: evaluation_json + problem_text
//                      + submission_number + hint_depth + language_register
//  - Brain B NEVER receives: proof_text, model_solution, answer_key
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = 'gpt-4o';

// ── IMO 0-7 score computation (P6.4) ──────────────────────
// Deterministic — no AI call needed
interface BrainAOutput {
  structure: {
    has_claim: boolean;
    has_cases: boolean;
    has_conclusion: boolean;
    logical_flow: number; // 0-1
  };
  gaps: Array<{
    location: string;
    type: string;
    severity: 'minor' | 'major' | 'critical';
    description: string;
  }>;
  approach: string | null;
  completeness: number; // 0-1
  rigor: number;        // 0-1
  score_suggestion: number;
}

function computeImoScore(evaluation: BrainAOutput, hintDepth: number): {
  raw: number;
  capped: number;
  breakdown: Record<string, number>;
} {
  // Base score from completeness (weight 4) + rigor (weight 3)
  const base = (evaluation.completeness * 4) + (evaluation.rigor * 3);
  let score = base;

  // Gap deductions
  let gapDeductions = 0;
  for (const gap of evaluation.gaps) {
    if (gap.severity === 'critical')   gapDeductions += 2;
    else if (gap.severity === 'major') gapDeductions += 1;
    // minor: no deduction
  }
  score -= gapDeductions;

  // Structure bonus (max 1 point)
  let structureBonus = 0;
  const s = evaluation.structure;
  if (s.has_claim && s.has_conclusion) structureBonus += 0.5;
  if (s.logical_flow > 0.8)           structureBonus += 0.5;
  score += structureBonus;

  // Clamp raw to 0-7
  const raw = Math.max(0, Math.min(7, Math.round(score)));

  // Hint cascade caps (P6.5)
  // hint_depth 1: no cap | 2: max 6 | 3: max 4 | 4: max 2
  const caps: Record<number, number> = { 1: 7, 2: 6, 3: 4, 4: 2 };
  const cap = caps[hintDepth] ?? 7;
  const capped = Math.min(raw, cap);

  return {
    raw,
    capped,
    breakdown: {
      base:            Math.round(base * 100) / 100,
      gap_deductions:  gapDeductions,
      structure_bonus: structureBonus,
      raw_score:       raw,
      hint_cap:        cap,
      final_score:     capped,
    },
  };
}

// ── Plagiarism detection (P6.6) ────────────────────────────
// Jaccard similarity on sentence-level trigrams — pure computation, zero AI cost
function buildTrigrams(text: string): Set<string> {
  const normalized = text.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const words = normalized.split(' ').filter(w => w.length > 1);
  const trigrams = new Set<string>();
  for (let i = 0; i < words.length - 2; i++) {
    trigrams.add(`${words[i]} ${words[i+1]} ${words[i+2]}`);
  }
  return trigrams;
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) { if (b.has(t)) intersection++; }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

async function checkPlagiarism(
  supabase: ReturnType<typeof createClient>,
  problemId: string,
  proofText: string
): Promise<{ plagiarism_score: number; plagiarism_source: string | null }> {
  const { data: refs } = await supabase
    .from('proof_reference_solutions')
    .select('id, solution_text, solution_source, ngram_signature')
    .eq('problem_id', problemId);

  if (!refs || refs.length === 0) {
    return { plagiarism_score: 0, plagiarism_source: null };
  }

  const proofTrigrams = buildTrigrams(proofText);
  let maxSimilarity = 0;
  let maxSource: string | null = null;

  for (const ref of refs) {
    let similarity: number;

    if (ref.ngram_signature && Array.isArray(ref.ngram_signature)) {
      // Use pre-computed trigrams stored by upsert_proof_reference_solution RPC (fast path)
      const refTrigrams = new Set<string>(ref.ngram_signature as string[]);
      similarity = jaccardSimilarity(proofTrigrams, refTrigrams);
    } else {
      // Compute on the fly for refs without pre-computed signature
      const refTrigrams = buildTrigrams(ref.solution_text);
      similarity = jaccardSimilarity(proofTrigrams, refTrigrams);
    }

    if (similarity > maxSimilarity) {
      maxSimilarity = similarity;
      maxSource = ref.solution_source;
    }
  }

  return {
    plagiarism_score: Math.round(maxSimilarity * 100) / 100,
    plagiarism_source: maxSimilarity > 0.70 ? maxSource : null,
  };
}

// ── Brain A call ───────────────────────────────────────────
async function callBrainA(
  apiKey: string,
  systemPrompt: string,
  problemText: string,
  proofText: string,
  submissionNumber: number
): Promise<{ output: BrainAOutput; latencyMs: number; modelVersion: string }> {
  const start = Date.now();

  const userContent =
    `Problem: ${problemText}\n\n` +
    `Student's proof: ${proofText}\n\n` +
    `Submission #: ${submissionNumber}`;

  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 600,
      temperature: 0,  // Deterministic evaluation
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userContent },
      ],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Brain A API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  const raw = data.choices[0]?.message?.content ?? '{}';
  let output: BrainAOutput;

  try {
    output = JSON.parse(raw);
  } catch {
    throw new Error(`Brain A returned invalid JSON: ${raw.slice(0, 200)}`);
  }

  // Validate required fields
  const required = ['structure', 'gaps', 'completeness', 'rigor'];
  for (const field of required) {
    if (!(field in output)) throw new Error(`Brain A missing field: ${field}`);
  }
  if (output.completeness < 0 || output.completeness > 1)
    throw new Error('Brain A: completeness out of range');
  if (output.rigor < 0 || output.rigor > 1)
    throw new Error('Brain A: rigor out of range');

  return {
    output,
    latencyMs: Date.now() - start,
    modelVersion: data.model ?? MODEL,
  };
}

// ── Brain B call ───────────────────────────────────────────
// CONTRACT: Brain B NEVER receives proof_text or model solution.
// It receives ONLY the evaluation JSON produced by Brain A.
async function callBrainB(
  apiKey: string,
  systemPrompt: string,
  evaluationJson: BrainAOutput,  // evaluation OF the proof — NOT the proof itself
  problemText: string,
  submissionNumber: number,
  hintDepth: number,
  languageRegister: string
): Promise<{ response: string; latencyMs: number }> {
  const start = Date.now();

  // ── ENFORCEMENT: Brain B user message contains ZERO proof content ──
  // proof_text is intentionally absent from this function's parameters.
  // answer_key is never fetched from DB (removed from select query).
  const userContent =
    `Evaluation: ${JSON.stringify(evaluationJson)}\n\n` +
    `Problem: ${problemText}\n\n` +
    `Submission #: ${submissionNumber}\n` +
    `Hint depth: ${hintDepth} (1=vague, 2=specific, 3=direct, 4=reveal)\n` +
    `Language: ${languageRegister}`;

  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 400,
      temperature: 0.4,  // Slight variation for Socratic warmth
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userContent },
      ],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Brain B API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  const response = data.choices[0]?.message?.content ?? '';

  if (!response) throw new Error('Brain B returned empty response');

  return { response, latencyMs: Date.now() - start };
}

// ── Main handler ───────────────────────────────────────────
serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'authorization, content-type',
      },
    });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const openaiKey   = Deno.env.get('OPENAI_API_KEY')!;

  const authHeader = req.headers.get('Authorization');
  const userClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader ?? '' } },
    auth: { storageKey: 'logicpals.auth' },
  });
  const adminClient = createClient(supabaseUrl, serviceKey);

  // ── BUG FIX 4: declare body OUTSIDE try so catch block can reference it ──
  let body: { submission_id?: string; hint_depth?: number } | null = null;

  try {
    // ── Authenticate user
    const { data: { user }, error: authErr } = await userClient.auth.getUser();
    if (authErr || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
    }

    body = await req.json();
    const submission_id = body?.submission_id;
    const hint_depth    = body?.hint_depth ?? 1;

    if (!submission_id) {
      return new Response(JSON.stringify({ error: 'submission_id required' }), { status: 400 });
    }

    // ── Fetch submission + problem data
    // BUG FIX 1: use problem_text (not description); never select answer_key
    const { data: submission, error: subErr } = await adminClient
      .from('proof_submissions')
      .select(`
        id, user_id, problem_id, proof_text, proof_format,
        submission_number, hint_count_used, language_register,
        problems!inner(id, problem_text)
      `)
      .eq('id', submission_id)
      .eq('user_id', user.id)   // Ownership check
      .eq('status', 'submitted')
      .single();

    if (subErr || !submission) {
      return new Response(
        JSON.stringify({ error: 'Submission not found or already evaluated' }),
        { status: 404 }
      );
    }

    // Determine effective hint depth
    const effectiveHintDepth = Math.max(
      hint_depth,
      submission.hint_count_used >= 3 ? 4 :
      submission.hint_count_used >= 2 ? 3 :
      submission.hint_count_used >= 1 ? 2 : 1
    );

    // ── Mark as evaluating
    await adminClient
      .from('proof_submissions')
      .update({ status: 'evaluating' })
      .eq('id', submission_id);

    // ── BUG FIX 3: Fetch approved prompt versions using two reliable queries
    // (nested .eq() + .order() on joined tables is unreliable in Supabase JS v2)

    // Brain A template ID
    const { data: brainATpl, error: tplErrA } = await adminClient
      .from('prompt_templates')
      .select('id')
      .eq('mode', 'PROOF_EVALUATE_A')
      .eq('is_active', true)
      .single();

    if (tplErrA || !brainATpl) {
      throw new Error('Brain A prompt template not found. Run P6.7 seed first.');
    }

    // Brain A latest approved version
    const { data: brainAPrompt, error: pvErrA } = await adminClient
      .from('prompt_versions')
      .select('content, system_instructions, version_hash')
      .eq('template_id', brainATpl.id)
      .eq('status', 'approved')
      .order('version_number', { ascending: false })
      .limit(1)
      .single();

    if (pvErrA || !brainAPrompt) {
      throw new Error('No approved Brain A prompt version found. Run P6.7 seed first.');
    }

    // Brain B template ID
    const { data: brainBTpl, error: tplErrB } = await adminClient
      .from('prompt_templates')
      .select('id')
      .eq('mode', 'PROOF_COACH_B')
      .eq('is_active', true)
      .single();

    if (tplErrB || !brainBTpl) {
      throw new Error('Brain B prompt template not found. Run P6.7 seed first.');
    }

    // Brain B latest approved version
    const { data: brainBPrompt, error: pvErrB } = await adminClient
      .from('prompt_versions')
      .select('content, system_instructions, version_hash')
      .eq('template_id', brainBTpl.id)
      .eq('status', 'approved')
      .order('version_number', { ascending: false })
      .limit(1)
      .single();

    if (pvErrB || !brainBPrompt) {
      throw new Error('No approved Brain B prompt version found. Run P6.7 seed first.');
    }

    // BUG FIX 2: use problem_text (not description)
    const problemText = (submission.problems as { problem_text: string }).problem_text;

    // ── STAGE 1: Brain A — structure + gap analysis
    const { output: brainAOutput, latencyMs: latencyA, modelVersion } = await callBrainA(
      openaiKey,
      brainAPrompt.system_instructions ?? brainAPrompt.content,
      problemText,              // correct column name ✓
      submission.proof_text,    // Brain A gets proof_text ✓
      submission.submission_number
    );

    // ── STAGE 2: IMO Score computation (pure TS, zero AI cost)
    const scoreResult = computeImoScore(brainAOutput, effectiveHintDepth);

    // ── STAGE 3: Plagiarism check (pure TS, zero AI cost)
    const plagiarismResult = await checkPlagiarism(
      adminClient,
      submission.problem_id,
      submission.proof_text
    );

    // ── STAGE 4: Brain B — Socratic coaching
    // ENFORCEMENT: proof_text and answer_key are NOT in scope here.
    // callBrainB() does not accept proof_text as a parameter.
    const { response: socraticResponse, latencyMs: latencyB } = await callBrainB(
      openaiKey,
      brainBPrompt.system_instructions ?? brainBPrompt.content,
      brainAOutput,             // Only evaluation JSON — NOT proof_text ✓
      problemText,              // Problem statement only — NOT answer_key ✓
      submission.submission_number,
      effectiveHintDepth,
      submission.language_register ?? 'auto'
    );

    const totalLatency = latencyA + latencyB;

    // ── Write proof_evaluation (append-only via trigger)
    const { data: evaluation, error: evalErr } = await adminClient
      .from('proof_evaluations')
      .insert({
        submission_id:        submission_id,
        score:                scoreResult.capped,
        score_breakdown:      scoreResult.breakdown,
        structure_assessment: brainAOutput.structure,
        gaps_detected:        brainAOutput.gaps,
        approach_identified:  brainAOutput.approach,
        completeness:         brainAOutput.completeness,
        rigor:                brainAOutput.rigor,
        plagiarism_score:     plagiarismResult.plagiarism_score,
        plagiarism_source:    plagiarismResult.plagiarism_source,
        socratic_response:    socraticResponse,
        hint_depth:           effectiveHintDepth,
        prompt_version_hash:  brainAPrompt.version_hash,
        model_version:        modelVersion,
        latency_ms:           totalLatency,
      })
      .select()
      .single();

    if (evalErr) throw new Error(`Failed to write evaluation: ${evalErr.message}`);

    // ── Mark submission as evaluated
    await adminClient
      .from('proof_submissions')
      .update({ status: 'evaluated' })
      .eq('id', submission_id);

    // ── Log AI cost (P2 cost ledger)
    // BUG FIX 5: use brainATpl.id (template id), not brainATemplate.id
    await adminClient.from('ai_cost_ledger').insert({
      user_id:           user.id,
      feature:           'proof_mentor',
      model:             modelVersion,
      tokens_in:         Math.ceil((600 + 400) * 0.7),
      tokens_out:        Math.ceil((600 + 400) * 0.3),
      cost_usd:          0.004,
      prompt_version_id: brainATpl.id,
      prompt_version:    brainAPrompt.version_hash,
    });

    // ── Return to client
    return new Response(
      JSON.stringify({
        submission_id,
        evaluation_id:      evaluation.id,
        score:              scoreResult.capped,
        score_breakdown:    scoreResult.breakdown,
        socratic_response:  socraticResponse,
        hint_depth:         effectiveHintDepth,
        plagiarism_flagged: plagiarismResult.plagiarism_score > 0.70,
        gaps_count:         brainAOutput.gaps.length,
        approach:           brainAOutput.approach,
        completeness:       brainAOutput.completeness,
        rigor:              brainAOutput.rigor,
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      }
    );

  } catch (err) {
    console.error('[proof-mentor] Error:', err);

    // BUG FIX 4: body is now accessible in catch scope
    if (body?.submission_id) {
      await adminClient
        .from('proof_submissions')
        .update({ status: 'error' })
        .eq('id', body.submission_id)
        .catch(() => {});
    }

    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : 'Internal error' }),
      { status: 500 }
    );
  }
});