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
const MAX_RETRIES = 5;

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
      // Manual retry of specific job
      query = query.eq('id', specificJobId);
    } else {
      // Cron job: find stale/stuck jobs
      query = query
        .or(`status.eq.processing,status.eq.pending,status.eq.stale`)
        .lt('updated_at', staleThreshold)
        .lt('retry_count', MAX_RETRIES)
        .order('created_at', { ascending: true })
        .limit(3); // Process max 3 jobs per cron run
    }

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
        // Mark job as "retrying" to prevent duplicate retries
        const { error: updateError } = await supabaseService
          .from('speaking_evaluation_jobs')
          .update({
            status: 'retrying',
            retry_count: (job.retry_count || 0) + 1,
            last_error: job.status === 'processing' 
              ? 'Previous attempt timed out (edge function shutdown)' 
              : job.last_error,
            updated_at: new Date().toISOString(),
          })
          .eq('id', job.id)
          .eq('status', job.status); // Optimistic lock

        if (updateError) {
          console.warn(`[retry-speaking-evaluation] Failed to update job ${job.id}:`, updateError);
          results.push({ jobId: job.id, status: 'skipped', message: 'Failed to acquire lock' });
          continue;
        }

        // Trigger new evaluation by calling evaluate-speaking-async
        const evalResponse = await fetch(`${supabaseUrl}/functions/v1/evaluate-speaking-async`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${supabaseAnonKey}`,
            'x-retry-job-id': job.id, // Signal this is a retry
          },
          body: JSON.stringify({
            testId: job.test_id,
            filePaths: job.file_paths,
            durations: job.durations,
            topic: job.topic,
            difficulty: job.difficulty,
            fluencyFlag: job.fluency_flag,
            retryJobId: job.id, // Pass the existing job ID
          }),
        });

        if (!evalResponse.ok) {
          const errorText = await evalResponse.text();
          console.error(`[retry-speaking-evaluation] Eval failed for job ${job.id}:`, errorText);
          
          // Mark as failed if max retries reached
          const newRetryCount = (job.retry_count || 0) + 1;
          if (newRetryCount >= MAX_RETRIES) {
            await supabaseService
              .from('speaking_evaluation_jobs')
              .update({
                status: 'failed',
                last_error: `Max retries (${MAX_RETRIES}) exceeded. Last error: ${errorText.slice(0, 200)}`,
              })
              .eq('id', job.id);
            results.push({ jobId: job.id, status: 'failed', message: 'Max retries exceeded' });
          } else {
            // Mark as stale for next retry attempt
            await supabaseService
              .from('speaking_evaluation_jobs')
              .update({
                status: 'stale',
                last_error: errorText.slice(0, 500),
              })
              .eq('id', job.id);
            results.push({ jobId: job.id, status: 'stale', message: 'Will retry later' });
          }
          continue;
        }

        console.log(`[retry-speaking-evaluation] Successfully triggered retry for job ${job.id}`);
        results.push({ jobId: job.id, status: 'retrying', message: 'Retry triggered' });

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
