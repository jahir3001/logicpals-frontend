// supabase/functions/vision-tutor/index.ts
// LogicPals Phase 4 — Vision Guidance Pipeline
// Stages: Validate (P4.3) → Brain A (P4.4) → [Confirmation] (P4.7) → Brain B (P4.6)
// Brain A/B separation: Brain B NEVER receives the image.
// Multi-provider: Gemini 1.5 Flash (Brain A) + GPT-4o text (Brain B)
// Builds on: P0 circuit breaker, P1 rate limiting, P2 prompt templates

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// ── Environment ──────────────────────────────────────────────────────────────
const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY");
const OPENAI_KEY = Deno.env.get("OPENAI_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const GEMINI_FLASH_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent";

// ── Tier caps ────────────────────────────────────────────────────────────────
const TIER_PER_PROBLEM_CAP: Record<string, number> = {
  thinker: 2,
  scholar: 3,
  champion: 5,
  free_trial: 0, // ZERO vision calls — typed fallback only
};

const TIER_COOLDOWN_MS: Record<string, number> = {
  thinker: 30_000,
  scholar: 20_000,
  champion: 10_000,
};

// ── P0 Circuit Breaker (read/write via rate_limit_config) ────────────────────
async function isCircuitOpen(
  db: ReturnType<typeof createClient>,
  service: string
): Promise<boolean> {
  const { data } = await db
    .from("rate_limit_config")
    .select("config")
    .eq("key", `circuit_breaker_${service}`)
    .single();
  if (!data) return false;
  const cfg = data.config as { open: boolean; opened_at: string };
  if (!cfg.open) return false;
  // Auto half-open after 60s
  const elapsed = Date.now() - new Date(cfg.opened_at).getTime();
  return elapsed < 60_000;
}

async function tripCircuit(
  db: ReturnType<typeof createClient>,
  service: string
): Promise<void> {
  await db.from("rate_limit_config").upsert({
    key: `circuit_breaker_${service}`,
    config: { open: true, opened_at: new Date().toISOString() },
  });
}

async function closeCircuit(
  db: ReturnType<typeof createClient>,
  service: string
): Promise<void> {
  await db.from("rate_limit_config").upsert({
    key: `circuit_breaker_${service}`,
    config: { open: false, opened_at: null },
  });
}

// ── Rate Limit Check (P1) ─────────────────────────────────────────────────────
async function checkRateLimit(
  db: ReturnType<typeof createClient>,
  userId: string,
  counter: string
): Promise<{ allowed: boolean; reason?: string }> {
  const { data, error } = await db.rpc("check_rate_limit", {
    p_user_id: userId,
    p_counter_name: counter,
  });
  if (error) {
    console.error("Rate limit check error:", error.message);
    return { allowed: false, reason: "Rate limit check failed" };
  }
  return { allowed: data === true };
}

// ── Stage 0: Image Validation ─────────────────────────────────────────────────
async function validateImage(
  imageBase64: string,
  mimeType: string
): Promise<{
  is_math: boolean;
  confidence: number;
  content_type: string;
  quality: string;
  raw?: unknown;
}> {
  const VALIDATE_PROMPT =
    'You are an image validator for a math education platform. Analyze this image and respond ONLY with a JSON object: {"is_math": true/false, "confidence": 0.0-1.0, "content_type": "handwritten_math"|"printed_math"|"not_math"|"unclear", "quality": "good"|"acceptable"|"poor"}. Do not explain. Only return JSON.';

  const res = await fetch(`${GEMINI_FLASH_URL}?key=${GEMINI_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { inline_data: { mime_type: mimeType, data: imageBase64 } },
            { text: VALIDATE_PROMPT },
          ],
        },
      ],
      generationConfig: { maxOutputTokens: 100, temperature: 0.1 },
    }),
  });

  if (!res.ok) {
    throw new Error(`Gemini validate error: ${res.status} ${await res.text()}`);
  }

  const json = await res.json();
  const rawText: string =
    json.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
  const cleaned = rawText.replace(/```json|```/g, "").trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    return {
      is_math: false,
      confidence: 0,
      content_type: "unclear",
      quality: "poor",
    };
  }
}

// ── Stage 1: Brain A — Gemini 1.5 Flash + image ───────────────────────────────
async function runBrainA(
  imageBase64: string,
  mimeType: string,
  problemDescription: string,
  attemptNumber: number
): Promise<{
  steps_detected: { step: number; summary: string; confidence: number }[];
  errors: { step: number; type: string; severity: string }[];
  approach_detected: string | null;
  overall_confidence: number;
  language: "en" | "bn" | "banglish";
  tokens_used?: number;
  latency_ms: number;
}> {
  const BRAIN_A_PROMPT = `You are an expert math tutor analyzing a student's handwritten work.
The student is working on: ${problemDescription}
This is attempt #${attemptNumber} of this problem.
Analyze the uploaded image and respond ONLY with this JSON structure:
{
  "steps_detected": [{"step": 1, "summary": "...", "confidence": 0.0-1.0}],
  "errors": [{"step": N, "type": "...", "severity": "minor|major|critical"}],
  "approach_detected": "name or null",
  "overall_confidence": 0.0-1.0,
  "language": "en|bn|banglish"
}
Error types: calculation_error, logic_gap, missing_step, wrong_approach, incomplete_argument, notation_error
Do NOT provide hints or solutions. Only analyze what the student wrote.`;

  const t0 = Date.now();

  const res = await fetch(`${GEMINI_FLASH_URL}?key=${GEMINI_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { inline_data: { mime_type: mimeType, data: imageBase64 } },
            { text: BRAIN_A_PROMPT },
          ],
        },
      ],
      generationConfig: { maxOutputTokens: 400, temperature: 0.2 },
    }),
  });

  const latency_ms = Date.now() - t0;

  if (!res.ok) {
    throw new Error(`Brain A error: ${res.status} ${await res.text()}`);
  }

  const json = await res.json();
  const rawText: string =
    json.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
  const cleaned = rawText.replace(/```json|```/g, "").trim();
  const tokens_used: number =
    json.usageMetadata?.totalTokenCount ?? 0;

  try {
    const parsed = JSON.parse(cleaned);
    return { ...parsed, tokens_used, latency_ms };
  } catch {
    throw new Error("Brain A returned non-JSON output");
  }
}

