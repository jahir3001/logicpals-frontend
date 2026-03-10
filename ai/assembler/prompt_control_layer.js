/**
 * LOGICPALS PROMPT CONTROL LAYER - PRODUCTION VERSION
 * Step 1 Implementation - FIXED with additional production improvements
 *
 * FIXES APPLIED (original + new):
 * 1. ✅ Answer key only included in "review" state (never during active attempt)
 * 2. ✅ Hint gating enforced in backend before assembly
 * 3. ✅ attempt_state explicitly required as input
 * 4. ✅ Provider-agnostic structured output
 * 5. ✅ Clear distinction: Step 1 DB fields only (not full Step 3 schema)
 *
 * NEW (critical for stopping ACTIVE leaks):
 * 6. ✅ Response Template layer added (strict output format by attempt_state)
 * 7. ✅ Standard chat_messages[] added (OpenAI/Anthropic friendly)
 * 8. ✅ Safe fallback templates if response_templates.json not present yet
 *
 * ALWAYS assemble prompts in this exact order:
 * 1. SYSTEM PROMPT (global constitution)
 * 2. TIER PROMPT (difficulty governor)
 * 3. MODE PROMPT (session context)
 * 4. RESPONSE TEMPLATE (strict output format)
 * 5. CONTEXT PROMPT (problem + student state)
 */

const fs = require("fs");
const path = require("path");

// Load prompt JSON files
const SYSTEM_PROMPT = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../prompts/system_prompt.json"), "utf8")
);
const TIER_PROMPTS = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../prompts/tier_prompts.json"), "utf8")
);
const MODE_PROMPTS = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../prompts/mode_prompts.json"), "utf8")
);

// Response templates (strict output formats)
// We try to load: ai/prompts/response_templates.json
// If missing, we use safe defaults so your app doesn't crash.
let RESPONSE_TEMPLATES = null;
try {
  RESPONSE_TEMPLATES = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "../prompts/response_templates.json"),
      "utf8"
    )
  );
} catch (e) {
  RESPONSE_TEMPLATES = {
    active_v1: [
      "OUTPUT RULES (ACTIVE ATTEMPT):",
      "- DO NOT reveal the final answer or full solution.",
      "- DO NOT use phrases like 'final answer', 'answer is', or show computed results.",
      "- Ask ONE focused question OR give ONE small hint.",
      "- Keep it short (max ~80 words).",
      "- Do not provide step-by-step solution."
    ],
    submitted_v1: [
      "OUTPUT RULES (SUBMITTED):",
      "- Student has submitted, but this is not review yet.",
      "- Acknowledge submission briefly.",
      "- Ask if they want review mode.",
      "- Do NOT reveal the final answer or full solution."
    ],
    review_v1: [
      "OUTPUT RULES (REVIEW MODE):",
      "- Student already submitted; provide full solution clearly.",
      "- Include final answer and explain reasoning.",
      "- Use steps if helpful.",
      "- Be crisp and correct."
    ]
  };
}

/**
 * Assemble complete prompt for AI interaction
 *
 * @param {Object} config - Configuration object
 * @param {string} config.tier - Difficulty tier: 'warmup' | 'standard' | 'challenge' | 'contest' | 'elite'
 * @param {string} config.mode - Training mode: 'bootcamp' | 'mixed' | 'mock'
 * @param {string} config.attempt_state - Attempt state: 'active' | 'submitted' | 'review'
 * @param {Object} config.problem - Problem object with statement, archetype, etc.
 * @param {Object} config.studentState - Student's current state (level, mastery, etc.)
 * @returns {Object} - Structured prompt object (provider-agnostic)
 */
