import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";

type ReqBody = {
  experiment_key: string;
  track?: "regular" | "olympiad" | null;
  days?: number;
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  try {
    const body = (req.body ?? {}) as Partial<ReqBody>;
    if (!body.experiment_key) return res.status(400).json({ error: "missing_experiment_key" });

    const days = Number.isFinite(body.days) ? Number(body.days) : 14;
    const track = body.track ?? null;

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const supabaseAnon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

    const authHeader = req.headers.authorization || "";
    const jwt = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!jwt) return res.status(401).json({ error: "missing_auth" });

    const supabase = createClient(supabaseUrl, supabaseAnon, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });

    const { data, error } = await supabase.rpc("ab_dash_admin_bundle", {
      p_experiment_key: String(body.experiment_key),
      p_track: track, // can be null, or 'regular'/'olympiad'
      p_days: days,
    });

    if (error) {
      // surface admin_only vs other errors cleanly
      const msg = error.message || "rpc_error";
      const code = msg.includes("admin_only") ? "admin_only" : "rpc_error";
      return res.status(403).json({ error: code, detail: msg });
    }

    return res.status(200).json({ ok: true, data });
  } catch (e: any) {
    return res.status(500).json({ error: "server_error", detail: e?.message ?? String(e) });
  }
}