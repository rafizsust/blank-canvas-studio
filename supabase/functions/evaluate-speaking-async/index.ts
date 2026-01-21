import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * Speaking Evaluation Job Creator v2.0
 * 
 * CRITICAL CHANGE: Browser transcripts are NO LONGER accepted for evaluation.
 * All transcription is done by Dual-Whisper engine in groq-speaking-transcribe.
 * 
 * This ensures consistent, production-grade transcription quality.
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const MAX_CONCURRENT_JOBS_PER_USER = 1;

interface EvaluationRequest {
  testId: string;
  filePaths: Record<string, string>;
  durations?: Record<string, number>;
  topic?: string;
  difficulty?: string;
  fluencyFlag?: boolean;
  retryJobId?: string;
  cancelExisting?: boolean;
  // NOTE: transcripts parameter is IGNORED - browser transcripts are unreliable
  // All transcription is done server-side by Dual-Whisper engine
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

    // Authenticate
    const { data: { user }, error: authError } = await supabaseClient.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const body: EvaluationRequest = await req.json();
    const { testId, filePaths, durations, topic, difficulty, fluencyFlag, retryJobId, cancelExisting } = body;

    // Validation
    if (!testId) {
      return new Response(JSON.stringify({ error: 'Missing testId' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const normalizedFilePaths: Record<string, string> =
      filePaths && typeof filePaths === 'object' ? filePaths : {};

    if (Object.keys(normalizedFilePaths).length === 0) {
      return new Response(JSON.stringify({ error: 'Missing filePaths - audio files required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`[evaluate-speaking-async] Processing ${Object.keys(normalizedFilePaths).length} audio files (Dual-Whisper mode)`);

    let job: any;

    if (retryJobId) {
      // Handle retry
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

      await supabaseService
        .from('speaking_evaluation_jobs')
        .update({
          status: 'pending',
          stage: 'pending_transcription',
          updated_at: new Date().toISOString(),
          last_error: null,
          lock_token: null,
          lock_expires_at: null,
        })
        .eq('id', retryJobId);

      job = existingJob;
    } else {
      // Check concurrent limit
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

      if (currentActiveCount >= MAX_CONCURRENT_JOBS_PER_USER && !cancelExisting) {
        const activeJob = activeJobs?.[0];
        return new Response(JSON.stringify({
          error: 'CONCURRENT_LIMIT',
          message: 'You already have an evaluation in progress.',
          activeJobId: activeJob?.id,
          activeTestId: activeJob?.test_id,
          activeStatus: activeJob?.status,
        }), {
          status: 429,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Cancel existing jobs if requested
      if (activeJobs && activeJobs.length > 0) {
        console.log(`[evaluate-speaking-async] Cancelling ${activeJobs.length} existing jobs`);
        await supabaseService
          .from('speaking_evaluation_jobs')
          .update({
            status: 'failed',
            stage: 'cancelled',
            last_error: 'Cancelled: New evaluation submitted',
            updated_at: new Date().toISOString(),
            lock_token: null,
            lock_expires_at: null,
          })
          .eq('user_id', user.id)
          .in('status', ['pending', 'processing']);
      }

      // Create new job - ALWAYS use Groq transcription (Dual-Whisper)
      const { data: newJob, error: jobError } = await supabaseService
        .from('speaking_evaluation_jobs')
        .insert({
          user_id: user.id,
          test_id: testId,
          status: 'pending',
          stage: 'pending_transcription', // Always start with Dual-Whisper transcription
          provider: 'groq',
          file_paths: normalizedFilePaths,
          durations: durations || {},
          topic,
          difficulty,
          fluency_flag: fluencyFlag || false,
          max_retries: 5,
          retry_count: 0,
          partial_results: {
            evaluationMode: 'dual-whisper',
            pipelineVersion: '2.0',
          },
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

    // Trigger transcription
    const runnerUrl = `${supabaseUrl}/functions/v1/speaking-job-runner`;
    fetch(runnerUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${supabaseServiceKey}`,
      },
      body: JSON.stringify({ jobId: job.id }),
    }).catch(console.error);

    return new Response(
      JSON.stringify({
        success: true,
        jobId: job.id,
        status: 'pending',
        message: 'Evaluation submitted. Results will be ready soon.',
        pipelineVersion: 'dual-whisper-2.0',
      }),
      {
        status: 202,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );

  } catch (error: any) {
    console.error('[evaluate-speaking-async] Error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
