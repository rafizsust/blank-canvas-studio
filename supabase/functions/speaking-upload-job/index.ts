import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { crypto } from "https://deno.land/std@0.168.0/crypto/mod.ts";
import { getFromR2 } from "../_shared/r2Client.ts";
import {
  corsHeaders,
  getMimeTypeFromExtension,
} from "../_shared/speakingUtils.ts";

/**
 * OPTIMIZED Speaking Upload Job - Stage 1 of Speaking Evaluation
 * 
 * NEW ARCHITECTURE (v2): Eliminates Google File API
 * 
 * This function ONLY handles:
 * 1. Downloading audio files from R2
 * 2. Converting them to base64 for inline Gemini calls
 * 3. Storing the base64 data in the database
 * 
 * Benefits:
 * - No Google File API dependency
 * - No key-file binding issues
 * - Per-part key rotation in evaluate job
 */

const HEARTBEAT_INTERVAL_MS = 15000;
const LOCK_DURATION_MINUTES = 5;

// Maximum size for inline audio (Gemini limit is ~20MB per request)
const MAX_INLINE_AUDIO_SIZE_MB = 15;

// Audio compression thresholds - files larger than 500KB may cause "model overloaded" errors
const COMPRESSION_THRESHOLD_BYTES = 500 * 1024;

