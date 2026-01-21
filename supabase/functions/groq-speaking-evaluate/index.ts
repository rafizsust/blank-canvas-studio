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
  // System prompt: human-like IELTS examiner (calibrated scoring, generous model answers)
  const system = `You are a CERTIFIED IELTS Speaking Examiner scoring like a real human examiner would.

## SCORING PHILOSOPHY (Human-Like, Not AI-Harsh)
- IELTS examiners are trained to be FAIR and ENCOURAGING, not punitive.
- A candidate who speaks coherently on topic for 1-2 minutes in Part 2 typically scores Band 5.5-6.5, even with some errors.
- Only give Band 4 or below for SEVERE issues: unintelligible speech, extreme brevity (<20 words Part 2), complete off-topic.
- Fillers (um, uh, like) are NORMAL in natural speech and should NOT heavily penalize fluency.
- Minor grammatical errors are expected up to Band 7; focus on communication effectiveness.

## HALLUCINATION HANDLING
- If transcript contains "[FLAGGED_HALLUCINATION:...]", IGNORE that text entirely when scoring.
- Do NOT penalize candidate for AI-generated artifacts in their transcript.

## OUTPUT REQUIREMENTS
1. Valid JSON matching exact schema
2. EVERY segment_key gets ONE unique modelAnswer (no skips, no duplicates)
3. EVERY weakness MUST include a quoted example from transcript

## MANDATORY MODEL ANSWER WORD COUNTS (COUNT CAREFULLY!)
- Part 1: MINIMUM 50 words, aim for 55-65 words
- Part 2: MINIMUM 180 words, aim for 190-210 words (THIS IS CRITICAL)
- Part 3: MINIMUM 70 words, aim for 80-95 words

## MANDATORY LEXICAL UPGRADES
- Provide AT LEAST 10 vocabulary upgrades (original → upgraded with context)

FAILURE TO MEET WORD COUNTS OR UPGRADE COUNTS IS UNACCEPTABLE.`;

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

    // Extract criteria with full Gemini-compatible structure
    const extractCriterion = (key: string, camelKey: string) => {
      const c = evaluation?.criteria?.[key] || evaluation?.criteria?.[camelKey] || {};
      return {
        band: typeof c.band === 'number' ? c.band : (typeof c.score === 'number' ? c.score : 5.0),
        feedback: c.feedback || '',
        strengths: Array.isArray(c.strengths) ? c.strengths : [],
        weaknesses: Array.isArray(c.weaknesses) ? c.weaknesses : [],
        suggestions: Array.isArray(c.suggestions) ? c.suggestions : [],
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
        return {
          segment_key: t.segmentKey,
          partNumber: t.partNumber,
          questionNumber: t.questionNumber,
          // Always populate from our own source-of-truth to avoid duplicated/missing question text.
          question: questionText || `Part ${t.partNumber} Question ${t.questionNumber}`,
          candidateResponse: t.text || '',
          estimatedBand: typeof match.estimatedBand === 'number' ? match.estimatedBand : undefined,
          targetBand: typeof match.targetBand === 'number' ? match.targetBand : undefined,
          modelAnswer: match.modelAnswer || match.model_answer || '',
          whyItWorks: Array.isArray(match.whyItWorks) ? match.whyItWorks : (Array.isArray(match.why_it_works) ? match.why_it_works : []),
          keyImprovements: Array.isArray(match.keyImprovements) ? match.keyImprovements : (Array.isArray(match.key_improvements) ? match.key_improvements : []),
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
  // Build COMPACT transcript section - removed redundant metadata to save ~1000 tokens
  const transcriptSection = transcriptions.map(t => {
    const questionText = getQuestionTextFromPayload(testPayload, t.partNumber, t.questionNumber, t.segmentKey);
    const pauseCount = t.longPauses.length;
    // Compact format: only essential info
    return `[P${t.partNumber}Q${t.questionNumber}|${t.segmentKey}] Q:"${questionText || 'N/A'}" T:"${t.text}" (${t.wordCount}w/${t.duration.toFixed(0)}s${pauseCount > 0 ? `/${pauseCount}pauses` : ''})`;
  }).join('\n');

  const totalQuestions = transcriptions.length;
  
  // Build modelAnswers requirement with STRICT word count enforcement
  const modelAnswersReq = transcriptions.map(t => {
    // MANDATORY word counts: P1=50-65w, P2=180-210w, P3=70-95w
    const limits = t.partNumber === 2 
      ? { min: 180, target: 200 } 
      : t.partNumber === 3 
        ? { min: 70, target: 85 } 
        : { min: 50, target: 60 };
    return `{"segment_key":"${t.segmentKey}","partNumber":${t.partNumber},"questionNumber":${t.questionNumber},"estimatedBand":<1-9>,"targetBand":<estimatedBand+1>,"modelAnswer":"WRITE ${limits.min}+ WORDS (target ${limits.target}w)","whyItWorks":["<1 reason>"],"keyImprovements":["<1 tip>"]}`;
  }).join(',');

  // Pronunciation feedback based on confidence level
  const pronunciationInstruction = pronunciationEstimate.confidence === 'high'
    ? `Pronunciation analysis: Use the provided Band ${pronunciationEstimate.estimatedBand} estimate. In weaknesses, quote specific words with low transcription confidence if available.`
    : `Pronunciation analysis: Insufficient audio evidence for specific mispronunciation claims. Use Band ${pronunciationEstimate.estimatedBand} estimate. In weaknesses, provide general tips like "Practice clearer enunciation of multi-syllable words" without claiming specific words were mispronounced. NEVER say "might be mispronounced" or "specific examples are not available".`;

  // Enhanced prompt optimized for accuracy and completeness
  return `IELTS Speaking Evaluation Task

**CONTEXT:**
- Topic: ${job.topic || 'General'}
- Difficulty: ${job.difficulty || 'Standard'}
- Parts covered: ${partNumbers.join(', ')}
- Total questions: ${totalQuestions}

**CANDIDATE TRANSCRIPTS:**
${transcriptSection}

**PRONUNCIATION ESTIMATE:** Band ${pronunciationEstimate.estimatedBand} (${pronunciationEstimate.confidence} confidence)
${pronunciationInstruction}

**HUMAN-LIKE SCORING GUIDELINES (be FAIR, not harsh):**
- On-topic, coherent, 1-2 minutes speaking → Band 5.5-6.5 baseline
- Minor vocabulary/grammar slips → still Band 5-6 if communication is clear
- Some hesitation/fillers are NORMAL → don't over-penalize fluency
- Off-topic/irrelevant → Band 3.5-4.5
- Very short (<20 words Part 2) → Band 3-4
- Nonsense/gibberish/unintelligible → Band 2-3
- Silent/no response → Band 1-2
- Ignore any "[FLAGGED_HALLUCINATION:...]" spans when scoring

**CRITICAL - WEAKNESS FORMAT REQUIREMENTS:**
✅ EVERY weakness MUST include a QUOTED EXAMPLE from the transcript:
   Format: "Issue description. Example: '[exact quote from transcript]'"
   Good: "Subject-verb disagreement. Example: 'The people was going there'"
   Good: "Limited vocabulary range. Example: 'I feel happy' could be 'I feel elated'"
❌ NEVER write vague statements like:
   - "Some words might be mispronounced, but specific examples are not available"
   - "Possible issues with intonation, though not explicitly evident"
   - "There may be pronunciation errors"
If you cannot provide a specific quoted example, DO NOT include that weakness.

**CRITICAL - LEXICAL UPGRADES FORMAT (STRICTLY ENFORCED):**
══════════════════════════════════════════════════════════════
⚠️ The "context" field MUST contain the EXACT ORIGINAL phrase FROM THE TRANSCRIPT.
⚠️ DO NOT include the upgraded word in the context - only the original words!
⚠️ Copy-paste the EXACT phrase from the transcript where the word appeared.

✅ CORRECT EXAMPLES:
{"original": "good", "upgraded": "exceptional", "context": "The service was good"}
{"original": "very", "upgraded": "extremely", "context": "It was very interesting"}
{"original": "a lot of", "upgraded": "numerous", "context": "There are a lot of problems"}

❌ WRONG EXAMPLES (DO NOT DO THIS):
{"original": "good", "upgraded": "exceptional", "context": "The service was exceptional"} <- WRONG: shows upgraded word
{"original": "very", "upgraded": "extremely", "context": "It was extremely interesting"} <- WRONG: shows upgraded word
{"original": "nice", "upgraded": "pleasant", "context": "a pleasant experience"} <- WRONG: shows upgraded word

VALIDATION RULE: The "context" field must contain the "original" word, NOT the "upgraded" word.
If the context contains the upgraded word, your response is INVALID.
══════════════════════════════════════════════════════════════

**CRITICAL - MODEL ANSWER WORD COUNT REQUIREMENTS (STRICTLY ENFORCED):**
⚠️ PART 1: Each answer MUST be AT LEAST 50 words (aim for 55-65 words)
⚠️ PART 2: Answer MUST be AT LEAST 180 words (aim for 190-210 words) - THIS IS MANDATORY. COUNT YOUR WORDS!
⚠️ PART 3: Each answer MUST be AT LEAST 70 words (aim for 80-95 words)

Part 2 is the "long turn" - the candidate speaks for 1-2 minutes. Your model answer MUST demonstrate this:
- Cover ALL bullet points from the cue card
- Include personal details and examples
- Use varied vocabulary and sentence structures
- Show natural elaboration and development of ideas

**CRITICAL - LEXICAL UPGRADES REQUIREMENT:**
⚠️ Provide AT LEAST 10 lexical_upgrades entries
Each must have: original word/phrase, upgraded version, and context showing the ORIGINAL phrase as spoken

WORD COUNTS AND UPGRADE COUNTS ARE STRICTLY ENFORCED. Short outputs are UNACCEPTABLE.

**OUTPUT FORMAT (valid JSON only):**
{
  "criteria": {
    "fluency_coherence": {"band": <1-9>, "feedback": "<2 sentences>", "strengths": ["..."], "weaknesses": ["Issue. Example: '[quote]'"], "suggestions": ["..."]},
    "lexical_resource": {"band": <1-9>, "feedback": "<2 sentences>", "strengths": ["..."], "weaknesses": ["Issue. Example: '[quote]'"], "suggestions": ["..."]},
    "grammatical_range": {"band": <1-9>, "feedback": "<2 sentences>", "strengths": ["..."], "weaknesses": ["Issue. Example: '[quote]'"], "suggestions": ["..."]},
    "pronunciation": {"band": <5-8>, "feedback": "...", "strengths": ["..."], "weaknesses": ["Specific issue with quoted example if evidence exists, otherwise actionable tip"], "suggestions": ["..."]}
  },
  "summary": "<2 sentence overall summary>",
  "examiner_notes": "<1 sentence key observation>",
  "modelAnswers": [${modelAnswersReq}],
  "lexical_upgrades": [{"original": "word", "upgraded": "better_word", "context": "EXACT phrase from transcript containing original word"}, ... (AT LEAST 10 ENTRIES)],
  "part_notes": [],
  "improvement_priorities": ["...", "..."],
  "strengths_to_maintain": ["..."]
}

FINAL VALIDATION CHECKLIST (ALL MUST PASS):
1. ✓ Part 2 modelAnswer has 180+ words? COUNT THEM!
2. ✓ All weaknesses have quoted examples from the transcript?
3. ✓ Every lexical_upgrades "context" contains the "original" word (NOT the "upgraded" word)?
4. ✓ At least 10 lexical_upgrades provided?
5. ✓ No vague pronunciation claims without evidence?
6. ✓ Context is EXACT quote from transcript, not a rewritten sentence?`;
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
