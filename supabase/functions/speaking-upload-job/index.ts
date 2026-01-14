import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { crypto } from "https://deno.land/std@0.168.0/crypto/mod.ts";
import { getFromR2 } from "../_shared/r2Client.ts";
import { getActiveGeminiKeysForModel } from "../_shared/apiKeyQuotaUtils.ts";

/**
 * Speaking Upload Job - Stage 1 of Speaking Evaluation
 * 
 * This function ONLY handles:
 * 1. Downloading audio files from R2
 * 2. Uploading them to Google File API
 * 3. Persisting the Google File URIs to the database
 * 
 * This is idempotent - if URIs already exist, it skips upload.
 * Updates heartbeat during long operations to prevent timeout detection.
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const HEARTBEAT_INTERVAL_MS = 15000; // Update heartbeat every 15 seconds
const LOCK_DURATION_MINUTES = 5;

serve(async (req) => {
  console.log(`[speaking-upload-job] Request at ${new Date().toISOString()}`);
  
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

    // Try to claim the job with a lock - first fetch the job to check conditions
    const nowIso = new Date().toISOString();
    
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
      console.log(`[speaking-upload-job] Job ${jobId} not claimable: status=${existingJob.status}, stage=${existingJob.stage}, lockExpired=${lockExpired}, noLock=${noLock}`);
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

    // Now claim the job with an update
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

    if (claimError) {
      console.error(`[speaking-upload-job] Error claiming job ${jobId}:`, claimError.message);
      return new Response(JSON.stringify({ 
        success: false, 
        error: `Failed to claim job: ${claimError.message}`,
        skipped: true 
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const job = updatedJobs?.[0];
    if (!job) {
      console.log(`[speaking-upload-job] No job returned after update for ${jobId}`);
      return new Response(JSON.stringify({ 
        success: false, 
        error: 'Job claim failed - no data returned',
        skipped: true 
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`[speaking-upload-job] Claimed job ${jobId}`);

    // Check if uploads already completed (idempotency)
    if (job.google_file_uris && Object.keys(job.google_file_uris).length > 0) {
      console.log(`[speaking-upload-job] Uploads already exist, skipping to eval stage`);
      
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
        console.log(`[speaking-upload-job] Heartbeat updated for ${jobId}`);
      } catch (e) {
        console.error(`[speaking-upload-job] Heartbeat failed:`, e);
      }
    }, HEARTBEAT_INTERVAL_MS);

    const { user_id: userId, file_paths, test_id } = job;
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

    // Build segment ordering
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

    const orderedSegments: Array<{ segmentKey: string; partNumber: 1 | 2 | 3; questionNumber: number }> = [];
    
    for (const segmentKey of Object.keys(filePathsMap)) {
      const m = String(segmentKey).match(/^part([123])\-q(.+)$/);
      if (!m) continue;
      const partNumber = Number(m[1]) as 1 | 2 | 3;
      const questionId = m[2];
      const q = questionById.get(questionId);
      if (!q) continue;
      orderedSegments.push({ segmentKey, partNumber, questionNumber: q.questionNumber });
    }

    orderedSegments.sort((a, b) => {
      if (a.partNumber !== b.partNumber) return a.partNumber - b.partNumber;
      return a.questionNumber - b.questionNumber;
    });

    console.log(`[speaking-upload-job] Processing ${orderedSegments.length} segments`);

    // Get an API key for Google File API upload
    let apiKey: string | null = null;

    // Try user's key first
    const { data: userSecret } = await supabaseService
      .from('user_secrets')
      .select('encrypted_value')
      .eq('user_id', userId)
      .eq('secret_name', 'GEMINI_API_KEY')
      .maybeSingle();

    if (userSecret?.encrypted_value && appEncryptionKey) {
      try {
        apiKey = await decryptKey(userSecret.encrypted_value, appEncryptionKey);
      } catch (e) {
        console.warn('[speaking-upload-job] Failed to decrypt user key:', e);
      }
    }

    // Fall back to admin keys
    if (!apiKey) {
      const dbApiKeys = await getActiveGeminiKeysForModel(supabaseService, 'flash_2_5');
      if (dbApiKeys.length > 0) {
        apiKey = dbApiKeys[0].key_value;
      }
    }

    if (!apiKey) {
      throw new Error('No API keys available for upload');
    }

    // Download from R2 and upload to Google File API
    const googleFileUris: Record<string, { fileUri: string; mimeType: string; index: number }> = {};

    for (let i = 0; i < orderedSegments.length; i++) {
      const segment = orderedSegments[i];
      const r2Path = filePathsMap[segment.segmentKey];
      
      if (!r2Path) {
        console.warn(`[speaking-upload-job] No R2 path for segment: ${segment.segmentKey}`);
        continue;
      }

      console.log(`[speaking-upload-job] [${i}/${orderedSegments.length}] Downloading ${segment.segmentKey}`);
      
      const downloadResult = await getFromR2(r2Path);
      if (!downloadResult.success || !downloadResult.bytes) {
        throw new Error(`Failed to download ${segment.segmentKey}: ${downloadResult.error}`);
      }

      const ext = r2Path.split('.').pop()?.toLowerCase() || 'webm';
      const mimeType = ext === 'mp3' ? 'audio/mpeg' : 'audio/webm';

      console.log(`[speaking-upload-job] [${i}/${orderedSegments.length}] Uploading to Google File API`);
      
      const uploadResult = await uploadToGoogleFileAPI(
        apiKey,
        downloadResult.bytes,
        `AUDIO_INDEX_${i}_${segment.segmentKey}.${ext}`,
        mimeType
      );

      googleFileUris[segment.segmentKey] = {
        fileUri: uploadResult.uri,
        mimeType: uploadResult.mimeType,
        index: i,
      };

      console.log(`[speaking-upload-job] [${i}/${orderedSegments.length}] Uploaded: ${uploadResult.uri}`);

      // Update heartbeat after each upload
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

    // Save Google File URIs and advance to eval stage
    await supabaseService
      .from('speaking_evaluation_jobs')
      .update({
        google_file_uris: googleFileUris,
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

    console.log(`[speaking-upload-job] Upload complete for ${jobId}, ${Object.keys(googleFileUris).length} files`);

    return new Response(JSON.stringify({ 
      success: true, 
      status: 'pending_eval',
      filesUploaded: Object.keys(googleFileUris).length,
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
    console.error('[speaking-upload-job] Error:', error);

    // Clear heartbeat interval on error
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
    }

    // Update job with error
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

async function uploadToGoogleFileAPI(
  apiKey: string,
  audioBytes: Uint8Array,
  fileName: string,
  mimeType: string
): Promise<{ uri: string; mimeType: string }> {
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
  
  return { uri: result.file.uri, mimeType: result.file.mimeType || mimeType };
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
