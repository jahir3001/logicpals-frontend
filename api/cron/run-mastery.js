const { createClient } = require("@supabase/supabase-js");
const { runMasteryWorkerOnce } = require("../../worker/mastery/logic.js");

function getEnv() {
  const SUPABASE_URL =
    process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const CRON_SECRET = process.env.CRON_SECRET;

  if (!CRON_SECRET) {
    throw new Error("missing_cron_secret");
  }
  if (!SUPABASE_URL) {
    throw new Error("missing_supabase_url");
  }
  if (!SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("missing_supabase_service_role_key");
  }

  return {
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    CRON_SECRET,
  };
}

function createSupabaseAdmin() {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = getEnv();

  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
}

function getBearer(req) {
  const auth = req.headers["authorization"] || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

function getJob(req) {
  return String(req.query.job || req.body?.job || "mastery")
    .trim()
    .toLowerCase();
}

function json(res, status, payload) {
  return res.status(status).json(payload);
}

async function runMasteryJob(supabase) {
  const result = await runMasteryWorkerOnce(supabase);

  return {
    ok: true,
    processed: (result && result.processed) || 0,
    raw: result || {},
  };
}

async function runEscalationsJob(supabase) {
  const start = new Date().toISOString();

  // heartbeat before run
  await supabase.rpc("rpc_upsert_automation_watchdog_runtime_state", {
    p_automation_key: "escalation_automation",
    p_automation_enabled: true,
    p_cron_enabled: true,
    p_last_cron_seen_at: new Date().toISOString(),
    p_source: "cron-pre-run"
  });

  const { data, error } = await supabase.rpc("run_open_incident_escalations_core", {
    p_trigger_source: "cron",
  });

  if (error) {
    // mark failure
    await supabase.rpc("rpc_upsert_automation_watchdog_runtime_state", {
      p_automation_key: "escalation_automation",
      p_last_run_status: "error",
      p_last_run_error_count: 1,
      p_last_cron_seen_at: new Date().toISOString(),
      p_source: "cron-exception"
    });

    await supabase.rpc("rpc_eval_automation_watchdog", {
      p_automation_key: "escalation_automation",
      p_trigger_source: "cron_exception"
    });

    throw new Error(error.message || "cron_escalation_run_failed");
  }

  const result = data || {
    ok: true,
    pairs_checked: 0,
    executed_count: 0,
    skipped_count: 0,
    error_count: 0,
  };

  // update runtime state after run
  await supabase.rpc("rpc_upsert_automation_watchdog_runtime_state", {
    p_automation_key: "escalation_automation",
    p_last_run_started_at: start,
    p_last_run_finished_at: new Date().toISOString(),
    p_last_run_status: "ok",
    p_last_run_error_count: result.error_count || 0,
    p_reported_backlog_count: result.backlog_count || 0,
    p_last_cron_seen_at: new Date().toISOString(),
    p_source: "cron-post-run"
  });

  await supabase.rpc("rpc_eval_automation_watchdog", {
    p_automation_key: "escalation_automation",
    p_trigger_source: "cron"
  });

  return result;
}

module.exports = async function handler(req, res) {
  try {
    if (!["GET", "POST"].includes(req.method)) {
      return json(res, 405, {
        ok: false,
        error: "method_not_allowed",
      });
    }

    const { CRON_SECRET } = getEnv();

    const suppliedBearer = getBearer(req);
    const suppliedSecret =
      suppliedBearer ||
      req.headers["x-cron-secret"] ||
      req.headers["x-vercel-cron-secret"] ||
      req.query.secret ||
      null;

    if (!suppliedSecret || suppliedSecret !== CRON_SECRET) {
      return json(res, 401, {
        ok: false,
        error: "unauthorized",
      });
    }

    const supabase = createSupabaseAdmin();
    const job = getJob(req);

    if (job === "mastery") {
      const result = await runMasteryJob(supabase);
      return json(res, 200, {
        ok: true,
        job: "mastery",
        result,
      });
    }

    if (job === "escalations") {
      const result = await runEscalationsJob(supabase);
      return json(res, 200, {
        ok: true,
        job: "escalations",
        result,
      });
    }

    if (job === "all") {
      const mastery = await runMasteryJob(supabase);
      const escalations = await runEscalationsJob(supabase);

      return json(res, 200, {
        ok: true,
        job: "all",
        result: {
          mastery,
          escalations,
        },
      });
    }

    return json(res, 400, {
      ok: false,
      error: "invalid_job",
      details: `Unsupported cron job: ${job}`,
    });
  } catch (e) {
    console.error("run-mastery cron error:", e);

    const message = e?.message || String(e);
    const status =
      message === "missing_cron_secret" ||
      message === "missing_supabase_url" ||
      message === "missing_supabase_service_role_key"
        ? 500
        : 500;

    return json(res, status, {
      ok: false,
      error: "FUNCTION_INVOCATION_FAILED",
      details: message,
    });
  }
};