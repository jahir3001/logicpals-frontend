// ============================================================
// LogicPals P5.8: Worksheet Generator Edge Function
// supabase/functions/worksheet-generator/index.ts
//
// Endpoints:
//   POST /worksheet/generate  — generate + return PDF
//   GET  /worksheet/download  — download existing worksheet
//
// PDF structure:
//   Student PDF: LogicPals branding, student name, date,
//     skill focus, problems numbered with work space, no answers
//   Coach PDF:   Same + answer key section at end
//
// Storage: worksheets/{user_id}/{worksheet_id}/student.html
//          worksheets/{user_id}/{worksheet_id}/coach.html
// ============================================================

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function err(message: string, status = 400): Response {
  return json({ error: message }, status);
}

// ── Types ────────────────────────────────────────────────────

interface Problem {
  id: string;
  title: string;
  problem_text: string;
  difficulty: string;
  skill_track: string | null;
  answer_key: string | null;
  olympiad_level: string | null;
  estimated_time: number | null;
}

interface GenerateRequest {
  track:        "regular" | "olympiad";
  skill_track?: string;
  difficulty?:  string;
  count?:       number;
  for_user_id?: string;    // coach generating for a student
}

// ── PDF HTML builder ─────────────────────────────────────────

function buildStudentHTML(
  problems: Problem[],
  studentName: string,
  track: string,
  skillFocus: string | null,
  worksheetId: string
): string {
  const date     = new Date().toLocaleDateString("en-GB", {
    day: "numeric", month: "long", year: "numeric"
  });
  const trackLabel = track === "olympiad" ? "Olympiad Track" : "Regular Track";
  const skillLabel = skillFocus
    ? skillFocus.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())
    : "Mixed Skills";

  const problemsHTML = problems.map((p, i) => `
    <div class="problem">
      <div class="problem-header">
        <span class="problem-num">Problem ${i + 1}</span>
        <span class="problem-meta">${p.difficulty ?? ""}${p.estimated_time ? ` · ~${p.estimated_time} min` : ""}</span>
      </div>
      <div class="problem-text">${escapeHtml(p.problem_text)}</div>
      <div class="work-space">
        <div class="work-label">Work space:</div>
        <div class="lines">${"<div class='line'></div>".repeat(8)}</div>
      </div>
    </div>
  `).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<title>LogicPals Worksheet — ${studentName}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap');
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Inter', sans-serif; color: #1a1a2e; background: #fff;
         padding: 40px; max-width: 800px; margin: 0 auto; }
  .header { display: flex; justify-content: space-between; align-items: flex-start;
             border-bottom: 3px solid #4f46e5; padding-bottom: 16px; margin-bottom: 28px; }
  .brand { font-size: 22px; font-weight: 700; color: #4f46e5; }
  .brand span { color: #06b6d4; }
  .meta { text-align: right; font-size: 13px; color: #6b7280; line-height: 1.8; }
  .meta strong { color: #1a1a2e; }
  .subtitle { font-size: 13px; background: #f0fdf4; color: #166534;
               padding: 6px 12px; border-radius: 6px; margin-bottom: 28px;
               display: inline-block; border: 1px solid #bbf7d0; }
  .problem { margin-bottom: 36px; page-break-inside: avoid; }
  .problem-header { display: flex; justify-content: space-between;
                     align-items: center; margin-bottom: 10px; }
  .problem-num { font-weight: 700; font-size: 15px; color: #4f46e5; }
  .problem-meta { font-size: 12px; color: #9ca3af; background: #f9fafb;
                   padding: 2px 8px; border-radius: 10px; }
  .problem-text { font-size: 14px; line-height: 1.7; color: #111827;
                   background: #f8fafc; padding: 14px 16px; border-radius: 8px;
                   border-left: 4px solid #4f46e5; margin-bottom: 14px; }
  .work-space { margin-top: 8px; }
  .work-label { font-size: 11px; color: #9ca3af; margin-bottom: 6px; text-transform: uppercase; }
  .line { border-bottom: 1px solid #e5e7eb; height: 28px; margin-bottom: 2px; }
  .footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid #e5e7eb;
             font-size: 11px; color: #9ca3af; text-align: center; }
  @media print { body { padding: 20px; } .problem { page-break-inside: avoid; } }
</style>
</head>
<body>
  <div class="header">
    <div>
      <div class="brand">Logic<span>Pals</span></div>
      <div style="font-size:13px;color:#6b7280;margin-top:4px;">Practice Worksheet</div>
    </div>
    <div class="meta">
      <div><strong>${escapeHtml(studentName)}</strong></div>
      <div>${date}</div>
      <div>${trackLabel} · ${skillLabel}</div>
      <div style="font-size:11px;color:#d1d5db;margin-top:2px;">ID: ${worksheetId.slice(0,8)}</div>
    </div>
  </div>

  <div class="subtitle">✓ ${problems.length} problems · No answers shown · Good luck!</div>

  ${problemsHTML}

  <div class="footer">
    LogicPals · Olympiad Preparation Platform · logicpals.com<br/>
    This worksheet was personalised for ${escapeHtml(studentName)} and excludes problems already practised.
  </div>
</body>
</html>`;
}

function buildCoachHTML(
  problems: Problem[],
  studentName: string,
  track: string,
  skillFocus: string | null,
  worksheetId: string
): string {
  // Start with student version then append answer key
  const studentHTML = buildStudentHTML(problems, studentName, track, skillFocus, worksheetId);

  const answerKeyHTML = `
    <div style="page-break-before:always; margin-top:40px;">
      <div style="font-size:18px;font-weight:700;color:#4f46e5;
                  border-bottom:2px solid #4f46e5;padding-bottom:10px;margin-bottom:20px;">
        Answer Key — Coach Copy
      </div>
      ${problems.map((p, i) => `
        <div style="margin-bottom:16px;padding:12px 16px;background:#f0fdf4;
                    border-radius:8px;border-left:4px solid #22c55e;">
          <div style="font-weight:600;font-size:13px;margin-bottom:6px;">
            Problem ${i + 1}
          </div>
          <div style="font-size:13px;color:#166534;">
            <strong>Answer:</strong> ${escapeHtml(p.answer_key ?? "See solution explanation")}
          </div>
          ${p.skill_track ? `<div style="font-size:11px;color:#6b7280;margin-top:4px;">
            Skill: ${p.skill_track.replace(/_/g," ")}
          </div>` : ""}
        </div>
      `).join("")}
      <div style="margin-top:20px;font-size:11px;color:#9ca3af;">
        CONFIDENTIAL — Coach copy only. Do not share with students.
      </div>
    </div>
  `;

  // Inject answer key before closing body tag
  return studentHTML.replace("</body>", answerKeyHTML + "</body>");
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Handler: POST /worksheet/generate ───────────────────────

async function handleGenerate(
  req: Request,
  supabase: ReturnType<typeof createClient>,
  userId: string
): Promise<Response> {
  let body: GenerateRequest;
  try { body = await req.json(); }
  catch { return err("Invalid JSON body"); }

  const {
    track = "olympiad",
    skill_track,
    difficulty,
    count = 10,
    for_user_id,
  } = body;

  const targetUserId = for_user_id ?? userId;

  // If generating for another user, caller must be coach/admin
  if (for_user_id && for_user_id !== userId) {
    const { data: callerProfile } = await supabase
      .from("profiles")
      .select("role, school_id")
      .eq("id", userId)
      .single();

    const { data: studentProfile } = await supabase
      .from("profiles")
      .select("school_id")
      .eq("id", for_user_id)
      .single();

    const isCoach = callerProfile?.role &&
      ["admin", "admin_olympiad", "admin_regular"].includes(callerProfile.role);
    const sameSchool = callerProfile?.school_id === studentProfile?.school_id;

    if (!isCoach || !sameSchool) {
      return err("Not authorised to generate worksheets for this student", 403);
    }
  }

  // Call generate_worksheet RPC
  const { data: wsRows, error: wsErr } = await supabase
    .rpc("generate_worksheet", {
      p_user_id:      targetUserId,
      p_track:        track,
      p_skill_track:  skill_track ?? null,
      p_difficulty:   difficulty  ?? null,
      p_count:        count,
      p_requested_by: userId,
    });

  if (wsErr || !wsRows?.[0]) {
    console.error("[worksheet/generate] RPC error:", wsErr);
    return err("Worksheet generation failed", 500);
  }

  const ws = wsRows[0];

  // Fetch problem details for PDF
  const { data: problems, error: probErr } = await supabase
    .from("problems")
    .select("id, title, problem_text, difficulty, skill_track, answer_key, olympiad_level, estimated_time")
    .in("id", ws.problem_ids)
    .order("difficulty");

  if (probErr || !problems?.length) {
    return err("Failed to fetch problem details", 500);
  }

  // Sort problems to match the order in ws.problem_ids
  const orderedProblems: Problem[] = ws.problem_ids
    .map((id: string) => problems.find((p: Problem) => p.id === id))
    .filter(Boolean);

  // Fetch student profile for name
  const { data: studentProfile } = await supabase
    .from("profiles")
    .select("full_name")
    .eq("id", targetUserId)
    .single();

  const studentName = studentProfile?.full_name ?? "Student";

  // Build HTML
  const studentHTML = buildStudentHTML(
    orderedProblems, studentName, track, skill_track ?? null, ws.worksheet_id
  );
  const coachHTML = buildCoachHTML(
    orderedProblems, studentName, track, skill_track ?? null, ws.worksheet_id
  );

  // Upload to Supabase Storage
  const storagePath = `worksheets/${targetUserId}/${ws.worksheet_id}`;

  const [studentUpload, coachUpload] = await Promise.all([
    supabase.storage
      .from("worksheets")
      .upload(`${storagePath}/student.html`, studentHTML, {
        contentType: "text/html",
        upsert: true,
      }),
    supabase.storage
      .from("worksheets")
      .upload(`${storagePath}/coach.html`, coachHTML, {
        contentType: "text/html",
        upsert: true,
      }),
  ]);

  if (studentUpload.error) {
    console.error("[worksheet/generate] Storage upload error:", studentUpload.error);
    return err("Failed to save worksheet", 500);
  }

  // Get signed URLs (7-day expiry)
  const [studentUrl, coachUrl] = await Promise.all([
    supabase.storage
      .from("worksheets")
      .createSignedUrl(`${storagePath}/student.html`, 7 * 24 * 3600),
    supabase.storage
      .from("worksheets")
      .createSignedUrl(`${storagePath}/coach.html`, 7 * 24 * 3600),
  ]);

  // Mark worksheet ready
  await supabase.rpc("mark_worksheet_ready", {
    p_worksheet_id:   ws.worksheet_id,
    p_pdf_url:        studentUrl.data?.signedUrl ?? null,
    p_answer_key_url: coachUrl.data?.signedUrl   ?? null,
  });

  return json({
    worksheet_id:    ws.worksheet_id,
    problem_count:   ws.problem_count,
    pdf_url:         studentUrl.data?.signedUrl,
    answer_key_url:  coachUrl.data?.signedUrl,
    message:         ws.message,
    expires_in:      "7 days",
  });
}

// ── Handler: GET /worksheet/download ────────────────────────

async function handleDownload(
  req: Request,
  supabase: ReturnType<typeof createClient>,
  userId: string
): Promise<Response> {
  const url          = new URL(req.url);
  const worksheetId  = url.searchParams.get("worksheet_id");
  const type         = url.searchParams.get("type") ?? "student";   // student | coach

  if (!worksheetId) return err("worksheet_id required");

  const { data: history } = await supabase
    .rpc("get_worksheet_history", {
      p_user_id: userId,
      p_limit:   50,
    });

  const ws = history?.find((w: { worksheet_id: string }) => w.worksheet_id === worksheetId);
  if (!ws) return err("Worksheet not found or access denied", 404);
  if (ws.status === "expired") return err("This worksheet has expired. Please generate a new one.", 410);

  const downloadUrl = type === "coach" ? ws.answer_key_url : ws.pdf_url;
  if (!downloadUrl) return err("Worksheet not ready yet", 404);

  return json({ url: downloadUrl, expires_at: ws.expires_at });
}

// ── Router ───────────────────────────────────────────────────

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  const url      = new URL(req.url);
  const pathname = url.pathname;

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } }
  );

  // Auth
  const auth = req.headers.get("authorization");
  if (!auth) return err("Unauthorized", 401);

  const anonClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
  );
  const { data: { user }, error: authErr } = await anonClient.auth.getUser(
    auth.replace("Bearer ", "")
  );
  if (authErr || !user) return err("Unauthorized", 401);

  try {
    if (pathname.endsWith("/worksheet/generate") && req.method === "POST")
      return handleGenerate(req, supabase, user.id);
    if (pathname.endsWith("/worksheet/download") && req.method === "GET")
      return handleDownload(req, supabase, user.id);

    return err("Not found", 404);
  } catch (e) {
    console.error("[worksheet-generator] Unhandled error:", e);
    return err("Internal server error", 500);
  }
});
