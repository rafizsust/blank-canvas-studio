import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { GoogleGenerativeAI } from "https://esm.sh/@google/generative-ai@0.21.0";
import { 
  getActiveGeminiKeysForModel, 
  markKeyQuotaExhausted,
  isQuotaExhaustedError
} from "../_shared/apiKeyQuotaUtils.ts";
import {
  decryptKey,
  uploadToGoogleFileAPI,
  parseJson,
  extractRetryAfterSeconds,
  sleep,
  calculateBandFromCriteria,
  computeWeightedPartBand,
  validateEvaluationResult,
  normalizeGeminiResponse,
  corsHeaders,
  QuotaError,
} from "../_shared/speakingUtils.ts";

/**
 * Resubmit Speaking Test with Parallel Mode
 * 
 * This edge function:
 * 1. Fetches existing audio from R2 (already uploaded in previous submission)
 * 2. Calls evaluate-speaking-parallel logic directly (single call, no R2 upload needed)
 * 3. Returns timing information for performance comparison
 */

const GEMINI_MODELS = ['gemini-2.5-flash'];

function isPermanentQuotaExhausted(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message || err || '').toLowerCase();
  if (msg.includes('check your plan') || msg.includes('billing')) return true;
  if (msg.includes('limit: 0')) return true;
  if (msg.includes('per day') && !msg.includes('retry')) return true;
  return false;
}

function computeOverallBandFromQuestionBands(result: unknown): number | null {
  const resultObj = result as { modelAnswers?: Array<{ partNumber?: number; estimatedBand?: number }> };
  const modelAnswers = Array.isArray(resultObj?.modelAnswers) ? resultObj.modelAnswers : [];
  const bands = modelAnswers
    .map((a) => ({
      part: Number(a?.partNumber),
      band: typeof a?.estimatedBand === 'number' ? a.estimatedBand : Number(a?.estimatedBand),
    }))
    .filter((x) => (x.part === 1 || x.part === 2 || x.part === 3) && Number.isFinite(x.band));

  if (!bands.length) return null;

  const weightForPart = (p: number) => (p === 2 ? 2.0 : p === 3 ? 1.5 : 1.0);
  const weighted = bands.reduce(
    (acc, x) => {
      const w = weightForPart(x.part);
      return { sum: acc.sum + x.band * w, w: acc.w + w };
    },
    { sum: 0, w: 0 },
  );

  if (weighted.w <= 0) return null;

  const avg = weighted.sum / weighted.w;
  const rounded = Math.round(avg * 2) / 2;
  return Math.min(9, Math.max(1, rounded));
}

