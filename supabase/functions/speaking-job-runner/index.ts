import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * Speaking Job Runner - Watchdog & Dispatcher
 * 
 * This function:
 * 1. Finds stuck jobs (stale heartbeat or expired lock)
 * 2. Resets them for retry
 * 3. Dispatches pending jobs to the correct stage function
 * 
 * Can be called:
 * - Periodically via cron (every 1-2 minutes)
 * - By frontend when user wants to retry
 * - After evaluate-speaking-async creates a job
 * - Automatically by the frontend when jobs appear stuck (> 90s without update)
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// How old a heartbeat can be before we consider the job stuck (in seconds)
// Reduced from 120s to 90s for faster recovery
const STALE_HEARTBEAT_SECONDS = 90;

// Maximum jobs to process per run
const MAX_JOBS_PER_RUN = 10;

// Declare EdgeRuntime for Supabase Edge Functions
declare const EdgeRuntime: {
  waitUntil: (promise: Promise<unknown>) => void;
} | undefined;

serve(async (req) => {
  console.log(`[speaking-job-runner] Request at ${new Date().toISOString()}`);
  
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabaseService = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const body = await req.json().catch(() => ({}));
    const { jobId: specificJobId, forceRetry } = body;

    const results = {
      stuckJobsReset: 0,
      jobsDispatched: 0,
      errors: [] as string[],
    };

    // Step 1: Find and reset stuck jobs
    const staleTime = new Date(Date.now() - STALE_HEARTBEAT_SECONDS * 1000).toISOString();
    
    let stuckJobsQuery = supabaseService
      .from('speaking_evaluation_jobs')
      .select('id, status, stage, retry_count, max_retries, heartbeat_at, lock_expires_at')
      .eq('status', 'processing')
      .or(`heartbeat_at.lt.${staleTime},heartbeat_at.is.null,lock_expires_at.lt.${new Date().toISOString()}`);

    if (specificJobId) {
      stuckJobsQuery = stuckJobsQuery.eq('id', specificJobId);
    }

    const { data: stuckJobs, error: stuckError } = await stuckJobsQuery.limit(MAX_JOBS_PER_RUN);

    if (stuckError) {
      console.error('[speaking-job-runner] Error finding stuck jobs:', stuckError);
    } else if (stuckJobs && stuckJobs.length > 0) {
      console.log(`[speaking-job-runner] Found ${stuckJobs.length} stuck jobs`);

      for (const job of stuckJobs) {
        const retryCount = (job.retry_count || 0) + 1;
        const maxRetries = job.max_retries || 3;

        // Determine which stage to reset to
        let newStage = 'pending_upload';
        if (job.stage === 'evaluating' || job.stage === 'pending_eval') {
          newStage = 'pending_eval';
        }
        if (job.stage === 'pending_text_eval' || job.stage === 'evaluating_text') {
          newStage = 'pending_text_eval';
        }

        if (retryCount >= maxRetries && !forceRetry) {
          // Mark as failed
          await supabaseService
            .from('speaking_evaluation_jobs')
            .update({
              status: 'failed',
              stage: 'failed',
              last_error: `Watchdog: Job stuck in ${job.stage} stage after ${retryCount} attempts`,
              retry_count: retryCount,
              lock_token: null,
              lock_expires_at: null,
              updated_at: new Date().toISOString(),
            })
            .eq('id', job.id);
          
          console.log(`[speaking-job-runner] Job ${job.id} marked as failed (max retries)`);
        } else {
          // Reset for retry
          await supabaseService
            .from('speaking_evaluation_jobs')
            .update({
              status: 'pending',
              stage: newStage,
              last_error: `Watchdog: Reset from stuck ${job.stage} stage`,
              retry_count: forceRetry ? job.retry_count : retryCount,
              lock_token: null,
              lock_expires_at: null,
              heartbeat_at: null,
              updated_at: new Date().toISOString(),
            })
            .eq('id', job.id);
          
          console.log(`[speaking-job-runner] Job ${job.id} reset to ${newStage}`);
          results.stuckJobsReset++;
        }
      }
    }

    // Step 2: Dispatch pending jobs to appropriate stage functions
    // This is a safety net - jobs should normally be triggered directly by the previous stage
    let pendingQuery = supabaseService
      .from('speaking_evaluation_jobs')
      .select('id, stage, google_file_uris, created_at, partial_results')
      .eq('status', 'pending')
      .in('stage', ['pending_upload', 'pending_eval', 'pending_text_eval'])
      .order('created_at', { ascending: true });

    if (specificJobId) {
      pendingQuery = pendingQuery.eq('id', specificJobId);
    }

    const { data: pendingJobs, error: pendingError } = await pendingQuery.limit(MAX_JOBS_PER_RUN);

    if (pendingError) {
      console.error('[speaking-job-runner] Error finding pending jobs:', pendingError);
    } else if (pendingJobs && pendingJobs.length > 0) {
      console.log(`[speaking-job-runner] Found ${pendingJobs.length} pending jobs to dispatch`);

      for (const job of pendingJobs) {
        try {
          // Determine which function to call based on stage
          let functionName: string;
          
          if (job.stage === 'pending_text_eval') {
            // Text-based evaluation (browser transcripts available) - use process-speaking-job
            functionName = 'process-speaking-job';
          } else if (job.stage === 'pending_upload') {
            // Check if uploads already exist (idempotency)
            if (job.google_file_uris && Object.keys(job.google_file_uris).length > 0) {
              // Uploads exist, advance to eval stage
              await supabaseService
                .from('speaking_evaluation_jobs')
                .update({ stage: 'pending_eval', updated_at: new Date().toISOString() })
                .eq('id', job.id);
              functionName = 'speaking-evaluate-job';
            } else {
              functionName = 'speaking-upload-job';
            }
          } else {
            functionName = 'speaking-evaluate-job';
          }

          console.log(`[speaking-job-runner] Dispatching job ${job.id} to ${functionName}`);

          // Use EdgeRuntime.waitUntil if available for reliable background dispatch
          const dispatchJob = async () => {
            const functionUrl = `${supabaseUrl}/functions/v1/${functionName}`;
            
            for (let attempt = 1; attempt <= 3; attempt++) {
              try {
                const triggerResponse = await fetch(functionUrl, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${supabaseServiceKey}`,
                  },
                  body: JSON.stringify({ jobId: job.id }),
                });

                console.log(`[speaking-job-runner] ${functionName} triggered for ${job.id}, status: ${triggerResponse.status}`);
                
                if (triggerResponse.ok) {
                  return;
                }
                
                const errorText = await triggerResponse.text().catch(() => 'Unknown');
                console.error(`[speaking-job-runner] ${functionName} trigger attempt ${attempt} failed for ${job.id}: ${errorText}`);
              } catch (fetchErr: any) {
                console.error(`[speaking-job-runner] ${functionName} trigger attempt ${attempt} error for ${job.id}:`, fetchErr.message);
              }
              
              if (attempt < 3) {
                await new Promise(r => setTimeout(r, 2000)); // Wait 2s before retry
              }
            }
          };

          // Fire dispatch - use waitUntil if available for reliability
          if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime.waitUntil) {
            EdgeRuntime.waitUntil(dispatchJob());
          } else {
            await dispatchJob();
          }

          results.jobsDispatched++;
        } catch (dispatchError: any) {
          console.error(`[speaking-job-runner] Dispatch error for ${job.id}:`, dispatchError);
          results.errors.push(`${job.id}: ${dispatchError.message}`);
        }
      }
    }

    console.log(`[speaking-job-runner] Complete: ${results.stuckJobsReset} reset, ${results.jobsDispatched} dispatched`);

    return new Response(JSON.stringify({
      success: true,
      ...results,
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
    console.error('[speaking-job-runner] Error:', error);
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
