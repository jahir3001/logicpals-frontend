export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY in Vercel Environment Variables" });
    }

    const body = req.body || {};

    // Accept BOTH formats:
    // A) { messages: [...] }  (curl test format)
    // B) { problem_text, solution_explanation, chatLog } (learn.html format)
    let messages = body.messages;

    if (!Array.isArray(messages)) {
      const problemText = String(body.problem_text || "").trim();
      const solutionExplanation = String(body.solution_explanation || "").trim();
      const chatLog = Array.isArray(body.chatLog) ? body.chatLog : [];

      if (!problemText) {
        return res.status(400).json({ error: "Missing problem_text (or messages[])" });
      }

      // Convert chatLog -> messages (keep last ~20 turns to be safe)
      const converted = chatLog
        .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .slice(-20)
        .map(m => ({ role: m.role, content: m.content }));

      const system = [
        "You are LogicPals Socratic Tutor.",
        "Help the student solve the problem step-by-step without giving the final answer immediately.",
        "Ask short guiding questions. Give hints when needed.",
        "If the student asks for the final answer, first explain reasoning, then provide it.",
      ].join(" ");

      messages = [
        { role: "system", content: system },
        {
          role: "user",
          content:
            `Problem:\n${problemText}\n\n` +
            (solutionExplanation ? `Teacher reference (do not reveal directly):\n${solutionExplanation}\n\n` : "") +
            `Conversation so far:\n${converted.map(m => `${m.role}: ${m.content}`).join("\n")}\n\n` +
            `Now respond as the tutor.`
        }
      ];
    }

    // Call OpenAI Responses API
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        input: messages,
      }),
    });

    const raw = await response.text();
    let data;
    try { data = JSON.parse(raw); } catch { data = null; }

    if (!response.ok) {
      return res.status(response.status).json({
        error: "OpenAI request failed",
        details: data || raw
      });
    }

    // Extract text from Responses API
    const reply =
      (data && data.output_text) ||
      (data && data.output && data.output[0] && data.output[0].content && data.output[0].content[0] && data.output[0].content[0].text) ||
      "";

    return res.status(200).json({ reply });
  } catch (err) {
    return res.status(500).json({ error: "Server error", details: String(err?.message || err) });
  }
}
