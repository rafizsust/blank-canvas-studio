import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';

export type JobStatus = 'pending' | 'processing' | 'completed' | 'failed';

interface JobPollingOptions<T> {
  /** Table name to poll from */
  tableName: string;
  /** Column name that contains the job ID */
  idColumn?: string;
  /** The job ID to monitor */
  jobId: string | null;
  /** Polling interval in milliseconds */
  pollInterval?: number;
  /** Whether to use Supabase Realtime as primary (with polling fallback) */
  useRealtime?: boolean;
  /** Callback when job completes */
  onComplete?: (job: T) => void;
  /** Callback when job fails */
  onFailed?: (job: T) => void;
  /** Callback on any status change */
  onStatusChange?: (status: JobStatus, job: T) => void;
  /** Whether polling is enabled */
  enabled?: boolean;
}

interface JobPollingResult<T> {
  job: T | null;
  status: JobStatus | null;
  isLoading: boolean;
  error: string | null;
  isSubscribed: boolean;
  refetch: () => Promise<void>;
}

export function useJobPolling<T extends { status: string; id: string }>({
  tableName,
  idColumn = 'id',
  jobId,
  pollInterval = 5000,
  useRealtime = true,
  onComplete,
  onFailed,
  onStatusChange,
  enabled = true,
}: JobPollingOptions<T>): JobPollingResult<T> {
  const [job, setJob] = useState<T | null>(null);
  const [status, setStatus] = useState<JobStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isSubscribed, setIsSubscribed] = useState(false);

  const pollTimerRef = useRef<number | null>(null);
  const hasCompletedRef = useRef(false);
  const lastStatusRef = useRef<JobStatus | null>(null);

  // Keep callbacks stable
  const onCompleteRef = useRef(onComplete);
  const onFailedRef = useRef(onFailed);
  const onStatusChangeRef = useRef(onStatusChange);

  useEffect(() => { onCompleteRef.current = onComplete; }, [onComplete]);
  useEffect(() => { onFailedRef.current = onFailed; }, [onFailed]);
  useEffect(() => { onStatusChangeRef.current = onStatusChange; }, [onStatusChange]);

  const handleJobUpdate = useCallback((jobData: T) => {
    const jobStatus = jobData.status as JobStatus;
    
    setJob(jobData);
    setStatus(jobStatus);
    setIsLoading(false);

    // Notify on status change
    if (lastStatusRef.current !== jobStatus) {
      lastStatusRef.current = jobStatus;
      onStatusChangeRef.current?.(jobStatus, jobData);
    }

    // Handle completion
    if (jobStatus === 'completed' && !hasCompletedRef.current) {
      hasCompletedRef.current = true;
      onCompleteRef.current?.(jobData);
    }

    // Handle failure
    if (jobStatus === 'failed') {
      onFailedRef.current?.(jobData);
    }
  }, []);

  const fetchJob = useCallback(async () => {
    if (!jobId || !enabled) return;

    try {
      // Use type assertion for dynamic table queries
      const { data, error: fetchError } = await (supabase
        .from(tableName as 'speaking_evaluation_jobs')
        .select('*')
        .eq(idColumn as 'id', jobId)
        .single());

      if (fetchError) {
        setError(fetchError.message);
        setIsLoading(false);
        return;
      }

      if (data) {
        handleJobUpdate(data as unknown as T);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch job status');
      setIsLoading(false);
    }
  }, [jobId, tableName, idColumn, enabled, handleJobUpdate]);

  // Realtime subscription
  useEffect(() => {
    if (!jobId || !enabled || !useRealtime) return;

    const channel = supabase
      .channel(`job-${tableName}-${jobId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: tableName,
          filter: `${idColumn}=eq.${jobId}`,
        },
        (payload: any) => {
          if (payload?.new) {
            handleJobUpdate(payload.new as T);
          }
        }
      )
      .subscribe((subscriptionStatus) => {
        setIsSubscribed(subscriptionStatus === 'SUBSCRIBED');
      });

    return () => {
      supabase.removeChannel(channel);
      setIsSubscribed(false);
    };
  }, [jobId, tableName, idColumn, enabled, useRealtime, handleJobUpdate]);

  // Polling fallback
  useEffect(() => {
    if (!jobId || !enabled) return;

    // Initial fetch
    fetchJob();

    // Set up polling
    const shouldPoll = status !== 'completed' && status !== 'failed';
    
    if (shouldPoll) {
      pollTimerRef.current = window.setInterval(fetchJob, pollInterval);
    }

    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [jobId, enabled, pollInterval, status, fetchJob]);

  // Reset state when jobId changes
  useEffect(() => {
    if (jobId) {
      hasCompletedRef.current = false;
      lastStatusRef.current = null;
      setIsLoading(true);
      setError(null);
    }
  }, [jobId]);

  return {
    job,
    status,
    isLoading,
    error,
    isSubscribed,
    refetch: fetchJob,
  };
}
