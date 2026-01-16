import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { GoogleGenerativeAI } from "https://esm.sh/@google/generative-ai@0.21.0";
import { crypto } from "https://deno.land/std@0.168.0/crypto/mod.ts";
import { 
  getActiveGeminiKeysForModels, 
  markModelQuotaExhausted,
  isQuotaExhaustedError,
  isDailyQuotaExhaustedError
} from "../_shared/apiKeyQuotaUtils.ts";
import { getFromR2 } from "../_shared/r2Client.ts";

/**
 * SEPARATED Speaking Job Processor
 * 
 * This function ONLY processes jobs - it does NOT create them.
 * Jobs are created by evaluate-speaking-async which returns immediately.
 * 
 * This processor can be called via:
 * 1. Supabase cron job (scheduled polling)
 * 2. Direct invocation from frontend (manual retry)
 * 3. Webhook trigger after job creation
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const GEMINI_MODELS = ['gemini-2.5-flash']; // Removed gemini-2.0-flash due to persistent rate limiting

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

function exponentialBackoffWithJitter(attempt: number, baseDelayMs = 1000, maxDelayMs = 60000): number {
  const exponentialDelay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
  const jitter = Math.random() * exponentialDelay * 0.5;
  return Math.round(exponentialDelay + jitter);
}

function extractRetryAfterSeconds(err: any): number | undefined {
  const msg = String(err?.message || err || '');
  const m1 = msg.match(/retryDelay"\s*:\s*"(\d+)s"/i);
  if (m1) return Math.max(0, Number(m1[1]));
  const m2 = msg.match(/retry\s+in\s+([0-9.]+)s/i);
  if (m2) return Math.max(0, Math.ceil(Number(m2[1])));
  return undefined;
}

// Removed isPermanentQuotaExhausted - use isDailyQuotaExhaustedError from shared utils instead

async function uploadToGoogleFileAPI(
  apiKey: string,
  audioBytes: Uint8Array,
  fileName: string,
  mimeType: string
): Promise<{ uri: string; mimeType: string }> {
  console.log(`[process-speaking-job] Uploading ${fileName} to Google File API (${audioBytes.length} bytes)...`);
  
  const initiateUrl = `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`;
  
  const metadata = { file: { displayName: fileName } };
  
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
  if (!uploadUrl) throw new Error('No upload URL returned');
  
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
  if (!result.file?.uri) throw new Error('No file URI returned');
  
  console.log(`[process-speaking-job] Uploaded ${fileName}: ${result.file.uri}`);
  return { uri: result.file.uri, mimeType: result.file.mimeType || mimeType };
}

serve(async (req) => {
  console.log(`[process-speaking-job] Request at ${new Date().toISOString()}`);
  
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const appEncryptionKey = Deno.env.get('app_encryption_key')!;

    const supabaseService = createClient(supabaseUrl, supabaseServiceKey);

    const body = await req.json();
    const { jobId } = body;

    if (!jobId) {
      return new Response(JSON.stringify({ error: 'Missing jobId' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Fetch the job
    const { data: job, error: jobError } = await supabaseService
      .from('speaking_evaluation_jobs')
      .select('*')
      .eq('id', jobId)
      .single();

    if (jobError || !job) {
      return new Response(JSON.stringify({ error: 'Job not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Check if job is already completed or cancelled
    if (job.status === 'completed' || job.status === 'failed') {
      console.log(`[process-speaking-job] Job ${jobId} already ${job.status}, skipping`);
      return new Response(JSON.stringify({ success: true, status: job.status, skipped: true }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Claim the job with a short lock + heartbeat so the watchdog doesn't reset it mid-run
    const lockToken = crypto.randomUUID();
    const lockExpiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const hasTranscripts = Boolean(job.partial_results?.transcripts) && Object.keys(job.partial_results.transcripts || {}).length > 0;

    await supabaseService
      .from('speaking_evaluation_jobs')
      .update({
        status: 'processing',
        stage: hasTranscripts ? 'evaluating_text' : (job.stage || 'processing'),
        lock_token: lockToken,
        lock_expires_at: lockExpiresAt,
        heartbeat_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', jobId);

    try {
      await processJob(job, supabaseService, appEncryptionKey);
      
      return new Response(JSON.stringify({ success: true, status: 'completed' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    } catch (processError: any) {
      console.error('[process-speaking-job] Processing failed:', processError);
      
      // Update job with error
      const retryCount = (job.retry_count || 0) + 1;
      const maxRetries = job.max_retries || 5; // Increased to 5 for more robust retrying
      
      if (retryCount >= maxRetries) {
        await supabaseService
          .from('speaking_evaluation_jobs')
          .update({
            status: 'failed',
            last_error: processError.message,
            retry_count: retryCount,
            updated_at: new Date().toISOString(),
          })
          .eq('id', jobId);
      } else {
        // Mark as pending for retry
        await supabaseService
          .from('speaking_evaluation_jobs')
          .update({
            status: 'pending',
            last_error: processError.message,
            retry_count: retryCount,
            updated_at: new Date().toISOString(),
          })
          .eq('id', jobId);
      }

      return new Response(JSON.stringify({ success: false, error: processError.message, retryCount }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  } catch (error: any) {
    console.error('[process-speaking-job] Error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

async function processJob(job: any, supabaseService: any, appEncryptionKey: string): Promise<void> {
  const { id: jobId, user_id: userId, test_id, file_paths, durations, topic, difficulty, fluency_flag, stage, partial_results } = job;

  console.log(`[processJob] Starting job ${jobId} for test ${test_id}, stage: ${stage || 'audio'}`);

  // Check evaluation mode from partial_results
  const evaluationMode = partial_results?.evaluationMode || 'basic';
  const hasTranscripts = partial_results?.transcripts && Object.keys(partial_results.transcripts).length > 0;
  
  console.log(`[processJob] Evaluation mode: ${evaluationMode}, hasTranscripts: ${hasTranscripts}`);
  
  // Route to appropriate evaluation path based on mode:
  // - 'accuracy' mode: ALWAYS use audio-based evaluation (for accurate pronunciation scoring)
  // - 'basic' mode with transcripts: use text-based evaluation (cheaper, faster)
  // - 'basic' mode without transcripts: fall back to audio evaluation
  
  if (evaluationMode === 'accuracy') {
    console.log(`[processJob] ACCURACY MODE: Using audio-based evaluation for job ${jobId}`);
    // Fall through to audio evaluation below
  } else if (hasTranscripts) {
    console.log(`[processJob] BASIC MODE: Using text-based evaluation for job ${jobId}`);
    await processTextBasedEvaluation(job, supabaseService, appEncryptionKey);
    return;
  } else {
    console.log(`[processJob] BASIC MODE without transcripts: Falling back to audio evaluation for job ${jobId}`);
  }
  
  // AUDIO-BASED EVALUATION - Used for 'accuracy' mode or when no transcripts available

  // Get test payload
  const { data: testRow } = await supabaseService
    .from('ai_practice_tests')
    .select('payload, topic, difficulty, preset_id')
    .eq('id', test_id)
    .eq('user_id', userId)
    .maybeSingle();

  if (!testRow) throw new Error('Test not found');

  let payload = testRow.payload as any || {};
  
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

  // Build segment ordering from file_paths - extract part number directly from key
  // Segment keys are formatted as: part{1|2|3}-q{questionId} where questionId may contain hyphens
  const parts = Array.isArray(payload?.speakingParts) ? payload.speakingParts : [];
  
  // Build question lookup for context (used for prompts, not for filtering)
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

  // Build segment list - process ALL file paths, extract part number from key prefix
  const segmentList: Array<{ segmentKey: string; partNumber: 1 | 2 | 3; questionNumber: number; questionText: string; originalIndex: number }> = [];
  const filePathsMap = file_paths as Record<string, string>;
  
  let idx = 0;
  for (const segmentKey of Object.keys(filePathsMap)) {
    // Extract part number from key prefix: part1-, part2-, part3-
    const partMatch = String(segmentKey).match(/^part([123])-q(.+)$/);
    let partNumber: 1 | 2 | 3 = 1;
    let questionId = '';
    
    if (partMatch) {
      partNumber = Number(partMatch[1]) as 1 | 2 | 3;
      questionId = partMatch[2]; // This may contain additional hyphens
    } else {
      // Fallback - try simpler pattern
      const simpleMatch = String(segmentKey).match(/^part([123])-/);
      if (simpleMatch) {
        partNumber = Number(simpleMatch[1]) as 1 | 2 | 3;
      }
      console.warn(`[processJob] Segment key ${segmentKey} has unusual format, defaulting to part ${partNumber}`);
    }
    
    // Try to find question context, but don't skip if not found
    const q = questionById.get(questionId);
    segmentList.push({
      segmentKey,
      partNumber,
      questionNumber: q?.questionNumber ?? (idx + 1),
      questionText: q?.questionText ?? `Question for ${segmentKey}`,
      originalIndex: idx,
    });
    idx++;
  }

  // Sort by part number, then by question number, then by original order
  const orderedSegments = segmentList.sort((a, b) => {
    if (a.partNumber !== b.partNumber) return a.partNumber - b.partNumber;
    if (a.questionNumber !== b.questionNumber) return a.questionNumber - b.questionNumber;
    return a.originalIndex - b.originalIndex;
  });

  console.log(`[processJob] Processing ${orderedSegments.length} segments from file_paths`);

  // Download audio files in exact order
  console.log('[processJob] Downloading audio files from R2...');
  const audioFiles: { index: number; key: string; bytes: Uint8Array; mimeType: string }[] = [];

  for (let i = 0; i < orderedSegments.length; i++) {
    const segment = orderedSegments[i];
    const r2Path = filePathsMap[segment.segmentKey];
    
    if (!r2Path) {
      console.warn(`[processJob] No R2 path for segment: ${segment.segmentKey}`);
      continue;
    }
    
    try {
      console.log(`[processJob] [${i}] Downloading Part ${segment.partNumber} Q${segment.questionNumber}: ${segment.segmentKey}`);
      const result = await getFromR2(r2Path);
      if (!result.success || !result.bytes) throw new Error(result.error || 'Download failed');
      
      const ext = r2Path.split('.').pop()?.toLowerCase() || 'webm';
      const mimeType = ext === 'mp3' ? 'audio/mpeg' : 'audio/webm';
      
      audioFiles.push({ index: i, key: segment.segmentKey, bytes: result.bytes, mimeType });
      console.log(`[processJob] [${i}] Downloaded: ${result.bytes.length} bytes`);
    } catch (e) {
      console.error(`[processJob] Download error for ${segment.segmentKey}:`, e);
    }
  }

  if (audioFiles.length === 0) throw new Error('No audio files downloaded');

  // Build API key queue
  interface KeyCandidate { key: string; keyId: string | null; isUserProvided: boolean; }
  const keyQueue: KeyCandidate[] = [];

  // User's key first
  const { data: userSecret } = await supabaseService
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
      console.warn('[processJob] Failed to decrypt user key:', e);
    }
  }

  // Admin keys - get keys available for ALL models we might use
  const dbApiKeys = await getActiveGeminiKeysForModels(supabaseService, GEMINI_MODELS);
  for (const dbKey of dbApiKeys) {
    keyQueue.push({ key: dbKey.key_value, keyId: dbKey.id, isUserProvided: false });
  }

  if (keyQueue.length === 0) throw new Error('No API keys available');

  console.log(`[processJob] Key queue: ${keyQueue.length} keys`);

  // Build prompt with explicit audio indexing
  const prompt = buildPrompt(payload, topic || testRow.topic, difficulty || testRow.difficulty, fluency_flag, orderedSegments);

  // Evaluation loop
  let evaluationResult: any = null;
  let usedModel: string | null = null;

  for (const candidateKey of keyQueue) {
    if (evaluationResult) break;
    
    console.log(`[processJob] Trying key ${candidateKey.isUserProvided ? '(user)' : `(admin: ${candidateKey.keyId})`}`);

    try {
      const genAI = new GoogleGenerativeAI(candidateKey.key);
      
      // Upload files with EXPLICIT index in filename for Gemini to reference
      const fileUris: Array<{ index: number; fileData: { mimeType: string; fileUri: string } }> = [];
      
      console.log(`[processJob] Uploading ${audioFiles.length} files to Google File API...`);
      
      for (const audioFile of audioFiles) {
        // Include explicit index in filename: "AUDIO_INDEX_0_part1-q123.webm"
        const explicitFileName = `AUDIO_INDEX_${audioFile.index}_${audioFile.key}.webm`;
        const uploadResult = await uploadToGoogleFileAPI(
          candidateKey.key,
          audioFile.bytes,
          explicitFileName,
          audioFile.mimeType
        );
        
        fileUris.push({
          index: audioFile.index,
          fileData: { mimeType: uploadResult.mimeType, fileUri: uploadResult.uri }
        });
      }
      
      // Sort by index to guarantee order
      fileUris.sort((a, b) => a.index - b.index);
      
      console.log(`[processJob] Uploaded ${fileUris.length} files`);

      for (const modelName of GEMINI_MODELS) {
        if (evaluationResult) break;

        console.log(`[processJob] Attempting evaluation with model: ${modelName}`);
        
        const model = genAI.getGenerativeModel({ 
          model: modelName,
          generationConfig: { temperature: 0.3, maxOutputTokens: 65000 },
        });

        // Build content: files in order, then prompt
        // CRITICAL: Gemini expects { fileData: { mimeType, fileUri } } NOT just the inner object
        const contentParts: any[] = [
          ...fileUris.map(f => ({ fileData: f.fileData })),
          { text: prompt }
        ];

        const MAX_RETRIES = 4;
        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
          try {
            const response = await model.generateContent({ contents: [{ role: 'user', parts: contentParts }] });
            const text = response.response?.text?.() || '';

            if (!text) {
              console.warn(`[processJob] Empty response from ${modelName}`);
              break;
            }

            const parsed = parseJson(text);
            if (parsed) {
              evaluationResult = parsed;
              usedModel = modelName;
              console.log(`[processJob] Success with ${modelName}`);
              break;
            } else {
              console.warn(`[processJob] Failed to parse JSON`);
              break;
            }
          } catch (err: any) {
            const errMsg = String(err?.message || '');
            console.error(`[processJob] ${modelName} failed (${attempt + 1}/${MAX_RETRIES}):`, errMsg.slice(0, 200));

            // Check for PERMANENT daily quota exhaustion - use strict check
            if (isDailyQuotaExhaustedError(err)) {
              console.log(`[processJob] Daily quota exhausted for ${modelName}, marking model exhausted`);
              if (!candidateKey.isUserProvided && candidateKey.keyId) {
                await markModelQuotaExhausted(supabaseService, candidateKey.keyId, modelName);
              }
              throw new QuotaError(errMsg, { permanent: true });
            }

            if (isQuotaExhaustedError(errMsg)) {
              const retryAfter = extractRetryAfterSeconds(err);
              if (attempt < MAX_RETRIES - 1) {
                const delay = retryAfter ? Math.min(retryAfter * 1000, 60000) : exponentialBackoffWithJitter(attempt, 2000, 60000);
                console.log(`[processJob] Rate limited, retrying in ${Math.round(delay / 1000)}s...`);
                await sleep(delay);
                continue;
              } else {
                throw new QuotaError(errMsg, { permanent: false });
              }
            }

            if (attempt < MAX_RETRIES - 1) {
              const delay = exponentialBackoffWithJitter(attempt, 1000, 30000);
              console.log(`[processJob] Transient error, retrying in ${Math.round(delay / 1000)}s...`);
              await sleep(delay);
              continue;
            }
            break;
          }
        }
      }
    } catch (keyError: any) {
      if (keyError instanceof QuotaError) {
        console.log(`[processJob] Key quota exhausted, trying next...`);
        continue;
      }
      console.error(`[processJob] Key error:`, keyError?.message);
    }
  }

  if (!evaluationResult) throw new Error('Evaluation failed: all models/keys exhausted');

  const overallBand = evaluationResult.overall_band || calculateBand(evaluationResult);

  // Build public audio URLs
  const publicBase = (Deno.env.get('R2_PUBLIC_URL') || '').replace(/\/$/, '');
  const audioUrls: Record<string, string> = {};
  if (publicBase) {
    for (const [k, r2Key] of Object.entries(file_paths as Record<string, string>)) {
      audioUrls[k] = `${publicBase}/${String(r2Key).replace(/^\//, '')}`;
    }
  }

  // Save result
  const { data: resultRow, error: saveError } = await supabaseService
    .from('ai_practice_results')
    .insert({
      test_id,
      user_id: userId,
      module: 'speaking',
      score: Math.round(overallBand * 10),
      band_score: overallBand,
      total_questions: audioFiles.length,
      time_spent_seconds: durations ? Math.round(Object.values(durations as Record<string, number>).reduce((a, b) => a + b, 0)) : 60,
      question_results: evaluationResult,
      answers: {
        audio_urls: audioUrls,
        transcripts_by_part: evaluationResult?.transcripts_by_part || {},
        transcripts_by_question: evaluationResult?.transcripts_by_question || {},
        file_paths,
      },
      completed_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (saveError) console.error('[processJob] Save error:', saveError);

  // Mark job completed
  await supabaseService
    .from('speaking_evaluation_jobs')
    .update({
      status: 'completed',
      result_id: resultRow?.id,
      completed_at: new Date().toISOString(),
    })
    .eq('id', jobId);

  console.log(`[processJob] Complete, band: ${overallBand}, result_id: ${resultRow?.id}`);
}

/**
 * Process text-based evaluation when transcripts are available from browser speech recognition
 */
