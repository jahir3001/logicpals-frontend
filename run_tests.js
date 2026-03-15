/**
 * run_tests.js — Env-aware test runner for Phase 0B
 * ─────────────────────────────────────────────────────────────
 * Loads .env.slack, then spawns the test suite as a child process.
 *
 * Usage:
 *   node run_tests.js              # default 5 tests
 *   node run_tests.js --all        # all 19 tests
 *   node run_tests.js --type circuit_breaker_tripped
 * ─────────────────────────────────────────────────────────────
 */

const fs   = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// ── Load .env.slack file ─────────────────────────────────────
const envFile = path.resolve(__dirname, '.env.slack');
const env = Object.assign({}, process.env); // clone current env

try {
  const content = fs.readFileSync(envFile, 'utf8');
  const lines   = content.split('\n');
  let loaded    = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;

    const key   = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();

    env[key] = value;
    loaded++;
  }

  console.log(`\x1b[32m✅ Loaded ${loaded} env vars from .env.slack\x1b[0m\n`);
} catch (err) {
  console.error('\x1b[31m❌ Could not read .env.slack file at:\x1b[0m', envFile);
  console.error('');
  console.error('Create it in your repo root with your webhook URLs (no # comments):');
  console.error('');
  console.error('  SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...');
  console.error('  SLACK_WEBHOOK_ALERTS=https://hooks.slack.com/services/...');
  console.error('  SLACK_WEBHOOK_AI_MONITORING=https://hooks.slack.com/services/...');
  console.error('  SLACK_WEBHOOK_DEV=https://hooks.slack.com/services/...');
  console.error('  SLACK_WEBHOOK_DEVELOPMENT=https://hooks.slack.com/services/...');
  console.error('  SLACK_WEBHOOK_OPS=https://hooks.slack.com/services/...');
  console.error('  SLACK_WEBHOOK_ALL=https://hooks.slack.com/services/...');
  console.error('  SLACK_WEBHOOK_PRODUCT=https://hooks.slack.com/services/...');
  console.error('  SLACK_WEBHOOK_SOCIAL=https://hooks.slack.com/services/...');
  process.exit(1);
}

// ── Verify all required vars ─────────────────────────────────
const required = [
  'SLACK_WEBHOOK_URL',
  'SLACK_WEBHOOK_ALERTS',
  'SLACK_WEBHOOK_AI_MONITORING',
  'SLACK_WEBHOOK_DEV',
  'SLACK_WEBHOOK_DEVELOPMENT',
  'SLACK_WEBHOOK_OPS',
  'SLACK_WEBHOOK_ALL',
  'SLACK_WEBHOOK_PRODUCT',
  'SLACK_WEBHOOK_SOCIAL',
];

const missing = required.filter(k => !env[k]);
if (missing.length > 0) {
  console.error('\x1b[31m❌ Missing env vars in .env.slack:\x1b[0m');
  missing.forEach(k => console.error(`   ${k}`));
  process.exit(1);
}

console.log(`\x1b[32m✅ All ${required.length} webhook URLs verified\x1b[0m\n`);

// ── Spawn the test suite with the loaded env ─────────────────
const args = process.argv.slice(2); // pass through --all, --type, etc.
const testFile = path.resolve(__dirname, 'backend', 'alerts', 'test_monitoring.js');

const child = spawn('node', [testFile, ...args], {
  env,                // pass loaded env vars
  stdio: 'inherit',   // pipe stdout/stderr to parent
  cwd: __dirname,
});

child.on('exit', (code) => {
  process.exit(code || 0);
});