# LogicPals — Disaster Recovery Plan & Schema Rollback Procedures
## Phase 0 Gate Requirement — P0.11
**Version:** 1.0 | **Date:** March 2026 | **Owner:** CTO (Jahir)

---

## 1. Overview

This document defines LogicPals' disaster recovery (DR) procedures, schema rollback protocol, and operational runbooks for the Supabase + Vercel + OpenAI production stack.

**RTO Target:** 2 hours (time to restore service)
**RPO Target:** 15 minutes (maximum data loss window)
**Stack:** Supabase (Postgres + Edge Functions) · Vercel (frontend) · OpenAI API · GitHub (source of truth)

---

## 2. Failure Taxonomy

| Category | Examples | Severity |
|----------|----------|----------|
| **P0 — Total outage** | Supabase project down, DB unreachable | Critical |
| **P1 — Partial outage** | Edge Function crashes, OpenAI unreachable | High |
| **P2 — Data integrity** | Bad migration applied, schema drift | High |
| **P3 — Performance** | Slow queries, cost spike, latency breach | Medium |
| **P4 — Security** | Leaked key, unauthorized role escalation | Critical |

---

## 3. Detection

All of the following fire automatically before a human notices:

- **P0.4 `v_platform_health_live`** — polls every 5 min via `lp-alert-monitor` cron
- **P0.5 `alert_log`** — captures threshold breaches (latency, error rate, cost)
- **P0.10 synthetic monitor** — full pipeline smoke test every 10 min, writes to `synthetic_monitor_runs`
- **Vercel** — deployment failure alerts via email

**First responder check:**
```sql
-- Run this first on any incident
SELECT * FROM v_platform_health_live;
SELECT * FROM v_synthetic_health;
SELECT alert_type, severity, message, created_at
FROM alert_log
WHERE created_at > now() - interval '1 hour'
ORDER BY created_at DESC;
```

---

## 4. Schema Rollback Procedure

### 4.1 Philosophy
- Every schema change is committed to GitHub **before** being applied to production
- Migration files live in `db/migrations/` named `YYYYMMDD_HHMMSS_description.sql`
- Every migration has a paired `_rollback.sql` file committed alongside it
- The `schema_migration_log` table (P2 gate) tracks every applied migration

### 4.2 Pre-Migration Snapshot (run before EVERY schema change)
```sql
-- Step 1: Record snapshot in migration log
INSERT INTO schema_migration_log (
  migration_name,
  applied_by,
  schema_hash,
  notes
) VALUES (
  'pre_migration_snapshot_' || to_char(now(), 'YYYYMMDD_HH24MISS'),
  current_user,
  md5(string_agg(column_name || data_type, ',' ORDER BY table_name, column_name))
    OVER ()::text,
  'Automatic pre-migration snapshot'
)
SELECT
  column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
LIMIT 1;
```

### 4.3 Emergency Schema Rollback — Step by Step

**Step 1 — Identify the bad migration**
```sql
SELECT migration_name, applied_at, applied_by, notes
FROM schema_migration_log
ORDER BY applied_at DESC
LIMIT 10;
```

**Step 2 — Enable maintenance mode on Vercel**
```bash
# Set MAINTENANCE_MODE=true in Vercel env vars
# This serves a static maintenance page instead of the app
vercel env add MAINTENANCE_MODE true production
vercel --prod
```

**Step 3 — Execute the rollback SQL**
```bash
# From repo root — rollback files are paired with each migration
cat db/migrations/YYYYMMDD_HHMMSS_description_rollback.sql | \
  psql $DATABASE_URL
```

Or paste directly into Supabase SQL Editor.

**Step 4 — Verify schema integrity**
```sql
-- Run P0.9 QC suite after rollback
-- In Git Bash:
-- node ai/tests/qc_suite.js
-- All 45 tests must pass before re-enabling traffic

-- Also verify immutability triggers still present
SELECT trigger_name, event_object_table
FROM information_schema.triggers
WHERE event_object_table IN (
  'audit_log', 'alert_log', 'ai_cost_ledger',
  'lp_hint_events', 'lp_explainability_events',
  'lp_score_receipts', 'lp_policy_versions'
)
ORDER BY event_object_table;
-- Expected: 2 triggers per table (no_update + no_delete)
```

**Step 5 — Disable maintenance mode and verify synthetic monitor**
```bash
vercel env rm MAINTENANCE_MODE production
vercel --prod
# Then manually trigger synthetic monitor:
curl -X POST https://ovszuxerimbmzfblzkgd.supabase.co/functions/v1/synthetic-monitor \
  -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" -d '{}'
# Must return "passed": true before declaring incident closed
```

**Step 6 — Log the incident**
```sql
INSERT INTO audit_log (action, actor_id, metadata) VALUES (
  'schema_rollback_completed',
  auth.uid(),
  jsonb_build_object(
    'migration_rolled_back', 'MIGRATION_NAME_HERE',
    'rollback_reason',       'REASON HERE',
    'qc_suite_passed',       true,
    'synthetic_monitor',     'passed'
  )
);
```

---

## 5. Runbooks by Failure Type

### 5.1 P0 — Supabase Project Unreachable

**Symptoms:** `v_platform_health_live` timeout, synthetic monitor fails `db_connectivity`

**Steps:**
1. Check https://status.supabase.com — if platform incident, wait and monitor
2. If not platform-wide: check Supabase Dashboard → Logs → Postgres logs for OOM/crash
3. If DB is up but PostgREST is down: restart via Dashboard → Settings → Restart
4. If project is paused (free tier): unpause via Dashboard
5. Notify users via status page after 10 minutes of confirmed outage