// ── Stage 2: Brain B — GPT-4o text only (NO image) ───────────────────────────
async function runBrainB(
  diagnosisJson: object,
  problemDescription: string,
  attemptNumber: number,
  languageRegister: string,
  confirmationApplied: boolean
): Promise<{ hint: string; tokens_used: number; latency_ms: number }> {
  const BRAIN_B_PROMPT = `You are a Socratic math tutor helping a student who uploaded their work.
You have received an analysis of their work (below).
You do NOT have their image or the solution.
Analysis: ${JSON.stringify(diagnosisJson)}
Problem: ${problemDescription}
Attempt #: ${attemptNumber}
Language: ${languageRegister}
Confirmation applied: ${confirmationApplied}
Hint depth rules:
- Attempt 1: Vague directional hint. "Think about what happens when..."
- Attempt 2: More specific. "In step 3, check your factor..."
- Attempt 3: Direct coaching. "Step 3 has a factoring error. Try..."
NEVER reveal the full solution.
NEVER say "the answer is...".
Always reference specific steps: "In your step 2, you wrote..."
If language is "banglish": use Bengali grammar with English math terms.`;

  const t0 = Date.now();

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o",
      max_tokens: 300,
      temperature: 0.4,
      messages: [
        { role: "system", content: BRAIN_B_PROMPT },
        { role: "user", content: "Please provide the Socratic hint." },
      ],
    }),
  });

  const latency_ms = Date.now() - t0;

  if (!res.ok) {
    throw new Error(`Brain B error: ${res.status} ${await res.text()}`);
  }

  const json = await res.json();
  const hint: string = json.choices?.[0]?.message?.content ?? "";
  const tokens_used: number = json.usage?.total_tokens ?? 0;

  return { hint, tokens_used, latency_ms };
}