function assemblePrompt(config) {
  const { tier, mode, attempt_state, problem, studentState } = config;

  // ✅ FIX 3: Validate attempt_state is required
  if (!attempt_state) {
    throw new Error(
      'Missing required parameter: attempt_state (must be "active", "submitted", or "review")'
    );
  }

  // Validate required parameters
  if (!tier || !mode || !problem) {
    throw new Error("Missing required parameters: tier, mode, problem");
  }

  // Validate tier
  const validTiers = ["warmup", "standard", "challenge", "contest", "elite"];
  if (!validTiers.includes(tier)) {
    throw new Error(
      `Invalid tier: ${tier}. Must be one of: ${validTiers.join(", ")}`
    );
  }

  // Validate mode
  const validModes = ["bootcamp", "mixed", "mock"];
  if (!validModes.includes(mode)) {
    throw new Error(
      `Invalid mode: ${mode}. Must be one of: ${validModes.join(", ")}`
    );
  }

  // Validate attempt_state
  const validStates = ["active", "submitted", "review"];
  if (!validStates.includes(attempt_state)) {
    throw new Error(
      `Invalid attempt_state: ${attempt_state}. Must be one of: ${validStates.join(
        ", "
      )}`
    );
  }

  // ✅ FIX 2: Enforce hint gating in backend
  const allowedHints = getGatedHints(tier, mode, attempt_state, problem.hints || []);

  // Build structured prompt components
  const systemPrompt = buildSystemPrompt();
  const developerPrompts = buildDeveloperPrompts(tier, mode);
  const responseTemplate = buildResponseTemplate(attempt_state);
  const contextPrompt = buildContextPrompt(
    problem,
    studentState,
    attempt_state,
    allowedHints
  );

  // Flattened system string (backward compatible)
  const flattenedSystem = [
    systemPrompt,
    ...developerPrompts,
    responseTemplate,
    contextPrompt
  ].join("\n\n");

  // ✅ NEW: Provider-agnostic standard messages array (OpenAI/Anthropic friendly)
  // We keep policy/template in "system" role and context in "user" role.
  const chat_messages = [
    { role: "system", content: systemPrompt },
    { role: "system", content: developerPrompts.join("\n\n") },
    { role: "system", content: responseTemplate },
    { role: "user", content: contextPrompt }
  ];

  return {
    // Structured components (future-proof)
    components: {
      system: systemPrompt,
      developer: developerPrompts,
      response_template: responseTemplate,
      context: contextPrompt
    },

    // ✅ Backward compatible (your current usage)
    messages: {
      system: flattenedSystem,
      role: "system"
    },

    // ✅ Standard chat messages
    chat_messages,

    // Metadata for logging/debugging
    metadata: {
      tier,
      mode,
      attempt_state,
      problem_id: problem.id || "unknown",
      archetype: problem.archetype || "unknown",
      skill_track: problem.skill_track || "unknown",
      student_level: studentState?.level || "unknown",
      hints_allowed: allowedHints.length,
      answer_included: attempt_state === "review",
      response_template_version: getResponseTemplateVersion(attempt_state)
    }
  };
}

/**
 * ✅ FIX 2: Gate hints based on tier, mode, and attempt state
 * CRITICAL: This must happen BEFORE prompt assembly
 *
 * @param {string} tier - Difficulty tier
 * @param {string} mode - Training mode
 * @param {string} attempt_state - Current attempt state
 * @param {Array} hints - Available hints from database
 * @returns {Array} - Filtered hints array (empty if not allowed)
 */
function getGatedHints(tier, mode, attempt_state, hints) {
  // Rule 1: No hints if attempt is not active
  if (attempt_state !== "active") {
    return [];
  }

  // Rule 2: Contest and Elite NEVER get hints during active attempt
  if (tier === "contest" || tier === "elite") {
    return [];
  }

  // Rule 3: Mock mode in Contest/Elite never gets hints
  if (mode === "mock" && (tier === "contest" || tier === "elite")) {
    return [];
  }

  // Rule 4: Otherwise, hints are allowed (tier prompt controls when to give them)
  return hints || [];
}

/**
 * Build system prompt component
 *
 * @returns {string} - System prompt text
 */
function buildSystemPrompt() {
  return (SYSTEM_PROMPT.content || []).join("\n");
}

/**
 * Build developer prompts (tier + mode)
 *
 * @param {string} tier - Difficulty tier
 * @param {string} mode - Training mode
 * @returns {Array<string>} - Developer prompt texts
 */
