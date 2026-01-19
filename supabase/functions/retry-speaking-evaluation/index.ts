import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * Retry Speaking Evaluation Edge Function
 * 
 * This function is designed to be called by:
 * 1. A cron job (every 2 minutes) to pick up stuck/failed jobs
 * 2. Frontend when user clicks "Retry" button
 * 
 * It detects jobs that are:
 * - Stuck in "processing" for too long (edge function timeout)
 * - Failed with retries remaining
 * - Pending but never started
 * 
 * Then triggers a new evaluation attempt by calling evaluate-speaking-async internally.
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// How long a job can be "processing" before considered stale
const STALE_THRESHOLD_SECONDS = 90; // Edge functions timeout at ~60s
// MAX_RETRIES for automatic/cron retries only - manual retries are unlimited
const AUTO_MAX_RETRIES = 5;

// Helper to check if job has exhausted auto-retries (only applies to automatic retries)
const hasExhaustedAutoRetries = (job: any): boolean => {
  return (job.retry_count || 0) >= AUTO_MAX_RETRIES;
};

serve(async (req) => {
  console.log(`[retry-speaking-evaluation] Request at ${new Date().toISOString()}`);
  
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!;

    const supabaseService = createClient(supabaseUrl, supabaseServiceKey);

    // Parse request body (optional jobId for manual retry)
    let specificJobId: string | null = null;
    try {
      const body = await req.json();
      specificJobId = body?.jobId || null;
    } catch {
      // No body or invalid JSON - that's fine for cron
    }

    // Calculate stale threshold
    const staleThreshold = new Date(Date.now() - STALE_THRESHOLD_SECONDS * 1000).toISOString();

    // Find jobs that need retry
    let query = supabaseService
      .from('speaking_evaluation_jobs')
      .select('*');

    if (specificJobId) {
      // Manual retry of specific job - NO LIMIT for manual retries
      // Users can retry as many times as they want
      query = query.eq('id', specificJobId);
    } else {
      // Cron job: find stale/stuck jobs that haven't exhausted auto-retries
      query = query
        .or(`status.eq.processing,status.eq.pending,status.eq.stale`)
        .lt('updated_at', staleThreshold)
        .lt('retry_count', AUTO_MAX_RETRIES)
        .order('created_at', { ascending: true })
        .limit(3); // Process max 3 jobs per cron run
    }

    // Flag to identify if this is a manual retry (no retry limit)
    const isManualRetry = !!specificJobId;

    const { data: stuckJobs, error: queryError } = await query;

    if (queryError) {
      console.error('[retry-speaking-evaluation] Query error:', queryError);
      return new Response(JSON.stringify({ error: 'Failed to query jobs' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!stuckJobs || stuckJobs.length === 0) {
      console.log('[retry-speaking-evaluation] No stuck jobs found');
      return new Response(JSON.stringify({ 
        success: true, 
        message: 'No jobs need retry',
        processed: 0 
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`[retry-speaking-evaluation] Found ${stuckJobs.length} stuck jobs`);

    const results: Array<{ jobId: string; status: string; message: string }> = [];

    for (const job of stuckJobs) {
      try {
        const currentRetryCount = job.retry_count || 0;
        
        // For AUTOMATIC retries (cron), check if exhausted - mark as permanently failed
        // For MANUAL retries (user-initiated), always allow retry regardless of count
        if (!isManualRetry && hasExhaustedAutoRetries(job)) {
          console.log(`[retry-speaking-evaluation] Job ${job.id} has exhausted all ${AUTO_MAX_RETRIES} auto-retries, marking as failed`);
          await supabaseService
            .from('speaking_evaluation_jobs')
            .update({
              status: 'failed',
              stage: 'failed',
              last_error: `Automatic retries exhausted after ${AUTO_MAX_RETRIES} attempts. Click retry to try again manually.`,
              updated_at: new Date().toISOString(),
            })
            .eq('id', job.id);
          results.push({ jobId: job.id, status: 'failed', message: `Auto-retries (${AUTO_MAX_RETRIES}) exhausted - manual retry still available` });
          continue;
        }

        // Determine which stage the job should retry from
        const hasTranscripts = Boolean(job.partial_results?.transcripts) && Object.keys(job.partial_results.transcripts || {}).length > 0;
        const hasGoogleUris = job.google_file_uris && Object.keys(job.google_file_uris).length > 0;

        // Text-based evaluation should always retry via process-speaking-job
        const targetStage = hasTranscripts ? 'pending_text_eval' : (hasGoogleUris ? 'pending_eval' : 'pending_upload');
        const targetFunction = hasTranscripts ? 'process-speaking-job' : (hasGoogleUris ? 'speaking-evaluate-job' : 'speaking-upload-job');

        // Reset the job to pending state for the appropriate stage
        const { error: updateError } = await supabaseService
          .from('speaking_evaluation_jobs')
          .update({
            status: 'pending',
            stage: targetStage,
            retry_count: currentRetryCount + 1,
            lock_token: null,
            lock_expires_at: null,
            last_error: isManualRetry 
              ? `Manual retry #${currentRetryCount + 1}: ${job.last_error || 'Unknown error'}`
              : `Auto-retry ${currentRetryCount + 1}/${AUTO_MAX_RETRIES}: ${job.last_error || 'Unknown error'}`,
            updated_at: new Date().toISOString(),
          })
          .eq('id', job.id);

        if (updateError) {
          console.warn(`[retry-speaking-evaluation] Failed to update job ${job.id}:`, updateError);
          results.push({ jobId: job.id, status: 'skipped', message: 'Failed to update job' });
          continue;
        }
        
        console.log(`[retry-speaking-evaluation] ${isManualRetry ? 'Manual' : 'Auto'} retry attempt ${currentRetryCount + 1} for job ${job.id}, triggering ${targetFunction}`);

        // Directly trigger the appropriate stage function
        const triggerResponse = await fetch(`${supabaseUrl}/functions/v1/${targetFunction}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${supabaseServiceKey}`,
          },
          body: JSON.stringify({ jobId: job.id }),
        });

        if (!triggerResponse.ok) {
          const errorText = await triggerResponse.text();
          console.error(`[retry-speaking-evaluation] ${targetFunction} failed for job ${job.id}:`, errorText);
          
          // Mark as stale for next retry attempt
          await supabaseService
            .from('speaking_evaluation_jobs')
            .update({
              status: 'stale',
              last_error: `Trigger failed: ${errorText.slice(0, 200)}`,
              updated_at: new Date().toISOString(),
            })
            .eq('id', job.id);
          results.push({ jobId: job.id, status: 'stale', message: 'Will retry later' });
          continue;
        }

        console.log(`[retry-speaking-evaluation] Successfully triggered ${targetFunction} for job ${job.id}`);
        results.push({ jobId: job.id, status: 'retrying', message: `Retry triggered via ${targetFunction}` });

      } catch (err: any) {
        console.error(`[retry-speaking-evaluation] Error processing job ${job.id}:`, err);
        results.push({ jobId: job.id, status: 'error', message: err.message });
      }
    }

    return new Response(JSON.stringify({
      success: true,
      processed: stuckJobs.length,
      results,
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
    console.error('[retry-speaking-evaluation] Error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
