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
import {
  decryptKey,
  uploadToGoogleFileAPI,
  parseJson,
  exponentialBackoffWithJitter,
  extractRetryAfterSeconds,
  sleep,
  calculateBandFromCriteria,
  corsHeaders,
  QuotaError,
} from "../_shared/speakingUtils.ts";

/**
 * SEPARATED Speaking Job Processor (OPTIMIZED)
 * 
 * Uses shared utilities from speakingUtils.ts.
 * This function ONLY processes jobs - it does NOT create them.
 * Jobs are created by evaluate-speaking-async which returns immediately.
 */

const GEMINI_MODELS = ['gemini-2.5-flash'];

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
            stage: 'failed',
            last_error: `Evaluation failed after ${maxRetries} attempts: ${processError.message}`,
            retry_count: retryCount,
            lock_token: null,
            lock_expires_at: null,
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
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 80000, // Increased to prevent truncation of model answers
            responseMimeType: 'application/json', // Force JSON output for reliable parsing
          },
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
              console.warn(`[processJob] Failed to parse JSON from ${modelName}. First 400 chars: ${text.slice(0, 400)}`);
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

  // Calculate evaluation timing from job creation
  const jobStartTime = new Date(job.created_at).getTime();
  const totalTimeMs = Date.now() - jobStartTime;
  const evaluationTiming = {
    totalTimeMs,
    timing: { total: totalTimeMs },
  };

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
      evaluation_timing: evaluationTiming,
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

  // Check for user's personal API key in user_secrets table
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
      if (userKey && userKey.length > 0) {
        keyQueue.push({ key: userKey, keyId: null, isUserProvided: true });
        console.log('[processTextBasedEvaluation] User has personal API key configured, adding to queue');
      }
    } catch (e) {
      console.warn('[processTextBasedEvaluation] Failed to decrypt user key, skipping user key:', e);
    }
  } else {
    console.log('[processTextBasedEvaluation] No personal API key configured for user, using admin pool only');
  }

  // Add admin keys from pool
  const TEXT_MODELS = ['gemini-2.5-flash'];
  const dbApiKeys = await getActiveGeminiKeysForModels(supabaseService, TEXT_MODELS);
  console.log(`[processTextBasedEvaluation] Found ${dbApiKeys.length} admin keys in pool`);
  for (const dbKey of dbApiKeys) {
    keyQueue.push({ key: dbKey.key_value, keyId: dbKey.id, isUserProvided: false });
  }

  if (keyQueue.length === 0) throw new Error('No API keys available (user or admin)');

  // Build the prompt
  const prompt = buildTextPrompt(transcripts, topic || testRow.topic, difficulty || testRow.difficulty, fluency_flag, testRow.payload);

  // Count parts in transcripts for progress tracking
  const partsPresent = new Set<number>();
  for (const key of Object.keys(transcripts)) {
    const match = key.match(/^part([123])/);
    if (match) partsPresent.add(parseInt(match[1]));
  }
  const totalParts = partsPresent.size || 3;

  // Update progress: Starting text-based evaluation (single stage, no fake part progression)
  await supabaseService
    .from('speaking_evaluation_jobs')
    .update({ 
      stage: 'evaluating_text',
      progress: 25, 
      current_part: null, // Don't set a fake part - text evaluation is a single AI call
      total_parts: totalParts,
      updated_at: new Date().toISOString() 
    })
    .eq('id', jobId);

  let evaluationResult: any = null;
  const COOLDOWN_SECONDS = 45; // Cooldown after any error before retrying this key

  for (const candidateKey of keyQueue) {
    if (evaluationResult) break;

    const genAI = new GoogleGenerativeAI(candidateKey.key);

    for (const modelName of TEXT_MODELS) {
      if (evaluationResult) break;

      // Single attempt per key - switch key immediately on ANY error
      try {
        console.log(`[processTextBasedEvaluation] Trying ${modelName} with key ${candidateKey.isUserProvided ? '(user)' : `(admin: ${candidateKey.keyId?.slice(0, 8)}...)`}`);
        
        // Update heartbeat during evaluation (keep stage as evaluating_text)
        await supabaseService
          .from('speaking_evaluation_jobs')
          .update({ 
            heartbeat_at: new Date().toISOString(),
            progress: 40, // Progress during text evaluation
            updated_at: new Date().toISOString()
          })
          .eq('id', jobId);
        
        const model = genAI.getGenerativeModel({
          model: modelName,
          generationConfig: { 
            temperature: 0.3, 
            maxOutputTokens: 60000, // Increased significantly to prevent JSON truncation and missing model answers
            responseMimeType: 'application/json', // Force JSON output
          },
        });

        const response = await model.generateContent(prompt);
        const text = response.response?.text?.() || '';

        if (!text) {
          console.warn(`[processTextBasedEvaluation] Empty response from ${modelName}, switching to next key`);
          // Empty response - switch to next key immediately (no retry with same key)
          if (!candidateKey.isUserProvided && candidateKey.keyId) {
            await supabaseService.rpc('mark_key_rate_limited', {
              p_key_id: candidateKey.keyId,
              p_cooldown_minutes: Math.ceil(COOLDOWN_SECONDS / 60),
            });
          }
          break; // Move to next key
        }

        // Log response length for debugging
        console.log(`[processTextBasedEvaluation] Response length: ${text.length} chars`);

        // Update progress: Received response, parsing (70%)
        await supabaseService
          .from('speaking_evaluation_jobs')
          .update({ 
            progress: 70, 
            updated_at: new Date().toISOString() 
          })
          .eq('id', jobId);

        const parsed = parseJson(text);
        if (parsed) {
          evaluationResult = parsed;
          console.log(`[processTextBasedEvaluation] Success with ${modelName}`);
          
          // Update progress: Evaluation complete, finalizing (85%)
          await supabaseService
            .from('speaking_evaluation_jobs')
            .update({ 
              progress: 85, 
              updated_at: new Date().toISOString() 
            })
            .eq('id', jobId);
          
          break;
        } else {
          // Log first 500 chars to help debug truncation issues
          console.warn(`[processTextBasedEvaluation] Failed to parse JSON from ${modelName}. First 500 chars: ${text.slice(0, 500)}`);
          console.warn(`[processTextBasedEvaluation] Last 200 chars: ${text.slice(-200)}`);
          
          // Parse failure - switch to next key immediately (no retry with same key)
          console.log(`[processTextBasedEvaluation] Parse failed, switching to next key (45s cooldown for current)`);
          if (!candidateKey.isUserProvided && candidateKey.keyId) {
            await supabaseService.rpc('mark_key_rate_limited', {
              p_key_id: candidateKey.keyId,
              p_cooldown_minutes: Math.ceil(COOLDOWN_SECONDS / 60),
            });
          }
          break; // Move to next key
        }
      } catch (err: any) {
        const errMsg = String(err?.message || '');
        console.error(`[processTextBasedEvaluation] ${modelName} error:`, errMsg.slice(0, 200));

        // On ANY error: switch key immediately with 45s cooldown
        // First, mark the key appropriately based on error type
        if (isDailyQuotaExhaustedError(err)) {
          console.log(`[processTextBasedEvaluation] Daily quota exhausted for ${modelName}, marking model exhausted + switching key`);
          if (!candidateKey.isUserProvided && candidateKey.keyId) {
            await markModelQuotaExhausted(supabaseService, candidateKey.keyId, modelName);
          }
        } else {
          // Rate limit or transient error - apply 45s cooldown
          console.log(`[processTextBasedEvaluation] Error on ${modelName}, applying ${COOLDOWN_SECONDS}s cooldown + switching key`);
          if (!candidateKey.isUserProvided && candidateKey.keyId) {
            await supabaseService.rpc('mark_key_rate_limited', {
              p_key_id: candidateKey.keyId,
              p_cooldown_minutes: Math.ceil(COOLDOWN_SECONDS / 60),
            });
          }
        }
        
        // ALWAYS break to next key on ANY error - no retries with same key
        break;
      }
    }
  }

  // If all keys exhausted, queue job for 60s retry instead of failing immediately
  if (!evaluationResult) {
    const hasAdminKeys = keyQueue.some(k => !k.isUserProvided);
    
    if (hasAdminKeys) {
      console.log(`[processTextBasedEvaluation] All keys exhausted, queuing for 60s retry`);
      await supabaseService
        .from('speaking_evaluation_jobs')
        .update({
          status: 'pending',
          stage: 'pending_text_eval',
          last_error: 'All API keys temporarily rate-limited, queued for retry in 60s',
          updated_at: new Date().toISOString(),
        })
        .eq('id', jobId);
      
      // Schedule a retry after 60s by throwing a specific error that won't increment retry_count
      throw new Error('QUEUED_FOR_RETRY: All keys temporarily exhausted, will retry in 60s');
    }
    
    throw new Error('Text evaluation failed: all models/keys exhausted');
  }


  // TEXT-BASED EVALUATION PRONUNCIATION NOTE
  // Since we can't actually hear the pronunciation in text-based mode,
  // add a disclaimer. NO penalty applied - identical scoring to audio mode.
  if (evaluationResult.criteria?.pronunciation?.band !== undefined) {
    evaluationResult.criteria.pronunciation.disclaimer = 
      `Text-based evaluation: Pronunciation estimated from speech recognition patterns. ` +
      `For more precise pronunciation analysis, use Accuracy Mode.`;
  }

  // Calculate overall band - IDENTICAL to audio mode (no -0.5 penalty)
  const overallBand = calculateBand(evaluationResult);
  evaluationResult.overall_band = overallBand;

  // =========================================================================
  // ROBUST AUDIO SYNC: Wait for background audio uploads before saving result
  // =========================================================================
  // For text-based evaluation, audio is uploaded in background by the client.
  // Wait briefly to allow uploads to complete, then fetch latest file_paths from job.
  // This ensures audio URLs are properly included in the result.
  
  console.log('[processTextBasedEvaluation] Waiting for background audio uploads to sync...');
  await sleep(5000); // Wait 5 seconds for background uploads to complete
  
  // Re-fetch job to get any updated file_paths from background upload
  const { data: refreshedJob } = await supabaseService
    .from('speaking_evaluation_jobs')
    .select('file_paths')
    .eq('id', jobId)
    .single();
  
  const latestFilePaths = (refreshedJob?.file_paths && Object.keys(refreshedJob.file_paths).length > 0)
    ? refreshedJob.file_paths
    : file_paths;
  
  console.log(`[processTextBasedEvaluation] File paths after sync: ${Object.keys(latestFilePaths || {}).length} files`);
  
  // Build public audio URLs from latest file_paths
  const publicBase = (Deno.env.get('R2_PUBLIC_URL') || '').replace(/\/$/, '');
  const audioUrls: Record<string, string> = {};
  if (publicBase && latestFilePaths) {
    for (const [k, r2Key] of Object.entries(latestFilePaths as Record<string, string>)) {
      audioUrls[k] = `${publicBase}/${String(r2Key).replace(/^\//, '')}`;
    }
  }

  // Calculate evaluation timing from job creation
  const jobStartTimeText = new Date(job.created_at).getTime();
  const totalTimeMsText = Date.now() - jobStartTimeText;
  const evaluationTimingText = {
    totalTimeMs: totalTimeMsText,
    timing: { total: totalTimeMsText },
  };

  // Save result with transcripts and audio URLs included
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
        transcripts, // Include the rich transcript data (we store input transcripts, not echoed from Gemini)
        file_paths: latestFilePaths,
      },
      evaluation_timing: evaluationTimingText,
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
      
      const transcript = d?.rawTranscript || d?.cleanedTranscript || '';
      
      return {
        key,
        partNum,
        questionNumber: qInfo?.questionNumber || 0,
        questionText: qInfo?.questionText || 'Unknown',
        transcript,
      };
    })
    .sort((a, b) => {
      if (a.partNum !== b.partNum) return a.partNum - b.partNum;
      return a.questionNumber - b.questionNumber;
    });

  // Compact segment format
  const segmentSummaries = orderedSegments.map((seg) => 
    `[${seg.key}] P${seg.partNum} Q${seg.questionNumber}: "${seg.questionText}"\n> "${seg.transcript}"`
  ).join('\n\n');

  const numSegments = orderedSegments.length;

  // UNIFIED PROMPT: Copy scoring rules from audio-based evaluation (speaking-evaluate-job)
  // This ensures text-based and audio-based evaluations have identical strictness
  return `You are a CERTIFIED SENIOR IELTS Speaking Examiner evaluating candidate responses.
Return ONLY valid JSON.

CONTEXT: Topic: ${topic || 'General'}, Difficulty: ${difficulty || 'Medium'}
${fluencyFlag ? '⚠️ Speaking time under 80 seconds - apply fluency penalty.' : ''}

CANDIDATE RESPONSES (Speech Recognition Transcripts):
${segmentSummaries}

══════════════════════════════════════════════════════════════
🚨 CRITICAL: STRICT SCORING FOR INADEQUATE RESPONSES 🚨
══════════════════════════════════════════════════════════════

You MUST apply HARSH penalties for responses that are:
- OFF-TOPIC or IRRELEVANT to the question
- Extremely SHORT (under 10 meaningful words)
- REPETITIVE NONSENSE (e.g., "nice nice nice nice")
- Single word answers (e.g., "drama", "yes", "no")
- Just reading the question back

⚠️ SCORING REQUIREMENTS FOR INADEQUATE RESPONSES:
- If transcript contains < 10 meaningful words → Band 2.0-3.0 MAX
- If transcript is off-topic/irrelevant → Band 2.5-3.5 MAX
- If transcript is just repetition of same word → Band 1.5-2.5 MAX
- If transcript is single word or "[NO SPEECH]" → Band 1.0-2.0 MAX

DO NOT give Band 5+ for responses like:
❌ "nice nice nice nice that's true" → This is Band 2.0
❌ "drama" → This is Band 1.5
❌ "yes I think so" (no elaboration) → This is Band 3.0
❌ "would be very crucial" → This is Band 2.5

══════════════════════════════════════════════════════════════
SCORING GUIDELINES (APPLY STRICTLY!)
══════════════════════════════════════════════════════════════

🔴 Band 1-2: Single words, nonsense, repetition, no actual answer, <5 meaningful words
🟠 Band 2.5-3.5: 5-10 words, minimal/no relevance to question, cannot communicate ideas
🟡 Band 4-4.5: 10-20 words, limited vocabulary, basic attempt at answering
🟢 Band 5-6: Adequate response length (20+ words) with some development and relevance
🔵 Band 7+: Full, fluent, well-developed responses with clear relevance

══════════════════════════════════════════════════════════════
🚨 MANDATORY: EXAMPLES FOR ALL WEAKNESSES 🚨
══════════════════════════════════════════════════════════════

For EVERY weakness listed, you MUST include a SPECIFIC EXAMPLE from the candidate's actual response.

FORMAT: "Issue description (e.g., 'word or phrase from their answer')"

❌ BAD: "Some inaccuracies in word choice"
✅ GOOD: "Incorrect word form usage (e.g., 'travel solo-ly' instead of 'travel solo')"

══════════════════════════════════════════════════════════════
🚨 STRICT MODEL ANSWER WORD LIMITS 🚨
══════════════════════════════════════════════════════════════

Part 1: 35-45 words (target: 40 words)
Part 2: 130-150 words (target: 140 words) - MANDATORY!
Part 3: 50-60 words (target: 55 words)

⚠️ Model answers outside this range are INVALID.
Count words carefully before outputting.

CRITICAL: You MUST provide model answers for ALL ${numSegments} questions,
EVEN IF the transcript shows "(Transcript unavailable)" or is empty.
Generate the model answer based on the QUESTION TEXT alone.

══════════════════════════════════════════════════════════════
OUTPUT JSON SCHEMA
══════════════════════════════════════════════════════════════
{
  "overall_band": 6.0,
  "criteria": {
    "fluency_coherence": {"band": 6.0, "feedback": "...", "strengths": ["str1", "str2"], "weaknesses": ["Issue (e.g., 'example from transcript')"], "suggestions": ["tip1"]},
    "lexical_resource": {"band": 6.0, "feedback": "...", "strengths": ["str1", "str2"], "weaknesses": ["Issue (e.g., 'example from transcript')"], "suggestions": ["tip1"]},
    "grammatical_range": {"band": 5.5, "feedback": "...", "strengths": ["str1", "str2"], "weaknesses": ["Issue (e.g., 'example from transcript')"], "suggestions": ["tip1"]},
    "pronunciation": {"band": 6.0, "feedback": "Text-based: estimated from speech patterns", "strengths": ["str1"], "weaknesses": ["Issue"], "suggestions": ["tip1"]}
  },
  "summary": "2-3 sentences honest assessment reflecting actual performance",
  "examiner_notes": "1 sentence on most critical area needing improvement",
  "vocabulary_upgrades": [{"original": "...", "upgraded": "...", "context": "..."}, {"original": "...", "upgraded": "...", "context": "..."}, {"original": "...", "upgraded": "...", "context": "..."}],
  "recognition_corrections": [{"captured": "misheard", "intended": "correct", "context": "sentence"}],
  "part_analysis": [{"part_number": 1, "performance_notes": "1 sentence", "key_moments": ["max 2"], "areas_for_improvement": ["Issue + example quote from transcript", "Issue + example", "Issue + example"]}],
  "modelAnswers": [
    {
      "segment_key": "${orderedSegments[0]?.key || 'part1-q...'}",
      "partNumber": 1,
      "questionNumber": 1,
      "question": "Question text",
      "candidateResponse": "Corrected transcript (or empty if unavailable)",
      "estimatedBand": 5.5,
      "targetBand": 6.5,
      "modelAnswer": "FULL model answer: Part1=40w, Part2=140w, Part3=55w - ALWAYS PROVIDE EVEN IF TRANSCRIPT UNAVAILABLE",
      "whyItWorks": ["max 2 points explaining why model answer is effective"],
      "keyImprovements": ["max 2 specific improvements candidate should make"]
    }
  ]
}
\`\`\`

FINAL RULES:
1. Return EXACTLY ${numSegments} modelAnswers with segment_keys: ${orderedSegments.map(s => s.key).join(', ')}
2. Model answer lengths: Part1=35-45w, Part2=130-150w (COUNT!), Part3=50-60w
3. ALWAYS provide model answers even if transcript is "(Transcript unavailable)" or empty
4. Max 2 items per strengths/weaknesses/suggestions arrays
5. Include max 3 vocabulary_upgrades (omit if none needed)
6. DO NOT inflate scores - a 3-word response CANNOT score above 3.0
7. part_analysis: Include 3+ areas_for_improvement per part with SPECIFIC examples

Return ONLY valid JSON.`;
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

