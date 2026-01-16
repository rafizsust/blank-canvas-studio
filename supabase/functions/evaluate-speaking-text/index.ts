import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { GoogleGenerativeAI } from "https://esm.sh/@google/generative-ai@0.21.0";
import { 
  getActiveGeminiKeysForModels, 
  markModelQuotaExhausted,
  isQuotaExhaustedError,
  isDailyQuotaExhaustedError 
} from "../_shared/apiKeyQuotaUtils.ts";
import { createPerformanceLogger } from "../_shared/performanceLogger.ts";

/**
 * Text-Based Speaking Evaluation - SIMPLIFIED
 * Receives raw transcripts from browser Web Speech API.
 * No word confidence or prosody metrics - just evaluates the transcript content.
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const GEMINI_MODELS = ['gemini-2.5-flash'];

interface TranscriptData {
  rawTranscript: string;
  durationMs: number;
  browserMode?: string;
}

interface EvaluationRequest {
  testId: string;
  userId: string;
  transcripts: Record<string, TranscriptData>;
  topic?: string;
  difficulty?: string;
  fluencyFlag?: boolean;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabaseService = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const body: EvaluationRequest = await req.json();
    const { testId, userId, transcripts, topic, difficulty, fluencyFlag } = body;

    if (!testId || !userId || !transcripts || Object.keys(transcripts).length === 0) {
      return new Response(JSON.stringify({ error: 'Missing required fields' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`[evaluate-speaking-text] Processing ${Object.keys(transcripts).length} segments for test ${testId}`);

    const { data: testRow } = await supabaseService
      .from('ai_practice_tests')
      .select('payload, topic, difficulty')
      .eq('id', testId)
      .maybeSingle();

    const prompt = buildTextEvaluationPrompt(
      transcripts,
      topic || (testRow as any)?.topic || 'general',
      difficulty || (testRow as any)?.difficulty || 'medium',
      fluencyFlag || false,
      testRow?.payload
    );

    const dbApiKeys = await getActiveGeminiKeysForModels(supabaseService, GEMINI_MODELS);
    if (dbApiKeys.length === 0) {
      throw new Error('No API keys available');
    }

    const perfLogger = createPerformanceLogger('evaluate_speaking');
    let result: any = null;

    for (const apiKey of dbApiKeys) {
      if (result) break;
      const genAI = new GoogleGenerativeAI(apiKey.key_value);

      for (const modelName of GEMINI_MODELS) {
        if (result) break;
        try {
          console.log(`[evaluate-speaking-text] Trying ${modelName}`);
          const callStart = Date.now();

          const model = genAI.getGenerativeModel({
            model: modelName,
            generationConfig: { temperature: 0.3, maxOutputTokens: 8000 },
          });

          const response = await model.generateContent(prompt);
          const text = response.response?.text?.() || '';
          const responseTimeMs = Date.now() - callStart;

          if (!text) {
            await perfLogger.logError(modelName, 'Empty response', responseTimeMs, apiKey.id);
            continue;
          }

          const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/) || text.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const jsonStr = jsonMatch[1] || jsonMatch[0];
            result = JSON.parse(jsonStr);
            await perfLogger.logSuccess(modelName, responseTimeMs, apiKey.id);
          } else {
            await perfLogger.logError(modelName, 'Failed to parse JSON', responseTimeMs, apiKey.id);
          }
        } catch (err: any) {
          const errMsg = String(err?.message || '');
          console.error(`[evaluate-speaking-text] Error with ${modelName}:`, errMsg);
          if (isQuotaExhaustedError(errMsg)) {
            await markModelQuotaExhausted(supabaseService, apiKey.id, modelName);
            if (isDailyQuotaExhaustedError(errMsg)) break;
          }
        }
      }
    }

    if (!result) throw new Error('All API keys exhausted');

    await supabaseService.from('ai_practice_results').upsert({
      user_id: userId,
      test_id: testId,
      module: 'speaking',
      band_score: result.overall_band || result.overallBand || 0,
      question_results: result,
      answers: { transcripts },
      completed_at: new Date().toISOString(),
    }, { onConflict: 'user_id,test_id' });

    return new Response(JSON.stringify({ success: true, result }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    console.error('[evaluate-speaking-text] Error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

function buildTextEvaluationPrompt(
  transcripts: Record<string, TranscriptData>,
  topic: string,
  difficulty: string,
  fluencyFlag: boolean,
  payload?: any
): string {
  const parts = Array.isArray(payload?.speakingParts) ? payload.speakingParts : [];
  const questionById = new Map<string, { partNumber: number; questionText: string }>();
  
  for (const p of parts) {
    for (const q of (p?.questions || [])) {
      questionById.set(String(q?.id), { partNumber: Number(p?.part_number), questionText: q?.question_text || '' });
    }
  }

  const segmentSummaries = Object.entries(transcripts).map(([key, d]) => {
    const match = key.match(/^part([123])-q(.+)$/);
    const qInfo = match ? questionById.get(match[2]) : null;
    const durationSec = Math.round(d.durationMs / 1000);
    const wordCount = d.rawTranscript.split(/\s+/).filter(w => w.length > 0).length;
    const wpm = durationSec > 0 ? Math.round((wordCount / durationSec) * 60) : 0;
    
    return `
### ${key.toUpperCase()}
Question: ${qInfo?.questionText || 'Unknown'}
Transcript: "${d.rawTranscript}"
Duration: ${durationSec}s | Words: ${wordCount} | WPM: ${wpm}`;
  }).join('\n');

  return `You are an IELTS Speaking examiner. Evaluate this candidate's responses based on the transcripts.

Topic: ${topic} | Difficulty: ${difficulty}
${fluencyFlag ? '⚠️ FLUENCY FLAG: Short Part 2 response (should be ~2 minutes)' : ''}

${segmentSummaries}

## ⚠️ CRITICAL ANTI-HALLUCINATION RULES - YOU MUST FOLLOW THESE
1. **LEXICAL UPGRADES**: ONLY suggest upgrades for words/phrases that appear EXACTLY and VERBATIM in the transcripts above. Do NOT invent or assume words. If you cannot find simple words to upgrade, return an empty array for lexical_upgrades.

2. **FLUENCY EVALUATION**: This is TEXT-ONLY evaluation from browser speech recognition. You CANNOT hear any audio. The browser has already cleaned and finalized the transcript before sending it to you. Therefore:
   - Do NOT mention hesitations, self-corrections, or pauses UNLESS they are explicitly written in the transcript (e.g., "um", "uh", "like", "you know")
   - Do NOT fabricate phrases like "I am wait" or "same, really difficult" - these are hallucinations
   - ONLY evaluate the coherence, logical flow, and structure of the text as written

3. **PRONUNCIATION**: You cannot assess pronunciation from text. Always score Band 6.0 with feedback: "Cannot be assessed from text - estimated score based on vocabulary complexity"

4. **ALL EXAMPLES AND QUOTES**: Every word, phrase, or example you cite MUST exist verbatim in the provided transcripts. Do NOT fabricate any phrases. If quoting the candidate, copy-paste exactly from the transcript.

5. **WEAKNESSES**: Only list issues that are visible in the written transcript text. Do NOT assume or invent issues like:
   - "Frequent hesitation" (unless "um", "uh" etc. actually appear)
   - "Self-correction" (unless visible in text like "I mean" followed by correction)
   - "Long pauses" (you cannot detect pauses from text)

## IMPORTANT NOTES
- These transcripts are from browser speech recognition - they may have minor errors but have been finalized by the browser
- Base your evaluation on the CONTENT, vocabulary, grammar, and coherence visible in the text ONLY
- When in doubt, DO NOT include information you're not 100% sure is from the transcript

## OUTPUT (JSON only)
\`\`\`json
{
  "overall_band": 6.5,
  "criteria": {
    "fluency_coherence": { "band": 6.5, "feedback": "Based on text structure and coherence only (audio not available)", "strengths": [], "weaknesses": [] },
    "lexical_resource": { "band": 6.0, "feedback": "...", "strengths": [], "weaknesses": [], "lexical_upgrades": [{"original": "EXACT word from transcript", "upgraded": "better alternative", "context": "quote from transcript showing the word"}] },
    "grammatical_range": { "band": 6.0, "feedback": "...", "strengths": [], "weaknesses": [] },
    "pronunciation": { "band": 6.0, "feedback": "Cannot be assessed from text - estimated score based on vocabulary complexity", "strengths": [], "weaknesses": [] }
  },
  "improvement_priorities": ["...", "..."],
  "examiner_notes": "..."
}
\`\`\``;
}
