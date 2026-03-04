// ============================================================
// P0.8: Session Replay QC Gate
// LogicPals Phase 0 — Week 2
// File: ai/tests/replay_gate.js
//
// PURPOSE:
// Verifies that assemblePrompt() produces byte-identical output
// for known fixture inputs. Any drift = deploy blocked.
//
// USAGE:
//   node ai/tests/replay_gate.js           # run all fixtures
//   node ai/tests/replay_gate.js --init    # first run: generate + store golden hashes
//   node ai/tests/replay_gate.js --fixture warmup_active_bootcamp
// ============================================================

const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');
const { createClient } = require('@supabase/supabase-js');
const { assemblePrompt, validatePromptAssembly } = require('../assembler/prompt_control_layer');

// ── Supabase client (service role for reading/writing fixtures) ──
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ── 10 Golden Fixtures ───────────────────────────────────────
// Each fixture is a known input → expected output pairing.
// Covers: all tiers, all states, hint gating, answer gating.
const FIXTURES = [
  {
    name: 'warmup_active_bootcamp',
    notes: 'Basic warmup, active state, no hints should leak answer',
    input: {
      tier: 'warmup', mode: 'bootcamp', attempt_state: 'active',
      problem: {
        id: 'test-001', statement: 'What is 2 + 2?',
        archetype: 'arithmetic', skill_track: 'regular',
        hints: ['Think about counting'], answer_key: '4', solution: '2+2=4'
      },
      studentState: { level: 'beginner', age: 10, attempts_on_this_archetype: 0 }
    }
  },
  {
    name: 'standard_active_mixed',
    notes: 'Standard tier, active, hints allowed',
    input: {
      tier: 'standard', mode: 'mixed', attempt_state: 'active',
      problem: {
        id: 'test-002', statement: 'Find the sum of first 10 natural numbers.',
        archetype: 'series', skill_track: 'regular',
        hints: ['Use the formula n(n+1)/2'], answer_key: '55', solution: '10*11/2=55'
      },
      studentState: { level: 'intermediate', age: 12, attempts_on_this_archetype: 2 }
    }
  },
  {
    name: 'challenge_active_mock',
    notes: 'Challenge tier, mock mode, active',
    input: {
      tier: 'challenge', mode: 'mock', attempt_state: 'active',
      problem: {
        id: 'test-003', statement: 'How many prime numbers are below 20?',
        archetype: 'primes', skill_track: 'olympiad',
        hints: ['List them out'], answer_key: '8', solution: '2,3,5,7,11,13,17,19'
      },
      studentState: { level: 'advanced', age: 14, attempts_on_this_archetype: 1 }
    }
  },
  {
    name: 'contest_active_bootcamp_no_hints',
    notes: 'CRITICAL: Contest tier must never have hints in active state',
    input: {
      tier: 'contest', mode: 'bootcamp', attempt_state: 'active',
      problem: {
        id: 'test-004', statement: 'Find all integers n such that n^2 - n is prime.',
        archetype: 'number_theory', skill_track: 'olympiad',
        hints: ['Try small values', 'Factor the expression'],
        answer_key: 'n=2', solution: 'n(n-1) prime only when n-1=1'
      },
      studentState: { level: 'elite', age: 16, attempts_on_this_archetype: 0 }
    }
  },
  {
    name: 'elite_active_mock_no_hints',
    notes: 'CRITICAL: Elite tier must never have hints in active state',
    input: {
      tier: 'elite', mode: 'mock', attempt_state: 'active',
      problem: {
        id: 'test-005', statement: 'Prove that sqrt(2) is irrational.',
        archetype: 'proof', skill_track: 'olympiad',
        hints: ['Use contradiction'],
        answer_key: 'Proof by contradiction', solution: 'Assume p/q in lowest terms...'
      },
      studentState: { level: 'olympiad', age: 16, attempts_on_this_archetype: 3 }
    }
  },
  {
    name: 'warmup_submitted_bootcamp',
    notes: 'Submitted state: no answer, no hints',
    input: {
      tier: 'warmup', mode: 'bootcamp', attempt_state: 'submitted',
      problem: {
        id: 'test-006', statement: 'What is 5 * 6?',
        archetype: 'arithmetic', skill_track: 'regular',
        hints: ['Count groups'], answer_key: '30', solution: '5*6=30'
      },
      studentState: { level: 'beginner', age: 9, attempts_on_this_archetype: 1 }
    }
  },
  {
    name: 'standard_review_mixed_with_answer',
    notes: 'CRITICAL: Review state must include answer_key',
    input: {
      tier: 'standard', mode: 'mixed', attempt_state: 'review',
      problem: {
        id: 'test-007', statement: 'What is the LCM of 4 and 6?',
        archetype: 'lcm_gcd', skill_track: 'regular',
        hints: ['List multiples'], answer_key: '12', solution: 'Multiples of 4: 4,8,12...'
      },
      studentState: { level: 'intermediate', age: 11, attempts_on_this_archetype: 2 }
    }
  },
  {
    name: 'challenge_review_bootcamp_with_answer',
    notes: 'Review mode with full solution exposed',
    input: {
      tier: 'challenge', mode: 'bootcamp', attempt_state: 'review',
      problem: {
        id: 'test-008', statement: 'How many diagonals does a hexagon have?',
        archetype: 'combinatorics', skill_track: 'olympiad',
        hints: ['Use nC2 - n'], answer_key: '9', solution: 'n(n-3)/2 = 6*3/2 = 9'
      },
      studentState: { level: 'advanced', age: 13, attempts_on_this_archetype: 0 }
    }
  },
  {
    name: 'warmup_active_no_student_state',
    notes: 'Edge case: missing studentState fields',
    input: {
      tier: 'warmup', mode: 'bootcamp', attempt_state: 'active',
      problem: {
        id: 'test-009', statement: 'Is 7 a prime number?',
        archetype: 'primes', skill_track: 'regular',
        hints: [], answer_key: 'Yes', solution: '7 is prime'
      },
      studentState: {}
    }
  },
  {
    name: 'standard_active_no_hints_in_db',
    notes: 'Edge case: problem has no hints at all',
    input: {
      tier: 'standard', mode: 'mixed', attempt_state: 'active',
      problem: {
        id: 'test-010', statement: 'What is 100 / 4?',
        archetype: 'division', skill_track: 'regular',
        hints: [], answer_key: '25', solution: '100/4=25'
      },
      studentState: { level: 'intermediate', age: 12, attempts_on_this_archetype: 5 }
    }
  }
];