function buildDeveloperPrompts(tier, mode) {
  const prompts = [];

  // Tier prompt
  const tierPromptKey = `tier_${tier}_v1`;
  const tierPrompt = TIER_PROMPTS[tierPromptKey];
  if (!tierPrompt) {
    throw new Error(`Tier prompt not found: ${tierPromptKey}`);
  }
  prompts.push((tierPrompt.content || []).join("\n"));

  // Mode prompt
  const modePromptKey = `mode_${mode}_v1`;
  const modePrompt = MODE_PROMPTS[modePromptKey];
  if (!modePrompt) {
    throw new Error(`Mode prompt not found: ${modePromptKey}`);
  }
  prompts.push((modePrompt.content || []).join("\n"));

  return prompts;
}

/**
 * ✅ NEW: Response Template layer (strict output format)
 *
 * @param {string} attempt_state - 'active' | 'submitted' | 'review'
 * @returns {string} - Response template text
 */
function buildResponseTemplate(attempt_state) {
  // Prefer state-specific templates if available
  if (attempt_state === "active" && RESPONSE_TEMPLATES.active_v1) {
    return RESPONSE_TEMPLATES.active_v1.join("\n");
  }
  if (attempt_state === "submitted" && RESPONSE_TEMPLATES.submitted_v1) {
    return RESPONSE_TEMPLATES.submitted_v1.join("\n");
  }
  if (attempt_state === "review" && RESPONSE_TEMPLATES.review_v1) {
    return RESPONSE_TEMPLATES.review_v1.join("\n");
  }

  // Fallback: safest behavior (no answer) for unknown states
  const safe = RESPONSE_TEMPLATES.active_v1 || [
    "OUTPUT RULES:",
    "- Do not reveal final answer.",
    "- Ask one helpful question."
  ];
  return safe.join("\n");
}

function getResponseTemplateVersion(attempt_state) {
  if (attempt_state === "active") return "active_v1";
  if (attempt_state === "submitted") return "submitted_v1";
  if (attempt_state === "review") return "review_v1";
  return "active_v1";
}

/**
 * Build context prompt with problem details and student state
 * ✅ FIX 1: Only include answer_key in "review" state
 *
 * @param {Object} problem - Problem object
 * @param {Object} studentState - Student state object
 * @param {string} attempt_state - Current attempt state
 * @param {Array} allowedHints - Gated hints (already filtered)
 * @returns {string} - Context prompt text
 */
function buildContextPrompt(problem, studentState, attempt_state, allowedHints) {
  const context = [];

  context.push("PROBLEM CONTEXT:");
  context.push("");

  // Problem statement (always included)
  if (problem.statement) {
    context.push("Problem Statement:");
    context.push(problem.statement);
    context.push("");
  }

  // Archetype (internal - don't reveal to student)
  if (problem.archetype) {
    context.push(`Internal Archetype: ${problem.archetype}`);
    context.push(
      "(Use this to guide hint strategy, but do not mention archetype name to student)"
    );
    context.push("");
  }

  // Skill track
  if (problem.skill_track) {
    context.push(`Skill Track: ${problem.skill_track}`);
    context.push("");
  }

  // Student context
  if (studentState) {
    context.push("STUDENT CONTEXT:");
    context.push("");

    if (studentState.level) {
      context.push(`Student Level: ${studentState.level}`);
    }

    if (studentState.age) {
      context.push(`Age: ${studentState.age} years`);
    }

    if (studentState.attempts_on_this_archetype !== undefined) {
      context.push(
        `Previous attempts on this archetype: ${studentState.attempts_on_this_archetype}`
      );
    }

    context.push("");
  }

  // ✅ Hints during ACTIVE attempt only (already gated)
  if (attempt_state === "active" && allowedHints.length > 0) {
    context.push("AVAILABLE HINTS:");
    context.push("(Use these ONLY when appropriate per tier rules)");
    allowedHints.forEach((hint, index) => {
      context.push(`Hint ${index + 1}: ${hint}`);
    });
    context.push("");
  }

  // ✅ Only include answer_key in REVIEW state
  if (attempt_state === "review" && problem.answer_key) {
    context.push("ANSWER & SOLUTION (REVIEW MODE):");
    context.push(
      "(Student has submitted their attempt. You may now provide full explanation)"
    );
    context.push("");
    context.push(`Correct Answer: ${problem.answer_key}`);

    if (problem.solution) {
      context.push("");
      context.push("Solution Steps:");
      context.push(problem.solution);
    }
    context.push("");
  }

  // Attempt state indicator
  context.push(`ATTEMPT STATE: ${attempt_state.toUpperCase()}`);
  if (attempt_state === "active") {
    context.push(
      "(Student is actively working on this problem - follow tier rules strictly)"
    );
  } else if (attempt_state === "submitted") {
    context.push(
      "(Student has submitted - acknowledge briefly; wait for review mode for full explanation)"
    );
  } else if (attempt_state === "review") {
    context.push(
      "(Review mode - provide complete explanation with answer and solution)"
    );
  }

  return context.join("\n");
}