function buildPrompt(
  payload: unknown,
  topic: string | undefined,
  difficulty: string | undefined,
  fluencyFlag: boolean | undefined,
  orderedSegments: Array<{ segmentKey: string; partNumber: 1 | 2 | 3; questionNumber: number; questionText: string }>,
): string {
  const payloadObj = payload as { speakingParts?: Array<{ part_number: number; questions?: Array<{ id: string; question_number: number; question_text: string }> }> };
  const parts = Array.isArray(payloadObj?.speakingParts) ? payloadObj.speakingParts : [];
  const questions = parts
    .flatMap((p) =>
      (Array.isArray(p?.questions)
        ? p.questions.map((q) => ({
            id: String(q?.id || ''),
            part_number: Number(p?.part_number),
            question_number: Number(q?.question_number),
            question_text: String(q?.question_text || ''),
          }))
        : []),
    )
    .filter((q) => q.part_number === 1 || q.part_number === 2 || q.part_number === 3);

  const questionJson = JSON.stringify(questions);
  const segmentJson = JSON.stringify(orderedSegments);
  
  const includedParts = [...new Set(orderedSegments.map(s => s.partNumber))].sort();
  const partsDescription = includedParts.length === 1 
    ? `Part ${includedParts[0]} only` 
    : `Parts ${includedParts.join(', ')}`;

  const numQ = orderedSegments.length;
  
  const audioMappingLines = orderedSegments.map((seg, idx) => 
    `AUDIO_${idx}: "${seg.segmentKey}" → Part ${seg.partNumber}, Q${seg.questionNumber}: "${seg.questionText}"`
  ).join('\n');

  return `You are a CERTIFIED SENIOR IELTS Speaking Examiner with 20+ years experience.
Evaluate exactly as an official IELTS examiner. Return ONLY valid JSON.

CONTEXT: Topic: ${topic || 'General'}, Difficulty: ${difficulty || 'Medium'}, Parts: ${partsDescription}, Questions: ${numQ}
${fluencyFlag ? '⚠️ Part 2 speaking time under 80 seconds - apply fluency penalty.' : ''}

══════════════════════════════════════════════════════════════
🚨 CRITICAL TRANSCRIPTION RULES 🚨
══════════════════════════════════════════════════════════════

**ZERO HALLUCINATION POLICY**: Transcribe ONLY what the candidate ACTUALLY SAID.

🚫 FORBIDDEN:
- DO NOT invent, fabricate, or guess content
- DO NOT create plausible answers based on context
- DO NOT paraphrase or improve what was said

✅ REQUIRED:
- Transcribe EXACT words spoken, word-for-word
- Include ALL filler words: "uh", "um", "like", "you know"
- Include false starts, repetitions, self-corrections
- Write "[INAUDIBLE]" for unclear portions
- Write "[NO SPEECH]" for silence

══════════════════════════════════════════════════════════════
AUDIO-TO-QUESTION MAPPING
══════════════════════════════════════════════════════════════
${numQ} audio files in EXACT order:

${audioMappingLines}

══════════════════════════════════════════════════════════════
SCORING & OUTPUT
══════════════════════════════════════════════════════════════

Score harshly for poor responses:
🔴 Band 1-2: Just says question number, no answer, <5 words
🟠 Band 2.5-3.5: 5-10 words, minimal relevance
🟡 Band 4-4.5: 10-20 words, basic grammar only

MODEL ANSWER WORD COUNTS:
- Part 1: 30-40 words
- Part 2: 120-140 words
- Part 3: 50-55 words (concise analytical response)

JSON OUTPUT SCHEMA:
{
  "overall_band": 6.0,
  "part_scores": {"part1": 6.0, "part2": 5.5, "part3": 6.5},
  "criteria": {
    "fluency_coherence": {"band": 6.0, "feedback": "...", "strengths": [], "weaknesses": [], "suggestions": []},
    "lexical_resource": {"band": 6.0, "feedback": "...", "strengths": [], "weaknesses": [], "suggestions": []},
    "grammatical_range": {"band": 5.5, "feedback": "...", "strengths": [], "weaknesses": [], "suggestions": []},
    "pronunciation": {"band": 6.0, "feedback": "...", "strengths": [], "weaknesses": [], "suggestions": []}
  },
  "summary": "2-3 sentence performance summary",
  "transcripts_by_part": {"1": "...", "2": "...", "3": "..."},
  "modelAnswers": [
    {
      "segment_key": "...",
      "partNumber": 1,
      "questionNumber": 1,
      "question": "...",
      "candidateResponse": "EXACT transcript",
      "estimatedBand": 5.5,
      "modelAnswer": "Model response"
    }
  ]
}

INPUT DATA:
questions_json: ${questionJson}
segment_map_json: ${segmentJson}

Return exactly ${numQ} modelAnswers.`;
}