// ── Typed Fallback (P4.8) — no image, text steps only ────────────────────────
async function runTypedFallback(
  typedSteps: string[],
  problemDescription: string,
  attemptNumber: number,
  languageRegister: string
): Promise<{ hint: string; tokens_used: number; latency_ms: number }> {
  const stepsText = typedSteps
    .map((s, i) => `Step ${i + 1}: ${s}`)
    .join("\n");

  const FALLBACK_PROMPT = `You are a Socratic math tutor. A student has typed their solution steps (they could not upload an image).
Steps provided:
${stepsText}
Problem: ${problemDescription}
Attempt #: ${attemptNumber}
Language: ${languageRegister}
Give ONE focused Socratic hint. Reference their step numbers.
NEVER reveal the full solution or final answer.
Keep response under 100 words.`;

  const t0 = Date.now();

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o",
      max_tokens: 200,
      temperature: 0.4,
      messages: [{ role: "user", content: FALLBACK_PROMPT }],
    }),
  });

  const latency_ms = Date.now() - t0;

  if (!res.ok) {
    throw new Error(`Typed fallback error: ${res.status}`);
  }

  const json = await res.json();
  const hint: string = json.choices?.[0]?.message?.content ?? "";
  const tokens_used: number = json.usage?.total_tokens ?? 0;

  return { hint, tokens_used, latency_ms };
}

// ── Cost Ledger Entry (P0) ────────────────────────────────────────────────────
async function logCost(
  db: ReturnType<typeof createClient>,
  userId: string,
  submissionId: string,
  stage: string,
  provider: string,
  model: string,
  tokensUsed: number,
  latencyMs: number
): Promise<void> {
  // Cost estimates: Gemini Flash ~$0.000075/1K tokens, GPT-4o ~$0.005/1K tokens
  const costPer1k: Record<string, number> = {
    "gemini-1.5-flash": 0.000075,
    "gpt-4o": 0.005,
  };
  const estimatedCost = (tokensUsed / 1000) * (costPer1k[model] ?? 0.001);

  await db.from("ai_cost_ledger").insert({
    user_id: userId,
    reference_id: submissionId,
    reference_type: "vision_submission",
    stage,
    provider,
    model,
    tokens_used: tokensUsed,
    estimated_cost_usd: estimatedCost,
    latency_ms: latencyMs,
  });
}

