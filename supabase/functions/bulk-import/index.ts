// ============================================================
// LogicPals Enterprise Roadmap v2 — Phase 1.4
// Edge Function: bulk-import
// ============================================================
// Deploy to: supabase/functions/bulk-import/index.ts
//
// FLOW:
//   1. org_admin POSTs multipart/form-data with CSV file
//   2. Edge Function parses + validates CSV
//   3. Creates import job via create_import_job()
//   4. Processes each row via process_import_row()
//   5. Finalises job via finalise_import_job()
//   6. Queues invite emails for pending parent_invitations
//
// CSV FORMAT (required columns):
//   child_name, age_group
// CSV FORMAT (optional columns):
//   parent_email, school_class, notes
//
// EXAMPLE CSV:
//   child_name,age_group,parent_email,school_class,notes
//   Amir Hossain,10-11,father@example.com,Class 5A,Good at math
//   Nadia Islam,12-13,,Class 7B,
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Valid age groups matching DB check constraint
const VALID_AGE_GROUPS = ["8-9", "10-11", "12-13", "14-15", "16+"];

// Max rows per import (seat limit enforced by DB, this is a safety cap)
const MAX_ROWS = 500;

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return json({ ok: true }, 200);
  }

  try {
    // ── Auth ────────────────────────────────────────────────
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "missing_authorization" }, 401);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );
    const serviceClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: { user }, error: authErr } = await supabase.auth.getUser();
    if (authErr || !user) return json({ error: "unauthorized" }, 401);

    // ── Parse request ───────────────────────────────────────
    const contentType = req.headers.get("content-type") || "";

    let org_id: string;
    let csvText: string;
    let filename = "import.csv";

    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      org_id   = form.get("org_id") as string;
      filename = (form.get("filename") as string) || "import.csv";
      const file = form.get("file") as File;
      if (!file) return json({ error: "file_required" }, 400);
      csvText = await file.text();
    } else {
      // JSON body with base64 or raw CSV
      const body = await req.json();
      org_id  = body.org_id;
      csvText = body.csv_content;
      filename = body.filename || "import.csv";
    }

    if (!org_id)  return json({ error: "org_id_required" }, 400);
    if (!csvText) return json({ error: "csv_content_required" }, 400);

    // ── Parse CSV ───────────────────────────────────────────
    const rows = parseCSV(csvText);
    if (rows.length === 0) return json({ error: "csv_empty" }, 400);
    if (rows.length > MAX_ROWS) {
      return json({
        error: "csv_too_large",
        max_rows: MAX_ROWS,
        received: rows.length,
        message: `Maximum ${MAX_ROWS} rows per import. Split into multiple files.`
      }, 400);
    }

    // Validate headers
    const headers = Object.keys(rows[0]).map(h => h.toLowerCase().trim());
    if (!headers.includes("child_name")) {
      return json({ error: "missing_column_child_name",
        required: ["child_name", "age_group"],
        received: headers }, 400);
    }
    if (!headers.includes("age_group")) {
      return json({ error: "missing_column_age_group",
        required: ["child_name", "age_group"],
        received: headers }, 400);
    }

    // ── Create import job ───────────────────────────────────
    const { data: jobData, error: jobErr } = await serviceClient.rpc("create_import_job", {
      p_org_id:     org_id,
      p_filename:   filename,
      p_total_rows: rows.length,
    });

    if (jobErr || !jobData?.success) {
      return json({
        error:   jobData?.error || jobErr?.message || "job_creation_failed",
        details: jobData,
      }, jobData?.error === "permission_denied" ? 403 : 400);
    }

    const job_id = jobData.job_id;

    // ── Process rows ────────────────────────────────────────
    const results = {
      succeeded: 0,
      failed:    0,
      duplicate: 0,
      skipped:   0,
      invites_queued: 0,
      errors: [] as Array<{ row: number; error: string; data: Record<string, string> }>,
    };

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 1;

      const child_name   = (row["child_name"]   || row["name"] || "").trim();
      const age_group    = (row["age_group"]     || "").trim();
      const parent_email = (row["parent_email"]  || row["email"] || "").trim() || null;
      const school_class = (row["school_class"]  || row["class"] || "").trim() || null;
      const notes        = (row["notes"]         || "").trim() || null;

      // Client-side validation before DB call
      if (!child_name) {
        results.failed++;
        results.errors.push({ row: rowNum, error: "child_name_empty", data: row });
        continue;
      }
      if (!VALID_AGE_GROUPS.includes(age_group)) {
        results.failed++;
        results.errors.push({
          row: rowNum,
          error: `invalid_age_group: "${age_group}" — valid: ${VALID_AGE_GROUPS.join(", ")}`,
          data: row
        });
        continue;
      }
      if (parent_email && !isValidEmail(parent_email)) {
        results.failed++;
        results.errors.push({ row: rowNum, error: `invalid_email: "${parent_email}"`, data: row });
        continue;
      }

      // Process row via RPC
      const { data: rowResult, error: rowErr } = await serviceClient.rpc("process_import_row", {
        p_job_id:       job_id,
        p_row_number:   rowNum,
        p_child_name:   child_name,
        p_age_group:    age_group,
        p_org_id:       org_id,
        p_parent_email: parent_email,
        p_school_class: school_class,
        p_notes:        notes,
        p_invited_by:   user.id,
      });

      if (rowErr) {
        results.failed++;
        results.errors.push({ row: rowNum, error: rowErr.message, data: row });
        continue;
      }

      switch (rowResult?.status) {
        case "succeeded":
          results.succeeded++;
          if (rowResult.invitation_id) results.invites_queued++;
          break;
        case "duplicate":
          results.duplicate++;
          results.errors.push({ row: rowNum, error: rowResult.error, data: row });
          break;
        case "failed":
          results.failed++;
          results.errors.push({ row: rowNum, error: rowResult.error, data: row });
          break;
        default:
          results.skipped++;
      }
    }

    // ── Finalise job ────────────────────────────────────────
    const { data: summary } = await serviceClient.rpc("finalise_import_job", {
      p_job_id: job_id,
    });

    // ── Queue invite emails ─────────────────────────────────
    // Notify parent-report Edge Function to send pending invite emails
    if (results.invites_queued > 0) {
      try {
        await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/parent-report`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
            "Content-Type":  "application/json",
          },
          body: JSON.stringify({
            action:  "send_pending_invites",
            org_id,
            job_id,
          }),
        });
      } catch (e) {
        // Non-fatal: invites are queued in DB, can be sent by cron
        console.error("[bulk-import] Failed to trigger invite emails:", e);
      }
    }

    return json({
      success:        true,
      job_id,
      total_rows:     rows.length,
      succeeded:      results.succeeded,
      failed:         results.failed,
      duplicate:      results.duplicate,
      invites_queued: results.invites_queued,
      errors:         results.errors,
      summary,
    });

  } catch (err) {
    console.error("[bulk-import] Unexpected error:", err);
    return json({ error: "internal_error", message: String(err) }, 500);
  }
});

// ── CSV Parser ───────────────────────────────────────────────
// Simple RFC 4180-compliant parser. Handles quoted fields.
function parseCSV(text: string): Record<string, string>[] {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const nonEmpty = lines.filter(l => l.trim() !== "");
  if (nonEmpty.length < 2) return [];

  const headers = splitCSVLine(nonEmpty[0]).map(h => h.toLowerCase().trim());
  const rows: Record<string, string>[] = [];

  for (let i = 1; i < nonEmpty.length; i++) {
    const values = splitCSVLine(nonEmpty[i]);
    if (values.every(v => v.trim() === "")) continue; // skip blank rows
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      row[h] = (values[idx] || "").trim();
    });
    rows.push(row);
  }
  return rows;
}

function splitCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"'; i++; // escaped quote
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      result.push(current); current = "";
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ============================================================
// CSV TEMPLATE (save as import_template.csv):
// child_name,age_group,parent_email,school_class,notes
// Mohammad Ali,10-11,parent@example.com,Class 5A,
// Fatima Begum,12-13,,Class 7B,Olympiad track
//
// DEPLOY:
//   supabase functions deploy bulk-import --no-verify-jwt
//
// TEST:
//   curl -X POST https://<ref>.supabase.co/functions/v1/bulk-import \
//     -H "Authorization: Bearer <token>" \
//     -F "org_id=<uuid>" \
//     -F "file=@students.csv"
// ============================================================