**Escalation:** If unresolved after 30 minutes, contact Supabase support with project ID `ovszuxerimbmzfblzkgd`

---

### 5.2 P1 — Edge Function Failure

**Symptoms:** Synthetic monitor fails `session_composer` or `rate_limit_rpc`

**Steps:**
1. Check function logs: Supabase Dashboard → Edge Functions → [function] → Logs
2. Common causes: environment variable missing, import failure, timeout
3. Redeploy from last known good commit:
```bash
git log --oneline supabase/functions/  # find last good commit
git checkout <commit_hash> -- supabase/functions/<function>/
npx supabase functions deploy <function>
```
4. Verify with synthetic monitor curl test

---

### 5.3 P1 — OpenAI API Unreachable

**Symptoms:** Synthetic monitor fails `openai_reachability`, P0.4 `flag_circuit_breaker_trip = true`

**Steps:**
1. Check https://status.openai.com
2. If OpenAI incident: AI features auto-degrade (P0.12 circuit breaker handles this)
3. Frontend should show "AI features temporarily unavailable" banner
4. Session composer falls back to problem-only mode (no hint generation)
5. Monitor `alert_log` for `provider_failure` entries
6. When OpenAI recovers: circuit breaker resets automatically after next successful call

**Key env vars to verify if key issue:**
```bash
# In Supabase Dashboard → Edge Functions → Secrets
# Verify OPENAI_API_KEY matches current key in platform.openai.com
```

---

### 5.4 P2 — Bad Migration Applied

**Symptoms:** QC suite failures, `v_platform_health_live` shows anomalies, user errors

**Steps:**
1. Immediately run: `node ai/tests/qc_suite.js --verbose`
2. Identify which step(s) fail to narrow down affected tables
3. Enable maintenance mode (Step 2 of rollback procedure above)
4. Execute rollback SQL (Step 3)
5. Re-run QC suite — all 45 must pass
6. Run synthetic monitor — must return `passed: true`
7. Disable maintenance mode

---

### 5.5 P4 — Leaked Secret / Key Rotation

**Symptoms:** Unexpected API usage, unauthorized access in audit_log

**Immediate actions (within 5 minutes):**

1. **Rotate Supabase service role key:**
   - Dashboard → Settings → API → Roll service_role key
   - Update in: Vercel env vars, `.env` file, all Edge Function secrets

2. **Rotate OpenAI key:**
   - platform.openai.com → API keys → Delete compromised key → Create new
   - Update in: Supabase Edge Function secrets (`OPENAI_API_KEY`), Vercel env vars

3. **Audit access:**
```sql
-- Check for suspicious admin actions
SELECT action, actor_id, created_at, metadata
FROM audit_log
WHERE created_at > now() - interval '24 hours'
AND action NOT IN (
  'session_created', 'attempt_submitted',
  'hint_requested', 'score_assigned'
)
ORDER BY created_at DESC;
```

4. **Check for unauthorized role escalation:**
```sql
SELECT u.email, r.role, r.created_at
FROM user_roles r
JOIN profiles u ON u.id = r.user_id
WHERE r.created_at > now() - interval '24 hours'
ORDER BY r.created_at DESC;
```

---

## 6. Backup & Point-in-Time Recovery

**Supabase Free Plan:**
- Daily automated backups retained for 7 days
- Location: Supabase Dashboard → Database → Backups

**Point-in-Time Recovery (PITR):**
- Available on Pro plan+ (upgrade if RPO < 15 min is required)
- Current RPO: ~24 hours (daily backup)
- Recommendation: Upgrade to Pro before reaching 1,000 active students

**Manual backup before risky migrations:**
```bash
# Run from local machine with pg_dump installed
pg_dump $DATABASE_URL \
  --schema=public \
  --no-owner \
  --no-acl \
  -f db/backups/backup_$(date +%Y%m%d_%H%M%S).sql

# Compress
gzip db/backups/backup_*.sql
```

---

## 7. RLS Policy Recovery

If RLS policies are accidentally dropped:

```sql
-- Verify RLS is enabled on critical tables
SELECT tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
AND tablename IN (
  'profiles', 'children', 'sessions', 'attempts',
  'subscriptions', 'user_roles', 'ai_cost_ledger',
  'audit_log', 'lp_policy_versions', 'ai_interactions'
)
ORDER BY tablename;
-- rowsecurity must be TRUE for all

-- Re-enable if dropped (example for audit_log)
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
```

---

## 8. CI/CD Gate Checklist

Before any production deployment, all of the following must pass:

- [ ] `node ai/tests/replay_gate.js` — 10/10 fixtures ✅
- [ ] `node ai/tests/qc_suite.js` — 45/45 tests ✅
- [ ] Synthetic monitor curl — `"passed": true` ✅
- [ ] `v_platform_health_live` — all flags false ✅
- [ ] Migration has paired `_rollback.sql` in `db/migrations/` ✅
- [ ] No secrets in committed code (`git grep -i "sk-" -- "*.js" "*.ts"`) ✅

---

## 9. Contact & Escalation

| Role | Action |
|------|--------|
| On-call dev | Run runbooks above, resolve within RTO |
| Supabase support | support.supabase.com — include project ID `ovszuxerimbmzfblzkgd` |
| OpenAI support | platform.openai.com/support |
| Vercel support | vercel.com/support |

**Incident declared closed when:**
1. QC suite passes (45/45)
2. Synthetic monitor passes (8/8)
3. No active alerts in `alert_log` for 15 minutes
4. Rollback/fix committed to GitHub with incident notes

---

*Document version: 1.0 — Update after every incident or architecture change.*
*Next review: Before P1 (Institutional layer) deployment.*
