# Phase 0B — Boundary Wiring + Env Var Fixes

## 🔴 Fix First: Missing SLACK_WEBHOOK_ALERTS

Your Vercel has 7 channel webhooks + 1 fallback, but `SLACK_WEBHOOK_ALERTS` is missing:

```
In Vercel now:                    Expected:
─────────────────────             ──────────────────────
SLACK_WEBHOOK_AI_MONITORING ✅    SLACK_WEBHOOK_ALERTS ❌ MISSING
SLACK_WEBHOOK_DEV ✅              SLACK_WEBHOOK_AI_MONITORING ✅
SLACK_WEBHOOK_DEVELOPMENT ✅      SLACK_WEBHOOK_DEV ✅
SLACK_WEBHOOK_OPS ✅              SLACK_WEBHOOK_DEVELOPMENT ✅
SLACK_WEBHOOK_ALL ✅              SLACK_WEBHOOK_OPS ✅
SLACK_WEBHOOK_PRODUCT ✅          SLACK_WEBHOOK_ALL ✅
SLACK_WEBHOOK_SOCIAL ✅           SLACK_WEBHOOK_PRODUCT ✅
SLACK_WEBHOOK_URL ✅ (fallback)   SLACK_WEBHOOK_SOCIAL ✅
                                  SLACK_WEBHOOK_URL ✅ (fallback)
```

**What happens right now:** 13 alert types route to `CHANNELS.ALERTS` → code looks for
`SLACK_WEBHOOK_ALERTS` → not found → falls back to `SLACK_WEBHOOK_URL` → alerts
still work, but you'll see "falling back" console warnings on every alert.

**Fix:** Add `SLACK_WEBHOOK_ALERTS` to Vercel using the webhook URL you have circled
in your .env file. This can be the SAME webhook URL as `SLACK_WEBHOOK_URL` if both
point to #alerts — that's fine. The point is to be explicit.

---

## Growth Channel Decision

Your growth/product alerts are ALREADY covered by existing channels:

| Alert Type | Routes to | Channel | Status |
|---|---|---|---|
| student_milestone | SLACK_WEBHOOK_ALL | #all-logicpals | ✅ configured |
| school_onboarded | SLACK_WEBHOOK_ALL | #all-logicpals | ✅ configured |
| student_feedback_received | SLACK_WEBHOOK_PRODUCT | #product-feedback | ✅ configured |
| subscription_upgraded | SLACK_WEBHOOK_PRODUCT | #product-feedback | ✅ configured |
| social_milestone | SLACK_WEBHOOK_SOCIAL | #social | ✅ configured |

**You do NOT need SLACK_WEBHOOK_GROWTH.** All growth alerts already have dedicated channels.

If you later want a single #growth channel that aggregates everything, that's a post-0B
enhancement — you'd create the Slack channel, add `CHANNELS.GROWTH` to `alert_types.js`,
reroute the 5 product/growth alerts, and add the webhook. But for now, the current
channel split is better because it separates social from product from company-wide.

---

## Files Delivered

| File | What it is | Where it goes |
|---|---|---|
| `api/monitoring/trigger.js` | Universal alert bridge (all 31 types) | → `api/monitoring/trigger.js` |
| `supabase/functions/_shared/slack_alert.ts` | Reusable Deno helper | → `supabase/functions/_shared/slack_alert.ts` |
| `wiring_v1_router_boundary.ts` | Paste-in snippets | → `supabase/functions/v1-router/index.ts` |
| `wiring_synthetic_monitor.ts` | Paste-in snippets | → `supabase/functions/synthetic-monitor/index.ts` |
| `wiring_admin_role_change.ts` | Two options (Edge Fn or frontend) | → depends on your admin console setup |

---

## Architecture: How It All Connects

