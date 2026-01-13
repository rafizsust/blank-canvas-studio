import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { GoogleGenerativeAI } from "https://esm.sh/@google/generative-ai@0.21.0";
import { crypto } from "https://deno.land/std@0.168.0/crypto/mod.ts";
import { 
  getActiveGeminiKeysForModel, 
  markKeyQuotaExhausted,
  isQuotaExhaustedError
} from "../_shared/apiKeyQuotaUtils.ts";
import { getFromR2 } from "../_shared/r2Client.ts";

/**
 * ASYNC Speaking Evaluation Edge Function
 * 
 * Uses Google File API for audio uploads to avoid base64 token bloat (stack overflow).
 * Audio files are uploaded to Google's servers, then URIs are passed to Gemini.
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

// Model priority: gemini-2.5-flash first (best quality), then 2.0-flash fallback
const GEMINI_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.0-flash',
];

// Custom error class for quota exhaustion / rate limiting
class QuotaError extends Error {
  permanent: boolean;
  retryAfterSeconds?: number;

  constructor(message: string, opts: { permanent: boolean; retryAfterSeconds?: number }) {
    super(message);
    this.name = 'QuotaError';
    this.permanent = opts.permanent;
    this.retryAfterSeconds = opts.retryAfterSeconds;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractRetryAfterSeconds(err: any): number | undefined {
  const msg = String(err?.message || err || '');
  const m1 = msg.match(/retryDelay"\s*:\s*"(\d+)s"/i);
  if (m1) return Math.max(0, Number(m1[1]));
  const m2 = msg.match(/retry\s+in\s+([0-9.]+)s/i);
  if (m2) return Math.max(0, Math.ceil(Number(m2[1])));
  return undefined;
}

function isPermanentQuotaExhausted(err: any): boolean {
  const msg = String(err?.message || err || '').toLowerCase();
  if (msg.includes('check your plan') || msg.includes('billing')) return true;
  if (msg.includes('limit: 0')) return true;
  if (msg.includes('per day') && !msg.includes('retry')) return true;
  return false;
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
  retryJobId?: string; // If this is a retry, use existing job instead of creating new one
}

// Upload audio to Google File API using direct HTTP (Deno-compatible)
async function uploadToGoogleFileAPI(
  apiKey: string,
  audioBytes: Uint8Array,
  fileName: string,
  mimeType: string
): Promise<{ uri: string; mimeType: string }> {
  console.log(`[evaluate-speaking-async] Uploading ${fileName} to Google File API (${audioBytes.length} bytes)...`);
  
  // Google File API uses resumable upload protocol
  const initiateUrl = `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`;
  
  const metadata = {
    file: {
      displayName: fileName,
    }
  };
  
  const initiateResponse = await fetch(initiateUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(audioBytes.length),
      'X-Goog-Upload-Header-Content-Type': mimeType,
    },
    body: JSON.stringify(metadata),
  });
  
  if (!initiateResponse.ok) {
    const errorText = await initiateResponse.text();
    throw new Error(`Failed to initiate upload: ${initiateResponse.status} - ${errorText}`);
  }
  
  const uploadUrl = initiateResponse.headers.get('X-Goog-Upload-URL');
  if (!uploadUrl) {
    throw new Error('No upload URL returned from Google File API');
  }
  
  // Step 2: Upload the actual bytes
  const uploadResponse = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Length': String(audioBytes.length),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
    },
    body: audioBytes.buffer as ArrayBuffer,
  });
  
  if (!uploadResponse.ok) {
    const errorText = await uploadResponse.text();
    throw new Error(`Failed to upload file: ${uploadResponse.status} - ${errorText}`);
  }
  
  const result = await uploadResponse.json();
  
  if (!result.file?.uri) {
    throw new Error('No file URI returned from Google File API');
  }
  
  console.log(`[evaluate-speaking-async] Uploaded ${fileName}: ${result.file.uri}`);
  
  return {
    uri: result.file.uri,
    mimeType: result.file.mimeType || mimeType,
  };
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
    const { testId, filePaths, durations, topic, difficulty, fluencyFlag, retryJobId } = body;

    if (!testId || !filePaths || Object.keys(filePaths).length === 0) {
      return new Response(JSON.stringify({ error: 'Missing testId or filePaths' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    let job: any;

    // Check if this is a retry (reuse existing job record)
    if (retryJobId) {
      console.log(`[evaluate-speaking-async] Retry mode - reusing job ${retryJobId}`);
      
      const { data: existingJob, error: fetchError } = await supabaseService
        .from('speaking_evaluation_jobs')
        .select('*')
        .eq('id', retryJobId)
        .single();

      if (fetchError || !existingJob) {
        console.error('[evaluate-speaking-async] Failed to fetch retry job:', fetchError);
        return new Response(JSON.stringify({ error: 'Retry job not found' }), {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Update status to processing
      await supabaseService
        .from('speaking_evaluation_jobs')
        .update({ status: 'processing', updated_at: new Date().toISOString() })
        .eq('id', retryJobId);

      job = existingJob;
    } else {
      console.log(`[evaluate-speaking-async] Creating new job for test ${testId}, ${Object.keys(filePaths).length} files`);

      // Create job record in database (triggers realtime for frontend)
      const { data: newJob, error: jobError } = await supabaseService
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

      job = newJob;
    }

    console.log(`[evaluate-speaking-async] Job ${retryJobId ? 'retry' : 'created'}: ${job.id}`);

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

    // Watchdog: if a job gets stuck, mark it as failed
    const watchdog = async () => {
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
          last_error: 'Evaluation timed out in background processing. Please resubmit.',
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

  const { test_id, file_paths, durations, topic, difficulty, fluency_flag } = job;

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

  // Build segment metadata for completeness checking
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

  // ============ DOWNLOAD FILES FROM R2 ============
  console.log('[runEvaluation] Downloading audio files from R2...');
  const audioFiles: { key: string; bytes: Uint8Array; mimeType: string }[] = [];

  for (const [audioKey, r2Path] of Object.entries(file_paths as Record<string, string>)) {
    try {
      console.log(`[runEvaluation] Downloading from R2: ${r2Path}`);
      const result = await getFromR2(r2Path as string);
      if (!result.success || !result.bytes) {
        throw new Error(`Failed to download: ${result.error}`);
      }
      
      const ext = (r2Path as string).split('.').pop()?.toLowerCase() || 'webm';
      const mimeType = ext === 'mp3' ? 'audio/mpeg' : 'audio/webm';
      
      audioFiles.push({ key: audioKey, bytes: result.bytes, mimeType });
      console.log(`[runEvaluation] Downloaded: ${r2Path} (${result.bytes.length} bytes)`);
    } catch (e) {
      console.error(`[runEvaluation] Download error for ${audioKey}:`, e);
    }
  }

  if (audioFiles.length === 0) {
    throw new Error('No audio files could be downloaded from R2');
  }

  console.log(`[runEvaluation] Downloaded ${audioFiles.length} audio files from R2`);

  // ============ BUILD API KEY QUEUE ============
  interface KeyCandidate {
    key: string;
    keyId: string | null;
    isUserProvided: boolean;
  }

  const keyQueue: KeyCandidate[] = [];

  // 1. Try user's key first
  const { data: userSecret } = await supabaseClient
    .from('user_secrets')
    .select('encrypted_value')
    .eq('user_id', userId)
    .eq('secret_name', 'GEMINI_API_KEY')
    .single();

  if (userSecret?.encrypted_value && appEncryptionKey) {
    try {
      const userKey = await decryptKey(userSecret.encrypted_value, appEncryptionKey);
      keyQueue.push({ key: userKey, keyId: null, isUserProvided: true });
    } catch (e) {
      console.warn('[runEvaluation] Failed to decrypt user API key:', e);
    }
  }

  // 2. Add admin keys from database pool
  const dbApiKeys = await getActiveGeminiKeysForModel(supabaseService, 'flash_2_5');
  for (const dbKey of dbApiKeys) {
    keyQueue.push({ key: dbKey.key_value, keyId: dbKey.id, isUserProvided: false });
  }

  if (keyQueue.length === 0) {
    throw new Error('No API keys available');
  }

  console.log(`[runEvaluation] Key queue: ${keyQueue.length} keys (${keyQueue.filter(k => k.isUserProvided).length} user, ${keyQueue.filter(k => !k.isUserProvided).length} admin)`);

  // Build the evaluation prompt
  const prompt = buildPrompt(
    payload,
    topic || testRow.topic,
    difficulty || testRow.difficulty,
    fluency_flag,
    orderedSegments,
  );

  // ============ EVALUATION LOOP WITH KEY ROTATION ============
  let evaluationResult: any = null;
  let usedModel: string | null = null;

  for (const candidateKey of keyQueue) {
    if (evaluationResult) break;
    
    console.log(`[runEvaluation] Trying key ${candidateKey.isUserProvided ? '(user)' : `(admin: ${candidateKey.keyId})`}`);

    try {
      // Initialize GenAI with this key
      const genAI = new GoogleGenerativeAI(candidateKey.key);

      // ============ UPLOAD FILES TO GOOGLE FILE API ============
      const fileUris: Array<{ fileData: { mimeType: string; fileUri: string } }> = [];
      
      console.log(`[runEvaluation] Uploading ${audioFiles.length} files to Google File API...`);
      
      for (const audioFile of audioFiles) {
        try {
          const uploadResult = await uploadToGoogleFileAPI(
            candidateKey.key,
            audioFile.bytes,
            `${audioFile.key}.webm`,
            audioFile.mimeType
          );
          
          fileUris.push({
            fileData: {
              mimeType: uploadResult.mimeType,
              fileUri: uploadResult.uri,
            }
          });
        } catch (uploadError: any) {
          console.error(`[runEvaluation] Failed to upload ${audioFile.key}:`, uploadError?.message);
          throw uploadError;
        }
      }
      
      console.log(`[runEvaluation] Successfully uploaded ${fileUris.length} files to Google File API`);

      // Try each model in priority order
      for (const modelName of GEMINI_MODELS) {
        if (evaluationResult) break;

        console.log(`[runEvaluation] Attempting evaluation with model: ${modelName}`);
        
        const model = genAI.getGenerativeModel({ 
          model: modelName,
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 65000,
          },
        });

        // Build content with file URIs (NOT base64 - avoids stack overflow)
        const contentParts: any[] = [
          ...fileUris, // File URIs first
          { text: prompt } // Then the prompt
        ];

        // Retry once on temporary rate limit
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const response = await model.generateContent({ contents: [{ role: 'user', parts: contentParts }] });
            const text = response.response?.text?.() || '';

            if (!text) {
              console.warn(`[runEvaluation] Empty response from ${modelName}`);
              break;
            }

            console.log(`[runEvaluation] Successfully received response from model: ${modelName}`);

            const parsed = parseJson(text);
            if (parsed) {
              evaluationResult = parsed;
              usedModel = modelName;
              console.log(`[runEvaluation] Success with ${modelName}`);
              break;
            } else {
              console.warn(`[runEvaluation] Failed to parse JSON from ${modelName}`);
              break;
            }
          } catch (err: any) {
            const errMsg = String(err?.message || '');
            console.error(`[runEvaluation] Model ${modelName} failed (attempt ${attempt + 1}/2):`, errMsg.slice(0, 300));

            // Check for quota exhaustion
            if (isQuotaExhaustedError(errMsg) || isPermanentQuotaExhausted(err)) {
              // Mark pool key as exhausted
              if (!candidateKey.isUserProvided && candidateKey.keyId) {
                await markKeyQuotaExhausted(supabaseService, candidateKey.keyId, 'flash_2_5');
              }
              // Break out of retry loop and model loop - try next key
              throw new QuotaError(errMsg, { permanent: true });
            }

            // Check for temporary rate limit
            const retryAfter = extractRetryAfterSeconds(err);
            if (retryAfter && attempt === 0) {
              console.log(`[runEvaluation] Temporary rate limit, waiting ${retryAfter}s...`);
              await sleep(Math.min(retryAfter * 1000, 60000));
              continue;
            }

            // Not retryable, try next model
            break;
          }
        }
      }
    } catch (keyError: any) {
      if (keyError instanceof QuotaError) {
        console.log(`[runEvaluation] Key quota exhausted, trying next key...`);
        continue;
      }
      console.error(`[runEvaluation] Key error:`, keyError?.message);
      // Try next key
    }
  }

  if (!evaluationResult) {
    throw new Error('Evaluation failed: all models/keys exhausted');
  }

  // Validate model answer lengths - Part 2 should be at least 100 words
  const modelAnswers = evaluationResult.modelAnswers || [];
  for (const answer of modelAnswers) {
    if (answer.partNumber === 2 && answer.modelAnswer) {
      const wordCount = String(answer.modelAnswer).split(/\s+/).filter(Boolean).length;
      if (wordCount < 100) {
        console.warn(`[runEvaluation] Part 2 model answer too short (${wordCount} words)`);
      }
    }
  }

  // Calculate band score
  const overallBand = evaluationResult.overall_band || calculateBand(evaluationResult);

  // Build public audio URLs
  const publicBase = (Deno.env.get('R2_PUBLIC_URL') || '').replace(/\/$/, '');
  const audioUrls: Record<string, string> = {};
  if (publicBase) {
    for (const [k, r2Key] of Object.entries(file_paths as Record<string, string>)) {
      audioUrls[k] = `${publicBase}/${String(r2Key).replace(/^\//, '')}`;
    }
  }

  // Save to ai_practice_results
  const transcriptsByPart = evaluationResult?.transcripts_by_part || {};
  const transcriptsByQuestion = evaluationResult?.transcripts_by_question || {};

  const { data: resultRow, error: saveError } = await supabaseService
    .from('ai_practice_results')
    .insert({
      test_id,
      user_id: userId,
      module: 'speaking',
      score: Math.round(overallBand * 10),
      band_score: overallBand,
      total_questions: audioFiles.length,
      time_spent_seconds: durations
        ? Math.round(Object.values(durations as Record<string, number>).reduce((a, b) => a + b, 0))
        : 60,
      question_results: evaluationResult,
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

  // Mark job as completed - triggers Realtime notification
  await supabaseService
    .from('speaking_evaluation_jobs')
    .update({
      status: 'completed',
      result_id: resultRow?.id,
      completed_at: new Date().toISOString(),
    })
    .eq('id', jobId);

  console.log(`[runEvaluation] Evaluation complete, band: ${overallBand}, result_id: ${resultRow?.id}`);
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
  
  const includedParts = [...new Set(orderedSegments.map(s => s.partNumber))].sort();
  const partsDescription = includedParts.length === 1 
    ? `Part ${includedParts[0]} only` 
    : `Parts ${includedParts.join(', ')}`;

  const numQ = orderedSegments.length;

  return `You are a SENIOR IELTS Speaking examiner with 15+ years experience. Return ONLY valid JSON, no markdown.

CONTEXT: Topic: ${topic || 'General'}, Difficulty: ${difficulty || 'Medium'}, Parts: ${partsDescription}, Questions: ${numQ}
${fluencyFlag ? '⚠️ Part 2 under 80s - penalize Fluency & Coherence.' : ''}

MANDATORY REQUIREMENTS:
1. Listen to ALL ${numQ} audio files and transcribe EACH one fully
2. Provide band scores (use "band" key, not "score") for ALL 4 criteria
3. Create modelAnswers array with EXACTLY ${numQ} entries - one for each audio
4. Include transcripts_by_question with ALL ${numQ} question transcripts
5. All band scores must be between 1.0 and 9.0 (not zero!)

EXPERT EXAMINER OBSERVATIONS (CRITICAL):
1. **Repetition Detection**: Identify if the candidate excessively repeats the same words, phrases, or sentence structures across multiple answers.
2. **Relevance & Topic Adherence**: Assess whether the candidate actually answers the question asked.
3. **Response Coherence**: Evaluate if responses make logical sense.

SCORING:
- Short responses (1-10 words) = Band 4.0-4.5 max
- Off-topic/irrelevant responses = Penalize Fluency & Coherence
- Excessive repetition = Penalize Lexical Resource
- Overall band = weighted average (Part2 x2.0, Part3 x1.5, Part1 x1.0)

MODEL ANSWERS - WORD COUNT REQUIREMENTS (CRITICAL):
- Part 1 answers: ~75 words each (conversational, natural response)
- Part 2 answers: ~300 words (full long-turn response with all cue card points)
- Part 3 answers: ~150 words each (extended discussion with reasoning)

EXACT JSON SCHEMA (follow precisely):
{
  "overall_band": 6.0,
  "criteria": {
    "fluency_coherence": {"band": 6.0, "feedback": "...", "strengths": [...], "weaknesses": [...], "suggestions": [...]},
    "lexical_resource": {"band": 6.0, "feedback": "...", "strengths": [...], "weaknesses": [...], "suggestions": [...]},
    "grammatical_range": {"band": 5.5, "feedback": "...", "strengths": [...], "weaknesses": [...], "suggestions": [...]},
    "pronunciation": {"band": 6.0, "feedback": "...", "strengths": [...], "weaknesses": [...], "suggestions": [...]}
  },
  "summary": "2-4 sentence overall performance summary",
  "lexical_upgrades": [{"original": "good", "upgraded": "beneficial", "context": "example sentence"}],
  "part_analysis": [{"part_number": 1, "performance_notes": "...", "key_moments": [...], "areas_for_improvement": [...]}],
  "improvement_priorities": ["Priority 1: ...", "Priority 2: ..."],
  "transcripts_by_part": {"1": "Full transcript for Part 1..."},
  "transcripts_by_question": {
    "1": [{"segment_key": "part1-q...", "question_number": 1, "question_text": "...", "transcript": "..."}]
  },
  "modelAnswers": [
    {
      "segment_key": "part1-q...",
      "partNumber": 1,
      "questionNumber": 1,
      "question": "Question text",
      "candidateResponse": "Full transcript of candidate's answer",
      "estimatedBand": 5.5,
      "targetBand": 6,
      "modelAnswer": "A comprehensive model answer (~75 words for Part1, ~300 words for Part2, ~150 words for Part3)...",
      "whyItWorks": ["Uses topic-specific vocabulary", "Clear organization"],
      "keyImprovements": ["Add more examples", "Vary vocabulary"]
    }
  ]
}

INPUT DATA:
questions_json: ${questionJson}
segment_map_json (${numQ} segments to evaluate): ${segmentJson}

CRITICAL: You MUST return exactly ${numQ} entries in modelAnswers array. Follow the word count guidelines for each part.`;
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
  return Math.round(avg * 2) / 2;
}
