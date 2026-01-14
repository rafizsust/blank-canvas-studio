import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { GoogleGenerativeAI } from "https://esm.sh/@google/generative-ai@0.21.0";
import { crypto } from "https://deno.land/std@0.168.0/crypto/mod.ts";
import { 
  getActiveGeminiKeysForModel, 
  markKeyQuotaExhausted,
  isQuotaExhaustedError
} from "../_shared/apiKeyQuotaUtils.ts";

/**
 * Speaking Evaluate Job - OPTIMIZED VERSION
 * 
 * This function processes speaking evaluations in PARTS to avoid timeout:
 * 1. Evaluate Part 1 (4-5 short questions) -> save partial results -> update progress (33%)
 * 2. Evaluate Part 2 (1 long response) -> save partial results -> update progress (66%)
 * 3. Evaluate Part 3 (3-4 discussion questions) -> combine all results -> complete (100%)
 * 
 * Each part is evaluated in a separate AI call, allowing the function to survive
 * Supabase's edge function timeout limits.
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash'];
const HEARTBEAT_INTERVAL_MS = 15000; // 15 seconds
const LOCK_DURATION_MINUTES = 5;
const AI_CALL_TIMEOUT_MS = 90000; // 90 seconds per part (shorter since we're doing smaller chunks)

class QuotaError extends Error {
  permanent: boolean;
  constructor(message: string, opts: { permanent: boolean }) {
    super(message);
    this.name = 'QuotaError';
    this.permanent = opts.permanent;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function exponentialBackoffWithJitter(attempt: number, baseMs: number, maxMs: number): number {
  const exponential = Math.min(baseMs * Math.pow(2, attempt), maxMs);
  const jitter = Math.random() * exponential * 0.3;
  return Math.floor(exponential + jitter);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: number | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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

serve(async (req) => {
  console.log(`[speaking-evaluate-job] Request at ${new Date().toISOString()}`);
  
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const appEncryptionKey = Deno.env.get('app_encryption_key')!;
  const supabaseService = createClient(supabaseUrl, supabaseServiceKey);

  let jobId: string | null = null;
  let heartbeatInterval: number | null = null;

  try {
    const body = await req.json();
    jobId = body.jobId;

    if (!jobId) {
      return new Response(JSON.stringify({ error: 'Missing jobId' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Generate lock token
    const lockToken = crypto.randomUUID();
    const lockExpiresAt = new Date(Date.now() + LOCK_DURATION_MINUTES * 60 * 1000).toISOString();

    // Fetch job
    const { data: existingJob, error: fetchError } = await supabaseService
      .from('speaking_evaluation_jobs')
      .select('*')
      .eq('id', jobId)
      .maybeSingle();

    if (fetchError || !existingJob) {
      console.log(`[speaking-evaluate-job] Job ${jobId} not found`);
      return new Response(JSON.stringify({ success: false, error: 'Job not found', skipped: true }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Check if job is claimable
    const isClaimableStatus = ['pending', 'processing'].includes(existingJob.status);
    const isClaimableStage = ['pending_eval', 'evaluating', null].includes(existingJob.stage);
    const lockExpired = !existingJob.lock_expires_at || new Date(existingJob.lock_expires_at) < new Date();
    const noLock = !existingJob.lock_token;

    if (!isClaimableStatus || !isClaimableStage || (!noLock && !lockExpired)) {
      console.log(`[speaking-evaluate-job] Job ${jobId} not claimable`);
      return new Response(JSON.stringify({ success: false, error: 'Job already claimed or in wrong state', skipped: true }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Claim the job
    const { data: updatedJobs, error: claimError } = await supabaseService
      .from('speaking_evaluation_jobs')
      .update({
        status: 'processing',
        stage: 'evaluating',
        lock_token: lockToken,
        lock_expires_at: lockExpiresAt,
        heartbeat_at: new Date().toISOString(),
        progress: existingJob.progress || 0,
        current_part: existingJob.current_part || 0,
        total_parts: 3,
        updated_at: new Date().toISOString(),
      })
      .eq('id', jobId)
      .select();

    if (claimError || !updatedJobs?.[0]) {
      return new Response(JSON.stringify({ success: false, error: 'Failed to claim job', skipped: true }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const job = updatedJobs[0];
    const googleFileUris = job.google_file_uris as Record<string, { fileUri: string; mimeType: string; index: number }>;
    
    if (!googleFileUris || Object.keys(googleFileUris).length === 0) {
      throw new Error('No Google File URIs found - upload stage incomplete');
    }

    console.log(`[speaking-evaluate-job] Claimed job ${jobId}, ${Object.keys(googleFileUris).length} files ready`);

    // Set up heartbeat
    heartbeatInterval = setInterval(async () => {
      try {
        await supabaseService
          .from('speaking_evaluation_jobs')
          .update({ 
            heartbeat_at: new Date().toISOString(),
            lock_expires_at: new Date(Date.now() + LOCK_DURATION_MINUTES * 60 * 1000).toISOString(),
          })
          .eq('id', jobId)
          .eq('lock_token', lockToken);
      } catch (e) {
        console.error(`[speaking-evaluate-job] Heartbeat failed:`, e);
      }
    }, HEARTBEAT_INTERVAL_MS);

    const { user_id: userId, test_id, file_paths, durations, topic, difficulty, fluency_flag, partial_results: existingPartialResults } = job;
    
    // Get partial results from previous run (if any)
    let partialResults = (existingPartialResults as Record<string, any>) || {};

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

    // Build segment metadata
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

    // Group segments by part
    const segmentsByPart: Record<number, Array<{ segmentKey: string; partNumber: 1 | 2 | 3; questionNumber: number; questionText: string }>> = {
      1: [], 2: [], 3: []
    };
    
    for (const segmentKey of Object.keys(googleFileUris)) {
      const m = String(segmentKey).match(/^part([123])\-q(.+)$/);
      if (!m) continue;
      const questionId = m[2];
      const q = questionById.get(questionId);
      if (!q) continue;
      segmentsByPart[q.partNumber].push({ 
        segmentKey, 
        partNumber: q.partNumber, 
        questionNumber: q.questionNumber,
        questionText: q.questionText,
      });
    }

    // Sort segments within each part
    for (const partNum of [1, 2, 3]) {
      segmentsByPart[partNum].sort((a, b) => a.questionNumber - b.questionNumber);
    }

    // Build API key queue
    interface KeyCandidate { key: string; keyId: string | null; isUserProvided: boolean; }
    const keyQueue: KeyCandidate[] = [];

    // User's key first
    const { data: userSecret } = await supabaseService
      .from('user_secrets')
      .select('encrypted_value')
      .eq('user_id', userId)
      .eq('secret_name', 'GEMINI_API_KEY')
      .maybeSingle();

    if (userSecret?.encrypted_value && appEncryptionKey) {
      try {
        const userKey = await decryptKey(userSecret.encrypted_value, appEncryptionKey);
        keyQueue.push({ key: userKey, keyId: null, isUserProvided: true });
      } catch (e) {
        console.warn('[speaking-evaluate-job] Failed to decrypt user key:', e);
      }
    }

    // Admin keys
    const dbApiKeys = await getActiveGeminiKeysForModel(supabaseService, 'flash_2_5');
    for (const dbKey of dbApiKeys) {
      keyQueue.push({ key: dbKey.key_value, keyId: dbKey.id, isUserProvided: false });
    }

    if (keyQueue.length === 0) throw new Error('No API keys available');
    console.log(`[speaking-evaluate-job] Key queue: ${keyQueue.length} keys`);

    // Determine which part to evaluate next
    const currentPart = (job.current_part as number) || 0;
    const partsToEvaluate = [1, 2, 3].filter(p => {
      // Skip parts that are already done
      if (partialResults[`part${p}`]) return false;
      // Skip parts that have no segments
      if (segmentsByPart[p].length === 0) return false;
      return true;
    });

    console.log(`[speaking-evaluate-job] Parts to evaluate: ${partsToEvaluate.join(', ')}, already done: ${Object.keys(partialResults).join(', ')}`);

    // Process ONE part at a time (to avoid timeout)
    const partToProcess = partsToEvaluate[0];
    
    if (partToProcess) {
      const segments = segmentsByPart[partToProcess];
      console.log(`[speaking-evaluate-job] Processing Part ${partToProcess} with ${segments.length} segments`);

      // Update progress before starting
      await supabaseService
        .from('speaking_evaluation_jobs')
        .update({ 
          current_part: partToProcess,
          progress: Math.round(((3 - partsToEvaluate.length) / 3) * 100),
          updated_at: new Date().toISOString(),
        })
        .eq('id', jobId)
        .eq('lock_token', lockToken);

      // Build file URIs for this part
      const partFileUris = segments.map(seg => {
        const uri = googleFileUris[seg.segmentKey];
        return { fileData: { mimeType: uri.mimeType, fileUri: uri.fileUri } };
      });

      // Build part-specific prompt
      const partPrompt = buildPartPrompt(partToProcess as 1 | 2 | 3, segments, topic || testRow.topic, difficulty || testRow.difficulty, fluency_flag && partToProcess === 2);

      // Evaluate this part
      let partResult: any = null;

      for (const candidateKey of keyQueue) {
        if (partResult) break;
        
        try {
          const genAI = new GoogleGenerativeAI(candidateKey.key);

          for (const modelName of GEMINI_MODELS) {
            if (partResult) break;

            console.log(`[speaking-evaluate-job] Part ${partToProcess}: trying ${modelName}`);
            
            const model = genAI.getGenerativeModel({ 
              model: modelName,
              generationConfig: { temperature: 0.3, maxOutputTokens: 20000 },
            });

            const contentParts: any[] = [...partFileUris, { text: partPrompt }];

            const MAX_RETRIES = 2;
            for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
              try {
                // Update heartbeat
                await supabaseService
                  .from('speaking_evaluation_jobs')
                  .update({ 
                    heartbeat_at: new Date().toISOString(),
                    lock_expires_at: new Date(Date.now() + LOCK_DURATION_MINUTES * 60 * 1000).toISOString(),
                  })
                  .eq('id', jobId)
                  .eq('lock_token', lockToken);

                const response = await withTimeout(
                  model.generateContent({ contents: [{ role: 'user', parts: contentParts }] }),
                  AI_CALL_TIMEOUT_MS,
                  `Gemini ${modelName} Part ${partToProcess}`
                );
                const text = response.response?.text?.() || '';

                if (!text) {
                  console.warn(`[speaking-evaluate-job] Empty response from ${modelName}`);
                  break;
                }

                const parsed = parseJson(text);
                if (parsed) {
                  partResult = parsed;
                  console.log(`[speaking-evaluate-job] Part ${partToProcess} success with ${modelName}`);
                  break;
                } else {
                  console.warn(`[speaking-evaluate-job] Failed to parse JSON from ${modelName}`);
                  break;
                }
              } catch (err: any) {
                const errMsg = String(err?.message || '');
                console.error(`[speaking-evaluate-job] ${modelName} failed (${attempt + 1}/${MAX_RETRIES}):`, errMsg.slice(0, 200));

                if (isPermanentQuotaExhausted(err)) {
                  if (!candidateKey.isUserProvided && candidateKey.keyId) {
                    await markKeyQuotaExhausted(supabaseService, candidateKey.keyId, 'flash_2_5');
                  }
                  throw new QuotaError(errMsg, { permanent: true });
                }

                if (isQuotaExhaustedError(errMsg)) {
                  const retryAfter = extractRetryAfterSeconds(err);
                  if (attempt < MAX_RETRIES - 1) {
                    const delay = retryAfter ? Math.min(retryAfter * 1000, 30000) : exponentialBackoffWithJitter(attempt, 2000, 30000);
                    console.log(`[speaking-evaluate-job] Rate limited, retrying in ${Math.round(delay / 1000)}s...`);
                    await sleep(delay);
                    continue;
                  } else {
                    throw new QuotaError(errMsg, { permanent: false });
                  }
                }

                if (attempt < MAX_RETRIES - 1) {
                  const delay = exponentialBackoffWithJitter(attempt, 1000, 15000);
                  await sleep(delay);
                  continue;
                }
                break;
              }
            }
          }
        } catch (keyError: any) {
          if (keyError instanceof QuotaError) {
            console.log(`[speaking-evaluate-job] Key quota exhausted, trying next...`);
            continue;
          }
          console.error(`[speaking-evaluate-job] Key error:`, keyError?.message);
        }
      }

      if (!partResult) {
        throw new Error(`Part ${partToProcess} evaluation failed: all models/keys exhausted`);
      }

      // Save partial result
      partialResults[`part${partToProcess}`] = partResult;
      
      const newProgress = Math.round(((3 - partsToEvaluate.length + 1) / 3) * 100);
      
      await supabaseService
        .from('speaking_evaluation_jobs')
        .update({ 
          partial_results: partialResults,
          progress: newProgress,
          current_part: partToProcess,
          updated_at: new Date().toISOString(),
        })
        .eq('id', jobId)
        .eq('lock_token', lockToken);

      console.log(`[speaking-evaluate-job] Part ${partToProcess} saved, progress: ${newProgress}%`);
    }

    // Clear heartbeat
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }

    // Check if all parts are done
    const remainingParts = [1, 2, 3].filter(p => {
      if (partialResults[`part${p}`]) return false;
      if (segmentsByPart[p].length === 0) return false;
      return true;
    });

    if (remainingParts.length > 0) {
      // More parts to process - release lock and let job runner pick it up again
      console.log(`[speaking-evaluate-job] ${remainingParts.length} parts remaining, releasing for next iteration`);
      
      await supabaseService
        .from('speaking_evaluation_jobs')
        .update({
          status: 'pending',
          stage: 'pending_eval',
          partial_results: partialResults,
          lock_token: null,
          lock_expires_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', jobId);

      // Immediately trigger next iteration
      const functionUrl = `${supabaseUrl}/functions/v1/speaking-evaluate-job`;
      fetch(functionUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${supabaseServiceKey}`,
        },
        body: JSON.stringify({ jobId }),
      }).catch(e => console.warn('Failed to trigger next iteration:', e));

      return new Response(JSON.stringify({ 
        success: true, 
        status: 'partial',
        progress: Math.round(((3 - remainingParts.length) / 3) * 100),
        remainingParts,
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ALL PARTS COMPLETE - Aggregate and save final result
    console.log(`[speaking-evaluate-job] All parts complete, aggregating results`);

    const allSegments = [...segmentsByPart[1], ...segmentsByPart[2], ...segmentsByPart[3]];
    const finalResult = aggregatePartResults(partialResults, allSegments);
    const overallBand = finalResult.overall_band || calculateBand(finalResult);

    // Build public audio URLs
    const publicBase = (Deno.env.get('R2_PUBLIC_URL') || '').replace(/\/$/, '');
    const audioUrls: Record<string, string> = {};
    const filePathsMap = file_paths as Record<string, string>;
    if (publicBase) {
      for (const [k, r2Key] of Object.entries(filePathsMap)) {
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
        total_questions: allSegments.length,
        time_spent_seconds: durations ? Math.round(Object.values(durations as Record<string, number>).reduce((a: number, b: number) => a + b, 0)) : 60,
        question_results: finalResult,
        answers: {
          audio_urls: audioUrls,
          transcripts_by_part: finalResult?.transcripts_by_part || {},
          transcripts_by_question: finalResult?.transcripts_by_question || {},
          file_paths: filePathsMap,
        },
        completed_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (saveError) console.error('[speaking-evaluate-job] Save error:', saveError);

    // Mark job completed
    await supabaseService
      .from('speaking_evaluation_jobs')
      .update({
        status: 'completed',
        stage: 'completed',
        result_id: resultRow?.id,
        progress: 100,
        completed_at: new Date().toISOString(),
        lock_token: null,
        lock_expires_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', jobId);

    // CLEANUP: Cancel all other pending/processing jobs for the same test
    // This prevents stale jobs from showing in the UI after successful completion
    const { data: staleJobs } = await supabaseService
      .from('speaking_evaluation_jobs')
      .select('id')
      .eq('test_id', test_id)
      .eq('user_id', userId)
      .neq('id', jobId)
      .in('status', ['pending', 'processing']);

    if (staleJobs && staleJobs.length > 0) {
      console.log(`[speaking-evaluate-job] Cancelling ${staleJobs.length} stale jobs for test ${test_id}`);
      await supabaseService
        .from('speaking_evaluation_jobs')
        .update({
          status: 'failed',
          stage: 'cancelled',
          last_error: 'Superseded by successful evaluation',
          lock_token: null,
          lock_expires_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq('test_id', test_id)
        .eq('user_id', userId)
        .neq('id', jobId)
        .in('status', ['pending', 'processing']);
    }

    console.log(`[speaking-evaluate-job] Complete, band: ${overallBand}, result_id: ${resultRow?.id}`);

    return new Response(JSON.stringify({ 
      success: true, 
      status: 'completed',
      resultId: resultRow?.id,
      band: overallBand,
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
    console.error('[speaking-evaluate-job] Error:', error);

    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
    }

    if (jobId) {
      const { data: currentJob } = await supabaseService
        .from('speaking_evaluation_jobs')
        .select('retry_count, max_retries, partial_results')
        .eq('id', jobId)
        .maybeSingle();

      const retryCount = (currentJob?.retry_count || 0) + 1;
      const maxRetries = currentJob?.max_retries || 5;

      if (retryCount >= maxRetries) {
        await supabaseService
          .from('speaking_evaluation_jobs')
          .update({
            status: 'failed',
            stage: 'failed',
            last_error: `Evaluation failed: ${error.message}`,
            retry_count: retryCount,
            lock_token: null,
            lock_expires_at: null,
            updated_at: new Date().toISOString(),
          })
          .eq('id', jobId);
      } else {
        await supabaseService
          .from('speaking_evaluation_jobs')
          .update({
            status: 'pending',
            stage: 'pending_eval',
            last_error: `Retry ${retryCount}/${maxRetries}: ${error.message}`,
            retry_count: retryCount,
            lock_token: null,
            lock_expires_at: null,
            updated_at: new Date().toISOString(),
          })
          .eq('id', jobId);
      }
    }

    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

async function decryptKey(encrypted: string, appKey: string): Promise<string> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const keyData = encoder.encode(appKey).slice(0, 32);
  const cryptoKey = await crypto.subtle.importKey('raw', keyData, { name: 'AES-GCM' }, false, ['decrypt']);
  const bytes = Uint8Array.from(atob(encrypted), c => c.charCodeAt(0));
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, cryptoKey, bytes.slice(12));
  return decoder.decode(decrypted);
}

function buildPartPrompt(
  partNumber: 1 | 2 | 3,
  segments: Array<{ segmentKey: string; partNumber: number; questionNumber: number; questionText: string }>,
  topic: string | undefined,
  difficulty: string | undefined,
  fluencyPenalty: boolean | undefined,
): string {
  const numQ = segments.length;
  
  const audioMappingLines = segments.map((seg, idx) => 
    `AUDIO_${idx}: "${seg.segmentKey}" → Question ${seg.questionNumber}: "${seg.questionText}"`
  ).join('\n');

  const partDescriptions: Record<number, string> = {
    1: 'Part 1: Introduction and familiar topics (30-60 words expected per answer)',
    2: 'Part 2: Individual long turn with cue card (150-250 words expected)',
    3: 'Part 3: Two-way discussion with abstract topics (40-80 words expected per answer)',
  };

  return `You are a CERTIFIED SENIOR IELTS Speaking Examiner evaluating ${partDescriptions[partNumber]}.
Return ONLY valid JSON.

CONTEXT: Topic: ${topic || 'General'}, Difficulty: ${difficulty || 'Medium'}
${fluencyPenalty ? '⚠️ Speaking time under 80 seconds - apply fluency penalty.' : ''}

══════════════════════════════════════════════════════════════
🚨 CRITICAL TRANSCRIPTION RULES 🚨
══════════════════════════════════════════════════════════════

**ZERO HALLUCINATION POLICY**: Transcribe ONLY what the candidate ACTUALLY SAID.

🚫 FORBIDDEN:
- DO NOT invent or fabricate content
- DO NOT create plausible answers based on context
- DO NOT paraphrase or improve what was said

✅ REQUIRED:
- Transcribe EXACT words spoken, word-for-word
- Include ALL filler words: "uh", "um", "like", "you know"
- Include false starts, repetitions, self-corrections
- Write "[INAUDIBLE]" for unclear portions
- Write "[NO SPEECH]" if silence

══════════════════════════════════════════════════════════════
AUDIO-TO-QUESTION MAPPING
══════════════════════════════════════════════════════════════
${numQ} audio file(s) in order:

${audioMappingLines}

══════════════════════════════════════════════════════════════
SCORING GUIDELINES
══════════════════════════════════════════════════════════════

🔴 Band 1-2: Just says question number, no actual answer, <5 words
🟠 Band 2.5-3.5: 5-10 words, minimal relevance
🟡 Band 4-4.5: 10-20 words, limited vocabulary
🟢 Band 5-6: Adequate response length with some development
🔵 Band 7+: Full, fluent, well-developed responses

══════════════════════════════════════════════════════════════
OUTPUT JSON SCHEMA
══════════════════════════════════════════════════════════════
{
  "part_number": ${partNumber},
  "criteria": {
    "fluency_coherence": {"band": 6.0, "feedback": "...", "strengths": [...], "weaknesses": [...], "suggestions": [...]},
    "lexical_resource": {"band": 6.0, "feedback": "...", "strengths": [...], "weaknesses": [...], "suggestions": [...]},
    "grammatical_range": {"band": 5.5, "feedback": "...", "strengths": [...], "weaknesses": [...], "suggestions": [...]},
    "pronunciation": {"band": 6.0, "feedback": "...", "strengths": [...], "weaknesses": [...], "suggestions": [...]}
  },
  "part_summary": "2-3 sentences summarizing Part ${partNumber} performance",
  "transcripts": [
    {"segment_key": "...", "question_number": 1, "question_text": "...", "transcript": "EXACT words spoken"}
  ],
  "modelAnswers": [
    {
      "segment_key": "...",
      "partNumber": ${partNumber},
      "questionNumber": 1,
      "question": "...",
      "candidateResponse": "EXACT transcript from audio",
      "estimatedBand": 5.5,
      "targetBand": 6,
      "modelAnswer": "Model response written at EXACTLY the targetBand level",
      "whyItWorks": ["reason1", "reason2"],
      "keyImprovements": ["what the candidate should do to reach this level"]
    }
  ],
  "lexical_upgrades": [{"original": "good", "upgraded": "beneficial", "context": "..."}]
}

══════════════════════════════════════════════════════════════
TARGET BAND CALCULATION RULES
══════════════════════════════════════════════════════════════

For each question's modelAnswer, set targetBand as follows:
- estimatedBand 1-4.5 → targetBand = 5
- estimatedBand 5-5.5 → targetBand = 6
- estimatedBand 6-6.5 → targetBand = 7
- estimatedBand 7-7.5 → targetBand = 8
- estimatedBand 8+ → targetBand = 9

CRITICAL: Write the modelAnswer at EXACTLY the targetBand level, NOT higher!
If targetBand is 6, write a Band 6 answer (not Band 7 or 8).

Return EXACTLY ${numQ} transcripts and ${numQ} modelAnswers.`;
}

function aggregatePartResults(
  partialResults: Record<string, any>,
  allSegments: Array<{ segmentKey: string; partNumber: number; questionNumber: number; questionText: string }>,
): any {
  const part1 = partialResults.part1 || {};
  const part2 = partialResults.part2 || {};
  const part3 = partialResults.part3 || {};

  // Aggregate criteria scores (average across parts that have them)
  const aggregateCriteria = (criterion: string) => {
    const scores: number[] = [];
    const feedbacks: string[] = [];
    const allStrengths: string[] = [];
    const allWeaknesses: string[] = [];
    const allSuggestions: string[] = [];

    for (const part of [part1, part2, part3]) {
      const c = part?.criteria?.[criterion];
      if (c?.band !== undefined) {
        scores.push(c.band);
        if (c.feedback) feedbacks.push(c.feedback);
        if (Array.isArray(c.strengths)) allStrengths.push(...c.strengths);
        if (Array.isArray(c.weaknesses)) allWeaknesses.push(...c.weaknesses);
        if (Array.isArray(c.suggestions)) allSuggestions.push(...c.suggestions);
      }
    }

    if (scores.length === 0) return { band: 5.5, feedback: '', strengths: [], weaknesses: [], suggestions: [] };

    return {
      band: Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 2) / 2,
      feedback: feedbacks.join(' '),
      strengths: [...new Set(allStrengths)].slice(0, 4),
      weaknesses: [...new Set(allWeaknesses)].slice(0, 4),
      suggestions: [...new Set(allSuggestions)].slice(0, 4),
    };
  };

  const criteria = {
    fluency_coherence: aggregateCriteria('fluency_coherence'),
    lexical_resource: aggregateCriteria('lexical_resource'),
    grammatical_range: aggregateCriteria('grammatical_range'),
    pronunciation: aggregateCriteria('pronunciation'),
  };

  // Aggregate transcripts
  const transcripts_by_part: Record<string, string> = {};
  const transcripts_by_question: Record<string, any[]> = { '1': [], '2': [], '3': [] };
  
  for (const [partKey, partData] of Object.entries({ part1, part2, part3 })) {
    const partNum = partKey.replace('part', '');
    if (Array.isArray(partData?.transcripts)) {
      transcripts_by_question[partNum] = partData.transcripts;
      transcripts_by_part[partNum] = partData.transcripts.map((t: any) => t.transcript || '').join(' ');
    }
  }

  // Aggregate model answers
  const modelAnswers: any[] = [];
  for (const part of [part1, part2, part3]) {
    if (Array.isArray(part?.modelAnswers)) {
      modelAnswers.push(...part.modelAnswers);
    }
  }

  // Aggregate lexical upgrades
  const lexical_upgrades: any[] = [];
  for (const part of [part1, part2, part3]) {
    if (Array.isArray(part?.lexical_upgrades)) {
      lexical_upgrades.push(...part.lexical_upgrades);
    }
  }

  // Build summary
  const partSummaries: string[] = [];
  if (part1.part_summary) partSummaries.push(`Part 1: ${part1.part_summary}`);
  if (part2.part_summary) partSummaries.push(`Part 2: ${part2.part_summary}`);
  if (part3.part_summary) partSummaries.push(`Part 3: ${part3.part_summary}`);

  // Calculate overall band
  const criteriaScores = [
    criteria.fluency_coherence.band,
    criteria.lexical_resource.band,
    criteria.grammatical_range.band,
    criteria.pronunciation.band,
  ];
  const overallBand = Math.round((criteriaScores.reduce((a, b) => a + b, 0) / 4) * 2) / 2;

  return {
    overall_band: overallBand,
    criteria,
    summary: partSummaries.join(' ') || 'Evaluation complete.',
    transcripts_by_part,
    transcripts_by_question,
    modelAnswers,
    lexical_upgrades: [...new Set(lexical_upgrades.map(l => JSON.stringify(l)))].map(s => JSON.parse(s)).slice(0, 10),
    part_analysis: [
      { part_number: 1, performance_notes: part1.part_summary || '', key_moments: [], areas_for_improvement: [] },
      { part_number: 2, performance_notes: part2.part_summary || '', key_moments: [], areas_for_improvement: [] },
      { part_number: 3, performance_notes: part3.part_summary || '', key_moments: [], areas_for_improvement: [] },
    ].filter(p => p.performance_notes),
    improvement_priorities: [],
    strengths_to_maintain: [],
  };
}

function parseJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {}
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
  ].filter((s: any) => typeof s === 'number');

  if (scores.length === 0) return 6.0;
  const avg = scores.reduce((a: number, b: number) => a + b, 0) / scores.length;
  return Math.round(avg * 2) / 2;
}