// ── Canonical hash function ───────────────────────────────────
// IMPORTANT: Must be deterministic across runs and Node versions.
// We hash the JSON.stringify of components with sorted keys.
function canonicalHash(assembled) {
  const canonical = JSON.stringify(assembled.components, Object.keys(assembled.components).sort());
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

// ── Security assertions per fixture ──────────────────────────
function assertSecurityInvariants(fixture, assembled) {
  const errors = [];
  const { attempt_state, tier } = fixture.input;
  const { answer_included, hints_allowed } = assembled.metadata;

  // Answer must NEVER appear outside review mode
  if (attempt_state !== 'review' && answer_included) {
    errors.push(`CRITICAL SECURITY: answer_included=true in ${attempt_state} state`);
  }

  // Verify answer is actually in context for review
  if (attempt_state === 'review' && fixture.input.problem.answer_key) {
    if (!assembled.components.context.includes(fixture.input.problem.answer_key)) {
      errors.push(`CRITICAL: answer_key missing from context in review state`);
    }
  }

  // Contest/Elite must never have hints in active state
  if ((tier === 'contest' || tier === 'elite') && attempt_state === 'active') {
    if (hints_allowed > 0) {
      errors.push(`CRITICAL SECURITY: hints_allowed=${hints_allowed} for ${tier} in active state`);
    }
  }

  // validatePromptAssembly must pass
  const validation = validatePromptAssembly(assembled);
  if (!validation.valid) {
    errors.push(...validation.errors.map(e => `VALIDATOR: ${e}`));
  }

  return errors;
}

// ── Main runner ───────────────────────────────────────────────
async function runReplayGate(options = {}) {
  const { init = false, fixtureName = null } = options;
  const fixtures = fixtureName
    ? FIXTURES.filter(f => f.name === fixtureName)
    : FIXTURES;

  if (fixtures.length === 0) {
    console.error(`No fixture found: ${fixtureName}`);
    process.exit(1);
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`LogicPals P0.8 Session Replay Gate`);
  console.log(`Mode: ${init ? 'INIT (generating golden hashes)' : 'VERIFY'}`);
  console.log(`Fixtures: ${fixtures.length}`);
  console.log('='.repeat(60));

  let passed = 0, failed = 0;
  const results = [];

  for (const fixture of fixtures) {
    process.stdout.write(`\n[${fixture.name}] `);

    // 1. Assemble prompt
    let assembled;
    try {
      assembled = assemblePrompt(fixture.input);
    } catch (err) {
      console.log(`❌ ASSEMBLY ERROR: ${err.message}`);
      failed++;
      results.push({ fixture: fixture.name, passed: false, error: err.message });
      continue;
    }

    // 2. Security invariant checks
    const securityErrors = assertSecurityInvariants(fixture, assembled);
    if (securityErrors.length > 0) {
      console.log(`❌ SECURITY VIOLATION:`);
      securityErrors.forEach(e => console.log(`   → ${e}`));
      failed++;
      results.push({ fixture: fixture.name, passed: false, errors: securityErrors });
      continue;
    }

    // 3. Compute hash
    const actualHash = canonicalHash(assembled);

    if (init) {
      // INIT mode: store as golden hash
      const { error } = await supabase
        .from('session_replay_fixtures')
        .upsert({
          fixture_name:     fixture.name,
          fixture_input:    fixture.input,
          golden_hash:      actualHash,
          hash_algorithm:   'sha256-canonical-v1',
          last_verified_at: new Date().toISOString(),
          last_verified_by: 'manual-init',
          notes:            fixture.notes
        }, { onConflict: 'fixture_name' });

      if (error) {
        console.log(`❌ DB STORE ERROR: ${error.message}`);
        failed++;
      } else {
        console.log(`✅ STORED: ${actualHash.slice(0, 16)}...`);
        passed++;
      }

    } else {
      // VERIFY mode: compare against golden hash
      const { data: stored } = await supabase
        .from('session_replay_fixtures')
        .select('golden_hash')
        .eq('fixture_name', fixture.name)
        .single();

      if (!stored) {
        console.log(`❌ NO GOLDEN HASH — run with --init first`);
        failed++;
        results.push({ fixture: fixture.name, passed: false, error: 'no_golden_hash' });
        continue;
      }

      const hashMatch = actualHash === stored.golden_hash;

      // Log run to DB
      await supabase.from('session_replay_runs').insert({
        fixture_name:  fixture.name,
        run_by:        'ci',
        passed:        hashMatch,
        actual_hash:   actualHash,
        expected_hash: stored.golden_hash,
        diff_summary:  hashMatch ? null : `Hash mismatch. Prompt template may have changed.`
      });

      if (hashMatch) {
        console.log(`✅ PASS ${actualHash.slice(0, 16)}...`);
        passed++;
      } else {
        console.log(`❌ HASH DRIFT`);
        console.log(`   Expected: ${stored.golden_hash.slice(0, 16)}...`);
        console.log(`   Actual:   ${actualHash.slice(0, 16)}...`);
        console.log(`   → Prompt template changed without updating golden hash.`);
        console.log(`   → If intentional: run --init to regenerate golden hashes.`);
        failed++;
      }
      results.push({ fixture: fixture.name, passed: hashMatch });
    }
  }

  // ── Summary ───────────────────────────────────────────────
  console.log(`\n${'='.repeat(60)}`);
  console.log(`RESULTS: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(60));

  if (failed > 0) {
    console.log(`\n🚨 DEPLOY BLOCKED — ${failed} replay fixture(s) failed.\n`);
    process.exit(1);   // non-zero exit blocks CI/CD
  } else {
    console.log(`\n✅ All replay fixtures passed. Deploy may proceed.\n`);
    process.exit(0);
  }
}

// ── CLI entry point ───────────────────────────────────────────
const args = process.argv.slice(2);
runReplayGate({
  init:        args.includes('--init'),
  fixtureName: args.includes('--fixture')
    ? args[args.indexOf('--fixture') + 1]
    : null
});