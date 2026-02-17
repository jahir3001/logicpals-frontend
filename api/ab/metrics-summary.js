import { createClient } from '@supabase/supabase-js';

function json(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function getBearer(req) {
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { ok:false, error:'method_not_allowed' });

  try {
    const jwt = getBearer(req);
    if (!jwt) return json(res, 401, { ok:false, error:'missing_auth' });

    const { experiment_key, track, window_days } = req.body || {};
    if (!experiment_key || !track) return json(res, 400, { ok:false, error:'missing_params' });

    const url = process.env.SUPABASE_URL;
    const anon = process.env.SUPABASE_ANON_KEY;

    if (!url || !anon) return json(res, 500, { ok:false, error:'missing_env' });

    // User-scoped client (RLS applies). Used for role check.
    const userSb = createClient(url, anon, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
      auth: { persistSession: false, autoRefreshToken: false }
    });

    // Role check (enterprise gate)
    const { data: role, error: roleErr } = await userSb.rpc('rpc_lp_my_role');
    if (roleErr) return json(res, 403, { ok:false, error:'role_rpc_failed', detail: roleErr.message });

    const allowed =
      role === 'super_admin' ||
      (track === 'regular' && role === 'admin_regular') ||
      (track === 'olympiad' && role === 'admin_olympiad');

    if (!allowed) return json(res, 403, { ok:false, error:'forbidden', role, track });

    // Service client for aggregation (server-side only).
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!serviceKey) return json(res, 500, { ok:false, error:'missing_service_role_key' });

    const svc = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });

    // Load experiment row (status + kill-switch)
    const { data: exp, error: expErr } = await svc
      .from('ab_experiments')
      .select('id, experiment_key, track, status, is_killswitched')
      .eq('experiment_key', experiment_key)
      .eq('track', track)
      .maybeSingle();

    if (expErr) return json(res, 500, { ok:false, error:'experiment_lookup_failed', detail: expErr.message });
    if (!exp) return json(res, 404, { ok:false, error:'experiment_not_found' });

    // Note: dashboard can show paused/killswitched, but still returns data (admin view).
    const now = new Date();
    let sinceIso = null;
    const wd = Number(window_days || 0);
    if (wd > 0) {
      const since = new Date(now.getTime() - wd * 24 * 60 * 60 * 1000);
      sinceIso = since.toISOString();
    }

    // Pull variants for this experiment
    const { data: vars, error: vErr } = await svc
      .from('ab_variants')
      .select('id, variant_key')
      .eq('experiment_id', exp.id);

    if (vErr) return json(res, 500, { ok:false, error:'variant_lookup_failed', detail: vErr.message });

    // Exposures by variant_id (unique users)
    let exposuresQ = svc
      .from('ab_exposures')
      .select('variant_id, user_id')
      .eq('experiment_id', exp.id)
      .eq('track', track);

    if (sinceIso) exposuresQ = exposuresQ.gte('created_at', sinceIso);

    const { data: exposures, error: xErr } = await exposuresQ;
    if (xErr) return json(res, 500, { ok:false, error:'exposures_read_failed', detail: xErr.message });

    // Metrics by variant_id (unique users + events)
    let metricsQ = svc
      .from('ab_metric_events')
      .select('variant_id, user_id, event_name')
      .eq('experiment_id', exp.id)
      .eq('track', track);

    if (sinceIso) metricsQ = metricsQ.gte('created_at', sinceIso);

    const { data: metrics, error: mErr } = await metricsQ;
    if (mErr) return json(res, 500, { ok:false, error:'metrics_read_failed', detail: mErr.message });

    const exposedUsersByVar = new Map();
    const metricUsersByVar = new Map();
    const eventsByVar = new Map();

    for (const v of (vars || [])) {
      exposedUsersByVar.set(v.id, new Set());
      metricUsersByVar.set(v.id, new Set());
      eventsByVar.set(v.id, 0);
    }

    for (const x of (exposures || [])) {
      if (!exposedUsersByVar.has(x.variant_id)) continue;
      exposedUsersByVar.get(x.variant_id).add(x.user_id);
    }

    for (const ev of (metrics || [])) {
      if (!metricUsersByVar.has(ev.variant_id)) continue;
      metricUsersByVar.get(ev.variant_id).add(ev.user_id);
      eventsByVar.set(ev.variant_id, (eventsByVar.get(ev.variant_id) || 0) + 1);
    }

    const rows = (vars || []).map(v => {
      const exposed = exposedUsersByVar.get(v.id)?.size || 0;
      const metricU = metricUsersByVar.get(v.id)?.size || 0;
      const events = eventsByVar.get(v.id) || 0;
      const conversion = exposed > 0 ? (metricU / exposed) : null;
      return {
        variant_key: v.variant_key,
        exposed_users: exposed,
        metric_users: metricU,
        events,
        conversion
      };
    });

    return json(res, 200, {
      ok: true,
      experiment_key,
      track,
      window_days: wd,
      status: exp.status,
      is_killswitched: !!exp.is_killswitched,
      rows
    });

  } catch (e) {
    return json(res, 500, { ok:false, error:'unhandled', detail: e?.message || String(e) });
  }
}