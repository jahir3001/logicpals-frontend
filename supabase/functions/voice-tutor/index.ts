// LogicPals - Stable Voice & Text Tutor (Self-Contained)
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

// 1. DEFINE HEADERS MANUALLY (Fixes the "Module not found" error)
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  // 2. Handle Pre-flight checks
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const openAIKey = Deno.env.get('OPENAI_API_KEY')
    if (!openAIKey) throw new Error("Missing OpenAI API Key")

    let userText = ""
    let history = []

    // 3. Parse Input (Text vs Voice)
    const contentType = req.headers.get('content-type') || ""

    if (contentType.includes('application/json')) {
        // TEXT MODE
        const body = await req.json()
        userText = body.text
        if (Array.isArray(body.history)) history = body.history
    } else if (contentType.includes('multipart/form-data')) {
        // VOICE MODE
        const formData = await req.formData()
        const audioFile = formData.get('file')
        const historyRaw = formData.get('history')

        if (historyRaw) {
            try {
                // Safe parsing to prevent crashes
                const parsed = JSON.parse(historyRaw.toString())
                if (Array.isArray(parsed)) history = parsed
            } catch (e) {
                console.warn("History parse failed, ignoring history.")
            }
        }

        if (!audioFile) throw new Error("No audio uploaded")

        // Manual FormData for OpenAI
        const openAIFormData = new FormData()
        openAIFormData.append('file', audioFile, 'input.wav')
        openAIFormData.append('model', 'whisper-1')

        const transRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${openAIKey}` },
            body: openAIFormData
        })
        
        if (!transRes.ok) throw new Error(`Whisper Error: ${await transRes.text()}`)
        const transData = await transRes.json()
        userText = transData.text
    }

    if (!userText) throw new Error("Could not understand input.")

    // 4. Sanitize History (Prevent Stack Overflow)
    // We strictly map to strings to ensure no circular objects exist
    const cleanHistory = history.slice(-6).map((msg: any) => ({
        role: msg.role === 'ai' ? 'assistant' : 'user',
        content: String(msg.content || "") 
    })).filter(m => m.content.trim() !== "" && !m.content.includes("Thinking"))

    const messages = [
        { role: 'system', content: "You are a friendly logic tutor. Keep answers short (2 sentences)." },
        ...cleanHistory,
        { role: 'user', content: userText }
    ]

    // 5. OpenAI Chat
    const chatRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${openAIKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ model: 'gpt-4o', messages: messages })
    })

    if (!chatRes.ok) throw new Error(`OpenAI Chat Error: ${await chatRes.text()}`)
    const chatData = await chatRes.json()
    const aiText = chatData.choices?.[0]?.message?.content || "I didn't catch that."

    // 6. Text-to-Speech
    const ttsRes = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${openAIKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ model: 'tts-1', input: aiText, voice: 'nova' })
    })

    if (!ttsRes.ok) throw new Error("TTS Error")
    const audioBuffer = await ttsRes.arrayBuffer()
    const base64Audio = btoa(String.fromCharCode(...new Uint8Array(audioBuffer)))

    return new Response(JSON.stringify({
        userTranscript: userText,
        aiText: aiText,
        audioContent: base64Audio
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

  } catch (error) {
    console.error("CRASH:", error.message)
    return new Response(JSON.stringify({ error: error.message }), { 
        status: 500, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
    })
  }
})