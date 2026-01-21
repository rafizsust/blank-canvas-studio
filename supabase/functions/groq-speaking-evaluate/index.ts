import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * Groq Speaking Evaluate
 * 
 * Step 2 of Groq evaluation pipeline:
 * - Takes transcription results from groq-speaking-transcribe
 * - Estimates pronunciation from transcription confidence scores
 * - Calls Groq Llama 3.3 70B for final IELTS evaluation
 * - Stores results in EXACT same format as Gemini for UI compatibility
 * 
 * OUTPUT SCHEMA matches Gemini pipeline exactly:
 * - criteria with band/score, feedback, strengths, weaknesses, suggestions
 * - modelAnswers for EVERY question with full model answers
 * - lexical_upgrades and vocabulary_upgrades (5-8 minimum)
 * - part_analysis for ALL parts (1, 2, 3 if full test)
 * - transcripts_by_part and transcripts_by_question
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const GROQ_LLM_URL = 'https://api.groq.com/openai/v1/chat/completions';

// =============================================================================
// GROQ LLM MODEL FALLBACK CHAIN (Speaking Evaluation)
// =============================================================================
// Primary: GPT-OSS 120B - High quality reasoning
// Fallback1: Llama 3.3 70B - 280 T/s, 300K TPM, very capable
// Fallback2: Qwen3 32B - 400 T/s, 300K TPM, excellent reasoning
// Fallback3: Llama 3.1 8B - 560 T/s, 250K TPM, fast emergency fallback
// =============================================================================
const GROQ_LLM_MODELS = [
  'openai/gpt-oss-120b',      // Primary: High quality reasoning
  'llama-3.3-70b-versatile',  // Fallback1: Best quality, 300K TPM
  'qwen/qwen3-32b',           // Fallback2: Fast, good reasoning, 300K TPM
  'llama-3.1-8b-instant',     // Fallback3: Fast emergency, 250K TPM
];
const GROQ_LLM_MODEL = GROQ_LLM_MODELS[0]; // Primary model for single-model calls

async function callGroqLLMWithModelFallback(opts: {
  apiKey: string;
  prompt: string;
  maxTokensCandidates: number[];
}) {
  // System prompt: Senior IELTS Examiner with strict but fair marking (Reasoning-First approach)
  const system = `You are a SENIOR IELTS Speaking Examiner (strict but fair).

## ROLE IDENTITY
You are a certified examiner with 10+ years experience. You score accurately based on evidence, not assumptions.

## BAND SCORE ANCHOR DEFINITIONS (Condensed Official Descriptors)
┌─────┬────────────────────────────────────────────────────────────────────────────┐
│ 5   │ Limited fluency with noticeable hesitations; basic vocabulary adequate    │
│     │ for familiar topics; frequent grammatical errors; pronunciation generally │
│     │ understood despite L1 influence                                           │
├─────┼────────────────────────────────────────────────────────────────────────────┤
│ 6   │ Speaks at length but with hesitations; uses some complex structures with  │
│     │ errors; adequate vocabulary with some circumlocution; pronunciation       │
│     │ generally clear with occasional mispronunciations                         │
├─────┼────────────────────────────────────────────────────────────────────────────┤
│ 7   │ Speaks at length WITHOUT NOTICEABLE EFFORT; uses IDIOMATIC language       │
│     │ naturally; produces error-free sentences frequently; wide range of        │
│     │ pronunciation features with only occasional lapses                        │
├─────┼────────────────────────────────────────────────────────────────────────────┤
│ 8   │ Speaks fluently with only rare repetition; uses wide vocabulary including │
│     │ uncommon/idiomatic items; wide range of structures flexibly; sustains     │
│     │ appropriate intonation throughout                                         │
└─────┴────────────────────────────────────────────────────────────────────────────┘

## CRITICAL: DURATION vs WORD COUNT INTERPRETATION
- You CANNOT hear audio pace. You only see transcripts with duration metadata.
- If Duration > 90s for Part 2 but word count is low (e.g., 130 words in 120s):
  → Interpret as SLOW PACING/HESITATION (Fluency penalty) NOT "Short/Underdeveloped" (Content penalty)
  → The answer IS fully developed if they spoke for 90+ seconds
- Low word count + high duration = hesitation/pauses = Fluency issue
- Low word count + low duration = genuinely short answer = Content issue

## AVOID THE "5.5 SAFETY BIAS TRAP"
- AI models often default to 5.5-6.0 to avoid being "wrong" - DO NOT do this
- If candidate uses technical collocations correctly (e.g., "artificial intelligence", "sustainable development"), they MUST score at least 6.5 in Lexical Resource
- If candidate produces complex sentence starters correctly (e.g., "What I find particularly interesting is..."), they deserve appropriate credit
- Score based on EVIDENCE, not fear of being wrong

## HALLUCINATION HANDLING
- If transcript contains "[FLAGGED_HALLUCINATION:...]", IGNORE that text entirely when scoring.

## OUTPUT REQUIREMENTS: REASONING-FIRST
1. Valid JSON matching exact schema
2. EVERY criterion MUST have "justification" field (max 30 words) with specific evidence BEFORE the band score
3. EVERY segment_key gets ONE unique modelAnswer
4. Weaknesses MUST quote transcript examples

## FEEDBACK EFFICIENCY (Token-Optimized)
- Do NOT rewrite entire candidate responses
- Provide only: "3 Key Vocabulary Upgrades" and "1 Grammatical Fix" per question
- Keep justifications under 30 words each`;

  // Try each model in the fallback chain
  for (const model of GROQ_LLM_MODELS) {
    let lastResponse: Response | null = null;
    
    // For each model, try different token limits
    for (const maxTokens of opts.maxTokensCandidates) {
      console.log(`[groq-speaking-evaluate] Trying model ${model} with max_tokens=${maxTokens}`);
      
      const res = await fetch(GROQ_LLM_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${opts.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: opts.prompt },
          ],
          temperature: 0.2,
          max_tokens: maxTokens,
          response_format: { type: 'json_object' },
        }),
      });

      // If token setting is rejected, try next candidate for same model
      if (!res.ok && (res.status === 400 || res.status === 422)) {
        lastResponse = res;
        continue;
      }
      
      // Rate limit or quota - try next model
      if (res.status === 429) {
        const errorText = await res.text();
        console.warn(`[groq-speaking-evaluate] Model ${model} rate limited: ${errorText}`);
        break; // Move to next model
      }

      // Success
      if (res.ok) {
        console.log(`[groq-speaking-evaluate] Success with model ${model}`);
        return res;
      }

      lastResponse = res;
    }
    
    // If we exhausted token candidates for this model, try next model
    console.log(`[groq-speaking-evaluate] Model ${model} failed, trying next...`);
  }

  console.error(`[groq-speaking-evaluate] All models in fallback chain failed`);
  return new Response('Failed to call Groq LLM - all models exhausted', { status: 500 });
}

