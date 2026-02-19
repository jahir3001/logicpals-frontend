export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ error: "method_not_allowed" });
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      return res.status(500).json({ error: "missing_supabase_env" });
    }

    // Auth: require bearer token (Supabase access_token)
    const authHeader = req.headers.authorization || "";
    if (!authHeader.toLowerCase().startsWith("bearer ")) {
      return res.status(401).json({ error: "missing_bearer_token" });
    }
    const jwt = authHeader.slice(7);

    // Inputs
    const child_id = (req.query.child_id || "").toString();
    const days = Math.max(1, Math.min(parseInt(req.query.days || "7", 10) || 7, 90));

    if (!child_id || !/^[0-9a-fA-F-]{36}$/.test(child_id)) {
      return res.status(400).json({ error: "invalid_child_id" });
    }

    // Call RPC
    const rpcUrl = `${SUPABASE_URL}/rest/v1/rpc/get_dashboard_summary`;

    const rpcResp = await fetch(rpcUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify({ p_child_id: child_id, p_days: days }),
    });

    const text = await rpcResp.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }

    if (!rpcResp.ok) {
      // Bubble up the Supabase error but normalize
      const msg =
        (data && (data.message || data.error_description || data.error)) ||
        `rpc_failed_${rpcResp.status}`;
      const status =
        msg === "not_authenticated" || rpcResp.status === 401 ? 401 :
        msg === "forbidden_child" || rpcResp.status === 403 ? 403 :
        400;
      return res.status(status).json({ error: msg, details: data });
    }

    // data is already the JSONB object returned by the RPC
    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: "server_error", message: String(e?.message || e) });
  }
}