serve(async (req) => {
  console.log(`[speaking-upload-job] Request at ${new Date().toISOString()}`);
  
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
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

    // First, check if job exists and is claimable
    const { data: existingJob, error: fetchError } = await supabaseService
      .from('speaking_evaluation_jobs')
      .select('*')
      .eq('id', jobId)
      .maybeSingle();

    if (fetchError) {
      console.error(`[speaking-upload-job] Error fetching job ${jobId}:`, fetchError.message);
      return new Response(JSON.stringify({ 
        success: false, 
        error: `Failed to fetch job: ${fetchError.message}`,
        skipped: true 
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!existingJob) {
      console.log(`[speaking-upload-job] Job ${jobId} not found`);
      return new Response(JSON.stringify({ 
        success: false, 
        error: 'Job not found',
        skipped: true 
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Check if job is in claimable state
    const isClaimableStatus = ['pending', 'processing'].includes(existingJob.status);
    const isClaimableStage = ['pending_upload', 'uploading', null].includes(existingJob.stage);
    const lockExpired = !existingJob.lock_expires_at || new Date(existingJob.lock_expires_at) < new Date();
    const noLock = !existingJob.lock_token;

    if (!isClaimableStatus || !isClaimableStage || (!noLock && !lockExpired)) {
      console.log(`[speaking-upload-job] Job ${jobId} not claimable: status=${existingJob.status}, stage=${existingJob.stage}`);
      return new Response(JSON.stringify({ 
        success: false, 
        error: 'Job already claimed or in wrong state',
        skipped: true,
        currentStatus: existingJob.status,
        currentStage: existingJob.stage,
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Claim the job
    const { data: updatedJobs, error: claimError } = await supabaseService
      .from('speaking_evaluation_jobs')
      .update({
        status: 'processing',
        stage: 'uploading',
        lock_token: lockToken,
        lock_expires_at: lockExpiresAt,
        processing_started_at: new Date().toISOString(),
        heartbeat_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', jobId)
      .select();

    if (claimError || !updatedJobs?.[0]) {
      return new Response(JSON.stringify({ 
        success: false, 
        error: 'Job claim failed',
        skipped: true 
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const job = updatedJobs[0];
    console.log(`[speaking-upload-job] Claimed job ${jobId}`);

    // Check if audio data already exists (idempotency)
    // We now use google_file_uris field to store inline audio data for compatibility
    if (job.google_file_uris && Object.keys(job.google_file_uris).length > 0) {
      console.log(`[speaking-upload-job] Audio data already exists, skipping to eval stage`);
      
      await supabaseService
        .from('speaking_evaluation_jobs')
        .update({
          status: 'pending',
          stage: 'pending_eval',
          lock_token: null,
          lock_expires_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', jobId)
        .eq('lock_token', lockToken);

      return new Response(JSON.stringify({ success: true, status: 'pending_eval', skipped: true }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Set up heartbeat updater
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
        console.error(`[speaking-upload-job] Heartbeat failed:`, e);
      }
    }, HEARTBEAT_INTERVAL_MS);

    const { file_paths, test_id, user_id: userId } = job;
    const filePathsMap = file_paths as Record<string, string>;

    // Get test payload for segment metadata
    const { data: testRow } = await supabaseService
      .from('ai_practice_tests')
      .select('payload, preset_id')
      .eq('id', test_id)
      .eq('user_id', userId)
      .maybeSingle();

    let payload = testRow?.payload as any || {};
    
    if (testRow?.preset_id && (!payload.speakingParts && !payload.part1)) {
      const { data: presetData } = await supabaseService
        .from('generated_test_audio')
        .select('content_payload')
        .eq('id', testRow.preset_id)
        .maybeSingle();
      
      if (presetData?.content_payload) {
        payload = presetData.content_payload;
      }
    }

    // Build segment ordering - extract part number from segment key
    const orderedSegments: Array<{ segmentKey: string; partNumber: 1 | 2 | 3; index: number }> = [];
    
    for (const segmentKey of Object.keys(filePathsMap)) {
      const partMatch = String(segmentKey).match(/^part([123])-/);
      if (partMatch) {
        const partNumber = Number(partMatch[1]) as 1 | 2 | 3;
        orderedSegments.push({ segmentKey, partNumber, index: orderedSegments.length });
      } else {
        console.warn(`[speaking-upload-job] Segment key ${segmentKey} doesn't match part pattern`);
        orderedSegments.push({ segmentKey, partNumber: 1, index: orderedSegments.length });
      }
    }

    // Sort by part number, then by original order
    orderedSegments.sort((a, b) => {
      if (a.partNumber !== b.partNumber) return a.partNumber - b.partNumber;
      return a.index - b.index;
    });

    console.log(`[speaking-upload-job] Processing ${orderedSegments.length} segments with INLINE audio`);

    // Download from R2 and convert to base64 (NO Google File API)
    const inlineAudioData: Record<string, { 
      base64: string; 
      mimeType: string; 
      index: number;
      sizeBytes: number;
    }> = {};

    let totalSizeBytes = 0;

    for (let i = 0; i < orderedSegments.length; i++) {
      const segment = orderedSegments[i];
      const r2Path = filePathsMap[segment.segmentKey];
      
      if (!r2Path) {
        console.warn(`[speaking-upload-job] No R2 path for segment: ${segment.segmentKey}`);
        continue;
      }

      console.log(`[speaking-upload-job] [${i + 1}/${orderedSegments.length}] Downloading ${segment.segmentKey}`);
      
      const downloadResult = await getFromR2(r2Path);
      if (!downloadResult.success || !downloadResult.bytes) {
        throw new Error(`Failed to download ${segment.segmentKey}: ${downloadResult.error}`);
      }

      let audioBytes = downloadResult.bytes;
      let mimeType = getMimeTypeFromExtension(r2Path);
      const originalSizeBytes = audioBytes.length;

      // Log the audio size for debugging
      console.log(`[speaking-upload-job] [${i + 1}/${orderedSegments.length}] Original size: ${(originalSizeBytes / 1024).toFixed(1)}KB, type: ${mimeType}`);

      // Audio is already recorded at optimal quality by the browser
      // Large files (> 500KB) may cause "model overloaded" errors
      // We'll note this but not re-compress since we can't transcode in Deno easily
      // The browser already records at 128kbps WebM which is reasonable
      if (originalSizeBytes > COMPRESSION_THRESHOLD_BYTES) {
        console.log(`[speaking-upload-job] [${i + 1}/${orderedSegments.length}] Large file (${(originalSizeBytes / 1024).toFixed(1)}KB > ${COMPRESSION_THRESHOLD_BYTES / 1024}KB threshold) - may cause model overload`);
        // Note: True audio transcoding requires ffmpeg which isn't available in Deno
        // The best mitigation is ensuring browser records at lower quality (already 128kbps)
      }

      const sizeBytes = audioBytes.length;
      totalSizeBytes += sizeBytes;

      // Check size limit
      if (totalSizeBytes > MAX_INLINE_AUDIO_SIZE_MB * 1024 * 1024) {
        console.warn(`[speaking-upload-job] Total audio size ${(totalSizeBytes / 1024 / 1024).toFixed(1)}MB exceeds limit`);
        // Continue anyway, Gemini will reject if too large
      }
      
      // Convert to base64 using chunked approach to avoid stack overflow
      let binary = '';
      const chunkSize = 32768; // 32KB chunks
      for (let j = 0; j < audioBytes.length; j += chunkSize) {
        const chunk = audioBytes.subarray(j, Math.min(j + chunkSize, audioBytes.length));
        binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
      }
      const base64 = btoa(binary);

      inlineAudioData[segment.segmentKey] = {
        base64,
        mimeType,
        index: i,
        sizeBytes,
      };

      console.log(`[speaking-upload-job] [${i + 1}/${orderedSegments.length}] Converted to base64: ${(sizeBytes / 1024).toFixed(1)}KB`);

      // Update heartbeat after each download
      await supabaseService
        .from('speaking_evaluation_jobs')
        .update({ 
          heartbeat_at: new Date().toISOString(),
          lock_expires_at: new Date(Date.now() + LOCK_DURATION_MINUTES * 60 * 1000).toISOString(),
        })
        .eq('id', jobId)
        .eq('lock_token', lockToken);
    }

    // Clear heartbeat interval
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }

    // Save inline audio data to google_file_uris field (repurposed for inline data)
    // This maintains compatibility with the evaluate job
    await supabaseService
      .from('speaking_evaluation_jobs')
      .update({
        google_file_uris: inlineAudioData,
        upload_completed_at: new Date().toISOString(),
        status: 'pending',
        stage: 'pending_eval',
        lock_token: null,
        lock_expires_at: null,
        heartbeat_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', jobId)
      .eq('lock_token', lockToken);

    console.log(`[speaking-upload-job] Upload complete: ${Object.keys(inlineAudioData).length} files, ${(totalSizeBytes / 1024 / 1024).toFixed(2)}MB total`);

    // Check the configured provider to determine which pipeline to use
    const { data: settingsRow } = await supabaseService
      .from('speaking_evaluation_settings')
      .select('provider')
      .eq('singleton_key', 'default')
      .maybeSingle();
    
    const configuredProvider = settingsRow?.provider || 'gemini';
    console.log(`[speaking-upload-job] Configured provider: ${configuredProvider}`);

    // Trigger the appropriate evaluate job based on provider
    let evaluateFunctionName: string;
    if (configuredProvider === 'groq') {
      // Groq pipeline: transcribe first, then evaluate
      evaluateFunctionName = 'groq-speaking-transcribe';
    } else {
      // Gemini pipeline: direct evaluation with audio
      evaluateFunctionName = 'speaking-evaluate-job';
    }

    const evaluateFunctionUrl = `${supabaseUrl}/functions/v1/${evaluateFunctionName}`;
    console.log(`[speaking-upload-job] Triggering ${evaluateFunctionName} for ${jobId}`);
    
    fetch(evaluateFunctionUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${supabaseServiceKey}`,
      },
      body: JSON.stringify({ jobId }),
    }).then(async (res) => {
      console.log(`[speaking-upload-job] ${evaluateFunctionName} trigger response: ${res.status}`);
    }).catch((err) => {
      console.error(`[speaking-upload-job] Failed to trigger ${evaluateFunctionName}:`, err);
    });

    return new Response(JSON.stringify({ 
      success: true, 
      status: 'pending_eval',
      filesProcessed: Object.keys(inlineAudioData).length,
      totalSizeMB: (totalSizeBytes / 1024 / 1024).toFixed(2),
      evaluateTriggered: true,
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
    console.error('[speaking-upload-job] Error:', error);

    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
    }

    if (jobId) {
      const { data: currentJob } = await supabaseService
        .from('speaking_evaluation_jobs')
        .select('retry_count, max_retries')
        .eq('id', jobId)
        .maybeSingle();

      const retryCount = (currentJob?.retry_count || 0) + 1;
      const maxRetries = currentJob?.max_retries || 3;

      if (retryCount >= maxRetries) {
        await supabaseService
          .from('speaking_evaluation_jobs')
          .update({
            status: 'failed',
            stage: 'failed',
            last_error: `Upload failed: ${error.message}`,
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
            stage: 'pending_upload',
            last_error: `Upload error (will retry): ${error.message}`,
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