```
┌─────────────────────────────────┐
│  Supabase Edge Functions        │
│  (Deno/TypeScript)              │
│                                 │
│  v1-router ──────┐              │
│  synthetic-monitor──┐           │
│  rate-limit-check ──┤           │
│  alert-monitor ─────┤           │
│                     ▼           │
│  _shared/slack_alert.ts         │
│  notifySlack(type, payload)     │
│         │                       │
└─────────│───────────────────────┘
          │ POST /api/monitoring/trigger
          │ x-internal-key auth
          ▼
┌─────────────────────────────────┐
│  Vercel (Node.js)               │
│                                 │
│  api/monitoring/trigger.js ◄────│── universal bridge (31 types)
│         │                       │
│         ▼                       │
│  backend/alerts/monitoring.js   │
│         │                       │
│         ▼                       │
│  backend/alerts/alert_router.js │
│    ├ dedup check                │
│    ├ alert_log write            │
│    └ channel routing            │
│         │                       │
│         ▼                       │
│  backend/alerts/slack_notifier.js
│    ├ Block Kit builder          │
│    ├ webhook resolve            │
│    └ cross-post logic           │
│         │                       │
└─────────│───────────────────────┘
          │
          ▼
┌─────────────────────────────────┐
│  Slack Channels                 │
│  #alerts, #ai-monitoring,      │
│  #dev, #ops, #development,     │
│  #all-logicpals,               │
│  #product-feedback, #social    │
└─────────────────────────────────┘
```

---

## Step-by-Step Execution

### 1. Fix env var (30 seconds)
- Add `SLACK_WEBHOOK_ALERTS` to Vercel env vars
- Value: the webhook URL from your .env file (circled as "Primary")

### 2. Add Supabase Edge Function secrets (1 minute)
Generate a key:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
Add to **Supabase Dashboard → Edge Functions → Manage Secrets**:
- `INTERNAL_MONITORING_KEY` = the generated key
- `VERCEL_APP_URL` = `https://logicpals.vercel.app` (no trailing slash)

Add to **Vercel env vars**:
- `INTERNAL_MONITORING_KEY` = same key

### 3. Deploy the shared helper
Save `supabase/functions/_shared/slack_alert.ts` and deploy:
```bash
supabase functions deploy v1-router
supabase functions deploy synthetic-monitor
```

### 4. Wire v1-router (track + olympiad boundary)
Open `supabase/functions/v1-router/index.ts` and:
1. Add the import: `import { notifySlack } from '../_shared/slack_alert.ts';`
2. Add `boundary_violation` call at the track guard (where you return 403)
3. Add `unauthorized_olympiad_access` call at the olympiad route guard

### 5. Wire synthetic-monitor
Open `supabase/functions/synthetic-monitor/index.ts` and:
1. Add the import: `import { notifySlack } from '../_shared/slack_alert.ts';`
2. Add failure/recovery/heartbeat calls per the snippet

### 6. Wire admin role change
Choose Option A (Edge Function/API route) or Option B (frontend) from the snippet.
Option A is recommended.

### 7. Deploy Edge Functions
```bash
supabase functions deploy v1-router
supabase functions deploy synthetic-monitor
```

### 8. Test
```bash
# Smoke test — all alerts still work
node backend/alerts/test_monitoring.js

# Verify boundary alerts: attempt olympiad access with a free_trial account
# Verify in #alerts Slack channel
```

---

## Env Vars Final Checklist

### Vercel (logicpals-frontend)
| Variable | Status |
|---|---|
| SLACK_WEBHOOK_URL | ✅ exists (3d ago) |
| SLACK_WEBHOOK_ALERTS | ❌ **ADD THIS** |
| SLACK_WEBHOOK_AI_MONITORING | ✅ exists |
| SLACK_WEBHOOK_DEV | ✅ exists |
| SLACK_WEBHOOK_DEVELOPMENT | ✅ exists |
| SLACK_WEBHOOK_OPS | ✅ exists |
| SLACK_WEBHOOK_ALL | ✅ exists |
| SLACK_WEBHOOK_PRODUCT | ✅ exists |
| SLACK_WEBHOOK_SOCIAL | ✅ exists |
| INTERNAL_MONITORING_KEY | ❌ **ADD THIS** |

### Supabase Edge Function Secrets
| Variable | Status |
|---|---|
| INTERNAL_MONITORING_KEY | ❌ **ADD THIS** |
| VERCEL_APP_URL | ❌ **ADD THIS** |
