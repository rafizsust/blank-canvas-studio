import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { crypto } from "https://deno.land/std@0.168.0/crypto/mod.ts";
import { 
  getActiveGeminiKeysForModel, 
  markKeyQuotaExhausted
} from "../_shared/apiKeyQuotaUtils.ts";
import { getFromR2 } from "../_shared/r2Client.ts";

/**
 * ASYNC Speaking Evaluation Edge Function
 * 
 * Returns 202 Accepted IMMEDIATELY. User gets instant "submitted" feedback.
 * Actual evaluation runs in background via EdgeRuntime.waitUntil.
 * Results are saved to DB and user is notified via Supabase Realtime.
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Model priority: 2.0 Flash -> 2.5 Flash -> 1.5 Pro
const GEMINI_MODELS = [
  'gemini-2.0-flash',
  'gemini-2.5-flash',
  'gemini-1.5-pro',
];

// Retries are ONLY for transient transport errors.
// IMPORTANT: If we detect quota exhaustion for a key, we DO NOT retry that key/model again.
const RETRY_CONFIG = {
  maxRetries: 2,
  initialDelayMs: 1500,
  maxDelayMs: 8000,
  backoffMultiplier: 2,
  retryableStatuses: [503, 504],
};

type GeminiErrorKind = 'quota' | 'rate_limit' | 'invalid_key' | 'not_found' | 'other';

function classifyGeminiError(status: number, errText: string): GeminiErrorKind {
  const lower = (errText || '').toLowerCase();
  if (status === 404) return 'not_found';
  if (status === 400 && (lower.includes('api_key') || lower.includes('api key'))) return 'invalid_key';

  // Gemini often returns 429 for both quota exhaustion and rate limiting.
  // Quota exhaustion usually contains these phrases.
  const looksLikeQuota =
    status === 429 &&
    (lower.includes('exceeded your current quota') ||
      lower.includes('check your plan') ||
      lower.includes('billing') ||
      lower.includes('quota'));
  if (looksLikeQuota) return 'quota';

  const looksLikeRateLimit =
    status === 429 && (lower.includes('too many requests') || lower.includes('rate limit') || lower.includes('resource_exhausted'));
  if (looksLikeRateLimit) return 'rate_limit';

  return 'other';
}

// Declare EdgeRuntime for background processing
declare const EdgeRuntime: { waitUntil?: (promise: Promise<void>) => void } | undefined;

interface EvaluationRequest {
  testId: string;
  filePaths: Record<string, string>;
  durations?: Record<string, number>;
  topic?: string;
  difficulty?: string;
  fluencyFlag?: boolean;
}

serve(async (req) => {
  console.log(`[evaluate-speaking-async] Request at ${new Date().toISOString()}`);
  
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const appEncryptionKey = Deno.env.get('app_encryption_key')!;

    const supabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: req.headers.get('Authorization')! } },
    });

    const supabaseService = createClient(supabaseUrl, supabaseServiceKey);

    // Authenticate user
    const { data: { user }, error: authError } = await supabaseClient.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const body: EvaluationRequest = await req.json();
    const { testId, filePaths, durations, topic, difficulty, fluencyFlag } = body;

    if (!testId || !filePaths || Object.keys(filePaths).length === 0) {
      return new Response(JSON.stringify({ error: 'Missing testId or filePaths' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`[evaluate-speaking-async] Creating job for test ${testId}, ${Object.keys(filePaths).length} files`);

    // Create job record in database (triggers realtime for frontend)
    const { data: job, error: jobError } = await supabaseService
      .from('speaking_evaluation_jobs')
      .insert({
        user_id: user.id,
        test_id: testId,
        status: 'pending',
        file_paths: filePaths,
        durations: durations || {},
        topic,
        difficulty,
        fluency_flag: fluencyFlag || false,
      })
      .select()
      .single();

    if (jobError) {
      console.error('[evaluate-speaking-async] Job creation failed:', jobError);
      return new Response(JSON.stringify({ error: 'Failed to create job' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`[evaluate-speaking-async] Job created: ${job.id}`);

    // Background processing function
    const processInBackground = async () => {
      try {
        await runEvaluation(job.id, user.id, supabaseService, supabaseClient, appEncryptionKey);
      } catch (err) {
        console.error('[evaluate-speaking-async] Background error:', err);
        await supabaseService
          .from('speaking_evaluation_jobs')
          .update({
            status: 'failed',
            last_error: err instanceof Error ? err.message : 'Unknown error',
          })
          .eq('id', job.id);
      }
    };

    // Watchdog: if a job gets stuck in pending/processing (function instance shutdown, etc.),
    // mark it as failed so the frontend stops polling forever.
    const watchdog = async () => {
      // 12 minutes: long enough for normal runs, short enough to avoid “infinite processing”.
      const WATCHDOG_MS = 12 * 60 * 1000;
      await new Promise((r) => setTimeout(r, WATCHDOG_MS));

      const { data: current } = await supabaseService
        .from('speaking_evaluation_jobs')
        .select('status, updated_at')
        .eq('id', job.id)
        .maybeSingle();

      if (!current) return;
      if (current.status === 'completed' || current.status === 'failed') return;

      console.warn('[evaluate-speaking-async] Watchdog firing: job still not terminal, marking failed', job.id);
      await supabaseService
        .from('speaking_evaluation_jobs')
        .update({
          status: 'failed',
          last_error:
            'Evaluation timed out in background processing. Please resubmit (we will reuse your uploaded audio).',
        })
        .eq('id', job.id);
    };

    // Use EdgeRuntime.waitUntil for true async background processing
    if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime.waitUntil) {
      console.log('[evaluate-speaking-async] Using EdgeRuntime.waitUntil');
      EdgeRuntime.waitUntil(processInBackground());
      EdgeRuntime.waitUntil(watchdog());
    } else {
      console.log('[evaluate-speaking-async] EdgeRuntime not available, running async');
      processInBackground().catch(console.error);
      watchdog().catch(console.error);
    }

    // Return 202 IMMEDIATELY - user gets instant feedback
    return new Response(
      JSON.stringify({
        success: true,
        jobId: job.id,
        status: 'pending',
        message: 'Evaluation submitted. You will be notified when results are ready.',
      }),
      {
        status: 202,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      },
    );

  } catch (error: any) {
    console.error('[evaluate-speaking-async] Error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

// Main evaluation logic (runs in background)
async function runEvaluation(
  jobId: string,
  userId: string,
  supabaseService: any,
  supabaseClient: any,
  appEncryptionKey: string
): Promise<void> {
  console.log(`[runEvaluation] Starting job ${jobId}`);
  
  // Mark as processing
  await supabaseService
    .from('speaking_evaluation_jobs')
    .update({ status: 'processing' })
    .eq('id', jobId);

  // Get job details
  const { data: job } = await supabaseService
    .from('speaking_evaluation_jobs')
    .select('*')
    .eq('id', jobId)
    .single();

  if (!job) throw new Error('Job not found');

  const { test_id, file_paths, durations, topic, difficulty, fluency_flag, retry_count, max_retries } = job;

  // Get test payload
  const { data: testRow } = await supabaseService
    .from('ai_practice_tests')
    .select('payload, topic, difficulty, preset_id')
    .eq('id', test_id)
    .eq('user_id', userId)
    .maybeSingle();

  if (!testRow) throw new Error('Test not found');

  let payload = testRow.payload as any || {};
  
  // Fetch preset content if needed
  if (testRow.preset_id && (!payload.speakingParts && !payload.part1)) {
    const { data: presetData } = await supabaseService
      .from('generated_test_audio')
      .select('content_payload')
      .eq('id', testRow.preset_id)
      .maybeSingle();
    
    if (presetData?.content_payload) {
      payload = presetData.content_payload;
    }
  }

  // Build a mapping from recorded segment keys (e.g. "part1-q<uuid>") to the test questions.
  // This is critical so we can return transcripts + model answers for EVERY question.
  const parts = Array.isArray(payload?.speakingParts) ? payload.speakingParts : [];
  const questionById = new Map<string, { partNumber: 1 | 2 | 3; questionNumber: number; questionText: string }>();
  for (const p of parts) {
    const partNumber = Number(p?.part_number) as 1 | 2 | 3;
    if (partNumber !== 1 && partNumber !== 2 && partNumber !== 3) continue;
    const qs = Array.isArray(p?.questions) ? p.questions : [];
    for (const q of qs) {
      const id = String(q?.id || '');
      if (!id) continue;
      questionById.set(id, {
        partNumber,
        questionNumber: Number(q?.question_number),
        questionText: String(q?.question_text || ''),
      });
    }
  }

  const segmentMetaByKey = new Map<
    string,
    { segmentKey: string; partNumber: 1 | 2 | 3; questionNumber: number; questionText: string }
  >();

  for (const segmentKey of Object.keys(file_paths as Record<string, string>)) {
    // Expected segmentKey format: part{n}-q{questionId}
    const m = String(segmentKey).match(/^part([123])\-q(.+)$/);
    if (!m) continue;
    const partNumber = Number(m[1]) as 1 | 2 | 3;
    const questionId = m[2];
    const q = questionById.get(questionId);
    if (!q) continue;
    segmentMetaByKey.set(segmentKey, {
      segmentKey,
      partNumber,
      questionNumber: q.questionNumber,
      questionText: q.questionText,
    });
  }

  const orderedSegments = Array.from(segmentMetaByKey.values()).sort((a, b) => {
    if (a.partNumber !== b.partNumber) return a.partNumber - b.partNumber;
    return a.questionNumber - b.questionNumber;
  });

  // Download audio files from R2 (preserve segmentKey so the model can align audio->question)
  console.log('[runEvaluation] Downloading audio files from R2...');
  const audioContents: {
    segmentKey: string;
    data: Uint8Array;
    mimeType: string;
    partNumber: 1 | 2 | 3;
    questionNumber: number;
    questionText: string;
  }[] = [];

  for (const [segmentKey, path] of Object.entries(file_paths)) {
    try {
      const result = await getFromR2(path as string);
      if (result.success && result.bytes) {
        const ext = (path as string).split('.').pop()?.toLowerCase() || 'webm';
        const mimeType = ext === 'mp3' ? 'audio/mpeg' : 'audio/webm';

        const meta = segmentMetaByKey.get(segmentKey);
        // If we cannot map this segment to a question, still include it, but mark unknown.
        const fallbackMeta = meta ?? {
          segmentKey,
          partNumber: 1,
          questionNumber: 0,
          questionText: '',
        };

        audioContents.push({
          segmentKey,
          data: result.bytes,
          mimeType,
          partNumber: fallbackMeta.partNumber,
          questionNumber: fallbackMeta.questionNumber,
          questionText: fallbackMeta.questionText,
        });
        console.log(`[runEvaluation] Downloaded: ${segmentKey} (${result.bytes.length} bytes)`);
      }
    } catch (e) {
      console.error(`[runEvaluation] Download error for ${segmentKey}:`, e);
    }
  }

  if (audioContents.length === 0) {
    throw new Error('No audio files could be downloaded');
  }

  // Build API key queue
  const keyQueue: { key: string; id: string | null; isUser: boolean }[] = [];

  // Try user's key first
  const { data: userSecret } = await supabaseClient
    .from('user_secrets')
    .select('encrypted_value')
    .eq('user_id', userId)
    .eq('secret_name', 'GEMINI_API_KEY')
    .single();

  if (userSecret?.encrypted_value) {
    try {
      const userKey = await decryptKey(userSecret.encrypted_value, appEncryptionKey);
      keyQueue.push({ key: userKey, id: null, isUser: true });
    } catch (e) {
      console.error('[runEvaluation] User key decryption failed:', e);
    }
  }

  // Add admin pool keys
  const poolKeys = await getActiveGeminiKeysForModel(supabaseService, 'flash');
  for (const pk of poolKeys) {
    keyQueue.push({ key: pk.key_value, id: pk.id, isUser: false });
  }

  if (keyQueue.length === 0) {
    throw new Error('No API keys available');
  }

  // Build evaluation prompt (includes segment/question mapping so output can be complete)
  const prompt = buildPrompt(
    payload,
    topic || testRow.topic,
    difficulty || testRow.difficulty,
    fluency_flag,
    orderedSegments,
  );

  // Evaluate with key/model rotation.
  // IMPORTANT: If a key is quota-exhausted, we do NOT retry it.
  let result: any = null;
  let usedModel: string | null = null;

  let userKeyWasQuotaLimited = false;

  for (const candidate of keyQueue) {
    if (result) break;

    // If user's key hit quota, skip it (we already marked it by flag).
    if (candidate.isUser && userKeyWasQuotaLimited) continue;

    for (const model of GEMINI_MODELS) {
      if (result) break;

      // Only retry transient 503/504. Never retry quota exhaustion.
      for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
        try {
          console.log(`[runEvaluation] Trying ${model} (attempt ${attempt + 1})`);

          const inlineParts = audioContents.map((ac) => ({
            inline_data: {
              mime_type: ac.mimeType,
              data: btoa(String.fromCharCode(...ac.data)),
            },
          }));

          const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(candidate.key)}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [{ role: 'user', parts: [...inlineParts, { text: prompt }] }],
                generationConfig: {
                  temperature: 0.3,
                  maxOutputTokens: 8000,
                  responseMimeType: 'application/json',
                },
              }),
            },
          );

          console.log(`[runEvaluation] ${model} response: ${response.status}`);

          if (!response.ok) {
            const errText = await response.text();
            const kind = classifyGeminiError(response.status, errText);
            console.error(`[runEvaluation] ${model} error (${kind}):`, errText.slice(0, 220));

            // Model not found: try next model.
            if (kind === 'not_found') break;

            // Quota: mark pool key exhausted (and stop using it). For user key, switch to pool.
            if (kind === 'quota') {
              if (candidate.isUser) {
                userKeyWasQuotaLimited = true;
              } else if (candidate.id) {
                await markKeyQuotaExhausted(supabaseService, candidate.id, 'flash');
              }
              // Do NOT retry this key/model.
              break;
            }

            // Invalid key: stop using this key.
            if (kind === 'invalid_key') {
              if (!candidate.isUser && candidate.id) {
                await markKeyQuotaExhausted(supabaseService, candidate.id, 'flash');
              }
              break;
            }

            // Retry ONLY for transient statuses.
            const isRetryable = RETRY_CONFIG.retryableStatuses.includes(response.status);
            if (isRetryable && attempt < RETRY_CONFIG.maxRetries) {
              const delay = Math.min(
                RETRY_CONFIG.initialDelayMs * Math.pow(RETRY_CONFIG.backoffMultiplier, attempt),
                RETRY_CONFIG.maxDelayMs,
              );
              console.log(`[runEvaluation] Retrying in ${delay}ms...`);
              await new Promise((r) => setTimeout(r, delay));
              continue;
            }

            // Otherwise: try next model (same key).
            break;
          }

          const data = await response.json();
          const text = data?.candidates?.[0]?.content?.parts
            ?.map((p: any) => p?.text)
            .filter(Boolean)
            .join('');

          if (text) {
            result = parseJson(text);
            if (result) {
              usedModel = model;
              console.log(`[runEvaluation] Success with ${model}`);
              break;
            }
          }

          // Got a response but invalid JSON: try next model.
          break;
        } catch (err: any) {
          console.error(`[runEvaluation] Error with ${model}:`, err?.message || String(err));
          if (attempt < RETRY_CONFIG.maxRetries) {
            const delay = Math.min(
              RETRY_CONFIG.initialDelayMs * Math.pow(RETRY_CONFIG.backoffMultiplier, attempt),
              RETRY_CONFIG.maxDelayMs,
            );
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }
          break;
        }
      }
    }
  }

  if (!result) {
    throw new Error('Evaluation failed: all models/keys exhausted');
  }

  // Calculate band score
  const overallBand = result.overall_band || calculateBand(result);

  // Build public audio URLs (client cannot access R2_PUBLIC_URL)
  const publicBase = (Deno.env.get('R2_PUBLIC_URL') || '').replace(/\/$/, '');
  const audioUrls: Record<string, string> = {};
  if (publicBase) {
    for (const [k, r2Key] of Object.entries(file_paths as Record<string, string>)) {
      audioUrls[k] = `${publicBase}/${String(r2Key).replace(/^\//, '')}`;
    }
  }

  // Save to ai_practice_results
  const transcriptsByPart = (result?.transcripts_by_part && typeof result.transcripts_by_part === 'object')
    ? result.transcripts_by_part
    : {};
  const transcriptsByQuestion = (result?.transcripts_by_question && typeof result.transcripts_by_question === 'object')
    ? result.transcripts_by_question
    : {};

  const { data: resultRow, error: saveError } = await supabaseService
    .from('ai_practice_results')
    .insert({
      test_id,
      user_id: userId,
      module: 'speaking',
      score: Math.round(overallBand * 10),
      band_score: overallBand,
      total_questions: audioContents.length,
      time_spent_seconds: durations
        ? Math.round(Object.values(durations as Record<string, number>).reduce((a, b) => a + b, 0))
        : 60,
      question_results: result,
      // IMPORTANT: store client-usable audio_urls + transcripts for results UI
      answers: {
        audio_urls: audioUrls,
        transcripts_by_part: transcriptsByPart,
        transcripts_by_question: transcriptsByQuestion,
        file_paths,
      },
      completed_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (saveError) {
    console.error('[runEvaluation] Save error:', saveError);
  }

  // Mark job as completed - this triggers Realtime notification to frontend
  await supabaseService
    .from('speaking_evaluation_jobs')
    .update({
      status: 'completed',
      result_id: resultRow?.id,
      completed_at: new Date().toISOString(),
    })
    .eq('id', jobId);

  console.log(`[runEvaluation] Job ${jobId} completed, band: ${overallBand}`);
}

// Helper functions
async function decryptKey(encrypted: string, appKey: string): Promise<string> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const keyData = encoder.encode(appKey).slice(0, 32);
  const cryptoKey = await crypto.subtle.importKey('raw', keyData, { name: 'AES-GCM' }, false, ['decrypt']);
  const bytes = Uint8Array.from(atob(encrypted), c => c.charCodeAt(0));
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, cryptoKey, bytes.slice(12));
  return decoder.decode(decrypted);
}

function buildPrompt(
  payload: any,
  topic: string | undefined,
  difficulty: string | undefined,
  fluencyFlag: boolean | undefined,
  orderedSegments: Array<{ segmentKey: string; partNumber: 1 | 2 | 3; questionNumber: number; questionText: string }>,
): string {
  const parts = Array.isArray(payload?.speakingParts) ? payload.speakingParts : [];
  const questions = parts
    .flatMap((p: any) =>
      (Array.isArray(p?.questions)
        ? p.questions.map((q: any) => ({
            id: String(q?.id || ''),
            part_number: Number(p?.part_number),
            question_number: Number(q?.question_number),
            question_text: String(q?.question_text || ''),
          }))
        : []),
    )
    .filter((q: any) => q.part_number === 1 || q.part_number === 2 || q.part_number === 3);

  const questionJson = JSON.stringify(questions);
  const segmentJson = JSON.stringify(orderedSegments);

  return [
    `You are a strict, professional IELTS Speaking examiner and mentor (2025 criteria).`,
    `Your job: produce COMPLETE evaluation for EVERY recorded question, acting like a real mentor who shows the NEXT ACHIEVABLE LEVEL.`,
    `Topic: ${topic || 'General'}. Difficulty: ${difficulty || 'Medium'}.`,
    fluencyFlag
      ? `Important: Part 2 speaking was under 80 seconds; reflect this in Fluency & Coherence feedback.`
      : null,
    ``,
    `CRITICAL OUTPUT RULES:`,
    `- Return STRICT JSON ONLY (no markdown, no backticks).`,
    `- You MUST include transcripts + model answers for ALL questions listed in segment_map_json.`,
    `- If speech is unclear, use "(inaudible)" for missing words but still return an entry.`,
    `- Keep answers realistic and aligned to band descriptors.`,
    ``,
    `MODEL ANSWER STRATEGY (IMPORTANT):`,
    `For EACH question, you will assess what band the candidate achieved for THAT SPECIFIC response.`,
    `Then provide ONE model answer that is exactly ONE band higher - the NEXT achievable level.`,
    `- If candidate achieved Band 4-5 on a question → provide a Band 6 model answer`,
    `- If candidate achieved Band 5-6 on a question → provide a Band 7 model answer`, 
    `- If candidate achieved Band 6-7 on a question → provide a Band 8 model answer`,
    `- If candidate achieved Band 8+ on a question → provide a Band 9 model answer`,
    `This is how a real mentor helps students improve - by showing them the next step, not overwhelming them with all levels.`,
    ``,
    `Return this exact schema and key names:`,
    `{`,
    `  "overall_band": 6.5,`,
    `  "criteria": {`,
    `    "fluency_coherence": { "band": 6.5, "feedback": "...", "strengths": ["..."], "weaknesses": ["..."], "suggestions": ["..."] },`,
    `    "lexical_resource": { "band": 6.5, "feedback": "...", "strengths": ["..."], "weaknesses": ["..."], "suggestions": ["..."] },`,
    `    "grammatical_range": { "band": 6.5, "feedback": "...", "strengths": ["..."], "weaknesses": ["..."], "suggestions": ["..."] },`,
    `    "pronunciation": { "band": 6.5, "feedback": "...", "strengths": ["..."], "weaknesses": ["..."], "suggestions": ["..."] }`,
    `  },`,
    `  "summary": "1-3 sentences overall summary",`,
    `  "improvements": ["Top 5 actionable improvements"],`,
    `  "transcripts_by_part": { "1": "...", "2": "...", "3": "..." },`,
    `  "transcripts_by_question": {`,
    `    "1": [{"segment_key":"part1-q...","question_number":1,"question_text":"...","transcript":"..."}],`,
    `    "2": [{"segment_key":"part2-q...","question_number":5,"question_text":"...","transcript":"..."}],`,
    `    "3": [{"segment_key":"part3-q...","question_number":9,"question_text":"...","transcript":"..."}]`,
    `  },`,
    `  "modelAnswers": [{`,
    `    "segment_key": "part1-q...",`,
    `    "partNumber": 1,`,
    `    "questionNumber": 1,`,
    `    "question": "...",`,
    `    "candidateResponse": "(copy from transcript)",`,
    `    "estimatedBand": 6.0,`,
    `    "targetBand": 7,`,
    `    "modelAnswer": "A Band 7 level answer showing the next achievable level...",`,
    `    "whyItWorks": ["Specific feature 1 that makes this a Band 7 answer", "Feature 2", "..."],`,
    `    "keyImprovements": ["What the candidate should focus on to reach this level"]`,
    `  }]`,
    `}`,
    ``,
    `You will receive (JSON):`,
    `- questions_json: all questions in the test`,
    `- segment_map_json: the recorded segments you MUST cover (this is the source of truth for completeness)`,
    ``,
    `questions_json: ${questionJson}`,
    `segment_map_json: ${segmentJson}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function parseJson(text: string): any {
  try { return JSON.parse(text); } catch {}
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (match) try { return JSON.parse(match[1].trim()); } catch {}
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch) try { return JSON.parse(objMatch[0]); } catch {}
  return null;
}

function calculateBand(result: any): number {
  const c = result.criteria;
  if (!c) return 6.0;
  const scores = [
    c.fluency_coherence?.band,
    c.lexical_resource?.band,
    c.grammatical_range?.band,
    c.pronunciation?.band,
  ].filter(s => typeof s === 'number');
  
  if (scores.length === 0) return 6.0;
  
  const avg = scores.reduce((a: number, b: number) => a + b, 0) / scores.length;
  return Math.round(avg * 2) / 2; // Round to nearest 0.5
}
