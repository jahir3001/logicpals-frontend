import { createClient } from "@supabase/supabase-js";
import { runMasteryWorkerOnce } from "../../worker/mastery/logic.js";

export default async function handler(req, res) {
  try {
    if (!process.env.CRON_SECRET) return res.status(500).send("Missing CRON_SECRET");
    if (!process.env.SUPABASE_URL) return res.status(500).send("Missing SUPABASE_URL");
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return res.status(500).send("Missing SUPABASE_SERVICE_ROLE_KEY");

    const auth = req.headers["authorization"];
    const expected = `Bearer ${process.env.CRON_SECRET}`;
    if (!auth || auth !== expected) return res.status(401).send("Unauthorized");

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const result = await runMasteryWorkerOnce(supabase);

    return res.status(200).json({ status: "ok", processed: result?.processed ?? 0 });
  } catch (e) {
    console.error("run-mastery error:", e);
    return res.status(500).send("FUNCTION_INVOCATION_FAILED");
  }
}