async function processTextBasedEvaluation(job: any, supabaseService: any, appEncryptionKey: string): Promise<void> {
  const { id: jobId, user_id: userId, test_id, file_paths, durations, partial_results, topic, difficulty, fluency_flag } = job;
  const transcripts = partial_results?.transcripts || {};

  console.log(`[processTextBasedEvaluation] Starting for job ${jobId} with ${Object.keys(transcripts).length} segments`);

  // Get test payload
  const { data: testRow } = await supabaseService
    .from('ai_practice_tests')
    .select('payload, topic, difficulty, preset_id')
    .eq('id', test_id)
    .eq('user_id', userId)
    .maybeSingle();

  if (!testRow) throw new Error('Test not found');

  // Build API key queue (user key first, then admin keys)
  interface KeyCandidate { key: string; keyId: string | null; isUserProvided: boolean; }
  const keyQueue: KeyCandidate[] = [];

  const { data: userSecret, error: userSecretError } = await supabaseService
    .from('user_secrets')
    .select('encrypted_value')
    .eq('user_id', userId)
    .eq('secret_name', 'GEMINI_API_KEY')
    .maybeSingle();

  if (userSecretError) {
    console.warn('[processTextBasedEvaluation] Failed to fetch user secret:', userSecretError.message);
  }

  if (userSecret?.encrypted_value && appEncryptionKey) {
    try {
      const userKey = await decryptKey(userSecret.encrypted_value, appEncryptionKey);
      keyQueue.push({ key: userKey, keyId: null, isUserProvided: true });
    } catch (e) {
      console.warn('[processTextBasedEvaluation] Failed to decrypt user key:', e);
    }
  }

  // Only use gemini-2.5-flash - no fallback to older models
  const TEXT_MODELS = ['gemini-2.5-flash'];
  const dbApiKeys = await getActiveGeminiKeysForModels(supabaseService, TEXT_MODELS);
  for (const dbKey of dbApiKeys) {
    keyQueue.push({ key: dbKey.key_value, keyId: dbKey.id, isUserProvided: false });
  }

  if (keyQueue.length === 0) throw new Error('No API keys available');

  // Build the prompt
  const prompt = buildTextPrompt(transcripts, topic || testRow.topic, difficulty || testRow.difficulty, fluency_flag, testRow.payload);

  let evaluationResult: any = null;
  const MAX_KEY_RETRIES = 3; // Retry each key up to 3 times with backoff

  for (const candidateKey of keyQueue) {
    if (evaluationResult) break;

    const genAI = new GoogleGenerativeAI(candidateKey.key);

    for (const modelName of TEXT_MODELS) {
      if (evaluationResult) break;

      // Retry loop with exponential backoff for each model
      for (let attempt = 0; attempt < MAX_KEY_RETRIES; attempt++) {
        try {
          console.log(`[processTextBasedEvaluation] Trying ${modelName} (attempt ${attempt + 1}/${MAX_KEY_RETRIES})`);
          
          // Update heartbeat to prevent watchdog from killing us
          await supabaseService
            .from('speaking_evaluation_jobs')
            .update({ heartbeat_at: new Date().toISOString() })
            .eq('id', jobId);
          
          const model = genAI.getGenerativeModel({
            model: modelName,
            generationConfig: { temperature: 0.3, maxOutputTokens: 8000 },
          });

          const response = await model.generateContent(prompt);
          const text = response.response?.text?.() || '';

          if (!text) {
            console.warn(`[processTextBasedEvaluation] Empty response from ${modelName}`);
            break; // Move to next model
          }

          const parsed = parseJson(text);
          if (parsed) {
            evaluationResult = parsed;
            console.log(`[processTextBasedEvaluation] Success with ${modelName} on attempt ${attempt + 1}`);
            break;
          } else {
            console.warn(`[processTextBasedEvaluation] Failed to parse JSON from ${modelName}`);
            break; // Move to next model
          }
        } catch (err: any) {
          const errMsg = String(err?.message || '');
          console.error(`[processTextBasedEvaluation] ${modelName} error (attempt ${attempt + 1}):`, errMsg.slice(0, 200));

          // Check for PERMANENT daily quota exhaustion
          if (isDailyQuotaExhaustedError(err)) {
            console.log(`[processTextBasedEvaluation] Daily quota exhausted for ${modelName}, marking model exhausted`);
            if (!candidateKey.isUserProvided && candidateKey.keyId) {
              await markModelQuotaExhausted(supabaseService, candidateKey.keyId, modelName);
            }
            break; // Move to next key - this model is done for the day
          }

          // Check for temporary rate limit errors - retry with backoff
          if (isQuotaExhaustedError(errMsg)) {
            const retryAfter = extractRetryAfterSeconds(err);
            if (attempt < MAX_KEY_RETRIES - 1) {
              const delay = retryAfter 
                ? Math.min(retryAfter * 1000, 60000) 
                : exponentialBackoffWithJitter(attempt, 2000, 60000);
              console.log(`[processTextBasedEvaluation] Rate limited, retrying in ${Math.round(delay / 1000)}s...`);
              await sleep(delay);
              continue;
            }
          }

          // For transient errors, also retry with backoff
          if (attempt < MAX_KEY_RETRIES - 1) {
            const delay = exponentialBackoffWithJitter(attempt, 1000, 30000);
            console.log(`[processTextBasedEvaluation] Transient error, retrying in ${Math.round(delay / 1000)}s...`);
            await sleep(delay);
            continue;
          }
          
          // All retries exhausted for this model, move to next
          break;
        }
      }
    }
  }

  if (!evaluationResult) throw new Error('Text evaluation failed: all models/keys exhausted after retries');

  const overallBand = evaluationResult.overall_band || calculateBand(evaluationResult);

  // Build public audio URLs if available
  const publicBase = (Deno.env.get('R2_PUBLIC_URL') || '').replace(/\/$/, '');
  const audioUrls: Record<string, string> = {};
  if (publicBase && file_paths) {
    for (const [k, r2Key] of Object.entries(file_paths as Record<string, string>)) {
      audioUrls[k] = `${publicBase}/${String(r2Key).replace(/^\//, '')}`;
    }
  }

  // Save result with transcripts included
  const { data: resultRow, error: saveError } = await supabaseService
    .from('ai_practice_results')
    .insert({
      test_id,
      user_id: userId,
      module: 'speaking',
      score: Math.round(overallBand * 10),
      band_score: overallBand,
      total_questions: Object.keys(transcripts).length,
      time_spent_seconds: durations ? Math.round(Object.values(durations as Record<string, number>).reduce((a, b) => a + b, 0)) : 60,
      question_results: evaluationResult,
      answers: {
        audio_urls: audioUrls,
        transcripts,  // Include the rich transcript data
        transcripts_by_part: evaluationResult?.transcripts_by_part || {},
        transcripts_by_question: evaluationResult?.transcripts_by_question || {},
        file_paths,
      },
      completed_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (saveError) console.error('[processTextBasedEvaluation] Save error:', saveError);

  // Mark job completed
  await supabaseService
    .from('speaking_evaluation_jobs')
    .update({
      status: 'completed',
      result_id: resultRow?.id,
      completed_at: new Date().toISOString(),
    })
    .eq('id', jobId);

  console.log(`[processTextBasedEvaluation] Complete, band: ${overallBand}, result_id: ${resultRow?.id}`);
}

function buildTextPrompt(
  transcripts: Record<string, any>,
  topic: string,
  difficulty: string,
  fluencyFlag: boolean,
  payload?: any
): string {
  const parts = Array.isArray(payload?.speakingParts) ? payload.speakingParts : [];
  const questionById = new Map<string, { partNumber: number; questionNumber: number; questionText: string }>();
  
  for (const p of parts) {
    for (const q of (p?.questions || [])) {
      questionById.set(String(q?.id), { 
        partNumber: Number(p?.part_number), 
        questionNumber: Number(q?.question_number),
        questionText: q?.question_text || '' 
      });
    }
  }

  // Build ordered segment list with metadata
  const orderedSegments = Object.entries(transcripts)
    .map(([key, d]: [string, any]) => {
      const match = key.match(/^part([123])-q(.+)$/);
      const partNum = match ? parseInt(match[1]) : 0;
      const questionId = match ? match[2] : '';
      const qInfo = questionById.get(questionId);
      
      const wpm = d?.fluencyMetrics?.wordsPerMinute || 0;
      const fillers = d?.fluencyMetrics?.fillerCount || 0;
      const pauses = d?.fluencyMetrics?.pauseCount || 0;
      const clarity = d?.overallClarityScore || 0;
      const pitch = d?.prosodyMetrics?.pitchVariation || 0;
      const duration = d?.durationMs ? Math.round(d.durationMs / 1000) : 0;
      const transcript = d?.rawTranscript || d?.cleanedTranscript || '';
      
      return {
        key,
        partNum,
        questionNumber: qInfo?.questionNumber || 0,
        questionText: qInfo?.questionText || 'Unknown',
        transcript,
        wpm,
        fillers,
        pauses,
        clarity,
        pitch,
        duration,
      };
    })
    .sort((a, b) => {
      if (a.partNum !== b.partNum) return a.partNum - b.partNum;
      return a.questionNumber - b.questionNumber;
    });

  const segmentSummaries = orderedSegments.map((seg, idx) => `
### SEGMENT_${idx}: ${seg.key.toUpperCase()}
Part ${seg.partNum} | Question ${seg.questionNumber}: "${seg.questionText}"
Transcript: "${seg.transcript}"
Duration: ${seg.duration}s | WPM: ${seg.wpm}
Fillers: ${seg.fillers} | Pauses: ${seg.pauses}
Clarity: ${seg.clarity}% | Pitch Variation: ${seg.pitch.toFixed(0)}%`).join('\n');

  const numSegments = orderedSegments.length;

  return `You are an OFFICIAL IELTS SPEAKING EXAMINER operating under strict British Council and IDP examination standards.

═══════════════════════════════════════════════════════════════════════════════
CRITICAL EXAMINATION PROTOCOL
═══════════════════════════════════════════════════════════════════════════════

You MUST evaluate this candidate EXACTLY as a real IELTS examiner would in an official test center. Your assessment must be:

1. **INDISTINGUISHABLE FROM HUMAN EXAMINER** - Your scores must match what a certified IELTS examiner would give in a live test. No inflation. No deflation.

2. **STRICTLY OBJECTIVE** - Personal opinions are irrelevant. Only the official IELTS Band Descriptors determine the score. Every score must be justified by specific evidence from the candidate's speech.

3. **PROFESSIONALLY CALIBRATED** - Band 9 is exceptionally rare (native-level fluency with no errors). Band 7+ requires consistent demonstration of complex language use. Most candidates score 5.5-6.5.

4. **EVIDENCE-BASED SCORING** - Each band score MUST be supported by:
   - Direct quotes from the candidate's response
   - Specific examples of strengths and weaknesses
   - Clear explanation of why the score is NOT higher or lower

═══════════════════════════════════════════════════════════════════════════════
EXAMINATION CONTEXT
═══════════════════════════════════════════════════════════════════════════════

Topic: ${topic} | Difficulty Level: ${difficulty} | Total Responses: ${numSegments}
${fluencyFlag ? '⚠️ FLUENCY PENALTY APPLICABLE: Part 2 speaking time below 80 seconds indicates insufficient response length.' : ''}

═══════════════════════════════════════════════════════════════════════════════
TRANSCRIPT CORRECTION PROTOCOL
═══════════════════════════════════════════════════════════════════════════════

The transcripts below contain SPEECH RECOGNITION ERRORS from browser-based transcription.
Apply your expertise to INTELLIGENTLY CORRECT obvious errors while preserving the candidate's actual language use.

Example corrections:
- "10 kilo would like" → "The skill I would like"
- "I'm gonna go to" → "I'm going to go to" (preserve informal register if candidate used it)

DO NOT:
- Add vocabulary the candidate did not use
- Correct grammatical errors (those reflect the candidate's actual language ability)
- Change the meaning or content of responses

═══════════════════════════════════════════════════════════════════════════════
CANDIDATE RESPONSES (Raw Transcripts - Correct Recognition Errors Only)
═══════════════════════════════════════════════════════════════════════════════

${segmentSummaries}

═══════════════════════════════════════════════════════════════════════════════
OFFICIAL IELTS SPEAKING BAND DESCRIPTORS (MANDATORY APPLICATION)
═══════════════════════════════════════════════════════════════════════════════

FLUENCY AND COHERENCE (FC):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Band 9: Speaks fluently with only rare repetition or self-correction. Any hesitation is content-related. Develops topics fully and coherently.
• Band 8: Speaks fluently with only occasional repetition or self-correction. Hesitation is usually content-related. Develops topics coherently.
• Band 7: Speaks at length without noticeable effort or loss of coherence. May demonstrate language-related hesitation. Uses range of connectives.
• Band 6: Is willing to speak at length though may lose coherence due to occasional repetition, self-correction or hesitation. Uses connectives but not always appropriately.
• Band 5: Maintains flow of speech but uses repetition, self-correction and/or slow speech to keep going. May over-use certain connectives.
• Band 4: Cannot respond without noticeable pauses. Speech may be slow. Frequently repeats and/or self-corrects.

LEXICAL RESOURCE (LR):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Band 9: Uses vocabulary with full flexibility and precision. Uses idiomatic language naturally and accurately.
• Band 8: Uses a wide vocabulary resource readily and flexibly. Uses less common and idiomatic vocabulary skillfully.
• Band 7: Uses vocabulary resource flexibly to discuss variety of topics. Uses some less common and idiomatic vocabulary.
• Band 6: Has a wide enough vocabulary for topic but sometimes lacks precision. Uses paraphrase effectively.
• Band 5: Manages to talk about familiar and unfamiliar topics but uses vocabulary with limited flexibility. May make errors in word choice.
• Band 4: Uses basic vocabulary for familiar topics. Frequently makes errors. Rarely attempts paraphrase.

GRAMMATICAL RANGE AND ACCURACY (GRA):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Band 9: Uses a full range of structures naturally and appropriately. Consistently produces accurate structures.
• Band 8: Uses a wide range of structures flexibly. Majority of sentences are error-free. Makes only occasional mistakes.
• Band 7: Uses a range of complex structures with some flexibility. Frequently produces error-free sentences though some grammatical mistakes persist.
• Band 6: Uses a mix of simple and complex structures but with limited flexibility. May make frequent mistakes with complex structures.
• Band 5: Produces basic sentence forms with reasonable accuracy. Uses limited range of complex structures.
• Band 4: Uses only basic sentence forms. Makes frequent errors. Rarely uses complex structures.

PRONUNCIATION (P) - Assessed via Speech Recognition Patterns:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Band 9: Uses full range of pronunciation features with precision and subtlety. Effortlessly comprehensible throughout.
• Band 8: Uses a wide range of features. Sustains flexible use of features with only occasional lapses. Easy to understand.
• Band 7: Shows all positive features of Band 6 and some of Band 8. Generally easy to understand.
• Band 6: Uses range of features with mixed control. Can generally be understood but mispronunciation occasionally causes strain.
• Band 5: Shows some effective use of features but not sustained. Mispronunciations are frequent and cause some difficulty.
• Band 4: Uses limited range of features. Frequently unintelligible.

NOTE: Pronunciation is estimated from speech recognition confidence patterns. Include disclaimer in output.

═══════════════════════════════════════════════════════════════════════════════
SCORING CALIBRATION GUIDANCE
═══════════════════════════════════════════════════════════════════════════════

AVOID THESE COMMON ERRORS:
✗ Giving Band 7+ for simple vocabulary even if error-free (complexity required)
✗ Giving Band 8+ unless candidate demonstrates exceptional, near-native fluency
✗ Inflating scores due to interesting content (we assess LANGUAGE, not ideas)
✗ Deflating scores due to accent (intelligibility matters, not accent type)
✗ Giving same band across all criteria (candidates typically vary ±1 band between criteria)

CALIBRATION CHECKPOINTS:
• Is this score justified by SPECIFIC examples from the transcript?
• Would a certified IELTS examiner agree with this score?
• Have I applied ALL relevant descriptors, not just favorable ones?
• Am I assessing LANGUAGE ABILITY, not personality or content?

═══════════════════════════════════════════════════════════════════════════════
REQUIRED JSON OUTPUT FORMAT
═══════════════════════════════════════════════════════════════════════════════

\`\`\`json
{
  "overall_band": 6.5,
  "criteria": {
    "fluency_coherence": { "band": 6.5, "feedback": "...", "strengths": ["..."], "weaknesses": ["..."], "suggestions": ["..."] },
    "lexical_resource": { "band": 6.0, "feedback": "...", "strengths": ["..."], "weaknesses": ["..."], "suggestions": ["..."] },
    "grammatical_range": { "band": 6.5, "feedback": "...", "strengths": ["..."], "weaknesses": ["..."], "suggestions": ["..."] },
    "pronunciation": { "band": 6.0, "feedback": "...", "strengths": ["..."], "weaknesses": ["..."], "suggestions": ["..."], "disclaimer": "Estimated from speech recognition patterns" }
  },
  "summary": "Examiner's overall assessment summary (2-3 sentences)",
  "examiner_notes": "Professional observation on candidate's key areas for development",
  "lexical_upgrades": [{"original": "word used", "upgraded": "band 8+ alternative", "context": "usage example"}],
  "improvement_priorities": ["Priority 1...", "Priority 2..."],
  "strengths_to_maintain": ["Strength 1...", "Strength 2..."],
  "part_analysis": [
    {
      "part_number": 1,
      "performance_notes": "Part 1 assessment",
      "key_moments": ["Positive moment 1"],
      "areas_for_improvement": ["Area 1"]
    }
  ],
  "transcripts_by_part": {
    "1": "Combined corrected transcript for Part 1...",
    "2": "Combined corrected transcript for Part 2...",
    "3": "Combined corrected transcript for Part 3..."
  },
  "transcripts_by_question": {
    "1": [{"segment_key": "part1-q...", "question_number": 1, "question_text": "...", "transcript": "..."}],
    "2": [{"segment_key": "part2-q...", "question_number": 1, "question_text": "...", "transcript": "..."}],
    "3": [{"segment_key": "part3-q...", "question_number": 1, "question_text": "...", "transcript": "..."}]
  },
  "modelAnswers": [
    {
      "segment_key": "part1-q...",
      "partNumber": 1,
      "questionNumber": 1,
      "question": "Question text",
      "candidateResponse": "Corrected transcript (speech recognition errors fixed)",
      "estimatedBand": 5.5,
      "modelAnswer": "Band 8+ model response demonstrating excellent language use",
      "whyItWorks": ["Uses sophisticated vocabulary", "Demonstrates complex grammar", "Maintains fluent delivery"],
      "keyImprovements": ["Specific improvement 1", "Specific improvement 2"]
    }
  ]
}
\`\`\`

═══════════════════════════════════════════════════════════════════════════════
FINAL INSTRUCTIONS
═══════════════════════════════════════════════════════════════════════════════

1. Return EXACTLY ${numSegments} modelAnswers (one per segment above)
2. Use the EXACT segment_key from input (e.g., "part1-q123")
3. Provide CORRECTED transcript as candidateResponse
4. Generate REALISTIC band 8+ model answers
5. Include part_analysis for each part with responses
6. Group transcripts by part and by question

Return ONLY valid JSON. No preamble. No explanation.`;
}

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

  const numQ = orderedSegments.length;
  
  // Build explicit audio mapping section
  const audioMappingLines = orderedSegments.map((seg, idx) => 
    `AUDIO_${idx}: "${seg.segmentKey}" → Part ${seg.partNumber}, Question ${seg.questionNumber}: "${seg.questionText}"`
  ).join('\n');

  return `You are a CERTIFIED SENIOR IELTS Speaking Examiner with 20+ years of experience.
Evaluate exactly as an official IELTS examiner. Return ONLY valid JSON.

CONTEXT: Topic: ${topic || 'General'}, Difficulty: ${difficulty || 'Medium'}, Questions: ${numQ}
${fluencyFlag ? '⚠️ Part 2 speaking time under 80 seconds - apply fluency penalty.' : ''}

══════════════════════════════════════════════════════════════
CRITICAL: AUDIO-TO-QUESTION MAPPING (FIXED - DO NOT CHANGE!)
══════════════════════════════════════════════════════════════
The ${numQ} audio files are provided in this EXACT fixed order:

${audioMappingLines}

RULES:
1. Audio file at position 0 = AUDIO_0 = first segment in the list above
2. Audio file at position 1 = AUDIO_1 = second segment in the list above
3. Continue this pattern for ALL files
4. The file names contain "AUDIO_INDEX_N" where N is the position
5. DO NOT reorder, swap, or guess. The mapping is FIXED.
6. Transcribe each audio to its corresponding question EXACTLY as mapped above

══════════════════════════════════════════════════════════════
OFFICIAL IELTS BAND DESCRIPTORS (MANDATORY)
══════════════════════════════════════════════════════════════

FLUENCY AND COHERENCE (FC):
- Band 9: Speaks fluently with rare hesitation; hesitation is content-related
- Band 7: Speaks at length without noticeable effort; some language-related hesitation
- Band 5: Maintains flow with repetition/self-correction/slow speech
- Band 4: Cannot respond without noticeable pauses; frequent repetition

LEXICAL RESOURCE (LR):
- Band 9: Full flexibility; idiomatic language naturally
- Band 7: Flexible vocabulary; some less common/idiomatic vocabulary
- Band 5: Limited vocabulary; pauses to search for words
- Band 4: Basic vocabulary, repetitive or inappropriate

GRAMMATICAL RANGE AND ACCURACY (GRA):
- Band 9: Full range of structures; consistently accurate
- Band 7: Range of complex structures; frequently error-free
- Band 5: Basic sentence forms; limited complex structures
- Band 4: Basic sentences; subordinate structures rare

PRONUNCIATION (P):
- Band 9: Full range of features with precision
- Band 7: Most features of Band 8; some L1 influence
- Band 5: Some Band 6 features; mispronounces individual words
- Band 4: Limited features; frequent mispronunciations

SCORING GUIDELINES:
- Short responses (<15 words): Max Band 4.0-4.5
- Off-topic: Severe FC penalty (1-2 bands)
- No response: Band 1.0-2.0
- Part 2: Holistic evaluation - quality > quantity
- Excellent concise Part 2 that fully addresses cue card can score Band 8+

EXACT JSON OUTPUT SCHEMA:
{
  "overall_band": 6.0,
  "criteria": {
    "fluency_coherence": {"band": 6.0, "feedback": "...", "strengths": [...], "weaknesses": [...], "suggestions": [...]},
    "lexical_resource": {"band": 6.0, "feedback": "...", "strengths": [...], "weaknesses": [...], "suggestions": [...]},
    "grammatical_range": {"band": 5.5, "feedback": "...", "strengths": [...], "weaknesses": [...], "suggestions": [...]},
    "pronunciation": {"band": 6.0, "feedback": "...", "strengths": [...], "weaknesses": [...], "suggestions": [...]}
  },
  "summary": "Overall performance summary",
  "lexical_upgrades": [{"original": "...", "upgraded": "...", "context": "..."}],
  "part_analysis": [{"part_number": 1, "performance_notes": "...", "key_moments": [...]}],
  "improvement_priorities": ["Priority 1...", "Priority 2..."],
  "transcripts_by_part": {"1": "...", "2": "...", "3": "..."},
  "transcripts_by_question": {
    "1": [{"segment_key": "part1-q...", "question_number": 1, "question_text": "...", "transcript": "..."}],
    "2": [...],
    "3": [...]
  },
  "modelAnswers": [
    {
      "segment_key": "MUST match segment_key from audio mapping",
      "partNumber": 1,
      "questionNumber": 1,
      "question": "Question text",
      "candidateResponse": "EXACT transcript",
      "estimatedBand": 5.5,
      "modelAnswer": "Model answer",
      "whyItWorks": [...],
      "keyImprovements": [...]
    }
  ]
}

QUESTIONS JSON: ${JSON.stringify(questions)}

REMINDER: There are exactly ${numQ} audio files. Return exactly ${numQ} modelAnswers with correct segment_keys matching the AUDIO_0 to AUDIO_${numQ - 1} mapping above.`;
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
  
  // Step 1: Calculate criterion-based score (fluency, lexical, grammatical, pronunciation)
  const criterionScores = c ? [
    c.fluency_coherence?.band,
    c.lexical_resource?.band,
    c.grammatical_range?.band,
    c.pronunciation?.band,
  ].filter(s => typeof s === 'number') : [];
  
  const criterionAvg = criterionScores.length > 0
    ? criterionScores.reduce((a: number, b: number) => a + b, 0) / criterionScores.length
    : 6.0;
  
  // Step 2: Extract per-question scores from modelAnswers
  const modelAnswers = Array.isArray(result.modelAnswers) ? result.modelAnswers : [];
  const questionScores = modelAnswers
    .map((ma: any) => {
      const band = ma.estimatedBand ?? ma.estimated_band ?? ma.questionBandScore ?? ma.question_band_score;
      const partNum = ma.partNumber ?? ma.part_number ?? 1;
      return { band: typeof band === 'number' ? band : null, partNum };
    })
    .filter((qs: any) => qs.band !== null);
  
  console.log(`[calculateBand] Criterion avg: ${criterionAvg.toFixed(2)}, Question scores: ${questionScores.length}`);
  
  // If no per-question scores, fall back to criterion average
  if (questionScores.length === 0) {
    return Math.round(criterionAvg * 2) / 2;
  }
  
  // Step 3: Group question scores by part for weighted calculation
  const scoresByPart: Record<number, number[]> = { 1: [], 2: [], 3: [] };
  for (const qs of questionScores) {
    const partNum = qs.partNum;
    if (partNum >= 1 && partNum <= 3) {
      scoresByPart[partNum].push(qs.band);
    }
  }
  
  // Calculate weighted average: each part with questions gets equal weight
  const partsWithScores = Object.entries(scoresByPart)
    .filter(([_, scores]) => scores.length > 0)
    .map(([partNum, scores]) => ({
      partNum: parseInt(partNum),
      avgScore: scores.reduce((a, b) => a + b, 0) / scores.length,
    }));
  
  if (partsWithScores.length === 0) {
    return Math.round(criterionAvg * 2) / 2;
  }
  
  const weightedAvgQuestionScore = partsWithScores.reduce((sum, p) => sum + p.avgScore, 0) / partsWithScores.length;
  console.log(`[calculateBand] Weighted avg question score: ${weightedAvgQuestionScore.toFixed(2)} from ${partsWithScores.length} parts`);
  console.log(`[calculateBand] Per-part averages: ${partsWithScores.map(p => `P${p.partNum}=${p.avgScore.toFixed(1)}`).join(', ')}`);
  
  // Step 4: Count minimal responses (score <= 2) for penalty caps
  const minimalCount = questionScores.filter((qs: any) => qs.band <= 2).length;
  const minimalRatio = minimalCount / questionScores.length;
  console.log(`[calculateBand] Minimal responses: ${minimalCount}/${questionScores.length} (${(minimalRatio * 100).toFixed(0)}%)`);
  
  // Apply penalty caps based on minimal response count
  let maxAllowedBand = 9.0;
  if (minimalRatio >= 0.5) {
    maxAllowedBand = 4.0; // 50% or more minimal responses
    console.log(`[calculateBand] Capping band to ${maxAllowedBand} due to ${(minimalRatio * 100).toFixed(0)}% minimal responses`);
  } else if (minimalRatio >= 0.3) {
    maxAllowedBand = 5.0; // 30% or more minimal responses
    console.log(`[calculateBand] Capping band to ${maxAllowedBand} due to ${(minimalRatio * 100).toFixed(0)}% minimal responses`);
  }
  
  // Step 5: Calculate final band
  // Add a small bonus (max 0.5) from criterion scores, but question scores are primary
  const bonusFromCriteria = Math.min(0.5, Math.max(0, (criterionAvg - weightedAvgQuestionScore) / 2));
  const questionBasedBand = Math.round((weightedAvgQuestionScore + bonusFromCriteria) * 2) / 2;
  console.log(`[calculateBand] Question-based band: ${questionBasedBand} (weighted avg: ${weightedAvgQuestionScore.toFixed(1)}, criteria bonus: ${bonusFromCriteria.toFixed(2)})`);
  
  // Take the lower of question-based and criterion-based scores
  let overallBand = Math.min(questionBasedBand, Math.round(criterionAvg * 2) / 2);
  
  // Apply the cap for minimal responses
  if (overallBand > maxAllowedBand) {
    console.log(`[calculateBand] Reducing overall band from ${overallBand} to ${maxAllowedBand} due to minimal responses cap`);
    overallBand = maxAllowedBand;
  }
  
  console.log(`[calculateBand] FINAL overall band: ${overallBand}`);
  return overallBand;
}
