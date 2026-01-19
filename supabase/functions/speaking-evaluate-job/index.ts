import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { GoogleGenerativeAI } from "https://esm.sh/@google/generative-ai@0.21.0";
import { crypto } from "https://deno.land/std@0.168.0/crypto/mod.ts";
import { 
  markModelQuotaExhausted,
} from "../_shared/apiKeyQuotaUtils.ts";
import { 
  createPerformanceLogger,
} from "../_shared/performanceLogger.ts";
import {
  parseJson,
  calculateBandFromCriteria,
  computeWeightedPartBand,
  corsHeaders,
} from "../_shared/speakingUtils.ts";
import {
  checkoutKeyForPart,
  releaseKeyWithCooldown,
  markKeyRateLimited,
  resetKeyRateLimit,
  markUserKeyQuotaExhausted,
  classifyError,
  interPartDelay,
  sleep,
  TIMINGS,
} from "../_shared/keyPoolManager.ts";

// Declare EdgeRuntime for Supabase Edge Functions
declare const EdgeRuntime: {
  waitUntil: (promise: Promise<unknown>) => void;
} | undefined;

/**
 * Speaking Evaluate Job - V2 with Per-Part Key Rotation
 * 
 * NEW ARCHITECTURE:
 * - Uses INLINE audio bytes instead of Google File API
 * - Separate API key for each part (1, 2, 3)
 * - Mandatory 45s cooldown after each key use
 * - 30s delay between parts for RPM quota reset
 * - No retry on 429 - switch key immediately
 * - 5-10 min cooldown for rate-limited keys
 */

