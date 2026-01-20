import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * Groq Speaking Evaluate
 * 
 * Step 2 of Groq evaluation pipeline:
 * - Takes transcription results from groq-speaking-transcribe
 * - Estimates pronunciation from transcription confidence scores
 * - Calls Groq Llama 3.3 70B for final IELTS evaluation
 * - Stores results in same format as Gemini for compatibility
 * 
 * Pronunciation Estimation Algorithm:
 * - Uses word probability (confidence) as clarity proxy
 * - Uses avg_logprob as pronunciation quality indicator
 * - Uses no_speech_prob for silence/mumbling detection
 * - Conservative scoring (caps at 7.0 for estimation)
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Groq LLM API endpoint
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

    // Get Groq API key for LLM
    const { data: keyData, error: keyError } = await supabaseService.rpc('checkout_groq_key_for_llm', {
      p_job_id: jobId,
      p_part_number: 1,
      p_lock_duration_seconds: 300,
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

    // Fetch test details for question context
    const { data: testData } = await supabaseService
      .from('speaking_tests')
      .select('*, speaking_questions(*)')
      .eq('id', job.test_id)
      .single();

    // Build evaluation prompt
    const evaluationPrompt = buildEvaluationPrompt(
      transcriptionResult.transcriptions,
      pronunciationEstimate,
      testData,
      job
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
            content: 'You are a certified IELTS Speaking Examiner with 10+ years of experience. Provide accurate, fair assessments following official IELTS band descriptors. Always respond with valid JSON.'
          },
          {
            role: 'user',
            content: evaluationPrompt
          }
        ],
        temperature: 0.3,
        max_tokens: 16000,
        response_format: { type: 'json_object' },
      }),
    });

    if (!llmResponse.ok) {
      const errorText = await llmResponse.text();
      console.error(`[groq-speaking-evaluate] LLM API error: ${llmResponse.status} - ${errorText}`);
      
      // Check for rate limit
      if (llmResponse.status === 429) {
        await supabaseService.rpc('mark_groq_key_exhausted', {
          p_key_id: groqKeyId,
          p_model: 'llama_70b',
        });
        throw new Error('RATE_LIMIT: Groq LLM quota exhausted');
      }
      
      throw new Error(`LLM API error: ${llmResponse.status}`);
    }

    const llmResult = await llmResponse.json();
    const processingTime = Date.now() - startTime;

    console.log(`[groq-speaking-evaluate] LLM response received in ${processingTime}ms`);

    // Parse evaluation result
    let evaluation;
    try {
      const content = llmResult.choices?.[0]?.message?.content;
      evaluation = JSON.parse(content);
    } catch (parseError) {
      console.error(`[groq-speaking-evaluate] Failed to parse LLM response:`, parseError);
      throw new Error('Failed to parse evaluation response');
    }

    // Add metadata
    evaluation.evaluationMetadata = {
      provider: 'groq',
      sttModel: 'whisper-large-v3-turbo',
      llmModel: 'llama-3.3-70b-versatile',
      pronunciationEstimation: pronunciationEstimate,
      processingTimeMs: processingTime,
      transcriptionSegments: transcriptionResult.transcriptions.length,
      totalAudioSeconds: transcriptionResult.totalAudioSeconds,
    };

    // Store result (same format as Gemini for compatibility)
    // Build audio URLs for result storage
    const publicBase = (Deno.env.get('R2_PUBLIC_URL') || '').replace(/\/$/, '');
    const filePaths = job.file_paths as Record<string, string> || {};
    const audioUrls: Record<string, string> = {};
    if (publicBase) {
      for (const [k, r2Key] of Object.entries(filePaths)) {
        audioUrls[k] = `${publicBase}/${String(r2Key).replace(/^\//, '')}`;
      }
    }

    // Build transcripts by part from transcription result
    const transcriptsByPart: Record<string, string> = {};
    const transcriptsByQuestion: Record<string, string> = {};
    for (const t of transcriptionResult.transcriptions) {
      const partKey = `part${t.partNumber}`;
      if (!transcriptsByPart[partKey]) {
        transcriptsByPart[partKey] = t.text;
      } else {
        transcriptsByPart[partKey] += ' ' + t.text;
      }
      transcriptsByQuestion[t.segmentKey] = t.text;
    }

    // Format result to match Gemini output structure for UI compatibility
    const finalResult = {
      overall_band: evaluation.overallBand,
      fluency_coherence: { 
        score: evaluation.criteriaScores?.fluencyCoherence || 5.0,
        feedback: evaluation.detailedFeedback?.fluencyCoherence || '',
      },
      lexical_resource: { 
        score: evaluation.criteriaScores?.lexicalResource || 5.0,
        feedback: evaluation.detailedFeedback?.lexicalResource || '',
      },
      grammatical_range: { 
        score: evaluation.criteriaScores?.grammaticalRange || 5.0,
        feedback: evaluation.detailedFeedback?.grammaticalRange || '',
      },
      pronunciation: { 
        score: evaluation.criteriaScores?.pronunciation || 5.0,
        feedback: evaluation.detailedFeedback?.pronunciation || '',
      },
      strengths: evaluation.feedback?.strengths || [],
      areas_for_improvement: evaluation.feedback?.areasForImprovement || [],
      tips: evaluation.feedback?.tips || [],
      transcripts_by_part: transcriptsByPart,
      transcripts_by_question: transcriptsByQuestion,
      part_analysis: evaluation.partAnalysis || {},
      evaluationMetadata: evaluation.evaluationMetadata,
    };

    // Calculate time spent from durations
    const durations = job.durations as Record<string, number> || {};
    const timeSpentSeconds = Object.values(durations).reduce((a: number, b: number) => a + b, 0) || 60;

    // Calculate evaluation timing
    const jobStartTime = new Date(job.created_at).getTime();
    const totalTimeMs = Date.now() - jobStartTime;
    const evaluationTiming = {
      totalTimeMs,
      processingTimeMs: processingTime,
      provider: 'groq',
    };

    // Save result to ai_practice_results (same as Gemini)
    const { data: resultRow, error: saveError } = await supabaseService
      .from('ai_practice_results')
      .insert({
        test_id: job.test_id,
        user_id: job.user_id,
        module: 'speaking',
        score: Math.round(evaluation.overallBand * 10),
        band_score: evaluation.overallBand,
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

    // Mark job completed with result_id reference
    await supabaseService
      .from('speaking_evaluation_jobs')
      .update({
        status: 'completed',
        stage: 'completed',
        partial_results: evaluation,
        result_id: resultRow?.id || null,
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        last_error: null,
      })
      .eq('id', jobId);

    console.log(`[groq-speaking-evaluate] Evaluation complete. Overall band: ${evaluation.overallBand}`);

    return new Response(JSON.stringify({
      success: true,
      overallBand: evaluation.overallBand,
      processingTimeMs: processingTime,
      resultId: resultRow?.id,
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
    console.error('[groq-speaking-evaluate] Error:', error);

    // Note: We can't re-parse req.json() here as body is already consumed.
    // The job runner watchdog will handle updating the job status.

    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

// ============================================================================
// Pronunciation Estimation
// ============================================================================

function estimatePronunciation(transcriptions: TranscriptionSegment[]): PronunciationEstimate {
  if (!transcriptions.length) {
    return { estimatedBand: 5.0, confidence: 'low', evidence: ['No transcription data'] };
  }

  // Aggregate metrics across all segments
  const totalWords = transcriptions.reduce((sum, t) => sum + t.wordCount, 0);
  const weightedConfidence = transcriptions.reduce((sum, t) => sum + (t.avgConfidence * t.wordCount), 0) / totalWords;
  const avgLogprob = transcriptions.reduce((sum, t) => sum + t.avgLogprob, 0) / transcriptions.length;
  
  // Count issues
  const totalFillerWords = transcriptions.reduce((sum, t) => sum + t.fillerWords.length, 0);
  const totalLongPauses = transcriptions.reduce((sum, t) => sum + t.longPauses.length, 0);
  const fillerRatio = totalFillerWords / Math.max(1, totalWords);

  // Normalize logprob (typically -1 to 0, closer to 0 is better)
  // Map to 0-1 scale where 1 is best
  const normalizedClarity = Math.max(0, Math.min(1, (avgLogprob + 1)));

  // Calculate score components (0-1 scale)
  const confidenceScore = weightedConfidence; // Already 0-1
  const clarityScore = normalizedClarity;
  const fluencyPenalty = Math.min(0.3, fillerRatio * 0.5 + (totalLongPauses * 0.02));
  const pausePenalty = Math.min(0.2, totalLongPauses * 0.03);

  // Weighted composite score
  const compositeScore = (
    confidenceScore * 0.35 +      // Word recognition confidence
    clarityScore * 0.30 +          // Overall audio clarity
    (1 - fluencyPenalty) * 0.20 +  // Fluency (fewer fillers = better)
    (1 - pausePenalty) * 0.15      // Pause management
  );

  // Map to IELTS band (conservative: max 7.0 for estimation)
  // Score 0.9+ = 7.0, 0.8 = 6.5, 0.7 = 6.0, etc.
  const rawBand = compositeScore * 6 + 3; // Maps 0-1 to 3-9
  const cappedBand = Math.min(7.0, rawBand); // Cap at 7.0 for estimation
  const estimatedBand = Math.round(cappedBand * 2) / 2; // Round to nearest 0.5

  // Determine confidence level
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
// Prompt Builder
// ============================================================================

function buildEvaluationPrompt(
  transcriptions: TranscriptionSegment[],
  pronunciationEstimate: PronunciationEstimate,
  testData: any,
  job: any
): string {
  // Build transcript section with metadata
  const transcriptSection = transcriptions.map(t => {
    const questionText = getQuestionText(testData, t.partNumber, t.questionNumber);
    return `
## Part ${t.partNumber}, Question ${t.questionNumber}
**Question:** ${questionText || 'N/A'}
**Transcript:** "${t.text}"
**Duration:** ${t.duration.toFixed(1)}s | **Words:** ${t.wordCount}
**Filler words detected:** ${t.fillerWords.length > 0 ? t.fillerWords.join(', ') : 'none'}
**Recognition confidence:** ${(t.avgConfidence * 100).toFixed(1)}%
**Long pauses (>2s):** ${t.longPauses.length}
`;
  }).join('\n');

  return `
# IELTS Speaking Test Evaluation

## Instructions
You are evaluating an IELTS Speaking test. The transcripts below were generated from audio recordings using Whisper STT.
Pronunciation scores are **estimated** from transcription confidence (not direct audio analysis).

## Topic
${job.topic || 'General IELTS Speaking'}

## Difficulty
${job.difficulty || 'Standard'}

## Transcription Data
${transcriptSection}

## Pronunciation Estimation (from transcription confidence)
**Estimated Band:** ${pronunciationEstimate.estimatedBand}
**Confidence:** ${pronunciationEstimate.confidence}
${pronunciationEstimate.evidence.map(e => `- ${e}`).join('\n')}

**Note:** Pronunciation is estimated from word recognition confidence and audio clarity metrics, not direct prosody analysis. Use this as a guide and adjust based on overall transcript quality.

## Evaluation Task

Evaluate the candidate on all four IELTS Speaking criteria:

1. **Fluency and Coherence (FC)** - Flow, pace, hesitation, coherence, discourse markers
2. **Lexical Resource (LR)** - Vocabulary range, accuracy, appropriateness, paraphrasing
3. **Grammatical Range and Accuracy (GRA)** - Sentence structures, grammatical accuracy, complexity
4. **Pronunciation (P)** - Use the estimated band as a baseline, adjust based on transcript patterns

## Response Format

Return a JSON object with this exact structure:
{
  "overallBand": <number 1-9 in 0.5 increments>,
  "criteriaScores": {
    "fluencyCoherence": <number>,
    "lexicalResource": <number>,
    "grammaticalRange": <number>,
    "pronunciation": <number>
  },
  "feedback": {
    "strengths": ["<strength 1>", "<strength 2>", ...],
    "areasForImprovement": ["<area 1>", "<area 2>", ...],
    "tips": ["<tip 1>", "<tip 2>", ...]
  },
  "detailedFeedback": {
    "fluencyCoherence": "<2-3 sentence feedback>",
    "lexicalResource": "<2-3 sentence feedback>",
    "grammaticalRange": "<2-3 sentence feedback>",
    "pronunciation": "<2-3 sentence feedback>"
  },
  "partAnalysis": {
    "part1": { "score": <number>, "comment": "<brief comment>" },
    "part2": { "score": <number>, "comment": "<brief comment>" },
    "part3": { "score": <number>, "comment": "<brief comment>" }
  }
}

Be fair, consistent, and follow official IELTS band descriptors.
`;
}

function getQuestionText(testData: any, partNumber: number, questionNumber: number): string {
  if (!testData?.speaking_questions) return '';
  
  const question = testData.speaking_questions.find(
    (q: any) => q.part_number === partNumber && q.question_order === questionNumber
  );
  
  return question?.question_text || '';
}
