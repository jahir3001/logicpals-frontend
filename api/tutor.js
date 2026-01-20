// Vercel Serverless Function: /api/tutor
// Receives: { messages: [{role: 'system'|'user'|'assistant', content: string}] }
// Returns: { content: string }

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) {
    return res.status(500).json({ error: 'Missing OPENAI_API_KEY in environment variables.' });
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: 'Invalid JSON body.' });
  }

  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const safeMessages = messages
    .filter(m => m && typeof m.role === 'string' && typeof m.content === 'string')
    .slice(-20) // simple cap
    .map(m => ({ role: m.role, content: m.content }));

  // Choose a default model; you can override by setting OPENAI_MODEL in Vercel.
  const model = process.env.OPENAI_MODEL || 'gpt-5';

  try {
    const resp = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        input: safeMessages,
      }),
    });

    const data = await resp.json();

    if (!resp.ok) {
      return res.status(resp.status).json({
        error: 'OpenAI request failed',
        details: data,
      });
    }

    // The Responses API provides output_text in many examples.
    // Fall back to walking the structure if needed.
    const content =
      (typeof data.output_text === 'string' && data.output_text.trim())
        ? data.output_text.trim()
        : extractTextFallback(data);

    return res.status(200).json({ content });
  } catch (err) {
    return res.status(500).json({ error: 'Server error', details: String(err) });
  }
}

function extractTextFallback(data) {
  try {
    const out = data?.output;
    if (Array.isArray(out)) {
      for (const item of out) {
        const contentArr = item?.content;
        if (Array.isArray(contentArr)) {
          for (const c of contentArr) {
            if (c?.type === 'output_text' && typeof c?.text === 'string') {
              const t = c.text.trim();
              if (t) return t;
            }
          }
        }
      }
    }
  } catch {}
  return '';
}
