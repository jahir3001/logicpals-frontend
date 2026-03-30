# Phase 0B — Steps 4–7 Integration Guide

## Files Delivered

| File | What it is | Where it goes |
|------|-----------|---------------|
| `step4_circuit_breaker_wiring.js` | Paste-in snippets | → `ai/circuit_breaker.js` (3 paste locations) |
| `api/monitoring/trigger.js` | Drop-in Vercel endpoint | → `api/monitoring/trigger.js` (new file) |
| `step5b_edge_function_snippet.ts` | Paste-in snippets | → your synthetic-monitor Edge Function |
| `step6_alert_log_constraint.sql` | Run in SQL Editor | → Supabase SQL Editor |

---

## Step 4 — Wire Circuit Breaker to Slack

**File to edit:** `ai/circuit_breaker.js`

**3 paste locations:**

1. **PASTE 1** — Add the import at the top (after existing imports):
   ```js
   import { recordCircuitBreakerTripped, recordCircuitBreakerRecovered }
     from '../backend/alerts/monitoring.js';
   ```

2. **PASTE 2** — After the breaker transitions to `OPEN` state:
   ```js
   recordCircuitBreakerTripped({
     provider: PROVIDER,
     consecutive_failures: v_breaker.consecutive_failures,
     threshold: v_breaker.failure_threshold,
   }).catch(err => console.warn('[circuit_breaker] Slack alert failed:', err.message));
   ```

3. **PASTE 3** — After `HALF_OPEN` recovers to `CLOSED`:
   ```js
   recordCircuitBreakerRecovered({
     provider: PROVIDER,
   }).catch(err => console.warn('[circuit_breaker] Slack alert failed:', err.message));
   ```

**Key design:** Both calls are fire-and-forget (`.catch`). If Slack is down, the circuit breaker still functions normally. Both use `forceSend: true` internally — they never get deduped.

---

## Step 5 — Wire Synthetic Monitor to Slack

### 5A: Deploy Vercel endpoint

1. Save `api/monitoring/trigger.js` in your repo at that exact path
2. Generate a strong random key:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
3. Add to **Vercel env vars**: `INTERNAL_MONITORING_KEY` = the key
4. Add to **Supabase Edge Function secrets**:
   - `INTERNAL_MONITORING_KEY` = same key
   - `VERCEL_APP_URL` = `https://logicpals.vercel.app` (no trailing slash)
5. Push + deploy — Vercel auto-creates `POST /api/monitoring/trigger`

### 5B: Wire the Edge Function

Open your synthetic-monitor Edge Function and:

1. **Add** the `notifySlack()` helper function (see snippet file)
2. **Call** `notifySlack('synthetic_monitor_failed', {...})` in your failure handler
3. **Call** `notifySlack('synthetic_monitor_recovered', {...})` when all steps pass after a previous failure
4. **(Optional)** Call `notifySlack('synthetic_monitor_heartbeat', {...})` for daily summaries

The snippet file includes a full integration example showing exactly where calls fit in the pipeline loop.

### Endpoint security

The trigger endpoint authenticates via `x-internal-key` header. Requests without a valid key get `401 Unauthorized`. The endpoint only accepts `POST` and only handles the 3 synthetic monitor alert types.

---

## Step 6 — Expand alert_log Constraint

1. Open **Supabase SQL Editor** → New Query
2. Paste the entire contents of `step6_alert_log_constraint.sql`
3. Click **Run**
4. Verify with:
   ```sql
   SELECT pg_get_constraintdef(oid)
   FROM pg_constraint
   WHERE conname = 'alert_log_alert_type_check';
   ```
   — should list all 31 types.

**What changed:** Constraint goes from 8 types → 31 types. The migration is wrapped in `BEGIN/COMMIT`, records itself in `schema_migrations` as version `2026.03.011`, and includes verification queries for both the constraint and the immutability trigger.

---

## Step 7 — Commit and Push

```bash
git add backend/alerts/ api/monitoring/
git commit -m 'Phase 0B: Enterprise Slack integration — 31 alert types, Block Kit, multi-channel, circuit breaker + synthetic monitor wiring'
git push
```

---

## Post-Deployment Verification Checklist

| Check | Command / Action |
|-------|-----------------|
| Test suite passes | `node backend/alerts/test_monitoring.js` |
| Circuit breaker trip fires Slack alert | Trip the breaker manually or wait for natural failure |
| Synthetic monitor failure fires Slack alert | Stop the monitor target temporarily |
| alert_log accepts new types | Insert test row via SQL Editor (see Step 6 verification) |
| Schema version recorded | `SELECT * FROM schema_migrations ORDER BY applied_at DESC LIMIT 1;` |
| All channel webhooks working | `node backend/alerts/test_monitoring.js --all` (after adding all 8 webhooks) |

---

## Env Vars Summary (new additions)

| Variable | Where | Purpose |
|----------|-------|---------|
| `INTERNAL_MONITORING_KEY` | Vercel + Supabase Edge Functions | Auth for synthetic monitor → Slack bridge |
| `VERCEL_APP_URL` | Supabase Edge Functions | Base URL for the trigger endpoint |

All 8 `SLACK_WEBHOOK_*` vars from Step 2 remain as documented in the handoff.