/**
 * Get prompt summary for logging/debugging
 *
 * @param {Object} config - Same config as assemblePrompt
 * @returns {Object} - Summary object
 */
function getPromptSummary(config) {
  return {
    tier: config.tier,
    mode: config.mode,
    attempt_state: config.attempt_state,
    problem_id: config.problem?.id || "unknown",
    archetype: config.problem?.archetype || "unknown",
    student_level: config.studentState?.level || "unknown",
    hints_in_db: config.problem?.hints?.length || 0,
    hints_allowed: getGatedHints(
      config.tier,
      config.mode,
      config.attempt_state,
      config.problem?.hints || []
    ).length,
    answer_included: config.attempt_state === "review",
    response_template: getResponseTemplateVersion(config.attempt_state),
    prompt_assembly_order: [
      "system_olympiad_constitution_v1",
      `tier_${config.tier}_v1`,
      `mode_${config.mode}_v1`,
      `response_template_${getResponseTemplateVersion(config.attempt_state)}`,
      "context_prompt"
    ]
  };
}

/**
 * Validate prompt assembly result
 *
 * @param {Object} assembled - Assembled prompt object
 * @returns {Object} - Validation result
 */
function validatePromptAssembly(assembled) {
  const validation = {
    valid: true,
    errors: [],
    warnings: []
  };

  // Must have components structure
  if (!assembled.components) {
    validation.valid = false;
    validation.errors.push("Missing components structure");
  }

  // System prompt must exist
  if (!assembled.components?.system) {
    validation.valid = false;
    validation.errors.push("Missing system prompt");
  }

  // Response template must exist
  if (!assembled.components?.response_template) {
    validation.valid = false;
    validation.errors.push("Missing response template layer");
  }

  // Check for answer leakage prevention in system
  const systemContent = assembled.components?.system || "";
  if (!systemContent.includes("Never reveal the final answer")) {
    // Keep as error because your validator and tests depend on this guard
    validation.valid = false;
    validation.errors.push("System prompt missing answer leakage prevention");
  }

  // Validate chat_messages structure exists (recommended)
  if (!Array.isArray(assembled.chat_messages)) {
    validation.warnings.push(
      "Missing chat_messages[] (recommended for OpenAI/Anthropic standard APIs)"
    );
  }

  // Check metadata exists
  if (!assembled.metadata) {
    validation.warnings.push("Missing metadata (recommended for logging)");
  }

  // ✅ Validate hint gating + answer inclusion
  if (assembled.metadata) {
    const { tier, attempt_state, hints_allowed, answer_included } =
      assembled.metadata;

    // Contest/Elite should never have hints during active
    if (
      (tier === "contest" || tier === "elite") &&
      attempt_state === "active" &&
      hints_allowed > 0
    ) {
      validation.valid = false;
      validation.errors.push(
        "CRITICAL: Contest/Elite tier has hints during active attempt"
      );
    }

    // Answer should only be included in review
    if (attempt_state !== "review" && answer_included) {
      validation.valid = false;
      validation.errors.push("CRITICAL: Answer included during non-review state");
    }
  }

  return validation;
}