serve(async (req) => {
  const startTime = Date.now();
  console.log(`[resubmit-parallel] ====== REQUEST START at ${new Date().toISOString()} ======`);
  
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const timing: Record<string, number> = {};

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const appEncryptionKey = Deno.env.get('app_encryption_key')!;
    const r2PublicUrl = Deno.env.get('R2_PUBLIC_URL') || '';

    const supabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: req.headers.get('Authorization')! } },
    });

    const supabaseService = createClient(supabaseUrl, supabaseServiceKey);

    const authStart = Date.now();
    const { data: { user } } = await supabaseClient.auth.getUser();
    timing.auth = Date.now() - authStart;

    if (!user) {
      return new Response(JSON.stringify({ error: 'Unauthorized', code: 'UNAUTHORIZED' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { testId, jobId, evaluationMode } = await req.json() as {
      testId: string;
      jobId?: string;
      evaluationMode?: 'basic' | 'accuracy';
    };

    if (!testId) {
      return new Response(JSON.stringify({ error: 'Missing testId', code: 'BAD_REQUEST' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`[resubmit-parallel] testId=${testId}, jobId=${jobId || 'none'}`);

    // STEP 1: Find existing job with file_paths
    const fetchJobStart = Date.now();
    let filePaths: Record<string, string> = {};
    let durations: Record<string, number> = {};
    let fluencyFlag: boolean | undefined;
    let topic: string | undefined;
    let difficulty: string | undefined;

    if (jobId) {
        const { data: job, error: jobError } = await supabaseService
          .from('speaking_evaluation_jobs')
          .select('file_paths, durations, fluency_flag, topic, difficulty')
          .eq('id', jobId)
          .eq('user_id', user.id)
          .single();

      if (jobError || !job) {
        console.error('[resubmit-parallel] Job not found:', jobError);
        return new Response(JSON.stringify({ error: 'Job not found', code: 'JOB_NOT_FOUND' }), {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      filePaths = (job.file_paths as Record<string, string>) || {};
      durations = (job.durations as Record<string, number>) || {};
      fluencyFlag = typeof job.fluency_flag === 'boolean' ? job.fluency_flag : undefined;
      topic = job.topic || undefined;
      difficulty = job.difficulty || undefined;
    } else {
      // Find most recent completed job for this test
      const { data: jobs } = await supabaseService
        .from('speaking_evaluation_jobs')
        .select('file_paths, durations, fluency_flag, topic, difficulty')
        .eq('test_id', testId)
        .eq('user_id', user.id)
        .eq('status', 'completed')
        .order('created_at', { ascending: false })
        .limit(1);

      if (jobs && jobs.length > 0) {
        filePaths = (jobs[0].file_paths as Record<string, string>) || {};
        durations = (jobs[0].durations as Record<string, number>) || {};
        fluencyFlag = typeof (jobs[0] as any).fluency_flag === 'boolean' ? (jobs[0] as any).fluency_flag : undefined;
        topic = jobs[0].topic || undefined;
        difficulty = jobs[0].difficulty || undefined;
      }
    }
    timing.fetchJob = Date.now() - fetchJobStart;

    if (!filePaths || Object.keys(filePaths).length === 0) {
      return new Response(JSON.stringify({ error: 'No stored audio found for this test', code: 'NO_AUDIO' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`[resubmit-parallel] Found ${Object.keys(filePaths).length} audio files`);

    // STEP 2: Fetch test payload
    const fetchTestStart = Date.now();
    const { data: testRow, error: testError } = await supabaseService
      .from('ai_practice_tests')
      .select('payload, topic, difficulty, preset_id')
      .eq('id', testId)
      .eq('user_id', user.id)
      .maybeSingle();

    if (testError || !testRow) {
      return new Response(JSON.stringify({ error: 'Test not found', code: 'TEST_NOT_FOUND' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    type PayloadType = { speakingParts?: Array<{ part_number: number; questions?: Array<{ id: string; question_number: number; question_text: string }> }> };
    let payload = testRow.payload as PayloadType || {};

    if (testRow.preset_id && (!payload.speakingParts)) {
      const { data: presetData } = await supabaseService
        .from('generated_test_audio')
        .select('content_payload')
        .eq('id', testRow.preset_id)
        .maybeSingle();
      
      if (presetData?.content_payload) {
        payload = presetData.content_payload as PayloadType;
      }
    }
    timing.fetchTest = Date.now() - fetchTestStart;

    topic = topic || testRow.topic;
    difficulty = difficulty || testRow.difficulty;

    // STEP 3: Re-queue evaluation using the async job pipeline so the UI can show stage-by-stage progress
    const resubmitMode = evaluationMode || 'accuracy';
    console.log(`[resubmit-parallel] Re-queuing evaluation via evaluate-speaking-async (mode=${resubmitMode})`);

    // IMPORTANT:
    // Basic mode is *text-based* only when transcripts are provided. When resubmitting from History,
    // we reconstruct per-question transcripts from the previous evaluation_report (modelAnswers[].candidateResponse)
    // so "Accuracy → Basic" resubmits stay truly text-based.
    let reconstructedTranscripts: Record<string, any> | undefined;

    if (resubmitMode === 'basic') {
      try {
        const { data: lastSubmission } = await supabaseService
          .from('speaking_submissions')
          .select('evaluation_report')
          .eq('test_id', testId)
          .eq('user_id', user.id)
          .order('submitted_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        const report = lastSubmission?.evaluation_report as any;
        const modelAnswers = Array.isArray(report?.modelAnswers) ? report.modelAnswers : [];

        const transcriptsFromReport: Record<string, any> = {};
        for (const a of modelAnswers) {
          const segKey = String(a?.segment_key || '');
          const candidateResponse = String(a?.candidateResponse || '').trim();
          if (!segKey || !candidateResponse) continue;

          transcriptsFromReport[segKey] = {
            rawTranscript: candidateResponse,
            cleanedTranscript: candidateResponse,
            durationMs: Math.round((durations?.[segKey] || 0) * 1000),
            // Optional metrics are left empty (processor tolerates missing fields).
            fluencyMetrics: {
              wordsPerMinute: 0,
              pauseCount: 0,
              fillerCount: 0,
              fillerRatio: 0,
              repetitionCount: 0,
              overallFluencyScore: 0,
            },
            prosodyMetrics: {
              pitchVariation: 0,
              stressEventCount: 0,
              rhythmConsistency: 0,
            },
            overallClarityScore: 0,
            wordConfidences: [],
          };
        }

        if (Object.keys(transcriptsFromReport).length > 0) {
          reconstructedTranscripts = transcriptsFromReport;
          console.log(`[resubmit-parallel] Reconstructed ${Object.keys(transcriptsFromReport).length} transcripts from last evaluation_report`);
        } else {
          console.warn('[resubmit-parallel] No candidateResponse transcripts found in last evaluation_report; basic-mode resubmit may fall back to audio');
        }
      } catch (e) {
        console.warn('[resubmit-parallel] Failed to reconstruct transcripts for basic-mode resubmit:', e);
      }
    }

    const { data: asyncData, error: asyncErr } = await supabaseClient.functions.invoke('evaluate-speaking-async', {
      body: {
        testId,
        filePaths,
        durations,
        topic,
        difficulty,
        fluencyFlag,
        cancelExisting: true,
        evaluationMode: resubmitMode,
        transcripts: resubmitMode === 'basic' ? reconstructedTranscripts : undefined,
      },
    });


    if (asyncErr) {
      console.error('[resubmit-parallel] Failed to queue async evaluation:', asyncErr);
      return new Response(JSON.stringify({ error: asyncErr.message || 'Failed to queue evaluation', code: 'QUEUE_FAILED' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ success: true, queued: true, ...asyncData }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });


    // Legacy resubmit logic removed.
    // This endpoint now strictly re-queues via `evaluate-speaking-async` so the UI can show
    // stage-by-stage progress (queued/uploading/transcribing/evaluating/finalizing) consistently.

  } catch (error: unknown) {
    const totalTimeMs = Date.now() - startTime;
    console.error('[resubmit-parallel] Error:', (error as Error)?.message);
    return new Response(JSON.stringify({ 
      error: (error as Error)?.message || 'Unexpected error', 
      code: 'UNKNOWN_ERROR',
      timing,
      totalTimeMs,
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