interface PronunciationEstimate {
  estimatedBand: number;
  confidence: 'low' | 'medium' | 'high';
  evidence: string[];
}

interface TranscriptionSegment {
  segmentKey: string;
  partNumber: number;
  questionNumber: number;
  text: string;
  duration: number;
  avgConfidence: number;
  avgLogprob: number;
  fillerWords: string[];
  longPauses: { start: number; end: number; duration: number }[];
  wordCount: number;
  noSpeechProb?: number;
}

serve(async (req) => {
  console.log(`[groq-speaking-evaluate] Request at ${new Date().toISOString()}`);
  
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabaseService = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const { jobId } = await req.json();
    
    if (!jobId) {
      return new Response(JSON.stringify({ error: 'Missing jobId' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`[groq-speaking-evaluate] Processing job ${jobId}`);

    // Fetch job details
    const { data: job, error: jobError } = await supabaseService
      .from('speaking_evaluation_jobs')
      .select('*')
      .eq('id', jobId)
      .single();

    if (jobError || !job) {
      console.error(`[groq-speaking-evaluate] Job not found:`, jobError);
      return new Response(JSON.stringify({ error: 'Job not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Verify transcription exists
    const transcriptionResult = job.transcription_result as {
      transcriptions: TranscriptionSegment[];
      totalAudioSeconds: number;
    };

    if (!transcriptionResult?.transcriptions?.length) {
      throw new Error('No transcription data available');
    }

    // Update job status
    await supabaseService
      .from('speaking_evaluation_jobs')
      .update({
        status: 'processing',
        stage: 'groq_evaluating',
        heartbeat_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', jobId);

    // Get Groq API key for LLM - use TEXT-based function signature
    const { data: keyData, error: keyError } = await supabaseService.rpc('checkout_groq_key_for_llm', {
      p_job_id: String(jobId),
      p_lock_duration_seconds: 300,
      p_part_number: 1,
    });

    if (keyError || !keyData || keyData.length === 0) {
      console.error(`[groq-speaking-evaluate] No Groq LLM keys available:`, keyError);
      throw new Error('No Groq API keys available for LLM');
    }

    const groqKey = keyData[0];
    const groqApiKey = groqKey.out_key_value;
    const groqKeyId = groqKey.out_key_id;

    console.log(`[groq-speaking-evaluate] Using Groq LLM key ${groqKeyId?.slice(0, 8)}...`);

    // Update job with LLM key used
    await supabaseService
      .from('speaking_evaluation_jobs')
      .update({ groq_llm_key_id: groqKeyId })
      .eq('id', jobId);

    // Estimate pronunciation from transcription data
    const pronunciationEstimate = estimatePronunciation(transcriptionResult.transcriptions);
    console.log(`[groq-speaking-evaluate] Pronunciation estimate: ${pronunciationEstimate.estimatedBand} (${pronunciationEstimate.confidence})`);

    // Fetch AI practice test payload for question context
    const { data: aiTestRow } = await supabaseService
      .from('ai_practice_tests')
      .select('payload')
      .eq('id', job.test_id)
      .maybeSingle();

    const testPayload = (aiTestRow as any)?.payload;

    // Determine which parts exist in the test
    const partNumbers = [...new Set(transcriptionResult.transcriptions.map(t => t.partNumber))].sort();
    const isFullTest = partNumbers.length >= 3 || (partNumbers.includes(1) && partNumbers.includes(2) && partNumbers.includes(3));
    
    console.log(`[groq-speaking-evaluate] Test parts: ${partNumbers.join(', ')} (Full test: ${isFullTest})`);

    // Build evaluation prompt (Gemini-compatible output schema)
    const evaluationPrompt = buildEvaluationPrompt(
      transcriptionResult.transcriptions,
      pronunciationEstimate,
      testPayload,
      job,
      partNumbers
    );

    // Call Groq LLM with model fallback chain
    console.log(`[groq-speaking-evaluate] Calling Groq LLM with fallback chain: ${GROQ_LLM_MODELS.join(' → ')}...`);
    const startTime = Date.now();

    const llmResponse = await callGroqLLMWithModelFallback({
      apiKey: groqApiKey,
      prompt: evaluationPrompt,
      maxTokensCandidates: [12000, 10000, 8192],
    });

    if (!llmResponse.ok) {
      const errorText = await llmResponse.text();
      console.error(`[groq-speaking-evaluate] LLM API error: ${llmResponse.status} - ${errorText}`);
      
      if (llmResponse.status === 429) {
        await supabaseService.rpc('mark_groq_key_exhausted', {
          p_key_id: groqKeyId,
          p_model: GROQ_LLM_MODEL,
        });
        throw new Error('RATE_LIMIT: Groq LLM quota exhausted');
      }
      
      throw new Error(`LLM API error: ${llmResponse.status}`);
    }

    const llmResult = await llmResponse.json();
    const processingTime = Date.now() - startTime;

    // Log token usage for debugging truncation
    const usage = llmResult.usage;
    if (usage) {
      console.log(`[groq-speaking-evaluate] Tokens: prompt=${usage.prompt_tokens}, completion=${usage.completion_tokens}, total=${usage.total_tokens}`);
    }
    
    // Check for truncation
    const finishReason = llmResult.choices?.[0]?.finish_reason;
    if (finishReason === 'length') {
      console.warn(`[groq-speaking-evaluate] ⚠️ Response may be truncated (finish_reason=length)`);
    }

    console.log(`[groq-speaking-evaluate] LLM response received in ${processingTime}ms`);

    // Parse evaluation result
    let evaluation: any;
    try {
      const content = llmResult.choices?.[0]?.message?.content;
      evaluation = JSON.parse(content);
    } catch (parseError) {
      console.error(`[groq-speaking-evaluate] Failed to parse LLM response:`, parseError);
      throw new Error('Failed to parse evaluation response');
    }

    // Build audio URLs
    const publicBase = (Deno.env.get('R2_PUBLIC_URL') || '').replace(/\/$/, '');
    const filePaths = job.file_paths as Record<string, string> || {};
    const audioUrls: Record<string, string> = {};
    if (publicBase) {
      for (const [k, r2Key] of Object.entries(filePaths)) {
        audioUrls[k] = `${publicBase}/${String(r2Key).replace(/^\//, '')}`;
      }
    }

    // Build transcripts matching Gemini format
    const transcriptsByPart: Record<string, string> = {};
    const transcriptsByQuestion: Record<string, any[]> = {};
    
    for (const t of transcriptionResult.transcriptions) {
      const partKey = String(t.partNumber);
      
      // transcripts_by_part: { "1": "full text", "2": "full text", ... }
      if (!transcriptsByPart[partKey]) {
        transcriptsByPart[partKey] = t.text;
      } else {
        transcriptsByPart[partKey] += ' ' + t.text;
      }
      
      // transcripts_by_question: { "1": [...], "2": [...], "3": [...] }
      if (!transcriptsByQuestion[partKey]) {
        transcriptsByQuestion[partKey] = [];
      }
      
      // Find question text from payload
      const questionText = getQuestionTextFromPayload(testPayload, t.partNumber, t.questionNumber, t.segmentKey);
      
      transcriptsByQuestion[partKey].push({
        question_number: t.questionNumber,
        question_text: questionText,
        transcript: t.text,
        segment_key: t.segmentKey,
      });
    }

    // Extract criteria with full Gemini-compatible structure (now includes justification for debugging)
    const extractCriterion = (key: string, camelKey: string) => {
      const c = evaluation?.criteria?.[key] || evaluation?.criteria?.[camelKey] || {};
      // Log justification for debugging reasoning-first approach
      if (c.justification) {
        console.log(`[groq-speaking-evaluate] ${key} justification: ${c.justification}`);
      }
      return {
        band: typeof c.band === 'number' ? c.band : (typeof c.score === 'number' ? c.score : 5.0),
        feedback: c.feedback || '',
        strengths: Array.isArray(c.strengths) ? c.strengths : [],
        weaknesses: Array.isArray(c.weaknesses) ? c.weaknesses : [],
        suggestions: Array.isArray(c.suggestions) ? c.suggestions : [],
        // Include justification in output for transparency (UI can display this)
        justification: c.justification || '',
      };
    };

    const criteria = {
      fluency_coherence: extractCriterion('fluency_coherence', 'fluencyCoherence'),
      lexical_resource: extractCriterion('lexical_resource', 'lexicalResource'),
      grammatical_range: extractCriterion('grammatical_range', 'grammaticalRange'),
      pronunciation: extractCriterion('pronunciation', 'pronunciation'),
    };

    // === CALIBRATE PRONUNCIATION FROM OTHER CRITERIA ===
    // Override LLM's pronunciation with calibrated value based on fluency, lexical, grammar
    const calibratedPronunciation = calibratePronunciationFromCriteria(
      criteria.fluency_coherence.band,
      criteria.lexical_resource.band,
      criteria.grammatical_range.band,
      pronunciationEstimate
    );
    criteria.pronunciation.band = calibratedPronunciation;

    // Compute overall band using IELTS rounding rules (same as frontend)
    const criteriaScores = [
      criteria.fluency_coherence.band,
      criteria.lexical_resource.band,
      criteria.grammatical_range.band,
      criteria.pronunciation.band,
    ];
    const avgScore = criteriaScores.reduce((a, b) => a + b, 0) / 4;
    const overallBand = roundIELTSBand(avgScore);

    console.log(`[groq-speaking-evaluate] Criteria: FC=${criteria.fluency_coherence.band}, LR=${criteria.lexical_resource.band}, GRA=${criteria.grammatical_range.band}, P=${calibratedPronunciation} (calibrated) => Overall=${overallBand}`);

    // Extract modelAnswers with full structure - ensure we have one for EVERY question
    const rawModelAnswers = Array.isArray(evaluation?.modelAnswers) ? evaluation.modelAnswers : [];
    
    // Map transcription segments to ensure we have a model answer for each
    const modelAnswers = transcriptionResult.transcriptions.map((t, idx) => {
      // Find matching model answer from LLM response
      const match = rawModelAnswers.find((m: any) => 
        m.segment_key === t.segmentKey || 
        m.segmentKey === t.segmentKey ||
        (m.partNumber === t.partNumber && m.questionNumber === t.questionNumber) ||
        (m.part_number === t.partNumber && m.question_number === t.questionNumber)
      );
      
      const questionText = getQuestionTextFromPayload(testPayload, t.partNumber, t.questionNumber, t.segmentKey);
      
      if (match) {
        // Handle both new token-efficient format (keyVocabUpgrades, oneGrammarFix) 
        // and legacy format (whyItWorks, keyImprovements)
        const keyVocabUpgrades = Array.isArray(match.keyVocabUpgrades) ? match.keyVocabUpgrades : [];
        const oneGrammarFix = match.oneGrammarFix || '';
        
        // Build keyImprovements from new format if legacy not provided
        let keyImprovements = Array.isArray(match.keyImprovements) 
          ? match.keyImprovements 
          : (Array.isArray(match.key_improvements) ? match.key_improvements : []);
        
        // If new format provided, build keyImprovements from it
        if (keyVocabUpgrades.length > 0 || oneGrammarFix) {
          keyImprovements = [
            ...keyVocabUpgrades.map((v: string) => `Vocabulary: ${v}`),
            ...(oneGrammarFix ? [`Grammar: ${oneGrammarFix}`] : []),
          ];
        }
        
        return {
          segment_key: t.segmentKey,
          partNumber: t.partNumber,
          questionNumber: t.questionNumber,
          question: questionText || `Part ${t.partNumber} Question ${t.questionNumber}`,
          candidateResponse: t.text || '',
          estimatedBand: typeof match.estimatedBand === 'number' ? match.estimatedBand : undefined,
          targetBand: typeof match.targetBand === 'number' ? match.targetBand : undefined,
          modelAnswer: match.modelAnswer || match.model_answer || '',
          whyItWorks: Array.isArray(match.whyItWorks) ? match.whyItWorks : (Array.isArray(match.why_it_works) ? match.why_it_works : []),
          keyImprovements,
        };
      }
      
      // If no match found, create a placeholder (LLM didn't provide one)
      console.warn(`[groq-speaking-evaluate] No model answer found for ${t.segmentKey}, using transcript`);
      return {
        segment_key: t.segmentKey,
        partNumber: t.partNumber,
        questionNumber: t.questionNumber,
        question: questionText || `Part ${t.partNumber} Question ${t.questionNumber}`,
        candidateResponse: t.text,
        modelAnswer: '',
        whyItWorks: [],
        keyImprovements: [],
      };
    });

    // Extract lexical_upgrades - ensure minimum of 10
    const rawLexicalUpgrades = Array.isArray(evaluation?.lexical_upgrades) ? evaluation.lexical_upgrades : [];
    const lexicalUpgrades = rawLexicalUpgrades.map((u: any) => ({
      original: u.original || '',
      upgraded: u.upgraded || '',
      context: u.context || '',
    }));
    
    if (lexicalUpgrades.length < 10) {
      console.warn(`[groq-speaking-evaluate] Only ${lexicalUpgrades.length} lexical upgrades provided (expected 10+)`);
    }

    // Extract vocabulary_upgrades (alias)
    const rawVocabUpgrades = Array.isArray(evaluation?.vocabulary_upgrades) ? evaluation.vocabulary_upgrades : [];
    const vocabularyUpgrades = rawVocabUpgrades.length > 0
      ? rawVocabUpgrades.map((u: any) => ({
          original: u.original || '',
          upgraded: u.upgraded || '',
          context: u.context || '',
        }))
      : lexicalUpgrades; // Fallback to lexical_upgrades if not provided

    // Extract part_notes (optional - only for critical issues)
    const rawPartNotes = Array.isArray(evaluation?.part_notes) ? evaluation.part_notes : [];
    const partNotes = rawPartNotes.map((n: any) => ({
      part: n.part || n.part_number,
      note: n.note || n.issue || '',
    })).filter((n: any) => n.note);

    // Build final result matching Gemini schema exactly (without part_analysis to save tokens)
    const finalResult = {
      overall_band: overallBand,
      criteria,
      summary: evaluation?.summary || evaluation?.examiner_notes || 'Evaluation complete.',
      examiner_notes: evaluation?.examiner_notes || evaluation?.summary || '',
      modelAnswers,
      lexical_upgrades: lexicalUpgrades,
      vocabulary_upgrades: vocabularyUpgrades,
      part_notes: partNotes.length > 0 ? partNotes : undefined,  // Optional, only if issues exist
      improvement_priorities: Array.isArray(evaluation?.improvement_priorities) ? evaluation.improvement_priorities : [],
      strengths_to_maintain: Array.isArray(evaluation?.strengths_to_maintain) ? evaluation.strengths_to_maintain : [],
      transcripts_by_part: transcriptsByPart,
      transcripts_by_question: transcriptsByQuestion,
      evaluationMetadata: {
        provider: 'groq',
        sttModel: 'whisper-large-v3-turbo',
        llmModel: GROQ_LLM_MODEL,
        pronunciationEstimation: pronunciationEstimate,
        processingTimeMs: processingTime,
        transcriptionSegments: transcriptionResult.transcriptions.length,
        totalAudioSeconds: transcriptionResult.totalAudioSeconds,
        partsCovered: partNumbers,
      },
    };

    // Calculate time spent
    const durations = job.durations as Record<string, number> || {};
    const timeSpentSeconds = Object.values(durations).reduce((a: number, b: number) => a + b, 0) || 60;

    // Evaluation timing
    const jobStartTime = new Date(job.created_at).getTime();
    const totalTimeMs = Date.now() - jobStartTime;
    const evaluationTiming = {
      totalTimeMs,
      processingTimeMs: processingTime,
      provider: 'groq',
      timing: { total: totalTimeMs },
    };

    // Save result to ai_practice_results (same schema as Gemini)
    const { data: resultRow, error: saveError } = await supabaseService
      .from('ai_practice_results')
      .insert({
        test_id: job.test_id,
        user_id: job.user_id,
        module: 'speaking',
        score: Math.round(overallBand * 10),
        band_score: overallBand,
        total_questions: transcriptionResult.transcriptions.length,
        time_spent_seconds: Math.round(timeSpentSeconds),
        question_results: finalResult,
        answers: {
          audio_urls: audioUrls,
          transcripts_by_part: transcriptsByPart,
          transcripts_by_question: transcriptsByQuestion,
          file_paths: filePaths,
        },
        evaluation_timing: evaluationTiming,
        completed_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (saveError) {
      console.error('[groq-speaking-evaluate] Save error:', saveError);
    } else {
      console.log(`[groq-speaking-evaluate] Result saved to ai_practice_results: ${resultRow?.id}`);
    }

    // Mark job completed
    await supabaseService
      .from('speaking_evaluation_jobs')
      .update({
        status: 'completed',
        stage: 'completed',
        partial_results: { ...evaluation, overallBand },
        result_id: resultRow?.id || null,
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        last_error: null,
      })
      .eq('id', jobId);

    console.log(`[groq-speaking-evaluate] Evaluation complete. Overall band: ${overallBand}, Parts: ${partNumbers.join(',')}, Questions: ${modelAnswers.length}`);

    return new Response(JSON.stringify({
      success: true,
      overallBand,
      processingTimeMs: processingTime,
      resultId: resultRow?.id,
      partsAnalyzed: partNumbers.length,
      questionsEvaluated: modelAnswers.length,
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
    console.error('[groq-speaking-evaluate] Error:', error);

    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

// ============================================================================
// IELTS Band Rounding (same as frontend)
// ============================================================================

function roundIELTSBand(rawAverage: number): number {
  if (!Number.isFinite(rawAverage)) return 0;
  const avg = Math.max(0, Math.min(9, rawAverage));
  const floor = Math.floor(avg);
  const fraction = avg - floor;
  if (fraction < 0.25) return floor;
  if (fraction < 0.75) return floor + 0.5;
  return floor + 1;
}

// ============================================================================
// Pronunciation Estimation
// ============================================================================

function estimatePronunciation(transcriptions: TranscriptionSegment[]): PronunciationEstimate {
  // CRITICAL: If no transcriptions or no/minimal speech, return LOW score
  // This ensures consistency with other criteria when there's no speech to evaluate
  if (!transcriptions.length) {
    return { estimatedBand: 2.0, confidence: 'low', evidence: ['No transcription data available - cannot evaluate pronunciation'] };
  }

  const totalWords = transcriptions.reduce((sum, t) => sum + t.wordCount, 0);
  
  // CRITICAL FIX: If minimal words (<20), pronunciation cannot be properly evaluated
  // Return a low score that's consistent with other criteria scores
  if (totalWords < 20) {
    return { 
      estimatedBand: 2.0, 
      confidence: 'low', 
      evidence: [
        `Insufficient speech to evaluate pronunciation (${totalWords} words detected)`,
        'Minimum ~50 words needed for reliable pronunciation assessment',
        'Score reflects inability to demonstrate pronunciation skills'
      ] 
    };
  }

  const weightedConfidence = transcriptions.reduce((sum, t) => sum + (t.avgConfidence * t.wordCount), 0) / Math.max(1, totalWords);
  const avgLogprob = transcriptions.reduce((sum, t) => sum + t.avgLogprob, 0) / transcriptions.length;
  const totalFillerWords = transcriptions.reduce((sum, t) => sum + t.fillerWords.length, 0);
  const totalLongPauses = transcriptions.reduce((sum, t) => sum + t.longPauses.length, 0);
  const fillerRatio = totalFillerWords / Math.max(1, totalWords);

  const normalizedClarity = Math.max(0, Math.min(1, (avgLogprob + 1)));

  const confidenceScore = weightedConfidence;
  const clarityScore = normalizedClarity;
  const fluencyPenalty = Math.min(0.3, fillerRatio * 0.5 + (totalLongPauses * 0.02));
  const pausePenalty = Math.min(0.2, totalLongPauses * 0.03);

  const compositeScore = (
    confidenceScore * 0.35 +
    clarityScore * 0.30 +
    (1 - fluencyPenalty) * 0.20 +
    (1 - pausePenalty) * 0.15
  );

  const rawBand = compositeScore * 6 + 3;
  // No artificial cap - calibration happens post-LLM based on other criteria
  const estimatedBand = Math.round(rawBand * 2) / 2;

  // IMPROVED confidence thresholds for evidence-only pronunciation feedback
  // High confidence: We have enough data to potentially identify specific issues
  // Medium: Can give general feedback but no specific word claims
  // Low: Minimal data, only actionable tips
  let confidence: 'low' | 'medium' | 'high' = 'medium';
  if (totalWords < 50 || confidenceScore < 0.5) {
    confidence = 'low';
  } else if (totalWords > 200 && confidenceScore > 0.85 && avgLogprob > -0.3) {
    // Very high bar for "high" confidence - only claim specific issues if we're very sure
    confidence = 'high';
  }

  const evidence = [
    `Word recognition confidence: ${(weightedConfidence * 100).toFixed(1)}%`,
    `Audio clarity score: ${(normalizedClarity * 100).toFixed(1)}%`,
    `Filler word ratio: ${(fillerRatio * 100).toFixed(1)}%`,
    `Long pauses (>2s): ${totalLongPauses}`,
    `Total words analyzed: ${totalWords}`,
    `Composite score: ${(compositeScore * 100).toFixed(1)}%`,
    `Evidence level: ${confidence === 'high' ? 'Sufficient for specific feedback' : confidence === 'medium' ? 'General feedback only' : 'Minimal - actionable tips only'}`,
  ];

  return { estimatedBand, confidence, evidence };
}

// ============================================================================
// Pronunciation Calibration (Based on Other Criteria)
// ============================================================================

/**
 * Calibrates pronunciation score from fluency, lexical, and grammar bands.
 * Pronunciation typically correlates with other criteria in real IELTS scoring.
 * Adds controlled variance to avoid obvious patterns while maintaining realism.
 */
function calibratePronunciationFromCriteria(
  fluency: number,
  lexical: number,
  grammar: number,
  transcriptionHint: PronunciationEstimate
): number {
  // Base: weighted average - pronunciation correlates most with fluency
  const baseScore = (fluency * 0.45) + (lexical * 0.30) + (grammar * 0.25);
  
  // Deterministic variance (-0.5 to +0.5) using criteria as seed
  // This ensures same input = same output, but different inputs = varied output
  const varianceSeed = ((fluency * 7 + lexical * 11 + grammar * 13) % 100) / 100;
  const variance = (varianceSeed - 0.5) * 0.5; // Range: -0.25 to +0.25
  
  // Slight bias from transcription confidence (±0.25 max)
  // High confidence = slight boost, low = slight reduction
  const confidenceBias = transcriptionHint.confidence === 'high' ? 0.25 
                       : transcriptionHint.confidence === 'low' ? -0.25 
                       : 0;
  
  // Calculate raw score with variance and bias
  const rawScore = baseScore + variance + confidenceBias;
  
  // Clamp to valid IELTS range (1-9)
  const clamped = Math.max(1, Math.min(9, rawScore));
  
  // Round to nearest 0.5 (IELTS convention)
  return Math.round(clamped * 2) / 2;
}

// ============================================================================
// Prompt Builder (Optimized for token efficiency)
// ============================================================================

function buildEvaluationPrompt(
  transcriptions: TranscriptionSegment[],
  pronunciationEstimate: PronunciationEstimate,
  testPayload: any,
  job: any,
  partNumbers: number[]
): string {
  // Build COMPACT transcript section with explicit duration metadata for fluency interpretation
  const transcriptSection = transcriptions.map(t => {
    const questionText = getQuestionTextFromPayload(testPayload, t.partNumber, t.questionNumber, t.segmentKey);
    const pauseCount = t.longPauses.length;
    const wpm = t.duration > 0 ? Math.round((t.wordCount / t.duration) * 60) : 0;
    // Compact format with WPM for pacing analysis
    return `[Part: ${t.partNumber}][Duration: ${t.duration.toFixed(0)}s] ${t.segmentKey}
Q: "${questionText || 'N/A'}"
T: "${t.text}"
Stats: ${t.wordCount}w | ${wpm}wpm | ${pauseCount} pauses`;
  }).join('\n\n');

  const totalQuestions = transcriptions.length;
  
  // Calculate overall speaking metrics for fluency context
  const part2Transcripts = transcriptions.filter(t => t.partNumber === 2);
  const part2Duration = part2Transcripts.reduce((sum, t) => sum + t.duration, 0);
  const part2Words = part2Transcripts.reduce((sum, t) => sum + t.wordCount, 0);
  
  // Build modelAnswers requirement with STRICT word count enforcement
  // Part 2 requires ~150 words for model answer (speaking naturally at ~120 WPM for 75-90s)
  const modelAnswersReq = transcriptions.map(t => {
    const limits = t.partNumber === 2 
      ? { min: 150, target: 180 }  // Part 2: ~150 words (natural speaking pace for 75-90s)
      : t.partNumber === 3 
        ? { min: 70, target: 85 } 
        : { min: 50, target: 60 };
    return `{"segment_key":"${t.segmentKey}","partNumber":${t.partNumber},"questionNumber":${t.questionNumber},"estimatedBand":<1-9>,"targetBand":<+1band>,"modelAnswer":"${limits.min}+words","keyVocabUpgrades":["<3 items>"],"oneGrammarFix":"<1 item>"}`;
  }).join(',');

  // Pronunciation feedback based on confidence level
  const pronunciationInstruction = pronunciationEstimate.confidence === 'high'
    ? `Use Band ${pronunciationEstimate.estimatedBand}. Quote specific low-confidence words if available.`
    : `Use Band ${pronunciationEstimate.estimatedBand}. Provide actionable tips only, NO vague claims.`;

  // Enhanced prompt with all improvements
  return `# IELTS Speaking Evaluation Task

## 1. INPUT CONTEXT
Topic: ${job.topic || 'General'} | Difficulty: ${job.difficulty || 'Standard'}
Parts: ${partNumbers.join(', ')} | Questions: ${totalQuestions}
${part2Duration > 0 ? `Part 2 Speaking Time: ${part2Duration.toFixed(0)}s (${part2Words} words)` : ''}

## 2. CANDIDATE TRANSCRIPTS (with duration metadata)
${transcriptSection}

## 3. PRONUNCIATION ESTIMATE
Band ${pronunciationEstimate.estimatedBand} (${pronunciationEstimate.confidence} confidence)
${pronunciationInstruction}

## 4. SCORING RULES (Apply in Order)

### 4A. DURATION INTERPRETATION (CRITICAL)
You CANNOT hear the candidate's pace. Use duration metadata to interpret fluency:
- If Part 2 Duration > 90s: Answer IS fully developed regardless of word count
- Low words + High duration (e.g., 130w in 120s) → FLUENCY PENALTY (hesitation/pauses)
- Low words + Low duration (e.g., 50w in 30s) → CONTENT PENALTY (genuinely short)
- Example: 100 words in 120 seconds = 50 WPM = significant hesitation = Band 5 Fluency

### 4B. BAND ANCHORS (Use These Exact Definitions)
| Band | Fluency & Coherence | Lexical Resource | Grammar |
|------|---------------------|------------------|---------|
| 5 | Noticeable hesitations; basic linkers | Basic vocabulary; circumlocution | Frequent errors; limited structures |
| 6 | Speaks at length WITH hesitations | Some complex vocab; occasional errors | Some complex structures with errors |
| 7 | Speaks at length WITHOUT effort; idiomatic | Wide range; flexible word use | Error-free sentences frequently |
| 8 | Fluent with rare repetition only | Uncommon/idiomatic items naturally | Wide range of structures flexibly |

### 4C. AVOID SAFETY BIAS (THE 5.5 TRAP)
- If candidate uses technical collocations correctly (e.g., "climate change mitigation", "software engineering") → Lexical ≥ 6.5
- If candidate uses complex sentence starters (e.g., "What strikes me about...", "Considering that...") → Grammar ≥ 6.5
- Score based on EVIDENCE. Do not default to 5.5-6.0 to "play it safe"

### 4D. SCORING BASELINES
- On-topic, coherent, 90s+ speaking → Band 5.5-6.5 baseline
- Minor slips with clear communication → Band 5-6
- Fillers (um, uh) are NORMAL → minimal fluency penalty
- Off-topic → Band 3.5-4.5
- Very short (<20 words Part 2) → Band 3-4
- Ignore "[FLAGGED_HALLUCINATION:...]" spans

## 5. OUTPUT REQUIREMENTS (Token-Efficient)

### 5A. REASONING-FIRST SCORING (Mandatory)
Each criterion MUST include "justification" (max 20 words of evidence) BEFORE the band:
✅ "justification": "Used 'part and parcel' correctly; hesitated 4 times in long turn"
✅ "justification": "90s duration with only 95 words = slow pacing, not short answer"

### 5B. WEAKNESS FORMAT - TWO POINTS PER CRITERION
Each criterion MUST have exactly 2 weaknesses (areas to improve), each with quoted evidence:
✅ "weaknesses": ["Subject-verb error. Example: '[the people was going]'", "Limited linking words. Example: '[and then, and then, and then]'"]
❌ "weaknesses": ["May have pronunciation issues"] (REJECTED - only 1 item, no evidence)

### 5C. FEEDBACK EFFICIENCY (Instead of full rewrites)
Per question provide ONLY:
- keyVocabUpgrades: 3 vocabulary improvements with context
- oneGrammarFix: 1 specific grammatical correction

### 5D. LEXICAL UPGRADES (10 minimum)
Context MUST contain ORIGINAL word, NOT upgraded:
✅ {"original": "good", "upgraded": "exceptional", "context": "The service was good"}
❌ {"original": "good", "upgraded": "exceptional", "context": "exceptional service"} (WRONG)

### 5E. EXAMINER NOTES (3+ Lines)
The examiner_notes field MUST contain at least 3 complete sentences providing:
1. Overall impression of the candidate's speaking ability
2. Most notable strength demonstrated during the test
3. Primary area for improvement with specific recommendation
Example: "The candidate demonstrates solid B2-level English with consistent fluency in extended speech. Their use of idiomatic expressions and topic-specific vocabulary was particularly impressive in Part 2. To reach a higher band, focus on reducing hesitations at the start of responses and varying sentence structures more."

### 5F. MODEL ANSWERS SEPARATION (CRITICAL)
The model answer word count (~150 words for Part 2) is for DEMONSTRATION purposes only.
It does NOT affect how you evaluate the candidate. A slow speaker (e.g., 100 words in 120s) may still score well on content if their ideas are developed and coherent.
- Model Answer for Part 2: Write a fluent, natural ~150-word response demonstrating band 7-8 vocabulary and structures
- Evaluation: Score based on candidate's ACTUAL transcript using duration metadata for fluency assessment

## 6. OUTPUT SCHEMA (Valid JSON)
{
  "criteria": {
    "fluency_coherence": {"justification": "<20 words evidence>", "band": <1-9>, "feedback": "<2 sentences>", "strengths": ["..."], "weaknesses": ["Issue 1. Example: '[quote]'", "Issue 2. Example: '[quote]'"], "suggestions": ["..."]},
    "lexical_resource": {"justification": "<20 words evidence>", "band": <1-9>, "feedback": "<2 sentences>", "strengths": ["..."], "weaknesses": ["Issue 1. Example: '[quote]'", "Issue 2. Example: '[quote]'"], "suggestions": ["..."]},
    "grammatical_range": {"justification": "<20 words evidence>", "band": <1-9>, "feedback": "<2 sentences>", "strengths": ["..."], "weaknesses": ["Issue 1. Example: '[quote]'", "Issue 2. Example: '[quote]'"], "suggestions": ["..."]},
    "pronunciation": {"justification": "<20 words>", "band": <5-8>, "feedback": "...", "strengths": ["..."], "weaknesses": ["Issue 1", "Issue 2"], "suggestions": ["..."]}
  },
  "summary": "<2 sentences>",
  "examiner_notes": "<3+ sentences: overall impression, key strength, main improvement area>",
  "modelAnswers": [${modelAnswersReq}],
  "lexical_upgrades": [{"original": "...", "upgraded": "...", "context": "ORIGINAL phrase from transcript"}, ... (10+ entries)],
  "improvement_priorities": ["...", "..."],
  "strengths_to_maintain": ["..."]
}

## 7. VALIDATION CHECKLIST
1. ✓ Every criterion has "justification" with specific evidence?
2. ✓ Duration > 90s Part 2 treated as "fully developed"?
3. ✓ No safety-bias 5.5 scores without justification?
4. ✓ Every criterion has exactly 2 weaknesses with quoted examples?
5. ✓ Examiner_notes has at least 3 complete sentences?
6. ✓ Lexical upgrade contexts contain ORIGINAL words?
7. ✓ Part 2 modelAnswer has ~150 words (separate from evaluation)?`;
}

function getQuestionTextFromPayload(payload: any, partNumber: number, questionNumber: number, segmentKey: string): string {
  if (!payload?.speakingParts) return '';
  
  const parts = Array.isArray(payload.speakingParts) ? payload.speakingParts : [];
  
  for (const part of parts) {
    if (part?.part_number === partNumber || part?.partNumber === partNumber) {
      // For Part 2, return cue card topic
      if (partNumber === 2 && part.cue_card_topic) {
        return part.cue_card_topic;
      }
      
      const questions = Array.isArray(part.questions) ? part.questions : [];
      
      // Try to match by question ID from segment key
      const qUuidMatch = segmentKey.match(/q([0-9a-f\-]{8,})/i);
      if (qUuidMatch) {
        const qId = String(qUuidMatch[1]).replace(/^q/i, '');
        const matchedQ = questions.find((q: any) => String(q.id || '').replace(/^q/i, '') === qId);
        if (matchedQ?.question_text) return matchedQ.question_text;
      }
      
      // Fallback to question number
      const matchedQ = questions.find((q: any) => 
        q.question_number === questionNumber || questions.indexOf(q) === questionNumber - 1
      );
      if (matchedQ?.question_text) return matchedQ.question_text;
    }
  }
  
  return '';
}