// ─────────────────────────────────────────────────────────────────────────────
// VISION MODES — Phase 4 (P4.3–P4.6)
// assembleVisionPrompt() is separate from assemblePrompt() because:
//   1. Brain A/B take images as input, not problem+studentState objects
//   2. Vision modes bypass tier/mode/hint gating (not applicable)
//   3. Brain B NEVER receives an image — enforced structurally here
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Assemble a vision pipeline prompt for Brain A or Brain B.
 *
 * @param {Object} config
 * @param {string} config.vision_mode - 'VISION_VALIDATE' | 'VISION_GUIDANCE_A' | 'VISION_GUIDANCE_B' | 'VISION_FALLBACK'
 * @param {string} [config.problem_description] - Human-readable problem text
 * @param {number} [config.attempt_number] - 1-based attempt index
 * @param {Object} [config.diagnosis_json] - Brain A output (Brain B only)
 * @param {string} [config.language_register] - 'en' | 'bn' | 'banglish'
 * @param {string[]} [config.typed_steps] - Student typed steps (VISION_FALLBACK only)
 * @returns {Object} Prompt payload safe to pass to the AI provider
 */
function assembleVisionPrompt(config) {
  const {
    vision_mode,
    problem_description,
    attempt_number = 1,
    diagnosis_json,
    language_register = "en",
    typed_steps = [],
  } = config;

  const VALID_VISION_MODES = [
    "VISION_VALIDATE",
    "VISION_GUIDANCE_A",
    "VISION_GUIDANCE_B",
    "VISION_FALLBACK",
  ];

  if (!VALID_VISION_MODES.includes(vision_mode)) {
    throw new Error(
      `Invalid vision_mode: ${vision_mode}. Must be one of: ${VALID_VISION_MODES.join(", ")}`
    );
  }

  // ── Mode-specific prompt assembly ──────────────────────────────────────────
  let systemContent;
  let maxTokens;
  let includesImage = false;

  switch (vision_mode) {
    case "VISION_VALIDATE":
      // Stage 0 — image required, cheap gatekeeper
      systemContent =
        'You are an image validator for a math education platform. ' +
        'Analyze this image and respond ONLY with a JSON object: ' +
        '{"is_math": true/false, "confidence": 0.0-1.0, ' +
        '"content_type": "handwritten_math"|"printed_math"|"not_math"|"unclear", ' +
        '"quality": "good"|"acceptable"|"poor"}. ' +
        'Do not explain. Only return JSON.';
      maxTokens = 100;
      includesImage = true;
      break;

    case "VISION_GUIDANCE_A":
      // Brain A — image required, structured JSON analysis only
      if (!problem_description) {
        throw new Error("VISION_GUIDANCE_A requires problem_description");
      }
      systemContent =
        `You are an expert math tutor analyzing a student's handwritten work.\n` +
        `The student is working on: ${problem_description}\n` +
        `This is attempt #${attempt_number} of this problem.\n` +
        `Analyze the uploaded image and respond ONLY with this JSON structure:\n` +
        `{\n` +
        `  "steps_detected": [{"step": 1, "summary": "...", "confidence": 0.0-1.0}],\n` +
        `  "errors": [{"step": N, "type": "...", "severity": "minor|major|critical"}],\n` +
        `  "approach_detected": "name or null",\n` +
        `  "overall_confidence": 0.0-1.0,\n` +
        `  "language": "en|bn|banglish"\n` +
        `}\n` +
        `Error types: calculation_error, logic_gap, missing_step, wrong_approach, ` +
        `incomplete_argument, notation_error\n` +
        `Do NOT provide hints or solutions. Only analyze what the student wrote.`;
      maxTokens = 400;
      includesImage = true;
      break;

    case "VISION_GUIDANCE_B":
      // Brain B — NO IMAGE EVER. Receives only diagnosis JSON.
      if (!diagnosis_json) {
        throw new Error("VISION_GUIDANCE_B requires diagnosis_json");
      }
      if (!problem_description) {
        throw new Error("VISION_GUIDANCE_B requires problem_description");
      }
      systemContent =
        `You are a Socratic math tutor helping a student who uploaded their work.\n` +
        `You have received an analysis of their work (below).\n` +
        `You do NOT have their image or the solution.\n` +
        `Analysis: ${JSON.stringify(diagnosis_json)}\n` +
        `Problem: ${problem_description}\n` +
        `Attempt #: ${attempt_number}\n` +
        `Language: ${language_register}\n` +
        `Hint depth rules:\n` +
        `- Attempt 1: Vague directional hint. "Think about what happens when..."\n` +
        `- Attempt 2: More specific. "In step 3, check your factor..."\n` +
        `- Attempt 3: Direct coaching. "Step 3 has a factoring error. Try..."\n` +
        `NEVER reveal the full solution.\n` +
        `NEVER say "the answer is...".\n` +
        `Always reference specific steps: "In your step 2, you wrote..."\n` +
        `If language is "banglish": use Bengali grammar with English math terms.`;
      maxTokens = 300;
      includesImage = false; // CRITICAL: Brain B never gets the image
      break;

    case "VISION_FALLBACK":
      // Typed fallback — no image at all
      if (!typed_steps || typed_steps.length === 0) {
        throw new Error("VISION_FALLBACK requires typed_steps array");
      }
      if (!problem_description) {
        throw new Error("VISION_FALLBACK requires problem_description");
      }
      const stepsText = typed_steps
        .map((s, i) => `Step ${i + 1}: ${s}`)
        .join("\n");
      systemContent =
        `You are a Socratic math tutor. A student has typed their solution steps ` +
        `(they could not upload an image).\n` +
        `Steps provided:\n${stepsText}\n` +
        `Problem: ${problem_description}\n` +
        `Attempt #: ${attempt_number}\n` +
        `Language: ${language_register}\n` +
        `Give ONE focused Socratic hint. Reference their step numbers.\n` +
        `NEVER reveal the full solution or final answer.\n` +
        `Keep response under 100 words.`;
      maxTokens = 200;
      includesImage = false;
      break;
  }

  // ── Brain A/B separation safety check ─────────────────────────────────────
  // Validate the prompt does not accidentally reference image for Brain B
  if (vision_mode === "VISION_GUIDANCE_B" && includesImage) {
    throw new Error(
      "CRITICAL: Brain B prompt must never include image. Architecture violation."
    );
  }

  const assembled = {
    vision_mode,
    system_prompt: systemContent,
    max_tokens: maxTokens,
    includes_image: includesImage,
    metadata: {
      vision_mode,
      attempt_number,
      language_register,
      has_diagnosis: !!diagnosis_json,
      has_typed_steps: typed_steps.length > 0,
      brain_separation_enforced: vision_mode === "VISION_GUIDANCE_B" ? true : null,
      prompt_version: "1.0.0",
      assembled_at: new Date().toISOString(),
    },
    // Chat messages format (provider-agnostic)
    chat_messages: [
      { role: "system", content: systemContent },
      { role: "user", content: "Please analyze and respond as instructed." },
    ],
  };

  return assembled;
}

