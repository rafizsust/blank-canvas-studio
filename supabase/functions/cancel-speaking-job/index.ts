import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * Cancel Speaking Evaluation Job
 * 
 * Allows users to cancel their pending/processing speaking evaluation jobs.
 * This prevents stuck jobs from blocking new submissions.
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

interface CancelRequest {
  jobId?: string;      // Cancel specific job
  testId?: string;     // Cancel all jobs for a test
  cancelAll?: boolean; // Cancel all pending jobs for user
}

serve(async (req) => {
  console.log(`[cancel-speaking-job] Request at ${new Date().toISOString()}`);
  
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

    const body: CancelRequest = await req.json();
    const { jobId, testId, cancelAll } = body;

    if (!jobId && !testId && !cancelAll) {
      return new Response(JSON.stringify({ error: 'Must provide jobId, testId, or cancelAll' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    let query = supabaseService
      .from('speaking_evaluation_jobs')
      .update({
        status: 'failed',
        stage: 'cancelled',
        last_error: 'Cancelled by user',
        lock_token: null,
        lock_expires_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', user.id)
      .in('status', ['pending', 'processing']);

    if (jobId) {
      query = query.eq('id', jobId);
    } else if (testId) {
      query = query.eq('test_id', testId);
    }
    // If cancelAll, just use the base query with user_id filter

    const { data: cancelledJobs, error: cancelError } = await query.select('id');

    if (cancelError) {
      console.error('[cancel-speaking-job] Cancel error:', cancelError);
      return new Response(JSON.stringify({ error: 'Failed to cancel jobs' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const cancelledCount = cancelledJobs?.length || 0;
    console.log(`[cancel-speaking-job] Cancelled ${cancelledCount} jobs for user ${user.id}`);

    return new Response(JSON.stringify({
      success: true,
      cancelledCount,
      cancelledJobIds: cancelledJobs?.map(j => j.id) || [],
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
    console.error('[cancel-speaking-job] Error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
