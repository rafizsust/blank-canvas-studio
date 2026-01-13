import { useEffect, useCallback, useState, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { useNavigate } from 'react-router-dom';

interface EvaluationJob {
  id: string;
  user_id: string;
  test_id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  result_id: string | null;
  last_error: string | null;
  retry_count: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface UseSpeakingEvaluationRealtimeOptions {
  testId: string;
  onComplete?: (resultId: string) => void;
  onFailed?: (error: string) => void;
  autoNavigate?: boolean;
  pollInterval?: number; // Fallback polling interval in ms
}

export function useSpeakingEvaluationRealtime({
  testId,
  onComplete,
  onFailed,
  autoNavigate = false,
  pollInterval = 5000,
}: UseSpeakingEvaluationRealtimeOptions) {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [jobStatus, setJobStatus] = useState<EvaluationJob['status'] | null>(null);
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const [lastError, setLastError] = useState<string | null>(null);
  const pollTimerRef = useRef<number | null>(null);
  const hasCompletedRef = useRef(false);

  const handleJobUpdate = useCallback((job: EvaluationJob) => {
    console.log('[SpeakingEvaluationRealtime] Job update:', job.status, job.id);
    
    setJobStatus(job.status);
    setRetryCount(job.retry_count || 0);
    setLastError(job.last_error);

    if (job.status === 'completed' && job.result_id && !hasCompletedRef.current) {
      hasCompletedRef.current = true;
      toast({
        title: 'Evaluation Complete!',
        description: 'Your speaking test results are ready.',
      });
      
      onComplete?.(job.result_id);
      
      if (autoNavigate) {
        navigate(`/ai-practice/speaking/results/${testId}`);
      }
    } else if (job.status === 'failed') {
      const errorMessage = job.last_error || 'Evaluation failed. Please try again.';
      toast({
        title: 'Evaluation Failed',
        description: errorMessage,
        variant: 'destructive',
      });
      
      onFailed?.(errorMessage);
    }
  }, [testId, onComplete, onFailed, autoNavigate, navigate, toast]);

  // Realtime subscription
  useEffect(() => {
    if (!testId) return;

    console.log('[SpeakingEvaluationRealtime] Subscribing to job updates for test:', testId);

    const channel = supabase
      .channel(`speaking-eval-${testId}`)
      .on(
        'postgres_changes',
        {
          event: '*', // Listen to INSERT and UPDATE
          schema: 'public',
          table: 'speaking_evaluation_jobs',
          filter: `test_id=eq.${testId}`,
        },
        (payload: any) => {
          if (payload.new) {
            handleJobUpdate(payload.new as EvaluationJob);
          }
        }
      )
      .subscribe((status) => {
        console.log('[SpeakingEvaluationRealtime] Subscription status:', status);
        setIsSubscribed(status === 'SUBSCRIBED');
      });

    return () => {
      console.log('[SpeakingEvaluationRealtime] Unsubscribing from job updates');
      supabase.removeChannel(channel);
      setIsSubscribed(false);
    };
  }, [testId, handleJobUpdate]);

  // Fallback polling for reliability
  const pollJobStatus = useCallback(async () => {
    if (!testId || hasCompletedRef.current) return;

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const { data: jobs } = await supabase
        .from('speaking_evaluation_jobs')
        .select('*')
        .eq('test_id', testId)
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(1);

      if (jobs && jobs.length > 0) {
        const job = jobs[0] as unknown as EvaluationJob;
        handleJobUpdate(job);
        
        // Continue polling if not in terminal state
        if (job.status !== 'completed' && job.status !== 'failed') {
          pollTimerRef.current = window.setTimeout(pollJobStatus, pollInterval);
        }
      }
    } catch (error) {
      console.error('[SpeakingEvaluationRealtime] Polling error:', error);
      // Retry polling on error
      pollTimerRef.current = window.setTimeout(pollJobStatus, pollInterval);
    }
  }, [testId, handleJobUpdate, pollInterval]);

  // Initial check and start polling
  useEffect(() => {
    if (!testId) return;
    
    hasCompletedRef.current = false;
    pollJobStatus();

    return () => {
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
      }
    };
  }, [testId, pollJobStatus]);

  return {
    jobStatus,
    isSubscribed,
    isPending: jobStatus === 'pending',
    isProcessing: jobStatus === 'processing',
    isCompleted: jobStatus === 'completed',
    isFailed: jobStatus === 'failed',
    retryCount,
    lastError,
    isWaiting: jobStatus === 'pending' || jobStatus === 'processing',
  };
}