/**
 * Validate a vision prompt assembly (mirrors validatePromptAssembly for vision)
 *
 * @param {Object} assembled - Result of assembleVisionPrompt()
 * @returns {Object} - { valid, errors, warnings }
 */
function validateVisionPromptAssembly(assembled) {
  const validation = { valid: true, errors: [], warnings: [] };

  if (!assembled.vision_mode) {
    validation.valid = false;
    validation.errors.push("Missing vision_mode");
  }

  if (!assembled.system_prompt) {
    validation.valid = false;
    validation.errors.push("Missing system_prompt");
  }

  // Critical: Brain B must never include image
  if (
    assembled.vision_mode === "VISION_GUIDANCE_B" &&
    assembled.includes_image
  ) {
    validation.valid = false;
    validation.errors.push(
      "CRITICAL: Brain B prompt has includes_image=true — architecture violation"
    );
  }

  // Brain A/B must produce structured JSON
  if (
    ["VISION_VALIDATE", "VISION_GUIDANCE_A"].includes(assembled.vision_mode) &&
    assembled.system_prompt &&
    !assembled.system_prompt.includes("JSON")
  ) {
    validation.valid = false;
    validation.errors.push(
      `${assembled.vision_mode} must instruct model to return JSON`
    );
  }

  // Warn if no metadata
  if (!assembled.metadata) {
    validation.warnings.push("Missing metadata");
  }

  return validation;
}

// Export functions
module.exports = {
  assemblePrompt,
  getGatedHints,
  buildContextPrompt,
  buildResponseTemplate,
  getPromptSummary,
  validatePromptAssembly,

  // Phase 4: Vision modes
  assembleVisionPrompt,
  validateVisionPromptAssembly,

  // Export prompt objects for direct access if needed
  SYSTEM_PROMPT,
  TIER_PROMPTS,
  MODE_PROMPTS
};