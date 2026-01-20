// LogicPals - Parent Insight Engine v2.2 (Smart Filtering)
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const SYSTEM_PROMPT = `
ROLE: Child Psychologist.
INPUT: Child's math stats.
OUTPUT: 2 brief, encouraging sentences for the parent. Focus on EFFORT.
`;

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const { child_id } = await req.json()
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )
    const openAIKey = Deno.env.get('OPENAI_API_KEY') ?? ''
    
    const { data: attempts, error } = await supabase
        .from('attempts')
        .select('*')
        .eq('child_id', child_id)
        .order('completed_at', { ascending: false })
        .limit(20) // Look at last 20 to find valid ones

    // --- SMART FILTERING ---
    // Ignore attempts where the child didn't speak (conversation length <= 2)
    // (Length 2 usually means just: System Prompt + AI Hello)
    const validAttempts = (attempts || []).filter(a => a.ai_conversation && a.ai_conversation.length > 2);

    if (error || validAttempts.length === 0) {
        return new Response(JSON.stringify({ 
            report: "No real activity yet. Ask your child to solve a problem and SPEAK to the AI!",
            stats: { total: 0, avg_questions: 0 }
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    // 2. Math on VALID attempts only
    const totalSolved = validAttempts.length;
    let totalTurns = 0;
    validAttempts.forEach(a => { totalTurns += a.ai_conversation.length; });
    const avgQuestions = Math.round((totalTurns / totalSolved) / 2) || 1;

    // 3. AI Analysis
    const latestChat = JSON.stringify(validAttempts[0].ai_conversation);
    
    const gptResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${openAIKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Stats: Solved ${totalSolved}. Latest Chat: ${latestChat}` }
        ]
      })
    })
    const gptResult = await gptResponse.json()
    const reportText = gptResult.choices[0].message.content

    return new Response(JSON.stringify({ 
        report: reportText,
        stats: { total: totalSolved, avg_questions: avgQuestions }
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }
})
