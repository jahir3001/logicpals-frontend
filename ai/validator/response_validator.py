"""
LOGICPALS PROMPT CONTROL LAYER - PRODUCTION VERSION
Step 1 Implementation - FIXED with 5 critical production improvements

FIXES APPLIED:
1. ✅ Answer key only included in "review" state (never during active attempt)
2. ✅ Hint gating enforced in backend before assembly
3. ✅ attempt_state explicitly required as input
4. ✅ Provider-agnostic structured output
5. ✅ Clear distinction: Step 1 DB fields only (not full Step 3 schema)

ALWAYS assemble prompts in this exact order:
1. SYSTEM PROMPT (global constitution)
2. TIER PROMPT (difficulty governor)
3. MODE PROMPT (session context)
4. CONTEXT PROMPT (problem + student state)
"""

import json
from pathlib import Path
from typing import Dict, List, Any, Optional, Literal

# Load prompt JSON files
PROMPTS_DIR = Path(__file__).parent.parent / 'prompts'

with open(PROMPTS_DIR / 'system_prompt.json', 'r', encoding='utf-8') as f:
    SYSTEM_PROMPT = json.load(f)

with open(PROMPTS_DIR / 'tier_prompts.json', 'r', encoding='utf-8') as f:
    TIER_PROMPTS = json.load(f)

with open(PROMPTS_DIR / 'mode_prompts.json', 'r', encoding='utf-8') as f:
    MODE_PROMPTS = json.load(f)

# Type definitions
AttemptState = Literal['active', 'submitted', 'review']
Tier = Literal['warmup', 'standard', 'challenge', 'contest', 'elite']
Mode = Literal['bootcamp', 'mixed', 'mock']


