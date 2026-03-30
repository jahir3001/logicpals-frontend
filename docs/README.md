# P5.4 Arena Edge Function — Deployment Guide

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Edge Function source (deploy to Supabase) |
| `deploy.sql` | Run in SQL editor after deploying the function |

---

## Step 1 — Deploy the Edge Function

In your terminal (from the repo root):

```bash
supabase functions deploy arena-engine --no-verify-jwt
```

> `--no-verify-jwt` is intentional — the function handles auth internally
> using the anon key + `supabase.auth.getUser()` so it can return
> structured 401 errors rather than Supabase's generic JWT rejection.

Verify it deployed:
```bash
supabase functions list
```
You should see `arena-engine` with status `active`.

---

## Step 2 — Set Environment Secrets

The function needs these secrets (already available as built-ins in
Supabase Edge Functions — no manual action needed):
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_ANON_KEY`

If you are running locally with `supabase functions serve`, create
a `.env.local` file:
```
SUPABASE_URL=https://ovszuxerimbmzfblzkgd.supabase.co
SUPABASE_ANON_KEY=<your anon key>
SUPABASE_SERVICE_ROLE_KEY=<your service role key>
```

---

## Step 3 — Run deploy.sql

Paste `deploy.sql` into the Supabase SQL editor and run it.
This registers the config_store entries and audit helper.

---

## Step 4 — Enable Progressive Rollout

Arena is deployed at 0% rollout by default. To enable for all users:

```sql
UPDATE config_store
SET value = '100'
WHERE key = 'arena_engine_rollout_pct';
```

Or enable for Champion tier only first:
```sql
UPDATE config_store
SET value = '{"champion": 100, "scholar": 0, "thinker": 0, "free_trial": 0}'
WHERE key = 'arena_engine_rollout_pct';
```

---

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/arena/join` | Request a match |
| GET | `/arena/status?match_id=<uuid>` | Poll match state |
| POST | `/arena/submit` | Submit answer |
| POST | `/arena/forfeit` | Leave match early |

### POST /arena/join
```json
{
  "track": "regular",
  "problem_count": 3
}
```

### POST /arena/submit
```json
{
  "match_id": "<uuid>",
  "problem_id": "<uuid>",
  "answer": "42",
  "time_ms": 45000
}
```

### POST /arena/forfeit
```json
{
  "match_id": "<uuid>"
}
```

---

## Match Lifecycle

```
/join called
    │
    ▼
find_or_create_arena_match()
    │
    ├─ status=active  ──────────────────────► Return match to client
    │
    └─ status=waiting
           │
           ├─ Poll every 2s (up to 15s)
           │     └─ Opponent joins ──────────► Return active match
           │
           └─ 15s timeout
                  │
                  └─ create_ghost_match()
                         ├─ ghost found ─────► Return ghost match
                         └─ unavailable ─────► 503 response

Active match
    │
    ├─ /submit (correct answer) → score++
    │     └─ all problems done → resolveAndSealMatch()
    │
    ├─ /status timer check → timer expired → resolveAndSealMatch()
    │
    └─ /forfeit → resolveAndSealMatch() (opponent wins)

resolveAndSealMatch()
    ├─ Determine winner (score → time tiebreaker)
    ├─ Compute Elo delta (K=32/24/16 by matches played)
    ├─ Ghost: halve delta, skip player B update
    ├─ Seal arena_matches row (status=completed)
    └─ upsert_arena_rating() for each player
```

---

## Frontend Integration (olympiad.html / dashboard.html)

```javascript
// 1. Join
const res = await fetch(`${SUPABASE_URL}/functions/v1/arena-engine/arena/join`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${session.access_token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ track: 'olympiad', problem_count: 3 })
});
const match = await res.json();

// 2. Subscribe to Realtime for live updates
const channel = supabase
  .channel(`arena-match-${match.match_id}`)
  .on('postgres_changes', {
    event: 'UPDATE',
    schema: 'public',
    table: 'arena_matches',
    filter: `id=eq.${match.match_id}`
  }, (payload) => {
    updateArenaUI(payload.new);
  })
  .subscribe();

// 3. Polling fallback if Realtime drops
let pollTimer;
channel.on('error', () => {
  pollTimer = setInterval(async () => {
    const s = await fetch(
      `${SUPABASE_URL}/functions/v1/arena-engine/arena/status?match_id=${match.match_id}`,
      { headers: { 'Authorization': `Bearer ${session.access_token}` } }
    );
    updateArenaUI(await s.json());
  }, match.poll_interval_ms ?? 2000);
});
```