function calculateBand(result: any): number {
  const c = result.criteria;
  
  // CRITERIA-DERIVED BAND SCORE (Primary method - official IELTS approach)
  // The overall band should be the average of the four criteria, rounded to nearest 0.5
  const criterionScores = c ? [
    c.fluency_coherence?.band,
    c.lexical_resource?.band,
    c.grammatical_range?.band,
    c.pronunciation?.band,
  ].filter((s: unknown): s is number => typeof s === 'number') : [];
  
  if (criterionScores.length > 0) {
    const criterionAvg = criterionScores.reduce((a, b) => a + b, 0) / criterionScores.length;
    // IELTS rounding: .25 rounds up to .5, .75 rounds up to next whole
    const rounded = Math.round(criterionAvg * 2) / 2;
    console.log(`[calculateBand] Criteria scores: ${criterionScores.join(', ')} → avg=${criterionAvg.toFixed(2)} → band=${rounded}`);
    return rounded;
  }
  
  // FALLBACK: If no criteria scores, try to extract from modelAnswers per-question scores
  const modelAnswers = Array.isArray(result.modelAnswers) ? result.modelAnswers : [];
  const questionScores = modelAnswers
    .map((ma: any) => ma.estimatedBand ?? ma.estimated_band ?? ma.questionBandScore ?? ma.question_band_score)
    .filter((band: unknown): band is number => typeof band === 'number');
  
  if (questionScores.length > 0) {
    const avg = questionScores.reduce((a: number, b: number) => a + b, 0) / questionScores.length;
    const rounded = Math.round(avg * 2) / 2;
    console.log(`[calculateBand] Fallback - question scores avg: ${avg.toFixed(2)} → band=${rounded}`);
    return rounded;
  }
  
  // Default fallback
  console.log('[calculateBand] No scores found, returning default 6.0');
  return 6.0;
}
