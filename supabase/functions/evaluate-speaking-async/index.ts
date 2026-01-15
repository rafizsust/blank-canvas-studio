import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * Speaking Evaluation Job Creator (Queue-Based Architecture)
 * 
 * This function ONLY creates the job record and returns immediately.
 * Actual processing is done by process-speaking-job (separate function).
 * 
 * NEW: Per-user concurrency limit (max 1 active job) to prevent rate limiting bursts.
 * 
 * Benefits:
 * - Instant response to user (no waiting)
 * - No edge function timeouts during AI processing
 * - Jobs can be retried independently
 * - Better error handling and visibility
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Per-user concurrency limit
const MAX_CONCURRENT_JOBS_PER_USER = 1;

interface EvaluationRequest {
  testId: string;
  filePaths: Record<string, string>;
  durations?: Record<string, number>;
  topic?: string;
  difficulty?: string;
  fluencyFlag?: boolean;
  retryJobId?: string;
  cancelExisting?: boolean; // If true, cancel existing jobs before creating new one
  // Text-based evaluation data (from browser speech analysis)
  transcripts?: Record<string, {
    rawTranscript: string;
    cleanedTranscript: string;
    wordConfidences: Array<{ word: string; confidence: number; isFiller: boolean; isRepeat: boolean }>;
    fluencyMetrics: { wordsPerMinute: number; pauseCount: number; fillerCount: number; fillerRatio: number; repetitionCount: number; overallFluencyScore: number };
    prosodyMetrics: { pitchVariation: number; stressEventCount: number; rhythmConsistency: number };
    durationMs: number;
    overallClarityScore: number;
  }>;
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
    const { testId, filePaths, durations, topic, difficulty, fluencyFlag, retryJobId, cancelExisting, transcripts } = body;

    // Check if text-based evaluation is available
    const hasTranscripts = transcripts && Object.keys(transcripts).length > 0;
    if (hasTranscripts) {
      console.log(`[evaluate-speaking-async] Text-based evaluation available with ${Object.keys(transcripts).length} segments`);
    }

    if (!testId || !filePaths || Object.keys(filePaths).length === 0) {
      return new Response(JSON.stringify({ error: 'Missing testId or filePaths' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    let job: any;

    // Handle retry case
    if (retryJobId) {
      console.log(`[evaluate-speaking-async] Retry mode - reusing job ${retryJobId}`);
      
      const { data: existingJob, error: fetchError } = await supabaseService
        .from('speaking_evaluation_jobs')
        .select('*')
        .eq('id', retryJobId)
        .single();

      if (fetchError || !existingJob) {
        return new Response(JSON.stringify({ error: 'Retry job not found' }), {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Reset status to pending for processor to pick up
      await supabaseService
        .from('speaking_evaluation_jobs')
        .update({ 
          status: 'pending', 
          stage: existingJob.google_file_uris ? 'pending_eval' : 'pending_upload',
          updated_at: new Date().toISOString(),
          last_error: null,
          lock_token: null,
          lock_expires_at: null,
        })
        .eq('id', retryJobId);

      job = existingJob;
    } else {
      console.log(`[evaluate-speaking-async] Creating new job for test ${testId}, ${Object.keys(filePaths).length} files`);

      // Check per-user concurrency limit (BEFORE cancelling anything)
      const { data: activeJobs, error: activeError } = await supabaseService
        .from('speaking_evaluation_jobs')
        .select('id, status, stage, test_id, created_at')
        .eq('user_id', user.id)
        .in('status', ['pending', 'processing'])
        .order('created_at', { ascending: false });

      if (activeError) {
        console.error('[evaluate-speaking-async] Error checking active jobs:', activeError);
      }

      const currentActiveCount = activeJobs?.length || 0;

      // If user has active jobs and cancelExisting is false, block submission
      if (currentActiveCount >= MAX_CONCURRENT_JOBS_PER_USER && !cancelExisting) {
        const activeJob = activeJobs?.[0];
        return new Response(JSON.stringify({ 
          error: 'CONCURRENT_LIMIT',
          message: `You already have an evaluation in progress. Please wait for it to complete or cancel it first.`,
          activeJobId: activeJob?.id,
          activeTestId: activeJob?.test_id,
          activeStatus: activeJob?.status,
        }), {
          status: 429,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Cancel existing jobs if requested or if we need to make room
      if (activeJobs && activeJobs.length > 0) {
        console.log(`[evaluate-speaking-async] Cancelling ${activeJobs.length} existing jobs`);
        await supabaseService
          .from('speaking_evaluation_jobs')
          .update({
            status: 'failed',
            stage: 'cancelled',
            last_error: 'Cancelled: User submitted a new evaluation request.',
            updated_at: new Date().toISOString(),
            lock_token: null,
            lock_expires_at: null,
          })
          .eq('user_id', user.id)
          .in('status', ['pending', 'processing']);
      }

      // Create new job record with staged processing
      // If transcripts are available, we can skip audio upload and go straight to text-based eval
      const { data: newJob, error: jobError } = await supabaseService
        .from('speaking_evaluation_jobs')
        .insert({
          user_id: user.id,
          test_id: testId,
          status: 'pending',
          stage: hasTranscripts ? 'pending_text_eval' : 'pending_upload',
          file_paths: filePaths,
          durations: durations || {},
          topic,
          difficulty,
          fluency_flag: fluencyFlag || false,
          max_retries: 5,
          retry_count: 0,
          // Store transcripts for text-based evaluation (much cheaper than audio)
          partial_results: hasTranscripts ? { transcripts } : null,
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

    // Trigger the job runner (watchdog/dispatcher) which will handle staged processing
    const runnerUrl = `${supabaseUrl}/functions/v1/speaking-job-runner`;
    
    fetch(runnerUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${supabaseServiceKey}`,
      },
      body: JSON.stringify({ jobId: job.id }),
    }).then(res => {
      console.log(`[evaluate-speaking-async] Job runner triggered, status: ${res.status}`);
    }).catch(err => {
      console.error('[evaluate-speaking-async] Failed to trigger job runner:', err);
    });

    // Return immediately - user gets instant feedback
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
