const { createClient } = require("@supabase/supabase-js");

/* ---------------------------------------------------------
   Helpers
--------------------------------------------------------- */

function json(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function getBearer(req) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

function safeJson(body) {
  if (body == null) return {};
  if (typeof body === "object") return body;
  if (typeof body !== "string") return null;
  const s = body.trim();
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function getAction(req, body) {
  return String(req.query.action || body.action || "").trim().toLowerCase();
}

function normalizeTrack(value) {
  return value === "regular" || value === "olympiad" ? value : null;
}

function toBoolean(value) {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

function toInt(value) {
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

/* ---------------------------------------------------------
   Supabase Clients
--------------------------------------------------------- */

function createUserClient(jwt) {
  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;

  if (!url || !anon) throw new Error("missing_supabase_env");

  return createClient(url, anon, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

function createServiceClient() {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) throw new Error("missing_supabase_url");
  if (!serviceKey) throw new Error("missing_service_role_key");

  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

/* ---------------------------------------------------------
   Role / Admin
--------------------------------------------------------- */

async function getRole(userSb) {
  const { data, error } = await userSb.rpc("rpc_lp_my_role");
  if (error) throw new Error("role_lookup_failed");
  return data;
}

function canAccessTrack(role, track) {
  return (
    role === "super_admin" ||
    (track === "regular" && role === "admin_regular") ||
    (track === "olympiad" && role === "admin_olympiad")
  );
}

async function requireAdmin(userSb) {
  const { error } = await userSb.rpc("ab_require_admin", {});
  if (error) throw new Error("admin_required");
}

/* ---------------------------------------------------------
   MAIN HANDLER
--------------------------------------------------------- */

module.exports = async function handler(req, res) {
  try {
    const body = safeJson(req.body);
    if (body === null) return json(res, 400, { ok: false, error: "invalid_json" });

    const action = getAction(req, body);

    const jwt = getBearer(req);
    let userSb = null;
    let role = null;

    if (jwt) {
      userSb = createUserClient(jwt);
      role = await getRole(userSb);
    }

    const svc = createServiceClient();

    /* =====================================================
       RUNTIME FEATURE FLAG RESOLUTION (NO ADMIN REQUIRED)
    ===================================================== */

    if (action === "flag_resolve_runtime") {
      const flag_key = body.flag_key;
      const track = normalizeTrack(body.track);
      const session_id = body.session_id || null;

      if (!flag_key || !track) {
        return json(res, 400, { ok: false, error: "missing_params" });
      }

      let user_id = null;
      if (jwt) {
        const { data } = await userSb.auth.getUser();
        user_id = data?.user?.id || null;
      }

      const { data, error } = await svc.rpc("flag_resolve_runtime", {
        p_flag_key: flag_key,
        p_track: track,
        p_user_id: user_id,
        p_session_id: session_id
      });

      if (error) {
        return json(res, 500, { ok: false, error: error.message });
      }

      return json(res, 200, data);
    }

    /* =====================================================
       ADMIN REQUIRED BELOW
    ===================================================== */

    if (!userSb) {
      return json(res, 401, { ok: false, error: "missing_jwt" });
    }

    await requireAdmin(userSb);

    /* -----------------------------------------------------
       Feature Flags Admin
    ----------------------------------------------------- */

    if (action === "feature_flags_list") {
      const { data, error } = await svc.rpc("admin_feature_flags_list");
      if (error) return json(res, 500, { ok: false, error: error.message });
      return json(res, 200, { ok: true, result: data });
    }

    if (action === "feature_flag_upsert") {
      const { data, error } = await svc.rpc("admin_feature_flag_upsert", {
        p_flag_key: body.flag_key,
        p_track: body.track,
        p_description: body.description,
        p_enabled: body.enabled,
        p_rollout_type: body.rollout_type,
        p_rollout_percentage: body.rollout_percentage,
        p_experiment_key: body.experiment_key,
        p_is_killswitched: body.is_killswitched,
        p_config: body.config || {}
      });

      if (error) return json(res, 500, { ok: false, error: error.message });
      return json(res, 200, { ok: true, result: data });
    }

    if (action === "feature_flag_set_enabled") {
      const { data, error } = await svc.rpc("admin_feature_flag_set_enabled", {
        p_flag_key: body.flag_key,
        p_track: body.track,
        p_enabled: body.enabled
      });

      if (error) return json(res, 500, { ok: false, error: error.message });
      return json(res, 200, { ok: true, result: data });
    }

    if (action === "feature_flag_set_killswitch") {
      const { data, error } = await svc.rpc("admin_feature_flag_set_killswitch", {
        p_flag_key: body.flag_key,
        p_track: body.track,
        p_is_killswitched: body.is_killswitched
      });

      if (error) return json(res, 500, { ok: false, error: error.message });
      return json(res, 200, { ok: true, result: data });
    }

    /* -----------------------------------------------------
       Experiment Dashboard Bundle
    ----------------------------------------------------- */

    if (action === "experiment_dashboard_bundle") {
      const { data, error } = await svc.rpc("admin_experiment_dashboard_bundle", {
        p_experiment_key: body.experiment_key,
        p_track: body.track
      });

      if (error) return json(res, 500, { ok: false, error: error.message });
      return json(res, 200, { ok: true, result: data });
    }

    return json(res, 400, { ok: false, error: "unknown_action" });
  } catch (err) {
    return json(res, 500, { ok: false, error: err.message });
  }
};