def assemble_prompt(
    tier: Tier,
    mode: Mode,
    attempt_state: AttemptState,
    problem: Dict[str, Any],
    student_state: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    """
    Assemble complete prompt for AI interaction
    
    Args:
        tier: Difficulty tier ('warmup', 'standard', 'challenge', 'contest', 'elite')
        mode: Training mode ('bootcamp', 'mixed', 'mock')
        attempt_state: Attempt state ('active', 'submitted', 'review')
        problem: Problem object with statement, archetype, etc.
        student_state: Student's current state (level, mastery, etc.)
    
    Returns:
        Structured prompt object (provider-agnostic)
    
    Raises:
        ValueError: If parameters are invalid
    """
    # ✅ FIX 3: Validate attempt_state is required
    if not attempt_state:
        raise ValueError('Missing required parameter: attempt_state (must be "active", "submitted", or "review")')
    
    # Validate required parameters
    if not tier or not mode or not problem:
        raise ValueError('Missing required parameters: tier, mode, problem')
    
    # Validate tier
    valid_tiers = ['warmup', 'standard', 'challenge', 'contest', 'elite']
    if tier not in valid_tiers:
        raise ValueError(f'Invalid tier: {tier}. Must be one of: {", ".join(valid_tiers)}')
    
    # Validate mode
    valid_modes = ['bootcamp', 'mixed', 'mock']
    if mode not in valid_modes:
        raise ValueError(f'Invalid mode: {mode}. Must be one of: {", ".join(valid_modes)}')
    
    # Validate attempt_state
    valid_states = ['active', 'submitted', 'review']
    if attempt_state not in valid_states:
        raise ValueError(f'Invalid attempt_state: {attempt_state}. Must be one of: {", ".join(valid_states)}')
    
    # ✅ FIX 2: Enforce hint gating in backend
    allowed_hints = get_gated_hints(tier, mode, attempt_state, problem.get('hints', []))
    
    # Build structured prompt components
    system_prompt = build_system_prompt()
    developer_prompts = build_developer_prompts(tier, mode)
    context_prompt = build_context_prompt(problem, student_state, attempt_state, allowed_hints)
    
    # ✅ FIX 4: Return provider-agnostic structured object
    return {
        # Structured components (future-proof)
        'components': {
            'system': system_prompt,
            'developer': developer_prompts,
            'context': context_prompt
        },
        
        # Flattened for current Anthropic usage (backward compatible)
        'messages': {
            'system': '\n\n'.join([system_prompt] + developer_prompts + [context_prompt]),
            'role': 'system'
        },
        
        # Metadata for logging/debugging
        'metadata': {
            'tier': tier,
            'mode': mode,
            'attempt_state': attempt_state,
            'problem_id': problem.get('id', 'unknown'),
            'archetype': problem.get('archetype', 'unknown'),
            'student_level': student_state.get('level', 'unknown') if student_state else 'unknown',
            'hints_allowed': len(allowed_hints),
            'answer_included': attempt_state == 'review'
        }
    }


def get_gated_hints(
    tier: str,
    mode: str,
    attempt_state: str,
    hints: List[str]
) -> List[str]:
    """
    ✅ FIX 2: Gate hints based on tier, mode, and attempt state
    CRITICAL: This must happen BEFORE prompt assembly
    
    Args:
        tier: Difficulty tier
        mode: Training mode
        attempt_state: Current attempt state
        hints: Available hints from database
    
    Returns:
        Filtered hints array (empty if not allowed)
    """
    # Rule 1: No hints if attempt is not active
    if attempt_state != 'active':
        return []
    
    # Rule 2: Contest and Elite NEVER get hints during active attempt
    if tier in ['contest', 'elite']:
        return []
    
    # Rule 3: Mock mode in Contest/Elite never gets hints
    if mode == 'mock' and tier in ['contest', 'elite']:
        return []
    
    # Rule 4: Otherwise, hints are allowed (tier prompt controls when to give them)
    return hints if hints else []


def build_system_prompt() -> str:
    """
    Build system prompt component
    
    Returns:
        System prompt text
    """
    return '\n'.join(SYSTEM_PROMPT['content'])


def build_developer_prompts(tier: str, mode: str) -> List[str]:
    """
    Build developer prompts (tier + mode)
    
    Args:
        tier: Difficulty tier
        mode: Training mode
    
    Returns:
        Developer prompt texts
    """
    prompts = []
    
    # Tier prompt
    tier_prompt_key = f'tier_{tier}_v1'
    tier_prompt = TIER_PROMPTS.get(tier_prompt_key)
    if not tier_prompt:
        raise ValueError(f'Tier prompt not found: {tier_prompt_key}')
    prompts.append('\n'.join(tier_prompt['content']))
    
    # Mode prompt
    mode_prompt_key = f'mode_{mode}_v1'
    mode_prompt = MODE_PROMPTS.get(mode_prompt_key)
    if not mode_prompt:
        raise ValueError(f'Mode prompt not found: {mode_prompt_key}')
    prompts.append('\n'.join(mode_prompt['content']))
    
    return prompts


def build_context_prompt(
    problem: Dict[str, Any],
    student_state: Optional[Dict[str, Any]],
    attempt_state: str,
    allowed_hints: List[str]
) -> str:
    """
    Build context prompt with problem details and student state
    ✅ FIX 1: Only include answer_key in "review" state
    
    Args:
        problem: Problem object
        student_state: Student state object
        attempt_state: Current attempt state
        allowed_hints: Gated hints (already filtered)
    
    Returns:
        Context prompt text
    """
    context = []
    
    context.append('PROBLEM CONTEXT:')
    context.append('')
    
    # Problem statement (always included)
    if 'statement' in problem:
        context.append('Problem Statement:')
        context.append(problem['statement'])
        context.append('')
    
    # Archetype (internal - don't reveal to student)
    if 'archetype' in problem:
        context.append(f"Internal Archetype: {problem['archetype']}")
        context.append('(Use this to guide hint strategy, but do not mention archetype name to student)')
        context.append('')
    
    # Skill track
    if 'skill_track' in problem:
        context.append(f"Skill Track: {problem['skill_track']}")
        context.append('')
    
    # Student context
    if student_state:
        context.append('STUDENT CONTEXT:')
        context.append('')
        
        if 'level' in student_state:
            context.append(f"Student Level: {student_state['level']}")
        
        if 'age' in student_state:
            context.append(f"Age: {student_state['age']} years")
        
        if 'attempts_on_this_archetype' in student_state:
            context.append(f"Previous attempts on this archetype: {student_state['attempts_on_this_archetype']}")
        
        context.append('')
    
    # ✅ FIX 1: Only include hints during ACTIVE attempt (already gated)
    if attempt_state == 'active' and allowed_hints:
        context.append('AVAILABLE HINTS:')
        context.append('(Use these ONLY when appropriate per tier rules)')
        for i, hint in enumerate(allowed_hints, 1):
            context.append(f'Hint {i}: {hint}')
        context.append('')
    
    # ✅ FIX 1: CRITICAL - Only include answer_key in REVIEW state
    if attempt_state == 'review' and 'answer_key' in problem:
        context.append('ANSWER & SOLUTION (REVIEW MODE):')
        context.append('(Student has submitted their attempt. You may now provide full explanation)')
        context.append('')
        context.append(f"Correct Answer: {problem['answer_key']}")
        
        if 'solution' in problem:
            context.append('')
            context.append('Solution Steps:')
            context.append(problem['solution'])
        context.append('')
    
    # Attempt state indicator
    context.append(f'ATTEMPT STATE: {attempt_state.upper()}')
    if attempt_state == 'active':
        context.append('(Student is actively working on this problem - follow tier rules strictly)')
    elif attempt_state == 'submitted':
        context.append('(Student has submitted - you may acknowledge but wait for review mode for full explanation)')
    elif attempt_state == 'review':
        context.append('(Review mode - provide complete explanation with answer and solution)')
    
    return '\n'.join(context)


def get_prompt_summary(
    tier: str,
    mode: str,
    attempt_state: str,
    problem: Dict[str, Any],
    student_state: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    """
    Get prompt summary for logging/debugging
    
    Args:
        tier: Difficulty tier
        mode: Training mode
        attempt_state: Attempt state
        problem: Problem object
        student_state: Student state object
    
    Returns:
        Summary dictionary
    """
    return {
        'tier': tier,
        'mode': mode,
        'attempt_state': attempt_state,
        'problem_id': problem.get('id', 'unknown'),
        'archetype': problem.get('archetype', 'unknown'),
        'student_level': student_state.get('level', 'unknown') if student_state else 'unknown',
        'hints_in_db': len(problem.get('hints', [])),
        'hints_allowed': len(get_gated_hints(tier, mode, attempt_state, problem.get('hints', []))),
        'answer_included': attempt_state == 'review',
        'prompt_assembly_order': [
            'system_olympiad_constitution_v1',
            f'tier_{tier}_v1',
            f'mode_{mode}_v1',
            'context_prompt'
        ]
    }


def validate_prompt_assembly(assembled: Dict[str, Any]) -> Dict[str, Any]:
    """
    Validate prompt assembly result
    
    Args:
        assembled: Assembled prompt object
    
    Returns:
        Validation result dictionary
    """
    validation = {
        'valid': True,
        'errors': [],
        'warnings': []
    }
    
    # Must have components structure
    if 'components' not in assembled:
        validation['valid'] = False
        validation['errors'].append('Missing components structure')
    
    # System prompt must exist
    if not assembled.get('components', {}).get('system'):
        validation['valid'] = False
        validation['errors'].append('Missing system prompt')
    
    # Check for answer leakage prevention in system
    system_content = assembled.get('components', {}).get('system', '')
    if 'Never reveal the final answer' not in system_content:
        validation['valid'] = False
        validation['errors'].append('System prompt missing answer leakage prevention')
    
    # Check metadata exists
    if 'metadata' not in assembled:
        validation['warnings'].append('Missing metadata (recommended for logging)')
    
    # ✅ Validate hint gating
    if 'metadata' in assembled:
        metadata = assembled['metadata']
        tier = metadata.get('tier')
        mode = metadata.get('mode')
        attempt_state = metadata.get('attempt_state')
        hints_allowed = metadata.get('hints_allowed', 0)
        answer_included = metadata.get('answer_included', False)
        
        # Contest/Elite should never have hints during active
        if tier in ['contest', 'elite'] and attempt_state == 'active' and hints_allowed > 0:
            validation['valid'] = False
            validation['errors'].append('CRITICAL: Contest/Elite tier has hints during active attempt')
        
        # Answer should only be included in review
        if attempt_state != 'review' and answer_included:
            validation['valid'] = False
            validation['errors'].append('CRITICAL: Answer included during non-review state')
    
    return validation


# Example usage
if __name__ == '__main__':
    # Example problem
    example_problem = {
        'id': 'prob_001',
        'statement': 'Triangle ABC has AB = AC and angle A = 40°. Find angle B.',
        'archetype': 'constraint_translation',
        'skill_track': 'Geometry without Formulas',
        'hints': [
            'What type of triangle is this?',
            'In an isosceles triangle, what about base angles?',
            'If angle A = 40°, how much is left for base angles?'
        ],
        'answer_key': '70°',
        'solution': 'Since AB = AC, triangle is isosceles. Base angles B and C are equal. Sum = 180°, so B = C = (180° - 40°) / 2 = 70°.'
    }
    
    # Example student state
    example_student = {
        'level': 'junior',
        'age': 11,
        'attempts_on_this_archetype': 2
    }
    
    # Test Case 1: Active attempt (no answer)
    print('TEST 1: Active attempt')
    prompts = assemble_prompt(
        tier='standard',
        mode='mixed',
        attempt_state='active',
        problem=example_problem,
        student_state=example_student
    )
    
    validation = validate_prompt_assembly(prompts)
    print(f'✅ Valid: {validation["valid"]}')
    print(f'Answer included: {prompts["metadata"]["answer_included"]}')  # Should be False
    print(f'Hints allowed: {prompts["metadata"]["hints_allowed"]}')  # Should be 3
    print()
    
    # Test Case 2: Review state (with answer)
    print('TEST 2: Review state')
    prompts = assemble_prompt(
        tier='standard',
        mode='mixed',
        attempt_state='review',
        problem=example_problem,
        student_state=example_student
    )
    
    validation = validate_prompt_assembly(prompts)
    print(f'✅ Valid: {validation["valid"]}')
    print(f'Answer included: {prompts["metadata"]["answer_included"]}')  # Should be True
    print(f'Hints allowed: {prompts["metadata"]["hints_allowed"]}')  # Should be 0 (review mode)
    print()
    
    # Test Case 3: Contest tier (no hints)
    print('TEST 3: Contest tier')
    prompts = assemble_prompt(
        tier='contest',
        mode='mock',
        attempt_state='active',
        problem=example_problem,
        student_state=example_student
    )
    
    validation = validate_prompt_assembly(prompts)
    print(f'✅ Valid: {validation["valid"]}')
    print(f'Hints allowed: {prompts["metadata"]["hints_allowed"]}')  # Should be 0
    print(f'Answer included: {prompts["metadata"]["answer_included"]}')  # Should be False
