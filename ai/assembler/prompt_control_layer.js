/**
 * LOGICPALS PROMPT CONTROL LAYER - PRODUCTION VERSION
 * Step 1 Implementation - FIXED with 5 critical production improvements
 * 
 * FIXES APPLIED:
 * 1. ✅ Answer key only included in "review" state (never during active attempt)
 * 2. ✅ Hint gating enforced in backend before assembly
 * 3. ✅ attempt_state explicitly required as input
 * 4. ✅ Provider-agnostic structured output
 * 5. ✅ Clear distinction: Step 1 DB fields only (not full Step 3 schema)
 * 
 * ALWAYS assemble prompts in this exact order:
 * 1. SYSTEM PROMPT (global constitution)
 * 2. TIER PROMPT (difficulty governor)
 * 3. MODE PROMPT (session context)
 * 4. CONTEXT PROMPT (problem + student state)
 */

const fs = require('fs');
const path = require('path');

// Load prompt JSON files
const SYSTEM_PROMPT = JSON.parse(fs.readFileSync(path.join(__dirname, '../prompts/system_prompt.json'), 'utf8'));
const TIER_PROMPTS = JSON.parse(fs.readFileSync(path.join(__dirname, '../prompts/tier_prompts.json'), 'utf8'));
const MODE_PROMPTS = JSON.parse(fs.readFileSync(path.join(__dirname, '../prompts/mode_prompts.json'), 'utf8'));

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
        throw new Error('Missing required parameter: attempt_state (must be "active", "submitted", or "review")');
    }
    
    // Validate required parameters
    if (!tier || !mode || !problem) {
        throw new Error('Missing required parameters: tier, mode, problem');
    }
    
    // Validate tier
    const validTiers = ['warmup', 'standard', 'challenge', 'contest', 'elite'];
    if (!validTiers.includes(tier)) {
        throw new Error(`Invalid tier: ${tier}. Must be one of: ${validTiers.join(', ')}`);
    }
    
    // Validate mode
    const validModes = ['bootcamp', 'mixed', 'mock'];
    if (!validModes.includes(mode)) {
        throw new Error(`Invalid mode: ${mode}. Must be one of: ${validModes.join(', ')}`);
    }
    
    // Validate attempt_state
    const validStates = ['active', 'submitted', 'review'];
    if (!validStates.includes(attempt_state)) {
        throw new Error(`Invalid attempt_state: ${attempt_state}. Must be one of: ${validStates.join(', ')}`);
    }
    
    // ✅ FIX 2: Enforce hint gating in backend
    const allowedHints = getGatedHints(tier, mode, attempt_state, problem.hints || []);
    
    // Build structured prompt components
    const systemPrompt = buildSystemPrompt();
    const developerPrompts = buildDeveloperPrompts(tier, mode);
    const contextPrompt = buildContextPrompt(problem, studentState, attempt_state, allowedHints);
    
    // ✅ FIX 4: Return provider-agnostic structured object
    return {
        // Structured components (future-proof)
        components: {
            system: systemPrompt,
            developer: developerPrompts,
            context: contextPrompt
        },
        
        // Flattened for current Anthropic usage (backward compatible)
        messages: {
            system: [systemPrompt, ...developerPrompts, contextPrompt].join('\n\n'),
            role: 'system'
        },
        
        // Metadata for logging/debugging
        metadata: {
            tier,
            mode,
            attempt_state,
            problem_id: problem.id || 'unknown',
            archetype: problem.archetype || 'unknown',
            student_level: studentState?.level || 'unknown',
            hints_allowed: allowedHints.length,
            answer_included: attempt_state === 'review'
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
    if (attempt_state !== 'active') {
        return [];
    }
    
    // Rule 2: Contest and Elite NEVER get hints during active attempt
    if (tier === 'contest' || tier === 'elite') {
        return [];
    }
    
    // Rule 3: Mock mode in Contest/Elite never gets hints
    if (mode === 'mock' && (tier === 'contest' || tier === 'elite')) {
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
    return SYSTEM_PROMPT.content.join('\n');
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
    prompts.push(tierPrompt.content.join('\n'));
    
    // Mode prompt
    const modePromptKey = `mode_${mode}_v1`;
    const modePrompt = MODE_PROMPTS[modePromptKey];
    if (!modePrompt) {
        throw new Error(`Mode prompt not found: ${modePromptKey}`);
    }
    prompts.push(modePrompt.content.join('\n'));
    
    return prompts;
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
    
    context.push('PROBLEM CONTEXT:');
    context.push('');
    
    // Problem statement (always included)
    if (problem.statement) {
        context.push('Problem Statement:');
        context.push(problem.statement);
        context.push('');
    }
    
    // Archetype (internal - don't reveal to student)
    if (problem.archetype) {
        context.push(`Internal Archetype: ${problem.archetype}`);
        context.push('(Use this to guide hint strategy, but do not mention archetype name to student)');
        context.push('');
    }
    
    // Skill track
    if (problem.skill_track) {
        context.push(`Skill Track: ${problem.skill_track}`);
        context.push('');
    }
    
    // Student context
    if (studentState) {
        context.push('STUDENT CONTEXT:');
        context.push('');
        
        if (studentState.level) {
            context.push(`Student Level: ${studentState.level}`);
        }
        
        if (studentState.age) {
            context.push(`Age: ${studentState.age} years`);
        }
        
        if (studentState.attempts_on_this_archetype !== undefined) {
            context.push(`Previous attempts on this archetype: ${studentState.attempts_on_this_archetype}`);
        }
        
        context.push('');
    }
    
    // ✅ FIX 1: Only include hints during ACTIVE attempt (already gated)
    if (attempt_state === 'active' && allowedHints.length > 0) {
        context.push('AVAILABLE HINTS:');
        context.push('(Use these ONLY when appropriate per tier rules)');
        allowedHints.forEach((hint, index) => {
            context.push(`Hint ${index + 1}: ${hint}`);
        });
        context.push('');
    }
    
    // ✅ FIX 1: CRITICAL - Only include answer_key in REVIEW state
    if (attempt_state === 'review' && problem.answer_key) {
        context.push('ANSWER & SOLUTION (REVIEW MODE):');
        context.push('(Student has submitted their attempt. You may now provide full explanation)');
        context.push('');
        context.push(`Correct Answer: ${problem.answer_key}`);
        
        if (problem.solution) {
            context.push('');
            context.push('Solution Steps:');
            context.push(problem.solution);
        }
        context.push('');
    }
    
    // Attempt state indicator
    context.push(`ATTEMPT STATE: ${attempt_state.toUpperCase()}`);
    if (attempt_state === 'active') {
        context.push('(Student is actively working on this problem - follow tier rules strictly)');
    } else if (attempt_state === 'submitted') {
        context.push('(Student has submitted - you may acknowledge but wait for review mode for full explanation)');
    } else if (attempt_state === 'review') {
        context.push('(Review mode - provide complete explanation with answer and solution)');
    }
    
    return context.join('\n');
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
        problem_id: config.problem?.id || 'unknown',
        archetype: config.problem?.archetype || 'unknown',
        student_level: config.studentState?.level || 'unknown',
        hints_in_db: config.problem?.hints?.length || 0,
        hints_allowed: getGatedHints(
            config.tier, 
            config.mode, 
            config.attempt_state, 
            config.problem?.hints || []
        ).length,
        answer_included: config.attempt_state === 'review',
        prompt_assembly_order: [
            'system_olympiad_constitution_v1',
            `tier_${config.tier}_v1`,
            `mode_${config.mode}_v1`,
            'context_prompt'
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
        validation.errors.push('Missing components structure');
    }
    
    // System prompt must exist
    if (!assembled.components?.system) {
        validation.valid = false;
        validation.errors.push('Missing system prompt');
    }
    
    // Check for answer leakage prevention in system
    const systemContent = assembled.components?.system || '';
    if (!systemContent.includes('Never reveal the final answer')) {
        validation.valid = false;
        validation.errors.push('System prompt missing answer leakage prevention');
    }
    
    // Check metadata exists
    if (!assembled.metadata) {
        validation.warnings.push('Missing metadata (recommended for logging)');
    }
    
    // ✅ Validate hint gating
    if (assembled.metadata) {
        const { tier, mode, attempt_state, hints_allowed } = assembled.metadata;
        
        // Contest/Elite should never have hints during active
        if ((tier === 'contest' || tier === 'elite') && attempt_state === 'active' && hints_allowed > 0) {
            validation.valid = false;
            validation.errors.push('CRITICAL: Contest/Elite tier has hints during active attempt');
        }
        
        // Answer should only be included in review
        if (attempt_state !== 'review' && assembled.metadata.answer_included) {
            validation.valid = false;
            validation.errors.push('CRITICAL: Answer included during non-review state');
        }
    }
    
    return validation;
}

// Export functions
module.exports = {
    assemblePrompt,
    getGatedHints,
    buildContextPrompt,
    getPromptSummary,
    validatePromptAssembly,
    
    // Export prompt objects for direct access if needed
    SYSTEM_PROMPT,
    TIER_PROMPTS,
    MODE_PROMPTS
};