// ── Main Handler ──────────────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  try {
    if (!GEMINI_KEY) throw new Error("Missing GEMINI_API_KEY");
    if (!OPENAI_KEY) throw new Error("Missing OPENAI_API_KEY");

    // ── Auth ──────────────────────────────────────────────────────────────────
    const authHeader = req.headers.get("authorization") ?? "";
    const token = authHeader.replace("Bearer ", "");
    const {
      data: { user },
      error: authErr,
    } = await db.auth.getUser(token);

    if (authErr || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const userId = user.id;

    // ── Parse request body ────────────────────────────────────────────────────
    const body = await req.json();
    const {
      mode,           // "vision" | "typed_fallback"
      image_base64,   // base64 string (vision mode only)
      mime_type,      // "image/jpeg" | "image/png" | "image/webp"
      problem_id,
      problem_description,
      attempt_number = 1,
      typed_steps,    // string[] (typed fallback mode)
      submission_id,  // provided if continuation (confirmation loop reply)
      confirmation_response, // true | false (confirmation loop P4.7)
    } = body;

    if (!problem_id || !problem_description) {
      return new Response(
        JSON.stringify({ error: "problem_id and problem_description required" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // ── Get user tier ─────────────────────────────────────────────────────────
    const { data: sub } = await db
      .from("subscriptions")
      .select("tier")
      .eq("user_id", userId)
      .eq("active", true)
      .single();

    const tier: string = sub?.tier ?? "free_trial";

    // ── TYPED FALLBACK path ───────────────────────────────────────────────────
    if (mode === "typed_fallback") {
      if (!typed_steps || !Array.isArray(typed_steps) || typed_steps.length === 0) {
        return new Response(
          JSON.stringify({ error: "typed_steps required for fallback mode" }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      // Typed fallback uses ai_text_calls counter (cheaper)
      const rateCheck = await checkRateLimit(db, userId, "ai_text_calls");
      if (!rateCheck.allowed) {
        return new Response(
          JSON.stringify({
            error: "Text limit reached for today",
            fallback_message:
              "You've used all your daily guidance sessions. Try again tomorrow!",
          }),
          {
            status: 429,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      const { hint, tokens_used, latency_ms } = await runTypedFallback(
        typed_steps,
        problem_description,
        attempt_number,
        "en"
      );

      // Log cost (P0)
      const subRecord = await db
        .from("vision_submissions")
        .insert({
          user_id: userId,
          problem_id,
          attempt_number,
          status: "responded",
          fallback_used: true,
        })
        .select("id")
        .single();

      if (subRecord.data) {
        await logCost(
          db,
          userId,
          subRecord.data.id,
          "vision_fallback",
          "openai",
          "gpt-4o",
          tokens_used,
          latency_ms
        );
      }

      return new Response(
        JSON.stringify({
          mode: "typed_fallback",
          hint,
          submission_id: subRecord.data?.id,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── VISION path ───────────────────────────────────────────────────────────

    // P4.9 Rate limiting: free_trial blocked entirely
    if (tier === "free_trial") {
      return new Response(
        JSON.stringify({
          error: "vision_not_available",
          fallback_message:
            "Image upload is available on Thinker, Scholar, and Champion plans. Type your steps below to get guidance!",
          show_typed_fallback: true,
        }),
        {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    if (!image_base64 || !mime_type) {
      return new Response(
        JSON.stringify({ error: "image_base64 and mime_type required for vision mode" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Daily vision rate limit (P1)
    const rateCheck = await checkRateLimit(db, userId, "ai_vision_calls");
    if (!rateCheck.allowed) {
      return new Response(
        JSON.stringify({
          error: "vision_limit_reached",
          fallback_message:
            "You've used all your vision guidance for today. Type your steps instead?",
          show_typed_fallback: true,
        }),
        {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Per-problem cap
    const { count: perProblemCount } = await db
      .from("vision_submissions")
      .select("*", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("problem_id", problem_id)
      .neq("status", "rejected");

    const tierCap = TIER_PER_PROBLEM_CAP[tier] ?? 2;
    if ((perProblemCount ?? 0) >= tierCap) {
      return new Response(
        JSON.stringify({
          error: "per_problem_limit_reached",
          fallback_message: `You've reached the upload limit for this problem (${tierCap} attempts). Type your steps for more guidance.`,
          show_typed_fallback: true,
        }),
        {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Cooldown check
    const { data: lastSub } = await db
      .from("vision_submissions")
      .select("created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (lastSub) {
      const cooldown = TIER_COOLDOWN_MS[tier] ?? 30_000;
      const elapsed = Date.now() - new Date(lastSub.created_at).getTime();
      if (elapsed < cooldown) {
        const wait = Math.ceil((cooldown - elapsed) / 1000);
        return new Response(
          JSON.stringify({
            error: "cooldown_active",
            fallback_message: `Please wait ${wait} seconds before uploading again.`,
          }),
          {
            status: 429,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }
    }

    // ── Confirmation loop continuation (P4.7) ─────────────────────────────────
    // If submission_id provided + confirmation_response provided: skip to Brain B
    if (submission_id && confirmation_response !== undefined) {
      const { data: existingDiag } = await db
        .from("vision_diagnoses")
        .select("*")
        .eq("submission_id", submission_id)
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

      if (!existingDiag) {
        return new Response(
          JSON.stringify({ error: "Diagnosis not found for submission" }),
          {
            status: 404,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      // Adjust diagnosis based on confirmation
      let diagnosisForB = { ...existingDiag };
      if (!confirmation_response) {
        // Student denied the approach — broaden analysis, lower confidence
        diagnosisForB.approach_detected = null;
        diagnosisForB.overall_confidence = Math.max(
          0,
          (existingDiag.overall_confidence ?? 0.5) - 0.2
        );
      }

      const { hint, tokens_used, latency_ms } = await runBrainB(
        {
          steps_detected: diagnosisForB.steps_detected,
          errors: diagnosisForB.errors_detected,
          approach_detected: diagnosisForB.approach_detected,
          overall_confidence: diagnosisForB.overall_confidence,
        },
        problem_description,
        attempt_number,
        diagnosisForB.language_detected ?? "en",
        true
      );

      // Log cost
      await logCost(
        db,
        userId,
        submission_id,
        "brain_b_confirmed",
        "openai",
        "gpt-4o",
        tokens_used,
        latency_ms
      );

      // Update submission status (via service_role — bypasses trigger)
      await db
        .from("vision_submissions")
        .update({ status: "responded", updated_at: new Date().toISOString() })
        .eq("id", submission_id);

      return new Response(
        JSON.stringify({
          mode: "vision",
          stage: "brain_b_confirmed",
          submission_id,
          hint,
          language: diagnosisForB.language_detected,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Full pipeline: Stage 0 → Brain A → [Confirmation check] → Brain B ────

    // Check circuit breaker for Gemini
    const circuitOpen = await isCircuitOpen(db, "gemini");
    if (circuitOpen) {
      return new Response(
        JSON.stringify({
          error: "vision_unavailable",
          fallback_message:
            "Vision analysis is temporarily unavailable. Please type your steps below.",
          show_typed_fallback: true,
        }),
        {
          status: 503,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Create submission record
    const { data: newSub, error: subErr } = await db
      .from("vision_submissions")
      .insert({
        user_id: userId,
        problem_id,
        attempt_number,
        status: "validating",
      })
      .select("id")
      .single();

    if (subErr || !newSub) {
      throw new Error("Failed to create submission record");
    }

    const subId = newSub.id;

    // ── Stage 0: Validate ────────────────────────────────────────────────────
    let validateResult: Awaited<ReturnType<typeof validateImage>>;
    const t0_validate = Date.now();

    try {
      validateResult = await validateImage(image_base64, mime_type);
    } catch (e) {
      await tripCircuit(db, "gemini");
      await db
        .from("vision_submissions")
        .update({ status: "error", updated_at: new Date().toISOString() })
        .eq("id", subId);
      return new Response(
        JSON.stringify({
          error: "vision_service_error",
          fallback_message: "Vision service unavailable. Please type your steps.",
          show_typed_fallback: true,
        }),
        {
          status: 503,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const validate_latency = Date.now() - t0_validate;
    await logCost(
      db,
      userId,
      subId,
      "vision_validate",
      "google",
      "gemini-1.5-flash",
      100, // fixed max for validate
      validate_latency
    );

    // Stage 0 decision
    const isRejected =
      !validateResult.is_math ||
      validateResult.confidence < 0.4 ||
      validateResult.quality === "poor";

    if (isRejected) {
      await db
        .from("vision_submissions")
        .update({
          status: "rejected",
          rejection_reason: `content_type=${validateResult.content_type} quality=${validateResult.quality} confidence=${validateResult.confidence}`,
          updated_at: new Date().toISOString(),
        })
        .eq("id", subId);

      return new Response(
        JSON.stringify({
          mode: "vision",
          stage: "rejected",
          submission_id: subId,
          reason: validateResult.content_type,
          quality: validateResult.quality,
          message:
            validateResult.content_type === "not_math"
              ? "This doesn't look like math work. Please upload a photo of your solution."
              : validateResult.quality === "poor"
              ? "The image quality is too low. Please take a clearer photo in good lighting."
              : "We couldn't read your work clearly. Please try again with a clearer photo.",
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Stage 1: Brain A ──────────────────────────────────────────────────────
    await db
      .from("vision_submissions")
      .update({ status: "analyzing", updated_at: new Date().toISOString() })
      .eq("id", subId);

    let brainAResult: Awaited<ReturnType<typeof runBrainA>>;

    try {
      brainAResult = await runBrainA(
        image_base64,
        mime_type,
        problem_description,
        attempt_number
      );
    } catch (e) {
      await tripCircuit(db, "gemini");
      await db
        .from("vision_submissions")
        .update({ status: "error", updated_at: new Date().toISOString() })
        .eq("id", subId);
      return new Response(
        JSON.stringify({
          error: "brain_a_failed",
          fallback_message:
            "Couldn't analyze your work right now. Type your steps for guidance.",
          show_typed_fallback: true,
        }),
        {
          status: 503,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Circuit closed on success
    await closeCircuit(db, "gemini");

    await logCost(
      db,
      userId,
      subId,
      "brain_a",
      "google",
      "gemini-1.5-flash",
      brainAResult.tokens_used ?? 400,
      brainAResult.latency_ms
    );

    // ── P4.5: Store diagnosis (Brain A → Brain B contract) ────────────────────
    await db
      .from("vision_submissions")
      .update({ status: "diagnosed", updated_at: new Date().toISOString() })
      .eq("id", subId);

    // Insert diagnosis record
    const { data: diagRecord } = await db
      .from("vision_diagnoses")
      .insert({
        submission_id: subId,
        user_id: userId,
        steps_detected: brainAResult.steps_detected,
        errors_detected: brainAResult.errors,
        approach_detected: brainAResult.approach_detected,
        overall_confidence: brainAResult.overall_confidence,
        language_detected: brainAResult.language,
        brain_a_model: "gemini-1.5-flash",
        brain_a_tokens_used: brainAResult.tokens_used,
        brain_a_latency_ms: brainAResult.latency_ms,
        validate_confidence: validateResult.confidence,
        validate_content_type: validateResult.content_type,
        prompt_version_a: "1.0.0",
      })
      .select("id")
      .single();

    // ── P4.7: Confirmation loop check ─────────────────────────────────────────
    const needsConfirmation =
      brainAResult.overall_confidence >= 0.5 &&
      brainAResult.overall_confidence <= 0.8 &&
      brainAResult.approach_detected !== null &&
      attempt_number === 1;

    if (needsConfirmation) {
      return new Response(
        JSON.stringify({
          mode: "vision",
          stage: "confirmation_required",
          submission_id: subId,
          diagnosis_id: diagRecord?.id,
          confirmation_prompt: `I see you're using ${brainAResult.approach_detected} in your work. Is that correct?`,
          approach_detected: brainAResult.approach_detected,
          confidence: brainAResult.overall_confidence,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Stage 2: Brain B ──────────────────────────────────────────────────────
    await db
      .from("vision_submissions")
      .update({ status: "confirmed", updated_at: new Date().toISOString() })
      .eq("id", subId);

    const { hint, tokens_used: bbTokens, latency_ms: bbLatency } =
      await runBrainB(
        {
          steps_detected: brainAResult.steps_detected,
          errors: brainAResult.errors,
          approach_detected: brainAResult.approach_detected,
          overall_confidence: brainAResult.overall_confidence,
        },
        problem_description,
        attempt_number,
        brainAResult.language,
        false
      );

    await logCost(
      db,
      userId,
      subId,
      "brain_b",
      "openai",
      "gpt-4o",
      bbTokens,
      bbLatency
    );

    // Update diagnosis with Brain B output
    if (diagRecord?.id) {
      await db.from("vision_diagnoses").insert({
        // Append new row with brain_b data — diagnoses is fully append-only
        // NOTE: We insert a second row linked to same submission, tracking B result
        // Alternatively: use a separate vision_brain_b_responses table
        // Per architecture: diagnoses is append-only; we insert a new row
        submission_id: subId,
        user_id: userId,
        brain_b_hint: hint,
        brain_b_model: "gpt-4o",
        brain_b_tokens_used: bbTokens,
        brain_b_latency_ms: bbLatency,
        prompt_version_b: "1.0.0",
        steps_detected: brainAResult.steps_detected,
        errors_detected: brainAResult.errors,
        approach_detected: brainAResult.approach_detected,
        overall_confidence: brainAResult.overall_confidence,
        language_detected: brainAResult.language,
        brain_a_model: "gemini-1.5-flash",
        validate_confidence: validateResult.confidence,
        validate_content_type: validateResult.content_type,
      });
    }

    await db
      .from("vision_submissions")
      .update({ status: "responded", updated_at: new Date().toISOString() })
      .eq("id", subId);

    // ── Final response ────────────────────────────────────────────────────────
    return new Response(
      JSON.stringify({
        mode: "vision",
        stage: "responded",
        submission_id: subId,
        hint,
        language: brainAResult.language,
        steps_count: brainAResult.steps_detected?.length ?? 0,
        errors_count: brainAResult.errors?.length ?? 0,
        approach_detected: brainAResult.approach_detected,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Vision tutor crash:", error.message);
    return new Response(
      JSON.stringify({
        error: error.message,
        fallback_message:
          "Something went wrong. Please type your steps for guidance.",
        show_typed_fallback: true,
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});