const GEMINI_MODEL = 'gemini-2.5-flash';
const HEARTBEAT_INTERVAL_MS = 15000;
const LOCK_DURATION_MINUTES = 5;
const AI_CALL_TIMEOUT_MS = 120000;

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
  let currentKeyId: string | null = null;
  let currentPartNumber: number | null = null;

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
      return new Response(JSON.stringify({ success: false, error: 'Job not in claimable state', skipped: true }), {
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
    
    // Get inline audio data (stored in google_file_uris field for compatibility)
    const inlineAudioData = job.google_file_uris as Record<string, { 
      base64: string; 
      mimeType: string; 
      index: number;
      sizeBytes?: number;
      // Legacy format support
      fileUri?: string;
    }>;
    
    if (!inlineAudioData || Object.keys(inlineAudioData).length === 0) {
      throw new Error('No audio data found - upload stage incomplete');
    }

    // Detect if this is legacy format (Google File URIs) or new format (inline base64)
    const firstEntry = Object.values(inlineAudioData)[0];
    const isLegacyFormat = !!firstEntry.fileUri && !firstEntry.base64;
    
    if (isLegacyFormat) {
      console.log(`[speaking-evaluate-job] Detected LEGACY format (Google File URIs) - falling back to old flow`);
      // For legacy jobs, we need to continue with the old approach
      // This ensures backward compatibility during migration
    }

    console.log(`[speaking-evaluate-job] Claimed job ${jobId}, ${Object.keys(inlineAudioData).length} audio segments`);

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
    const segmentsByPart: Record<number, Array<{ 
      segmentKey: string; 
      partNumber: 1 | 2 | 3; 
      questionNumber: number; 
      questionText: string;
      base64?: string;
      mimeType?: string;
    }>> = { 1: [], 2: [], 3: [] };
    
    // Extract cue card topics from old-format payloads
    const cueCardByPart: Record<number, string> = {};
    for (const partKey of ['part1', 'part2', 'part3']) {
      const partNum = Number(partKey.replace('part', ''));
      const partData = payload?.[partKey];
      if (partData?.cue_card) {
        cueCardByPart[partNum] = String(partData.cue_card);
      }
    }
    
    for (const segmentKey of Object.keys(inlineAudioData)) {
      const m = String(segmentKey).match(/^part([123])\-q(.+)$/);
      if (!m) continue;
      
      const partNumber = Number(m[1]) as 1 | 2 | 3;
      const questionId = m[2];
      
      const audioData = inlineAudioData[segmentKey];
      
      const q = questionById.get(questionId);
      if (q) {
        segmentsByPart[q.partNumber].push({ 
          segmentKey, 
          partNumber: q.partNumber, 
          questionNumber: q.questionNumber,
          questionText: q.questionText,
          base64: audioData.base64,
          mimeType: audioData.mimeType,
        });
      } else {
        const qNumMatch = questionId.match(/q(\d+)/);
        const questionNumber = qNumMatch ? Number(qNumMatch[1]) : 1;
        const questionText = cueCardByPart[partNumber] || `Part ${partNumber} Question ${questionNumber}`;
        
        segmentsByPart[partNumber].push({ 
          segmentKey, 
          partNumber, 
          questionNumber,
          questionText,
          base64: audioData.base64,
          mimeType: audioData.mimeType,
        });
      }
    }

    // Sort segments within each part
    for (const partNum of [1, 2, 3]) {
      segmentsByPart[partNum].sort((a, b) => a.questionNumber - b.questionNumber);
    }

    // Calculate actual total parts
    const actualTotalParts = [1, 2, 3].filter(p => segmentsByPart[p].length > 0).length;
    console.log(`[speaking-evaluate-job] Total parts with segments: ${actualTotalParts}`);

    await supabaseService
      .from('speaking_evaluation_jobs')
      .update({ 
        total_parts: actualTotalParts,
        updated_at: new Date().toISOString(),
      })
      .eq('id', jobId)
      .eq('lock_token', lockToken);

    // Determine which part to evaluate next
    const partsToEvaluate = [1, 2, 3].filter(p => {
      if (partialResults[`part${p}`]) return false;
      if (segmentsByPart[p].length === 0) return false;
      return true;
    });

    console.log(`[speaking-evaluate-job] Parts to evaluate: ${partsToEvaluate.join(', ')}`);

    // Process ONE part at a time
    const partToProcess = partsToEvaluate[0];
    
    if (partToProcess) {
      currentPartNumber = partToProcess;
      const segments = segmentsByPart[partToProcess];
      console.log(`[speaking-evaluate-job] Processing Part ${partToProcess} with ${segments.length} segments`);

      // Update progress
      const completedParts = actualTotalParts - partsToEvaluate.length;
      const progressPercent = actualTotalParts > 0 ? Math.round((completedParts / actualTotalParts) * 100) : 0;

      await supabaseService
        .from('speaking_evaluation_jobs')
        .update({ 
          current_part: partToProcess,
          progress: progressPercent,
          updated_at: new Date().toISOString(),
        })
        .eq('id', jobId)
        .eq('lock_token', lockToken);

      // =====================================================================
      // PER-PART KEY CHECKOUT
      // =====================================================================
      console.log(`[speaking-evaluate-job] Checking out key for Part ${partToProcess}...`);
      
      const keyResult = await checkoutKeyForPart(
        supabaseService,
        userId,
        jobId,
        partToProcess as 1 | 2 | 3,
        appEncryptionKey,
        { 
          lockDurationSec: TIMINGS.KEY_LOCK_DURATION_SEC,
          modelName: GEMINI_MODEL,
        }
      );

      if (!keyResult) {
        // No keys available - fail gracefully
        throw new Error('All API keys are currently rate-limited or unavailable. Please try again in a few minutes.');
      }

      currentKeyId = keyResult.keyId;
      const apiKey = keyResult.keyValue;
      const isUserKey = keyResult.isUserKey;

      console.log(`[speaking-evaluate-job] Part ${partToProcess}: Using ${isUserKey ? 'user' : 'admin'} key ${currentKeyId.slice(0, 8)}...`);

      // Build inline audio parts for Gemini
      const inlineAudioParts = segments.map(seg => {
        if (seg.base64 && seg.mimeType) {
          return {
            inlineData: {
              mimeType: seg.mimeType,
              data: seg.base64,
            }
          };
        } else if (isLegacyFormat) {
          // Legacy format - use file URI
          const legacyData = inlineAudioData[seg.segmentKey] as any;
          return {
            fileData: {
              mimeType: legacyData.mimeType || 'audio/webm',
              fileUri: legacyData.fileUri,
            }
          };
        }
        throw new Error(`No audio data for segment ${seg.segmentKey}`);
      });

      // Build prompt
      const partPrompt = buildPartPrompt(
        partToProcess as 1 | 2 | 3, 
        segments, 
        topic || testRow.topic, 
        difficulty || testRow.difficulty, 
        fluency_flag && partToProcess === 2
      );

      // Create performance logger
      const perfLogger = createPerformanceLogger('evaluate_speaking');

      // Make the AI call
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({ 
        model: GEMINI_MODEL,
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 20000,
          responseMimeType: 'application/json',
        },
      });

      const contentParts: any[] = [...inlineAudioParts, { text: partPrompt }];
      const callStart = Date.now();
      let partResult: any = null;

      try {
        // Update heartbeat before AI call
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
          `Gemini ${GEMINI_MODEL} Part ${partToProcess}`
        );

        const text = response.response?.text?.() || '';
        const responseTimeMs = Date.now() - callStart;

        if (!text) {
          throw new Error('Empty response from AI');
        }

        const parsed = parseJson(text);
        if (parsed) {
          partResult = parsed;
          console.log(`[speaking-evaluate-job] Part ${partToProcess} success in ${responseTimeMs}ms`);
          await perfLogger.logSuccess(GEMINI_MODEL, responseTimeMs, currentKeyId !== 'user' ? currentKeyId : undefined);
          
          // Reset rate limit counter on success
          if (!isUserKey && currentKeyId) {
            await resetKeyRateLimit(supabaseService, currentKeyId);
          }
        } else {
          throw new Error('Failed to parse AI response as JSON');
        }

      } catch (err: any) {
        const errMsg = String(err?.message || '');
        const responseTimeMs = Date.now() - callStart;
        console.error(`[speaking-evaluate-job] Part ${partToProcess} error:`, errMsg.slice(0, 200));

        // Classify the error
        const errorClass = classifyError(err);
        console.log(`[speaking-evaluate-job] Error classification: ${errorClass.type} - ${errorClass.description}`);

        // Handle based on error type
        if (errorClass.type === 'rate_limit') {
          // Mark key as rate-limited (NO RETRY)
          if (!isUserKey && currentKeyId) {
            await markKeyRateLimited(supabaseService, currentKeyId, errorClass.cooldownMinutes);
          }
          await perfLogger.logError(GEMINI_MODEL, `Rate limit: ${errMsg.slice(0, 100)}`, responseTimeMs, currentKeyId !== 'user' ? currentKeyId : undefined);
          
          // Release the lock and re-queue for retry with different key
          await releaseKeyWithCooldown(supabaseService, jobId, partToProcess as 1 | 2 | 3, 0);
          
          // For rate limit, re-queue the job to try with a different key
          await supabaseService
            .from('speaking_evaluation_jobs')
            .update({
              status: 'pending',
              stage: 'pending_eval',
              last_error: `Rate limit hit (will retry with different key): ${errMsg.slice(0, 100)}`,
              lock_token: null,
              lock_expires_at: null,
              heartbeat_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq('id', jobId);
          
          console.log(`[speaking-evaluate-job] Rate limit, re-queued for retry with different key`);
          
          // Trigger retry with different key
          const triggerRetry = async () => {
            await sleep(3000); // Short delay before retry
            const functionUrl = `${supabaseUrl}/functions/v1/speaking-evaluate-job`;
            try {
              await fetch(functionUrl, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${supabaseServiceKey}`,
                },
                body: JSON.stringify({ jobId }),
              });
              console.log(`[speaking-evaluate-job] Retry triggered after rate limit`);
            } catch (e) {
              console.warn(`[speaking-evaluate-job] Retry trigger failed:`, e);
            }
          };
          
          if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime.waitUntil) {
            EdgeRuntime.waitUntil(triggerRetry());
          } else {
            triggerRetry().catch(e => console.error('[speaking-evaluate-job] Background retry failed:', e));
          }
          
          return new Response(JSON.stringify({ 
            success: false, 
            error: 'Rate limit, retrying with different key',
            retrying: true,
          }), {
            status: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        if (errorClass.type === 'daily_quota') {
          // Mark key as exhausted for the day
          if (isUserKey) {
            // CRITICAL: Mark user's key as exhausted so we fallback to admin keys
            await markUserKeyQuotaExhausted(supabaseService, userId, GEMINI_MODEL);
            console.log(`[speaking-evaluate-job] User key marked as exhausted, will retry with admin keys`);
          } else if (currentKeyId) {
            await markModelQuotaExhausted(supabaseService, currentKeyId, GEMINI_MODEL);
          }
          await perfLogger.logQuotaExceeded(GEMINI_MODEL, errMsg.slice(0, 100), currentKeyId !== 'user' ? currentKeyId : undefined);
          
          // Release the lock and re-queue for retry with different key
          await releaseKeyWithCooldown(supabaseService, jobId, partToProcess as 1 | 2 | 3, 0);
          
          // Re-queue the job to try with a different key (admin key if user key was exhausted)
          await supabaseService
            .from('speaking_evaluation_jobs')
            .update({
              status: 'pending',
              stage: 'pending_eval',
              last_error: `Quota exhausted (will retry with different key): ${errMsg.slice(0, 100)}`,
              lock_token: null,
              lock_expires_at: null,
              heartbeat_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq('id', jobId);
          
          console.log(`[speaking-evaluate-job] Daily quota exhausted, re-queued for retry with different key`);
          
          // Trigger retry with different key
          const triggerRetry = async () => {
            await sleep(3000); // Short delay before retry
            const functionUrl = `${supabaseUrl}/functions/v1/speaking-evaluate-job`;
            try {
              await fetch(functionUrl, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${supabaseServiceKey}`,
                },
                body: JSON.stringify({ jobId }),
              });
              console.log(`[speaking-evaluate-job] Retry triggered after quota exhaustion`);
            } catch (e) {
              console.warn(`[speaking-evaluate-job] Retry trigger failed:`, e);
            }
          };
          
          if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime.waitUntil) {
            EdgeRuntime.waitUntil(triggerRetry());
          } else {
            triggerRetry().catch(e => console.error('[speaking-evaluate-job] Background retry failed:', e));
          }
          
          return new Response(JSON.stringify({ 
            success: false, 
            error: 'Daily quota exhausted, retrying with different key',
            retrying: true,
          }), {
            status: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        // Handle transient errors (503, timeouts, etc.) - allow retry
        if (errorClass.type === 'transient') {
          await perfLogger.logError(GEMINI_MODEL, `Transient: ${errMsg.slice(0, 100)}`, responseTimeMs, currentKeyId !== 'user' ? currentKeyId : undefined);
          
          // Release the key without cooldown and re-queue for retry
          await releaseKeyWithCooldown(supabaseService, jobId, partToProcess as 1 | 2 | 3, 0);
          
          // Re-queue for retry with same or different key
          await supabaseService
            .from('speaking_evaluation_jobs')
            .update({
              status: 'pending',
              stage: 'pending_eval',
              last_error: `Transient error (will retry): ${errMsg.slice(0, 150)}`,
              lock_token: null,
              lock_expires_at: null,
              heartbeat_at: new Date().toISOString(), // Keep heartbeat fresh
              updated_at: new Date().toISOString(),
            })
            .eq('id', jobId);
          
          console.log(`[speaking-evaluate-job] Transient error, re-queued for retry`);
          
          // CRITICAL: Use EdgeRuntime.waitUntil for reliable background trigger
          const triggerRetry = async () => {
            await sleep(5000); // Wait 5s before retry
            
            const functionUrl = `${supabaseUrl}/functions/v1/speaking-evaluate-job`;
            
            for (let attempt = 1; attempt <= 3; attempt++) {
              try {
                const response = await fetch(functionUrl, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${supabaseServiceKey}`,
                  },
                  body: JSON.stringify({ jobId }),
                });
                
                if (response.ok) {
                  console.log(`[speaking-evaluate-job] Retry triggered successfully (attempt ${attempt})`);
                  return;
                }
              } catch (e) {
                console.warn(`[speaking-evaluate-job] Retry attempt ${attempt} error:`, e);
              }
              
              if (attempt < 3) await sleep(2000);
            }
          };

          if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime.waitUntil) {
            EdgeRuntime.waitUntil(triggerRetry());
          } else {
            triggerRetry().catch(e => console.error('[speaking-evaluate-job] Background retry failed:', e));
          }
          
          return new Response(JSON.stringify({ 
            success: false, 
            error: 'Transient error, retrying',
            retrying: true,
          }), {
            status: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        // For other permanent errors, just fail
        await perfLogger.logError(GEMINI_MODEL, errMsg.slice(0, 200), responseTimeMs, currentKeyId !== 'user' ? currentKeyId : undefined);
        throw new Error(`Part ${partToProcess} evaluation failed: ${errMsg.slice(0, 100)}`);
      }

      // =====================================================================
      // RELEASE KEY WITH COOLDOWN
      // =====================================================================
      console.log(`[speaking-evaluate-job] Releasing key with ${TIMINGS.KEY_COOLDOWN_SEC}s cooldown...`);
      await releaseKeyWithCooldown(supabaseService, jobId, partToProcess as 1 | 2 | 3, TIMINGS.KEY_COOLDOWN_SEC);
      currentKeyId = null;

      // Save partial result
      partialResults[`part${partToProcess}`] = partResult;
      
      const newProgress = Math.round(((actualTotalParts - partsToEvaluate.length + 1) / actualTotalParts) * 100);
      
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
      // More parts to process - schedule next iteration with delay
      console.log(`[speaking-evaluate-job] ${remainingParts.length} parts remaining`);
      
      // Calculate when the next part can run (inter-part delay for RPM quota reset)
      const nextRunAt = new Date(Date.now() + TIMINGS.INTER_PART_DELAY_SEC * 1000).toISOString();
      
      await supabaseService
        .from('speaking_evaluation_jobs')
        .update({
          status: 'pending',
          stage: 'pending_eval',
          partial_results: partialResults,
          lock_token: null,
          lock_expires_at: null,
          heartbeat_at: new Date().toISOString(), // Keep heartbeat fresh so watchdog doesn't reset prematurely
          updated_at: new Date().toISOString(),
        })
        .eq('id', jobId);

      console.log(`[speaking-evaluate-job] Job ${jobId} updated to pending, scheduling next iteration after ${TIMINGS.INTER_PART_DELAY_SEC}s`);

      // CRITICAL: Use EdgeRuntime.waitUntil() to ensure trigger completes even after response is sent
      // This prevents the edge function shutdown from killing the trigger
      const triggerNextPart = async () => {
        // Wait for inter-part delay
        await sleep(TIMINGS.INTER_PART_DELAY_SEC * 1000);
        
        const functionUrl = `${supabaseUrl}/functions/v1/speaking-evaluate-job`;
        
        // Try multiple times to ensure trigger succeeds
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const response = await fetch(functionUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${supabaseServiceKey}`,
              },
              body: JSON.stringify({ jobId }),
            });
            
            if (response.ok) {
              console.log(`[speaking-evaluate-job] Next iteration triggered successfully (attempt ${attempt})`);
              return;
            }
            
            console.warn(`[speaking-evaluate-job] Trigger attempt ${attempt} failed with status ${response.status}`);
          } catch (e) {
            console.warn(`[speaking-evaluate-job] Trigger attempt ${attempt} error:`, e);
          }
          
          if (attempt < 3) {
            await sleep(2000); // Wait 2s before retry
          }
        }
        
        console.error(`[speaking-evaluate-job] All trigger attempts failed for job ${jobId}`);
      };

      // Use EdgeRuntime.waitUntil if available (Supabase Edge Runtime), otherwise fire-and-forget
      if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime.waitUntil) {
        EdgeRuntime.waitUntil(triggerNextPart());
      } else {
        // Fallback: fire and don't await (less reliable but still works in many cases)
        triggerNextPart().catch(e => console.error('[speaking-evaluate-job] Background trigger failed:', e));
      }

      return new Response(JSON.stringify({ 
        success: true, 
        status: 'partial',
        progress: Math.round(((actualTotalParts - remainingParts.length) / actualTotalParts) * 100),
        remainingParts,
        nextRunAt,
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

    // Cleanup stale/failed jobs for same test
    const { data: staleJobs } = await supabaseService
      .from('speaking_evaluation_jobs')
      .select('id')
      .eq('test_id', test_id)
      .eq('user_id', userId)
      .neq('id', jobId)
      .in('status', ['pending', 'processing', 'failed', 'stale']);

    if (staleJobs && staleJobs.length > 0) {
      console.log(`[speaking-evaluate-job] Cancelling ${staleJobs.length} stale/failed jobs`);
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
        .in('status', ['pending', 'processing', 'failed', 'stale']);
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

    // Release key if we have one checked out
    if (currentKeyId && currentPartNumber && jobId) {
      try {
        await releaseKeyWithCooldown(supabaseService, jobId, currentPartNumber as 1 | 2 | 3, 0);
        console.log(`[speaking-evaluate-job] Released key on error`);
      } catch (releaseErr) {
        console.warn('[speaking-evaluate-job] Failed to release key:', releaseErr);
      }
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
  "part_band": 6.0,
  "criteria": {
    "fluency_coherence": {"band": 6.0, "feedback": "...", "strengths": ["str1", "str2"], "weaknesses": ["w1"], "suggestions": ["tip1"]},
    "lexical_resource": {"band": 6.0, "feedback": "...", "strengths": ["str1", "str2"], "weaknesses": ["w1"], "suggestions": ["tip1"]},
    "grammatical_range": {"band": 5.5, "feedback": "...", "strengths": ["str1", "str2"], "weaknesses": ["w1"], "suggestions": ["tip1"]},
    "pronunciation": {"band": 6.0, "feedback": "...", "strengths": ["str1", "str2"], "weaknesses": ["w1"], "suggestions": ["tip1"]}
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
      "modelAnswer": "Model response written at EXACTLY the targetBand level (~50 words for Part 1, ~150 for Part 2, ~80 for Part 3)",
      "whyItWorks": ["reason1", "reason2"],
      "keyImprovements": ["improvement1"]
    }
  ],
  "lexical_upgrades": [{"original": "good", "upgraded": "beneficial", "context": "..."}]
}

IMPORTANT OUTPUT LIMITS:
- strengths: maximum 2 items per criterion
- weaknesses: maximum 2 items per criterion  
- suggestions: maximum 2 items per criterion
- whyItWorks: maximum 2 reasons
- keyImprovements: maximum 2 items
- lexical_upgrades: maximum 5 total

══════════════════════════════════════════════════════════════
TARGET BAND CALCULATION RULES
══════════════════════════════════════════════════════════════

CRITICAL: For ALL modelAnswers, use a UNIFIED targetBand:
1. Calculate the highest band score among all 4 criteria (FC, LR, GRA, P)
2. Set targetBand = highest_criteria_score + 1 (max 9)
3. ALL model answers should be written at this SAME targetBand level

Example: If criteria scores are FC=6, LR=6, GRA=5.5, P=6
- Highest = 6
- targetBand = 7 for ALL answers

Write ALL modelAnswers at the targetBand level to show the next achievable level.

Return EXACTLY ${numQ} transcripts and ${numQ} modelAnswers.`;
}

function aggregatePartResults(
  partialResults: Record<string, any>,
  allSegments: Array<{ segmentKey: string; partNumber: number; questionNumber: number; questionText: string }>,
): any {
  const part1 = partialResults.part1 || {};
  const part2 = partialResults.part2 || {};
  const part3 = partialResults.part3 || {};

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

  const transcripts_by_part: Record<string, string> = {};
  const transcripts_by_question: Record<string, any[]> = { '1': [], '2': [], '3': [] };
  
  for (const [partKey, partData] of Object.entries({ part1, part2, part3 })) {
    const partNum = partKey.replace('part', '');
    if (Array.isArray(partData?.transcripts)) {
      transcripts_by_question[partNum] = partData.transcripts;
      transcripts_by_part[partNum] = partData.transcripts.map((t: any) => t.transcript || '').join(' ');
    }
  }

  const modelAnswers: any[] = [];
  for (const part of [part1, part2, part3]) {
    if (Array.isArray(part?.modelAnswers)) {
      modelAnswers.push(...part.modelAnswers);
    }
  }

  const lexical_upgrades: any[] = [];
  for (const part of [part1, part2, part3]) {
    if (Array.isArray(part?.lexical_upgrades)) {
      lexical_upgrades.push(...part.lexical_upgrades);
    }
  }

  const partSummaries: string[] = [];
  if (part1.part_summary) partSummaries.push(`Part 1: ${part1.part_summary}`);
  if (part2.part_summary) partSummaries.push(`Part 2: ${part2.part_summary}`);
  if (part3.part_summary) partSummaries.push(`Part 3: ${part3.part_summary}`);

  const part_scores: { part1?: number; part2?: number; part3?: number } = {};
  if (typeof part1.part_band === 'number') part_scores.part1 = part1.part_band;
  if (typeof part2.part_band === 'number') part_scores.part2 = part2.part_band;
  if (typeof part3.part_band === 'number') part_scores.part3 = part3.part_band;

  const weightedBand = computeWeightedPartBand(part_scores);
  const criteriaScores = [
    criteria.fluency_coherence.band,
    criteria.lexical_resource.band,
    criteria.grammatical_range.band,
    criteria.pronunciation.band,
  ];
  const criteriaAvg = Math.round((criteriaScores.reduce((a, b) => a + b, 0) / 4) * 2) / 2;
  const overallBand = weightedBand ?? criteriaAvg;

  return {
    overall_band: overallBand,
    part_scores,
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
