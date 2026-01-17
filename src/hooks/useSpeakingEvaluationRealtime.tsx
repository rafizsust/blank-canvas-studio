import { useEffect, useCallback, useState, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { useNavigate } from 'react-router-dom';

interface EvaluationJob {
  id: string;
  user_id: string;
  test_id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  stage?: string;
  result_id: string | null;
  last_error: string | null;
  retry_count: number;
  progress?: number;
  current_part?: number;
  total_parts?: number;
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

const DEFAULT_KICK_AFTER_MS = 60 * 1000; // 1 minute - kick watchdog earlier if job seems stuck

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
  const [jobStage, setJobStage] = useState<string | null>(null);
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const [lastError, setLastError] = useState<string | null>(null);
  const [latestJobId, setLatestJobId] = useState<string | null>(null);
  const [latestJobUpdatedAt, setLatestJobUpdatedAt] = useState<string | null>(null);
  const [progress, setProgress] = useState<number>(0);
  const [currentPart, setCurrentPart] = useState<number>(0);
  const [totalParts, setTotalParts] = useState<number>(3);
  const [isCancelling, setIsCancelling] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);

  const pollTimerRef = useRef<number | null>(null);
  const hasCompletedRef = useRef(false);
  const lastLoggedStatusRef = useRef<EvaluationJob['status'] | null>(null);
  const kickStartedRef = useRef(false);
  const kickTimerRef = useRef<number | null>(null);
  const initialStatusRef = useRef<EvaluationJob['status'] | null>(null); // Track initial status to suppress toast for pre-completed jobs
  const mountedAtRef = useRef<number>(Date.now());

  // Keep callbacks stable so realtime subscription doesn't resubscribe every render
  const onCompleteRef = useRef(onComplete);
  const onFailedRef = useRef(onFailed);

  // Keep impure functions stable (some implementations return new references each render)
  const toastRef = useRef(toast);
  const navigateRef = useRef(navigate);

  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  useEffect(() => {
    onFailedRef.current = onFailed;
  }, [onFailed]);

  useEffect(() => {
    toastRef.current = toast;
  }, [toast]);

  useEffect(() => {
    navigateRef.current = navigate;
  }, [navigate]);

  const handleJobUpdate = useCallback(
    (job: EvaluationJob) => {
      // Once we have a successful completion, ignore older/late "failed" updates
      // (common when previous attempts are cancelled after a new attempt succeeds).
      if (hasCompletedRef.current && job.status !== 'completed') {
        return;
      }

      // Ignore cancelled jobs entirely - these were superseded by a new submission
      if (job.status === 'failed' && job.last_error?.includes('Cancelled:')) {
        console.log('[SpeakingEvaluationRealtime] Ignoring cancelled job:', job.id);
        return;
      }

      // Track initial status on first update to detect pre-completed jobs
      if (initialStatusRef.current === null) {
        initialStatusRef.current = job.status;
        console.log('[SpeakingEvaluationRealtime] Initial status captured:', job.status);
      }

      if (lastLoggedStatusRef.current !== job.status) {
        console.log('[SpeakingEvaluationRealtime] Job update:', job.status, job.stage, job.id);
        lastLoggedStatusRef.current = job.status;
      }

      setLatestJobId(job.id);
      setLatestJobUpdatedAt(job.updated_at || job.created_at);
      setJobStatus(job.status as EvaluationJob['status']);
      setJobStage(job.stage || null);
      setRetryCount(job.retry_count || 0);
      setLastError(job.last_error);
      setProgress(job.progress || 0);
      setCurrentPart(job.current_part || 0);
      setTotalParts(job.total_parts || 3);

      if (job.status === 'completed' && job.result_id && !hasCompletedRef.current) {
        hasCompletedRef.current = true;
        
        // Only show toast if job was NOT already completed when we started watching
        // This prevents the flicker when viewing already-completed results
        const wasAlreadyCompleted = initialStatusRef.current === 'completed';
        const jobCompletedRecently = job.completed_at && (Date.now() - new Date(job.completed_at).getTime()) < 30000; // Within 30 seconds
        
        if (!wasAlreadyCompleted || jobCompletedRecently) {
          toastRef.current({
            title: 'Evaluation Complete!',
            description: 'Your speaking test results are ready.',
          });
        } else {
          console.log('[SpeakingEvaluationRealtime] Suppressing toast for pre-completed job');
        }

        onCompleteRef.current?.(job.result_id);

        if (autoNavigate) {
          navigateRef.current(`/ai-practice/speaking/results/${testId}`);
        }
      } else if (job.status === 'failed' && !job.last_error?.includes('Cancelled:')) {
        // Only show failure toast for non-cancelled failures
        const errorMessage = job.last_error || 'Evaluation failed. Please try again.';
        toastRef.current({
          title: 'Evaluation Failed',
          description: errorMessage,
          variant: 'destructive',
        });

        onFailedRef.current?.(errorMessage);
      }
    },
    [testId, autoNavigate]
  );

  // Cancel the current job
  const cancelJob = useCallback(async () => {
    if (!latestJobId || isCancelling) return;

    setIsCancelling(true);
    try {
      const { error } = await supabase.functions.invoke('cancel-speaking-job', {
        body: { jobId: latestJobId },
      });

      if (error) {
        console.error('[SpeakingEvaluationRealtime] Cancel failed:', error);
        toastRef.current({
          title: 'Cancel Failed',
          description: 'Could not cancel the evaluation. Please try again.',
          variant: 'destructive',
        });
      } else {
        toastRef.current({
          title: 'Evaluation Cancelled',
          description: 'Your evaluation has been cancelled.',
        });
        setJobStatus('failed');
        setLastError('Cancelled by user');
      }
    } catch (e) {
      console.error('[SpeakingEvaluationRealtime] Cancel error:', e);
    } finally {
      setIsCancelling(false);
    }
  }, [latestJobId, isCancelling]);

  // Retry the failed job
  const retryJob = useCallback(async () => {
    if (!latestJobId || isRetrying) return;

    setIsRetrying(true);
    try {
      const { error } = await supabase.functions.invoke('retry-speaking-evaluation', {
        body: { jobId: latestJobId },
      });

      if (error) {
        console.error('[SpeakingEvaluationRealtime] Retry failed:', error);
        toastRef.current({
          title: 'Retry Failed',
          description: 'Could not retry the evaluation. Please try again.',
          variant: 'destructive',
        });
      } else {
        toastRef.current({
          title: 'Retry Started',
          description: 'Your evaluation is being retried.',
        });
        // Reset state for retry
        hasCompletedRef.current = false;
        setJobStatus('pending');
        setLastError(null);
        setProgress(0);
      }
    } catch (e) {
      console.error('[SpeakingEvaluationRealtime] Retry error:', e);
    } finally {
      setIsRetrying(false);
    }
  }, [latestJobId, isRetrying]);

  // Realtime subscription
  useEffect(() => {
    if (!testId) return;

    console.log('[SpeakingEvaluationRealtime] Subscribing to job updates for test:', testId);

    const channel = supabase
      .channel(`speaking-eval-${testId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'speaking_evaluation_jobs',
          filter: `test_id=eq.${testId}`,
        },
        (payload: any) => {
          if (payload?.new) {
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

      // Get the latest non-cancelled job
      const { data: jobs } = await supabase
        .from('speaking_evaluation_jobs')
        .select('*')
        .eq('test_id', testId)
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(5);

      if (jobs && jobs.length > 0) {
        // Find the latest job that isn't cancelled
        const latestActiveJob = jobs.find(j => 
          !(j.status === 'failed' && j.last_error?.includes('Cancelled:'))
        );
        
        if (latestActiveJob) {
          const job = latestActiveJob as unknown as EvaluationJob;
          handleJobUpdate(job);

          // Continue polling if not in terminal state
          if (job.status !== 'completed' && job.status !== 'failed') {
            pollTimerRef.current = window.setTimeout(pollJobStatus, pollInterval);
          }
        }
      }
    } catch (error) {
      console.error('[SpeakingEvaluationRealtime] Polling error:', error);
      // Retry polling on error
      pollTimerRef.current = window.setTimeout(pollJobStatus, pollInterval);
    }
  }, [testId, handleJobUpdate, pollInterval]);

  // Kick the watchdog if the job seems stuck (prevents "evaluating forever")
  const kickWatchdog = useCallback(async () => {
    if (!latestJobId || kickStartedRef.current || hasCompletedRef.current) return;

    kickStartedRef.current = true;
    try {
      await supabase.functions.invoke('speaking-job-runner', {
        body: { jobId: latestJobId },
      });
      console.log('[SpeakingEvaluationRealtime] Watchdog kicked for job:', latestJobId);
    } catch (e) {
      console.warn('[SpeakingEvaluationRealtime] Failed to kick watchdog:', e);
    }
  }, [latestJobId]);

  useEffect(() => {
    // reset when test changes
    kickStartedRef.current = false;

    if (kickTimerRef.current) {
      window.clearTimeout(kickTimerRef.current);
      kickTimerRef.current = null;
    }

    if (!latestJobUpdatedAt || !latestJobId) return;
    if (hasCompletedRef.current) return;

    if (jobStatus === 'processing' || jobStatus === 'pending') {
      // Schedule one kick; if job updates keep flowing, we reschedule.
      kickTimerRef.current = window.setTimeout(() => {
        void kickWatchdog();
      }, DEFAULT_KICK_AFTER_MS);
    }

    return () => {
      if (kickTimerRef.current) {
        window.clearTimeout(kickTimerRef.current);
        kickTimerRef.current = null;
      }
    };
  }, [testId, latestJobUpdatedAt, latestJobId, jobStatus, kickWatchdog]);

  // Initial check and start polling
  useEffect(() => {
    if (!testId) return;

    hasCompletedRef.current = false;
    initialStatusRef.current = null; // Reset initial status tracking
    mountedAtRef.current = Date.now();
    pollJobStatus();

    return () => {
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
      }
    };
  }, [testId, pollJobStatus]);

  return {
    jobStatus,
    jobStage,
    isSubscribed,
    isPending: jobStatus === 'pending',
    isProcessing: jobStatus === 'processing',
    isCompleted: jobStatus === 'completed',
    isFailed: jobStatus === 'failed',
    retryCount,
    lastError,
    isWaiting: jobStatus === 'pending' || jobStatus === 'processing',
    // Progress info
    progress,
    currentPart,
    totalParts,
    // Job actions
    latestJobId,
    cancelJob,
    retryJob,
    isCancelling,
    isRetrying,
  };
}
