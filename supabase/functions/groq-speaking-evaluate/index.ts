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

    // Call Groq Llama 3.3 70B
    console.log(`[groq-speaking-evaluate] Calling Llama 3.3 70B...`);
    const startTime = Date.now();

    const llmResponse = await fetch(GROQ_LLM_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${groqApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          {
            role: 'system',
            content: `You are a CERTIFIED SENIOR IELTS Speaking Examiner with 10+ years of experience.

CRITICAL RULES:
1. Provide accurate, fair assessments following official IELTS band descriptors
2. ALWAYS respond with valid JSON matching the EXACT schema requested
3. Provide COMPLETE responses for ALL questions - never skip or duplicate
4. Each question gets its OWN unique model answer with the CORRECT transcript
5. Model answers MUST meet word count requirements (Part 1: 35 words, Part 2: 150 words, Part 3: 70 words)
6. Apply STRICT scoring: short/off-topic responses get Band 2-4, NOT Band 5+
7. EVERY weakness must include a direct quote example from the transcript

DO NOT duplicate answers. Each segment_key corresponds to ONE unique response.`
          },
          {
            role: 'user',
            content: evaluationPrompt
          }
        ],
        temperature: 0.2, // Lower temperature for more consistent output
        max_tokens: 24000, // Increased for detailed model answers
        response_format: { type: 'json_object' },
      }),
    });

    if (!llmResponse.ok) {
      const errorText = await llmResponse.text();
      console.error(`[groq-speaking-evaluate] LLM API error: ${llmResponse.status} - ${errorText}`);
      
      if (llmResponse.status === 429) {
        await supabaseService.rpc('mark_groq_key_exhausted', {
          p_key_id: groqKeyId,
          p_model: 'llama-3.3-70b-versatile',
        });
        throw new Error('RATE_LIMIT: Groq LLM quota exhausted');
      }
      
      throw new Error(`LLM API error: ${llmResponse.status}`);
    }

    const llmResult = await llmResponse.json();
    const processingTime = Date.now() - startTime;

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

    // Compute overall band using IELTS rounding rules (same as frontend)
    const criteriaScores = [
      criteria.fluency_coherence.band,
      criteria.lexical_resource.band,
      criteria.grammatical_range.band,
      criteria.pronunciation.band,
    ];
    const avgScore = criteriaScores.reduce((a, b) => a + b, 0) / 4;
    const overallBand = roundIELTSBand(avgScore);

    console.log(`[groq-speaking-evaluate] Criteria: FC=${criteria.fluency_coherence.band}, LR=${criteria.lexical_resource.band}, GRA=${criteria.grammatical_range.band}, P=${criteria.pronunciation.band} => Overall=${overallBand}`);

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
          question: match.question || match.question_text || questionText || '',
          candidateResponse: match.candidateResponse || match.candidate_response || t.text || '',
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
        question: questionText || `Part ${t.partNumber}, Question ${t.questionNumber}`,
        candidateResponse: t.text,
        modelAnswer: '',
        whyItWorks: [],
        keyImprovements: [],
      };
    });

    // Extract lexical_upgrades - ensure minimum of 5
    const rawLexicalUpgrades = Array.isArray(evaluation?.lexical_upgrades) ? evaluation.lexical_upgrades : [];
    const lexicalUpgrades = rawLexicalUpgrades.map((u: any) => ({
      original: u.original || '',
      upgraded: u.upgraded || '',
      context: u.context || '',
    }));
    
    if (lexicalUpgrades.length < 5) {
      console.warn(`[groq-speaking-evaluate] Only ${lexicalUpgrades.length} lexical upgrades provided (expected 5+)`);
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

    // Extract part_analysis - ensure we have analysis for ALL parts present in the test
    const rawPartAnalysis = Array.isArray(evaluation?.part_analysis) ? evaluation.part_analysis : [];
    const partAnalysis = partNumbers.map(partNum => {
      const match = rawPartAnalysis.find((p: any) => 
        p.part_number === partNum || p.partNumber === partNum
      );
      
      if (match) {
        return {
          part_number: partNum,
          performance_notes: match.performance_notes || match.performanceNotes || match.comment || '',
          key_moments: Array.isArray(match.key_moments) ? match.key_moments : (Array.isArray(match.keyMoments) ? match.keyMoments : []),
          areas_for_improvement: Array.isArray(match.areas_for_improvement) ? match.areas_for_improvement : (Array.isArray(match.areasForImprovement) ? match.areasForImprovement : []),
        };
      }
      
      // If no match found, create a placeholder
      console.warn(`[groq-speaking-evaluate] No part analysis found for Part ${partNum}`);
      return {
        part_number: partNum,
        performance_notes: `Analysis for Part ${partNum}`,
        key_moments: [],
        areas_for_improvement: [],
      };
    });

    // Build final result matching Gemini schema exactly
    const finalResult = {
      overall_band: overallBand,
      criteria,
      summary: evaluation?.summary || evaluation?.examiner_notes || 'Evaluation complete.',
      examiner_notes: evaluation?.examiner_notes || evaluation?.summary || '',
      modelAnswers,
      lexical_upgrades: lexicalUpgrades,
      vocabulary_upgrades: vocabularyUpgrades,
      part_analysis: partAnalysis,
      improvement_priorities: Array.isArray(evaluation?.improvement_priorities) ? evaluation.improvement_priorities : [],
      strengths_to_maintain: Array.isArray(evaluation?.strengths_to_maintain) ? evaluation.strengths_to_maintain : [],
      transcripts_by_part: transcriptsByPart,
      transcripts_by_question: transcriptsByQuestion,
      evaluationMetadata: {
        provider: 'groq',
        sttModel: 'whisper-large-v3-turbo',
        llmModel: 'llama-3.3-70b-versatile',
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
  if (!transcriptions.length) {
    return { estimatedBand: 5.0, confidence: 'low', evidence: ['No transcription data'] };
  }

  const totalWords = transcriptions.reduce((sum, t) => sum + t.wordCount, 0);
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
  const cappedBand = Math.min(7.0, rawBand);
  const estimatedBand = Math.round(cappedBand * 2) / 2;

  let confidence: 'low' | 'medium' | 'high' = 'medium';
  if (totalWords < 50) {
    confidence = 'low';
  } else if (totalWords > 200 && confidenceScore > 0.8) {
    confidence = 'high';
  }

  const evidence = [
    `Word recognition confidence: ${(weightedConfidence * 100).toFixed(1)}%`,
    `Audio clarity score: ${(normalizedClarity * 100).toFixed(1)}%`,
    `Filler word ratio: ${(fillerRatio * 100).toFixed(1)}%`,
    `Long pauses (>2s): ${totalLongPauses}`,
    `Total words analyzed: ${totalWords}`,
    `Composite score: ${(compositeScore * 100).toFixed(1)}%`,
  ];

  return { estimatedBand, confidence, evidence };
}

// ============================================================================
// Prompt Builder (Gemini-compatible output schema)
// ============================================================================

function buildEvaluationPrompt(
  transcriptions: TranscriptionSegment[],
  pronunciationEstimate: PronunciationEstimate,
  testPayload: any,
  job: any,
  partNumbers: number[]
): string {
  // Build transcript section with metadata
  const transcriptSection = transcriptions.map(t => {
    const questionText = getQuestionTextFromPayload(testPayload, t.partNumber, t.questionNumber, t.segmentKey);
    
    // Include pause analysis if there are long pauses
    const pauseInfo = t.longPauses.length > 0 
      ? `**Long pauses (>2s):** ${t.longPauses.map(p => `${p.duration.toFixed(1)}s at ${p.start.toFixed(1)}s`).join(', ')}`
      : '**Long pauses:** none';
    
    return `
## Part ${t.partNumber}, Question ${t.questionNumber}
**Segment Key:** ${t.segmentKey}
**Question:** ${questionText || 'N/A'}
**Transcript:** "${t.text}"
**Duration:** ${t.duration.toFixed(1)}s | **Words:** ${t.wordCount}
**Filler words detected:** ${t.fillerWords.length > 0 ? t.fillerWords.join(', ') : 'none'}
**Recognition confidence:** ${(t.avgConfidence * 100).toFixed(1)}%
${pauseInfo}
`;
  }).join('\n');

  // Count total questions and build segment info for modelAnswers requirement
  const totalQuestions = transcriptions.length;
  const segmentInfo = transcriptions.map(t => {
    const questionText = getQuestionTextFromPayload(testPayload, t.partNumber, t.questionNumber, t.segmentKey);
    return {
      segment_key: t.segmentKey,
      partNumber: t.partNumber,
      questionNumber: t.questionNumber,
      question: questionText || `Part ${t.partNumber} Question ${t.questionNumber}`,
      transcript: t.text,
    };
  });

  // STRICT word limits for model answers (matching Gemini)
  const modelAnswerWordLimits: Record<number, { min: number; max: number; target: number }> = {
    1: { min: 30, max: 40, target: 35 },  // Part 1: ~35 words per answer
    2: { min: 140, max: 160, target: 150 }, // Part 2: ~150 words total
    3: { min: 60, max: 80, target: 70 },  // Part 3: ~70 words per answer
  };

  // Build part_analysis requirement
  const partAnalysisRequirement = partNumbers.map(p => `{
      "part_number": ${p},
      "performance_notes": "<2-3 sentence assessment of Part ${p} with specific examples>",
      "key_moments": ["<positive moment with direct quote>", "<another positive with quote>"],
      "areas_for_improvement": ["<issue with direct quote>", "<another issue with quote>", "<third issue with quote>"]
    }`).join(',\n    ');

  // Build modelAnswers requirement showing ALL questions with strict word counts
  const modelAnswersRequirement = segmentInfo.map((s, i) => {
    const limits = modelAnswerWordLimits[s.partNumber] || { target: 50 };
    const wordTarget = limits.target;
    return `{
      "segment_key": "${s.segment_key}",
      "partNumber": ${s.partNumber},
      "questionNumber": ${s.questionNumber},
      "question": "${s.question.replace(/"/g, '\\"')}",
      "candidateResponse": "${s.transcript.slice(0, 80).replace(/"/g, '\\"')}...",
      "estimatedBand": <band for this specific response 1.0-9.0>,
      "targetBand": <estimatedBand + 1, max 9>,
      "modelAnswer": "<COMPLETE ${wordTarget}-word model answer - MUST be exactly ${limits.min}-${limits.max} words>",
      "whyItWorks": ["<specific reason why model answer is better>", "<second reason>"],
      "keyImprovements": ["<specific improvement from their answer>", "<second improvement>"]
    }`;
  }).join(',\n    ');

  return `You are a CERTIFIED SENIOR IELTS Speaking Examiner with 10+ years of experience.
Return ONLY valid JSON matching the exact schema below.

══════════════════════════════════════════════════════════════
CONTEXT
══════════════════════════════════════════════════════════════
Topic: ${job.topic || 'General IELTS Speaking'}
Difficulty: ${job.difficulty || 'Standard'}
Parts covered: ${partNumbers.join(', ')}
Total questions: ${totalQuestions}

══════════════════════════════════════════════════════════════
🚨 CRITICAL: SCORING FOR INADEQUATE RESPONSES 🚨
══════════════════════════════════════════════════════════════

Apply STRICT penalties for responses that are:
- OFF-TOPIC or IRRELEVANT to the question
- Extremely SHORT (under 10 meaningful words)
- REPETITIVE NONSENSE (e.g., "nice nice nice nice")
- Single word answers (e.g., "drama", "yes", "no")
- Just reading the question back

⚠️ SCORING REQUIREMENTS FOR INADEQUATE RESPONSES:
- Transcript < 10 meaningful words → Band 2.0-3.0 MAX
- Off-topic/irrelevant → Band 2.5-3.5 MAX
- Just repetition of same word → Band 1.5-2.5 MAX
- Single word or "[NO SPEECH]" → Band 1.0-2.0 MAX

DO NOT give Band 5+ for responses like:
❌ "nice nice nice that's true" → Band 2.0
❌ "drama" → Band 1.5
❌ "yes I think so" (no elaboration) → Band 3.0-3.5

══════════════════════════════════════════════════════════════
🚨 MANDATORY: EXAMPLES FOR ALL WEAKNESSES 🚨
══════════════════════════════════════════════════════════════

For EVERY weakness, include a SPECIFIC EXAMPLE from the candidate's actual response.

FORMAT: "Issue description (e.g., 'exact word or phrase from their answer')"

❌ BAD: "Some grammar errors"
✅ GOOD: "Subject-verb agreement errors (e.g., 'the people goes' instead of 'the people go')"

❌ BAD: "Limited vocabulary"
✅ GOOD: "Repetitive use of basic words (e.g., used 'good' 4 times instead of 'beneficial', 'excellent')"

══════════════════════════════════════════════════════════════
🚨 STRICT MODEL ANSWER WORD LIMITS 🚨
══════════════════════════════════════════════════════════════

Part 1: EXACTLY 30-40 words per answer (target: 35)
Part 2: EXACTLY 140-160 words (target: 150)
Part 3: EXACTLY 60-80 words per answer (target: 70)

⚠️ Model answers outside these ranges are INVALID.
Count words carefully!

══════════════════════════════════════════════════════════════
TRANSCRIPTION DATA (from Whisper STT)
══════════════════════════════════════════════════════════════
${transcriptSection}

══════════════════════════════════════════════════════════════
PRONUNCIATION ESTIMATION (from transcription confidence)
══════════════════════════════════════════════════════════════
**Estimated Band:** ${pronunciationEstimate.estimatedBand}
**Confidence:** ${pronunciationEstimate.confidence}
${pronunciationEstimate.evidence.map(e => `- ${e}`).join('\n')}

Note: Pronunciation is estimated from audio clarity and word recognition confidence.
Adjust this band ±0.5 based on fluency markers in the transcript.

══════════════════════════════════════════════════════════════
OUTPUT JSON SCHEMA (FOLLOW EXACTLY)
══════════════════════════════════════════════════════════════

{
  "criteria": {
    "fluency_coherence": {
      "band": <number 1.0-9.0 in 0.5 increments>,
      "feedback": "<2-3 sentences addressing pauses, hesitations, flow, and coherence>",
      "strengths": ["<strength with quote example>", "<second strength>"],
      "weaknesses": ["<weakness (e.g., 'quote from transcript')>", "<second weakness (e.g., 'quote')>"],
      "suggestions": ["<actionable tip>", "<second tip>"]
    },
    "lexical_resource": {
      "band": <number>,
      "feedback": "<2-3 sentences on vocabulary range, precision, idioms>",
      "strengths": ["<strength with example>"],
      "weaknesses": ["<weakness (e.g., 'quote')>"],
      "suggestions": ["<tip>"]
    },
    "grammatical_range": {
      "band": <number>,
      "feedback": "<2-3 sentences on grammar variety and accuracy>",
      "strengths": ["<strength>"],
      "weaknesses": ["<weakness (e.g., 'quote')>"],
      "suggestions": ["<tip>"]
    },
    "pronunciation": {
      "band": ${pronunciationEstimate.estimatedBand},
      "feedback": "<2 sentences noting this is estimated from audio clarity>",
      "strengths": ["<strength>"],
      "weaknesses": ["<weakness>"],
      "suggestions": ["<tip>"]
    }
  },
  "summary": "<3-4 sentence overall assessment covering all criteria>",
  "examiner_notes": "<1-2 sentences on the most critical improvement area>",
  "modelAnswers": [
    ${modelAnswersRequirement}
  ],
  "lexical_upgrades": [
    {"original": "<actual word from transcript>", "upgraded": "<sophisticated alternative>", "context": "<how to use in sentence>"},
    {"original": "...", "upgraded": "...", "context": "..."},
    {"original": "...", "upgraded": "...", "context": "..."},
    {"original": "...", "upgraded": "...", "context": "..."},
    {"original": "...", "upgraded": "...", "context": "..."},
    {"original": "...", "upgraded": "...", "context": "..."}
  ],
  "vocabulary_upgrades": [
    {"original": "<basic word from transcript>", "upgraded": "<advanced word>", "context": "<example sentence>"},
    {"original": "...", "upgraded": "...", "context": "..."},
    {"original": "...", "upgraded": "...", "context": "..."},
    {"original": "...", "upgraded": "...", "context": "..."},
    {"original": "...", "upgraded": "...", "context": "..."},
    {"original": "...", "upgraded": "...", "context": "..."}
  ],
  "part_analysis": [
    ${partAnalysisRequirement}
  ],
  "improvement_priorities": ["<most important priority>", "<second priority>", "<third priority>"],
  "strengths_to_maintain": ["<key strength to keep>", "<second strength>"]
}

══════════════════════════════════════════════════════════════
🚨 MANDATORY VALIDATION CHECKLIST 🚨
══════════════════════════════════════════════════════════════

Before outputting, verify:
- [ ] modelAnswers has EXACTLY ${totalQuestions} entries (one per question)
- [ ] Each modelAnswer has the FULL question text from the segment
- [ ] Each modelAnswer has the CORRECT transcript for that question (NOT duplicated)
- [ ] Model answer word counts: Part 1=35±5, Part 2=150±10, Part 3=70±10
- [ ] part_analysis has EXACTLY ${partNumbers.length} entries for parts: ${partNumbers.join(', ')}
- [ ] lexical_upgrades has AT LEAST 6 entries with real examples
- [ ] vocabulary_upgrades has AT LEAST 6 entries
- [ ] ALL weaknesses have (e.g., 'quote') examples
- [ ] Bands are realistic: inadequate responses get Band 2-4, not 5+

🚨 CRITICAL: Each modelAnswer MUST correspond to its specific question with the correct transcript. Do NOT copy the same transcript to all answers.

Be fair, rigorous, and follow official IELTS band descriptors exactly.
`;
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
        const qId = qUuidMatch[1];
        const matchedQ = questions.find((q: any) => q.id === qId);
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
