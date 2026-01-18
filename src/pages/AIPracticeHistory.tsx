import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Navbar } from '@/components/Navbar';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ToastAction } from '@/components/ui/toast';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/useAuth';
import { useBrowserNotifications } from '@/hooks/useBrowserNotifications';
import { supabase } from '@/integrations/supabase/client';
import { 
  getSpeakingSubmissionTracker,
  getPersistedTiming,
  type SpeakingSubmissionTracker,
} from '@/lib/speakingSubmissionTracker';
import { 
  BookOpen, 
  Headphones, 
  PenTool,
  Mic,
  Clock,
  Target,
  Trash2,
  History,
  Sparkles,
  ArrowLeft,
  Eye,
  RotateCcw,
  AlertCircle,
  RefreshCw,
  Loader2,
  Bell,
  BellOff,
  Zap,
  Timer,
  Upload,
  AudioLines,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';
import { setCurrentTest, GeneratedTest } from '@/types/aiPractice';
import { hasFailedSubmission } from '@/hooks/useTestSubmission';
import type { Tables } from '@/integrations/supabase/types';

interface PendingEvaluation {
  id: string;
  test_id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'stale' | 'retrying';
  created_at: string;
  updated_at?: string;
  last_error?: string | null;
  retry_count?: number;
  max_retries?: number;
  progress?: number;
  current_part?: number;
  total_parts?: number;
}

const MAX_RETRIES = 5; // Must match edge function

type AIPracticeTest = Tables<'ai_practice_tests'>;
type AIPracticeResult = Tables<'ai_practice_results'>;

const MODULE_ICONS: Record<string, typeof BookOpen> = {
  reading: BookOpen,
  listening: Headphones,
  writing: PenTool,
  speaking: Mic,
};

const DIFFICULTY_COLORS: Record<string, string> = {
  easy: 'bg-success/20 text-success border-success/30',
  medium: 'bg-warning/20 text-warning border-warning/30',
  hard: 'bg-destructive/20 text-destructive border-destructive/30',
};

// SessionStorage key for timing data
const TIMING_STORAGE_KEY = 'ai_practice_timing';

// Load timing data from sessionStorage
function loadTimingFromStorage(): Record<string, { totalTimeMs: number; timing: Record<string, number> }> {
  try {
    const stored = sessionStorage.getItem(TIMING_STORAGE_KEY);
    return stored ? JSON.parse(stored) : {};
  } catch {
    return {};
  }
}

// Save timing data to sessionStorage
function saveTimingToStorage(timing: Record<string, { totalTimeMs: number; timing: Record<string, number> }>) {
  try {
    sessionStorage.setItem(TIMING_STORAGE_KEY, JSON.stringify(timing));
  } catch {
    // ignore storage errors
  }
}

// Live elapsed time component for pending evaluations
function LiveElapsedTime({ startTime }: { startTime: string }) {
  const [elapsed, setElapsed] = useState('');
  
  useEffect(() => {
    const start = new Date(startTime).getTime();
    
    const update = () => {
      const now = Date.now();
      const durationMs = now - start;
      
      if (durationMs < 60000) {
        setElapsed(`${Math.round(durationMs / 1000)}s`);
      } else if (durationMs < 3600000) {
        const mins = Math.floor(durationMs / 60000);
        const secs = Math.round((durationMs % 60000) / 1000);
        setElapsed(`${mins}m ${secs}s`);
      } else {
        const hours = Math.floor(durationMs / 3600000);
        const mins = Math.floor((durationMs % 3600000) / 60000);
        setElapsed(`${hours}h ${mins}m`);
      }
    };
    
    update(); // Initial update
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [startTime]);
  
  return (
    <span className="flex items-center gap-1 text-primary animate-pulse">
      <Timer className="w-3 h-3" />
      {elapsed}...
    </span>
  );
}

// Timing breakdown component - only shows when evaluation is COMPLETED
function TimingBreakdown({ 
  timing, 
  tracker,
  testId 
}: { 
  timing?: { totalTimeMs: number; timing: Record<string, number> };
  tracker?: SpeakingSubmissionTracker | null;
  testId?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  
  // Only show timing after evaluation is complete (not during)
  // Check if tracker stage is 'completed' or if we have result timing
  const isComplete = tracker?.stage === 'completed' || !!timing;
  if (!isComplete) return null;
  
  // Combine timing from multiple sources in priority order:
  // 1. Completed result timing (most reliable, persisted in DB)
  // 2. Active tracker timing (live updates)
  // 3. Persisted timing from sessionStorage (after tracker was cleared)
  const trackerTiming = tracker?.timing as Record<string, number> | undefined;
  const persistedTiming = testId ? getPersistedTiming(testId) : null;
  const persistedTimingRecord = persistedTiming as Record<string, number> | null;
  
  const displayTiming: Record<string, number> = timing?.timing || trackerTiming || persistedTimingRecord || {};
  const totalMs = timing?.totalTimeMs || displayTiming.totalMs || 0;
  
  // Only show if we have actual timing data
  if (totalMs === 0 && Object.keys(displayTiming).length === 0) return null;
  
  const formatMs = (ms: number) => {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };
  
  const stages = [
    { key: 'conversionMs', label: 'Conversion', icon: AudioLines },
    { key: 'uploadMs', label: 'Upload', icon: Upload },
    { key: 'queueMs', label: 'Queue', icon: Clock },
    { key: 'evaluationMs', label: 'Evaluation', icon: Zap },
    { key: 'r2UploadMs', label: 'R2 Upload', icon: Upload },
    { key: 'googleUploadMs', label: 'Google Upload', icon: Upload },
    { key: 'saveResultMs', label: 'Save', icon: Target },
  ].filter(s => displayTiming[s.key] !== undefined);
  
  // If we only have totalMs, just show that
  const hasDetails = stages.length > 0;
  
  return (
    <div className="mt-2">
      <button
        onClick={(e) => { e.stopPropagation(); hasDetails && setExpanded(!expanded); }}
        className={cn(
          "flex items-center gap-1 text-xs text-muted-foreground transition-colors",
          hasDetails && "hover:text-foreground cursor-pointer"
        )}
      >
        {hasDetails && (expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />)}
        <span>Timing breakdown</span>
        {totalMs > 0 && <span className="text-success">({formatMs(totalMs)} total)</span>}
      </button>
      
      {expanded && hasDetails && (
        <div className="mt-2 pl-4 border-l-2 border-muted space-y-1">
          {stages.map(({ key, label, icon: Icon }) => (
            <div key={key} className="flex items-center gap-2 text-xs text-muted-foreground">
              <Icon className="w-3 h-3" />
              <span>{label}:</span>
              <span className="text-foreground">{formatMs(displayTiming[key])}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function AIPracticeHistory() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { user, loading: authLoading } = useAuth();
  const { 
    isSupported: notificationsSupported, 
    permission: notificationPermission, 
    requestPermission,
    notifyEvaluationComplete,
    notifyEvaluationFailed,
  } = useBrowserNotifications();
  const [tests, setTests] = useState<AIPracticeTest[]>([]);
  const [testResults, setTestResults] = useState<Record<string, AIPracticeResult>>({});
  const [loading, setLoading] = useState(true);
  const [activeModule, setActiveModule] = useState<string>('all');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [pendingEvaluations, setPendingEvaluations] = useState<Map<string, PendingEvaluation>>(new Map());
  // Client-side tracker state for tests still uploading/converting (before DB job exists)
  const [clientTrackers, setClientTrackers] = useState<Map<string, SpeakingSubmissionTracker>>(new Map());
  
  // REF to track testResults for use in realtime callbacks (avoids stale closures)
  const testResultsRef = useRef<Record<string, AIPracticeResult>>({});
  useEffect(() => {
    testResultsRef.current = testResults;
  }, [testResults]);

  // REF to track if realtime channels have been set up (prevent re-subscribe loops)
  const channelsSetupRef = useRef(false);
  const channelIdsRef = useRef<{ evalChannel: string | null; resultsChannel: string | null }>({
    evalChannel: null,
    resultsChannel: null,
  });

  // Listen for client-side tracker updates (from test page still running in another tab or before navigation)
  useEffect(() => {
    // Check for any existing trackers on mount (in case user refreshed or navigated back)
    const checkExistingTrackers = () => {
      const newTrackers = new Map<string, SpeakingSubmissionTracker>();
      // Check sessionStorage for any trackers
      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i);
        if (key?.startsWith('speaking_submission_tracker:')) {
          const testId = key.replace('speaking_submission_tracker:', '');
          const tracker = getSpeakingSubmissionTracker(testId);
          if (tracker) {
            newTrackers.set(testId, tracker);
          }
        }
      }
      if (newTrackers.size > 0) {
        setClientTrackers(newTrackers);
      }
    };

    checkExistingTrackers();

    // Listen for tracker updates (custom events from same tab)
    const handleTrackerUpdate = (e: CustomEvent<{ testId: string; tracker: SpeakingSubmissionTracker | null }>) => {
      const { testId, tracker } = e.detail;
      setClientTrackers(prev => {
        const updated = new Map(prev);
        if (!tracker) {
          updated.delete(testId);
        } else {
          updated.set(testId, tracker);
        }
        return updated;
      });
    };

    window.addEventListener('speaking-submission-tracker', handleTrackerUpdate as EventListener);
    
    // Periodic polling for tracker updates from sessionStorage
    // This catches updates from edge function fire-and-forget calls that may update
    // sessionStorage after the navigation has occurred
    const pollInterval = setInterval(() => {
      checkExistingTrackers();
    }, 2000); // Poll every 2 seconds for responsive updates

    return () => {
      window.removeEventListener('speaking-submission-tracker', handleTrackerUpdate as EventListener);
      clearInterval(pollInterval);
    };
  }, []);
  useEffect(() => {
    if (!authLoading && user) {
      loadTests();
      loadPendingEvaluations();
    } else if (!authLoading && !user) {
      setLoading(false);
    }
  }, [user, authLoading]);

  // Sort tests by most recent activity whenever tests, results, or pending evaluations change
  useEffect(() => {
    if (tests.length === 0) return;
    
    const sortedTests = [...tests].sort((a, b) => {
      const aResult = testResults[a.id];
      const bResult = testResults[b.id];
      const aPending = pendingEvaluations.get(a.id);
      const bPending = pendingEvaluations.get(b.id);
      
      // Get the most recent activity time for each test
      const getActivityTime = (_testId: string, result: AIPracticeResult | undefined, pending: PendingEvaluation | undefined, generatedAt: string): number => {
        const times: number[] = [new Date(generatedAt).getTime()];
        
        if (result?.completed_at) {
          times.push(new Date(result.completed_at).getTime());
        }
        
        if (pending?.created_at) {
          times.push(new Date(pending.created_at).getTime());
        }
        
        return Math.max(...times);
      };
      
      const aTime = getActivityTime(a.id, aResult, aPending, a.generated_at);
      const bTime = getActivityTime(b.id, bResult, bPending, b.generated_at);
      
      return bTime - aTime; // Descending order (newest first)
    });
    
    // Only update if order actually changed to avoid infinite loops
    const hasChanged = sortedTests.some((t, i) => t.id !== tests[i]?.id);
    if (hasChanged) {
      setTests(sortedTests);
    }
  }, [testResults, pendingEvaluations]);

  // Realtime subscription for speaking evaluation jobs - setup ONCE per user session
  useEffect(() => {
    if (!user || channelsSetupRef.current) return;

    const isNewer = (a: PendingEvaluation, b: PendingEvaluation) => {
      const ta = new Date(a.created_at).getTime();
      const tb = new Date(b.created_at).getTime();
      return ta >= tb;
    };

    const hasNewerResult = (testId: string, jobCreatedAt: string) => {
      const r = testResultsRef.current[testId];
      if (!r?.completed_at) return false;
      return new Date(r.completed_at).getTime() >= new Date(jobCreatedAt).getTime();
    };

    // Create unique channel ID for this session
    const evalChannelId = `speaking-eval-history-${user.id}-${Date.now()}`;
    channelIdsRef.current.evalChannel = evalChannelId;

    const channel = supabase
      .channel(evalChannelId)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'speaking_evaluation_jobs',
          filter: `user_id=eq.${user.id}`,
        },
        (payload: any) => {
          const job = payload.new as PendingEvaluation;
          if (!job) return;

          // If the user already has a newer result saved, ignore late/stale failures from older attempts.
          if (job.status === 'failed' && hasNewerResult(job.test_id, job.created_at)) {
            // Also remove this job from pending if it exists
            setPendingEvaluations((prev) => {
              if (prev.has(job.test_id)) {
                const updated = new Map(prev);
                updated.delete(job.test_id);
                return updated;
              }
              return prev;
            });
            return;
          }
          
          // If the job was cancelled due to a new submission, ignore it entirely
          if (job.status === 'failed' && job.last_error?.includes('Cancelled:')) {
            return;
          }

          setPendingEvaluations((prev) => {
            const existing = prev.get(job.test_id);
            // Keep only the latest job per test_id
            if (existing && !isNewer(job, existing)) {
              return prev;
            }

            const updated = new Map(prev);

            if (job.status === 'completed') {
              // Remove from pending and reload results
              updated.delete(job.test_id);
            } else {
              updated.set(job.test_id, job as PendingEvaluation);
            }

            return updated;
          });

          if (job.status === 'completed') {
            toast({
              title: '🎉 Speaking Evaluation Ready!',
              description: 'Your speaking test results are now available.',
              action: (
                <ToastAction 
                  altText="View Results"
                  onClick={() => navigate(`/ai-practice/speaking/results/${job.test_id}`)}
                >
                  View Results
                </ToastAction>
              ),
            });

            // Browser notification with navigation - use window.location for reliability
            const testResultsUrl = `/ai-practice/speaking/results/${job.test_id}`;
            notifyEvaluationComplete(undefined, () => {
              window.location.href = testResultsUrl;
            });

            loadTests();
          } else if (job.status === 'failed') {
            const isMaxRetriesReached = (job.retry_count || 0) >= MAX_RETRIES;

            toast({
              title: isMaxRetriesReached ? 'Evaluation Permanently Failed' : 'Evaluation Failed',
              description: isMaxRetriesReached
                ? 'Max retries exceeded. Please try generating a new test.'
                : (job.last_error || 'There was an issue evaluating your speaking test. You can retry.'),
              variant: 'destructive',
            });

            if (isMaxRetriesReached) {
              notifyEvaluationFailed('Max retries exceeded. Please try generating a new test.');
            }
          } else if (job.status === 'stale') {
            toast({
              title: 'Evaluation Timed Out',
              description: 'The evaluation timed out. Retrying automatically...',
              variant: 'destructive',
            });
          }
        }
      )
      .subscribe();

    // Mark channels as setup
    channelsSetupRef.current = true;

    return () => {
      supabase.removeChannel(channel);
      channelsSetupRef.current = false;
      channelIdsRef.current.evalChannel = null;
    };
  }, [user, toast, navigate, notifyEvaluationComplete, notifyEvaluationFailed]);

  // Realtime subscription for ai_practice_results - instant updates when results are saved
  useEffect(() => {
    if (!user) return;
    // Prevent re-subscribe if already set up for results channel
    if (channelIdsRef.current.resultsChannel) return;

    const resultsChannelId = `ai-practice-results-${user.id}-${Date.now()}`;
    channelIdsRef.current.resultsChannel = resultsChannelId;

    const resultsChannel = supabase
      .channel(resultsChannelId)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'ai_practice_results',
          filter: `user_id=eq.${user.id}`,
        },
        (payload: any) => {
          const newResult = payload.new as AIPracticeResult;
          if (!newResult) return;

          // Update testResults state immediately
          setTestResults((prev) => {
            // Only update if this is a newer result or we don't have one yet
            const existing = prev[newResult.test_id];
            if (existing && new Date(existing.completed_at) >= new Date(newResult.completed_at)) {
              return prev;
            }
            return { ...prev, [newResult.test_id]: newResult };
          });

          // Remove from pending evaluations if exists
          setPendingEvaluations((prev) => {
            if (prev.has(newResult.test_id)) {
              const updated = new Map(prev);
              updated.delete(newResult.test_id);
              return updated;
            }
            return prev;
          });

          // Show toast for speaking/writing results (modules with AI evaluation)
          if (newResult.module === 'speaking' || newResult.module === 'writing') {
            toast({
              title: `✅ ${newResult.module.charAt(0).toUpperCase() + newResult.module.slice(1)} Results Ready!`,
              description: newResult.band_score 
                ? `Band ${Number(newResult.band_score).toFixed(1)} achieved.`
                : 'Your evaluation is complete.',
              action: (
                <ToastAction 
                  altText="View Results"
                  onClick={() => navigate(`/ai-practice/${newResult.module}/results/${newResult.test_id}`)}
                >
                  View
                </ToastAction>
              ),
            });
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(resultsChannel);
      channelIdsRef.current.resultsChannel = null;
    };
  }, [user, toast, navigate]);

  // Load pending evaluations on mount
  const loadPendingEvaluations = useCallback(async () => {
    if (!user) return;

    try {
      // Only load jobs that are actually pending or processing (not failed/completed)
      // and exclude cancelled jobs
      const { data: jobs } = await supabase
        .from('speaking_evaluation_jobs')
        .select('id, test_id, status, created_at, updated_at, last_error, retry_count, max_retries, progress, current_part, total_parts')
        .eq('user_id', user.id)
        .in('status', ['pending', 'processing'])
        .order('created_at', { ascending: false });

      if (jobs && jobs.length > 0) {
        const pendingMap = new Map<string, PendingEvaluation>();
        // Jobs are ordered newest-first, so first seen per test_id is the latest.
        jobs.forEach((job) => {
          if (!pendingMap.has(job.test_id)) {
            // Skip cancelled jobs
            if (job.last_error?.includes('Cancelled:')) {
              return;
            }
            // If a newer result exists, ignore old pending entries.
            const r = testResults[job.test_id];
            if (r?.completed_at && new Date(r.completed_at).getTime() >= new Date(job.created_at).getTime()) {
              return;
            }
            pendingMap.set(job.test_id, job as PendingEvaluation);
          }
        });
        setPendingEvaluations(pendingMap);
      } else {
        setPendingEvaluations(new Map());
      }
    } catch (err) {
      console.error('Failed to load pending evaluations:', err);
    }
  }, [user, testResults]);

  const loadTests = async () => {
    if (!user) return;
    
    try {
      // Load tests - we'll sort client-side after getting results to order by most recent activity
      const { data: testsData, error: testsError } = await supabase
        .from('ai_practice_tests')
        .select('*')
        .eq('user_id', user.id)
        .order('generated_at', { ascending: false })
        .limit(100); // Safe limit to prevent massive queries

      if (testsError) throw testsError;

      // Load results for these tests (batch in chunks to avoid massive IN queries)
      if (testsData && testsData.length > 0) {
        const testIds = testsData.map(t => t.id);
        const resultsMap: Record<string, AIPracticeResult> = {};
        
        // Batch load in chunks of 50 to avoid query limits
        const chunkSize = 50;
        for (let i = 0; i < testIds.length; i += chunkSize) {
          const chunk = testIds.slice(i, i + chunkSize);
          const { data: resultsData } = await supabase
            .from('ai_practice_results')
            .select('*')
            .eq('user_id', user.id)
            .in('test_id', chunk);

          if (resultsData) {
            resultsData.forEach(r => {
              // Keep the most recent result per test
              if (!resultsMap[r.test_id] || new Date(r.completed_at) > new Date(resultsMap[r.test_id].completed_at)) {
                resultsMap[r.test_id] = r;
              }
            });
          }
        }
        
        setTestResults(resultsMap);

        // Sort will be applied later after pending evaluations are loaded
        setTests(testsData);
      } else {
        setTests(testsData || []);
      }
    } catch (err: any) {
      console.error('Failed to load tests:', err);
      toast({
        title: 'Error',
        description: 'Failed to load practice history',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (testId: string) => {
    if (!user) return;
    
    setDeletingId(testId);
    try {
      const { error } = await supabase
        .from('ai_practice_tests')
        .delete()
        .eq('id', testId)
        .eq('user_id', user.id);

      if (error) throw error;

      setTests(prev => prev.filter(t => t.id !== testId));
      toast({
        title: 'Deleted',
        description: 'Practice test removed from history',
      });
    } catch (err: any) {
      console.error('Failed to delete test:', err);
      toast({
        title: 'Error',
        description: 'Failed to delete test',
        variant: 'destructive',
      });
    } finally {
      setDeletingId(null);
    }
  };

  // Retry a failed/stale speaking evaluation
  const [retryingJobId, setRetryingJobId] = useState<string | null>(null);
  const [cancellingJobId, setCancellingJobId] = useState<string | null>(null);
  
  // Parallel mode resubmission state - load from sessionStorage on mount
  const [parallelResubmitting, setParallelResubmitting] = useState<string | null>(null);
  const [parallelTiming, setParallelTiming] = useState<Record<string, { totalTimeMs: number; timing: Record<string, number> }>>(() => loadTimingFromStorage());

  // Persist timing to sessionStorage whenever it changes
  useEffect(() => {
    saveTimingToStorage(parallelTiming);
  }, [parallelTiming]);

  // Cancel a pending/processing speaking evaluation
  const handleCancelEvaluation = async (testId: string) => {
    const pendingJob = pendingEvaluations.get(testId);
    if (!pendingJob) return;

    setCancellingJobId(pendingJob.id);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        toast({ title: 'Error', description: 'Please log in to cancel', variant: 'destructive' });
        return;
      }

      const response = await supabase.functions.invoke('cancel-speaking-job', {
        body: { jobId: pendingJob.id },
      });

      if (response.error) {
        throw new Error(response.error.message);
      }

      toast({
        title: 'Evaluation Cancelled',
        description: 'The speaking evaluation has been cancelled.',
      });

      // Remove from pending evaluations
      setPendingEvaluations(prev => {
        const updated = new Map(prev);
        updated.delete(testId);
        return updated;
      });

    } catch (err: any) {
      console.error('Failed to cancel evaluation:', err);
      toast({
        title: 'Cancel Failed',
        description: err.message || 'Failed to cancel evaluation',
        variant: 'destructive',
      });
    } finally {
      setCancellingJobId(null);
    }
  };
  
  const handleRetryEvaluation = async (testId: string) => {
    const pendingJob = pendingEvaluations.get(testId);
    if (!pendingJob) return;

    setRetryingJobId(pendingJob.id);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        toast({ title: 'Error', description: 'Please log in to retry', variant: 'destructive' });
        return;
      }

      const response = await supabase.functions.invoke('retry-speaking-evaluation', {
        body: { jobId: pendingJob.id },
      });

      if (response.error) {
        throw new Error(response.error.message);
      }

      toast({
        title: 'Retry Started',
        description: 'Evaluation is being retried. Please wait...',
      });

      // Update local state to show retrying
      setPendingEvaluations(prev => {
        const updated = new Map(prev);
        updated.set(testId, { ...pendingJob, status: 'retrying' });
        return updated;
      });

    } catch (err: any) {
      console.error('Failed to retry evaluation:', err);
      toast({
        title: 'Retry Failed',
        description: err.message || 'Failed to retry evaluation',
        variant: 'destructive',
      });
    } finally {
      setRetryingJobId(null);
    }
  };

  // Handle Parallel Mode resubmission (uses stored R2 audio, single API call)
  const handleParallelResubmit = async (testId: string) => {
    setParallelResubmitting(testId);
    const startTime = Date.now();
    
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        toast({ title: 'Error', description: 'Please log in to resubmit', variant: 'destructive' });
        return;
      }

      toast({
        title: 'Parallel Mode Started',
        description: 'Resubmitting with accuracy mode... This may take 30-60 seconds.',
      });

      const response = await supabase.functions.invoke('resubmit-parallel', {
        body: { testId },
      });

      const clientElapsed = Date.now() - startTime;

      if (response.error) {
        throw new Error(response.error.message);
      }

      const data = response.data;
      
      if (data?.success) {
        setParallelTiming(prev => ({
          ...prev,
          [testId]: {
            totalTimeMs: data.totalTimeMs,
            timing: data.timing,
          },
        }));

        toast({
          title: `✅ Parallel Mode Complete!`,
          description: `Band ${data.overallBand?.toFixed(1)} in ${(data.totalTimeMs / 1000).toFixed(1)}s (server) / ${(clientElapsed / 1000).toFixed(1)}s (client)`,
        });

        // Reload tests to show updated results
        loadTests();
      } else if (data?.error) {
        throw new Error(data.error);
      }
    } catch (err: any) {
      console.error('[AIPracticeHistory] Parallel resubmission error:', err);
      toast({
        title: 'Parallel Mode Failed',
        description: err.message || 'Failed to resubmit with parallel mode',
        variant: 'destructive',
      });
    } finally {
      setParallelResubmitting(null);
    }
  };
  const handleViewResults = (test: AIPracticeTest) => {
    const result = testResults[test.id];
    if (!result) {
      toast({
        title: 'No Results Yet',
        description: 'Complete the test first to view results.',
      });
      return;
    }

    // Navigate to appropriate results page based on module
    if (test.module === 'writing') {
      navigate(`/ai-practice/writing/results/${test.id}`);
    } else if (test.module === 'speaking') {
      navigate(`/ai-practice/speaking/results/${test.id}`);
    } else if (test.module === 'reading') {
      navigate(`/ai-practice/results/${test.id}`);
    } else if (test.module === 'listening') {
      navigate(`/ai-practice/results/${test.id}`);
    } else {
      navigate(`/ai-practice/results/${test.id}`);
    }
  };

  const handleStartTest = (test: AIPracticeTest) => {
    // Convert DB record to GeneratedTest format and cache it
    const payload = typeof test.payload === 'object' && test.payload !== null ? (test.payload as Record<string, any>) : {};

    // Prefer DB columns, then payload fallbacks (some older rows stored audioUrl inside payload)
    const resolvedAudioUrl =
      (test as any).audio_url ??
      payload.audioUrl ??
      (payload as any).audio_url ??
      undefined;

    const generatedTest: GeneratedTest = {
      ...payload,
      id: test.id,
      module: test.module as any,
      questionType: test.question_type as any,
      difficulty: test.difficulty as any,
      topic: test.topic,
      timeMinutes: test.time_minutes,
      totalQuestions: test.total_questions,
      generatedAt: test.generated_at,
      audioUrl: resolvedAudioUrl,
      audioFormat: (test as any).audio_format ?? payload.audioFormat ?? undefined,
      sampleRate: (test as any).sample_rate ?? payload.sampleRate ?? undefined,
    };

    setCurrentTest(generatedTest);

    // Navigate to appropriate test page
    if (test.module === 'writing') {
      navigate(`/ai-practice/writing/${test.id}`);
    } else if (test.module === 'speaking') {
      navigate(`/ai-practice/speaking/${test.id}`);
    } else if (test.module === 'reading') {
      navigate(`/ai-practice/reading/${test.id}`);
    } else if (test.module === 'listening') {
      navigate(`/ai-practice/listening/${test.id}`);
    } else {
      navigate(`/ai-practice/test/${test.id}`);
    }
  };

  const filteredTests = activeModule === 'all' 
    ? tests 
    : tests.filter(t => t.module === activeModule);

  const formatQuestionType = (type: string) => {
    return type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  };

  const formatWritingQuestionType = (type: string) => {
    switch (type) {
      case 'TASK_1':
        return 'Task 1 (Report)';
      case 'TASK_2':
        return 'Task 2 (Essay)';
      case 'FULL_TEST':
        return 'Full Test (Task 1 + Task 2)';
      default:
        return formatQuestionType(type);
    }
  };

  // Helper function to get the "Last updated" time for a test
  const getLastUpdatedTime = (
    test: AIPracticeTest,
    result: AIPracticeResult | undefined,
    pending: PendingEvaluation | undefined,
    tracker: SpeakingSubmissionTracker | null | undefined
  ): Date => {
    const times: number[] = [new Date(test.generated_at).getTime()];
    
    if (result?.completed_at) {
      times.push(new Date(result.completed_at).getTime());
    }
    
    if (pending?.created_at) {
      times.push(new Date(pending.created_at).getTime());
    }
    
    if (pending?.updated_at) {
      times.push(new Date(pending.updated_at).getTime());
    }
    
    if (tracker?.updatedAt) {
      times.push(tracker.updatedAt);
    }
    
    return new Date(Math.max(...times));
  };

  if (authLoading || loading) {
    return (
      <div className="min-h-screen flex flex-col bg-background">
        <Navbar />
        <main className="flex-1 flex items-center justify-center">
          <div className="animate-pulse text-muted-foreground">Loading...</div>
        </main>
        <Footer />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen flex flex-col bg-background">
        <Navbar />
        <main className="flex-1 py-8">
          <div className="container max-w-2xl mx-auto px-4 text-center">
            <History className="w-16 h-16 text-muted-foreground mx-auto mb-4" />
            <h1 className="text-2xl font-bold mb-2">Login Required</h1>
            <p className="text-muted-foreground mb-6">
              Please log in to view your AI practice history.
            </p>
            <Link to="/auth?returnTo=/ai-practice/history">
              <Button>Log In</Button>
            </Link>
          </div>
        </main>
        <Footer />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <Navbar />
      
      <main className="flex-1 py-8">
        <div className="container max-w-5xl mx-auto px-4">
          {/* Header */}
          <div className="flex items-center gap-4 mb-6">
            <Link to="/ai-practice">
              <Button variant="ghost" size="icon">
                <ArrowLeft className="w-5 h-5" />
              </Button>
            </Link>
            <div>
              <h1 className="text-2xl md:text-3xl font-bold flex items-center gap-2">
                <History className="w-7 h-7 text-primary" />
                Practice History
              </h1>
              <p className="text-muted-foreground">
                Review and retake your previously generated AI practice tests
              </p>
            </div>
            
            {/* Notification Toggle */}
            {notificationsSupported && (
              <Button
                variant="outline"
                size="sm"
                onClick={requestPermission}
                className={cn(
                  "ml-auto gap-2",
                  notificationPermission === 'granted' && "text-primary border-primary/50"
                )}
                title={notificationPermission === 'granted' 
                  ? 'Notifications enabled' 
                  : 'Enable notifications for evaluation updates'}
              >
                {notificationPermission === 'granted' ? (
                  <Bell className="w-4 h-4" />
                ) : (
                  <BellOff className="w-4 h-4" />
                )}
                <span className="hidden sm:inline">
                  {notificationPermission === 'granted' ? 'Notifications On' : 'Enable Notifications'}
                </span>
              </Button>
            )}
          </div>

          {/* Module Filter */}
          <Tabs value={activeModule} onValueChange={setActiveModule} className="mb-6">
            <TabsList className="grid w-full grid-cols-5 h-auto p-1">
              <TabsTrigger value="all" className="py-2">
                All
              </TabsTrigger>
              <TabsTrigger value="reading" className="flex items-center gap-1 py-2">
                <BookOpen className="w-4 h-4" />
                <span className="hidden sm:inline">Reading</span>
              </TabsTrigger>
              <TabsTrigger value="listening" className="flex items-center gap-1 py-2">
                <Headphones className="w-4 h-4" />
                <span className="hidden sm:inline">Listening</span>
              </TabsTrigger>
              <TabsTrigger value="writing" className="flex items-center gap-1 py-2">
                <PenTool className="w-4 h-4" />
                <span className="hidden sm:inline">Writing</span>
              </TabsTrigger>
              <TabsTrigger value="speaking" className="flex items-center gap-1 py-2">
                <Mic className="w-4 h-4" />
                <span className="hidden sm:inline">Speaking</span>
              </TabsTrigger>
            </TabsList>
          </Tabs>

          {/* Tests List */}
          {filteredTests.length === 0 ? (
            <Card className="text-center py-12">
              <CardContent>
                <Sparkles className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
                <h3 className="text-lg font-medium mb-2">No practice tests yet</h3>
                <p className="text-muted-foreground mb-4">
                  Generate your first AI practice test to get started!
                </p>
                <Link to="/ai-practice">
                  <Button>
                    <Sparkles className="w-4 h-4 mr-2" />
                    Generate Practice Test
                  </Button>
                </Link>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-4">
              {filteredTests.map((test) => {
                const ModuleIcon = MODULE_ICONS[test.module] || BookOpen;
                const hasResult = !!testResults[test.id];
                const result = testResults[test.id];
                const testType = `ai-${test.module}` as const;
                const hasFailedSub = hasFailedSubmission(test.id, testType);
                const isPendingEval = pendingEvaluations.has(test.id);
                const pendingJob = pendingEvaluations.get(test.id);
                // Client-side tracker for tests still uploading (before DB job exists)
                const clientTracker = test.module === 'speaking' ? clientTrackers.get(test.id) : null;
                const isClientUploading = !!clientTracker && ['preparing', 'converting', 'uploading', 'queuing'].includes(clientTracker.stage);
                
                // Calculate last updated time
                const lastUpdated = getLastUpdatedTime(test, result, pendingJob, clientTracker);
                
                return (
                  <Card 
                    key={test.id} 
                    className={cn(
                      "transition-colors",
                      hasResult ? "hover:border-primary/50 cursor-pointer" : "hover:border-border",
                      (isPendingEval || isClientUploading) && "border-primary/30 animate-pulse"
                    )}
                    onClick={() => hasResult && handleViewResults(test)}
                  >
                    <CardContent className="p-4">
                      <div className="flex items-start gap-4">
                        <div className="p-3 rounded-lg bg-primary/10">
                          <ModuleIcon className="w-6 h-6 text-primary" />
                        </div>
                        
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap mb-1">
                            <h3 className="font-medium capitalize">{test.module} Practice</h3>
                            <Badge variant="outline" className={DIFFICULTY_COLORS[test.difficulty]}>
                              {test.difficulty}
                            </Badge>
                            {hasResult && result?.band_score && (() => {
                              // Recalculate band from criteria to match Results page
                              const qr = result.question_results as any;
                              const criteria = qr?.criteria || qr || {};
                              const fluency = criteria?.fluency_coherence?.band ?? criteria?.fluency_coherence?.score ?? 0;
                              const lexical = criteria?.lexical_resource?.band ?? criteria?.lexical_resource?.score ?? 0;
                              const grammar = criteria?.grammatical_range?.band ?? criteria?.grammatical_range?.score ?? 0;
                              const pronunciation = criteria?.pronunciation?.band ?? criteria?.pronunciation?.score ?? 0;
                              const avg = (fluency + lexical + grammar + pronunciation) / 4;
                              // IELTS rounding: .25 rounds up to .5, .75 rounds up to next whole
                              const floor = Math.floor(avg);
                              const fraction = avg - floor;
                              const computedBand = fraction < 0.25 ? floor : fraction < 0.75 ? floor + 0.5 : floor + 1;
                              const displayBand = computedBand > 0 ? computedBand : Number(result.band_score);
                              return (
                                <Badge className="bg-primary/20 text-primary border-primary/30">
                                  Band {displayBand.toFixed(1)}
                                </Badge>
                              );
                            })()}
                            {hasResult && (
                              <Badge variant="secondary" className="gap-1 text-xs">
                                <Eye className="w-3 h-3" />
                                Completed
                              </Badge>
                            )}
                            {isPendingEval && pendingJob && ['pending', 'processing'].includes(pendingJob.status) && (
                              <Badge variant="outline" className="gap-1 text-xs border-primary/50 text-primary">
                                <Loader2 className="w-3 h-3 animate-spin" />
                                {pendingJob.status === 'processing' 
                                  ? `Evaluating Part ${pendingJob.current_part || 1} of ${pendingJob.total_parts || 3}`
                                  : 'Queued'}
                              </Badge>
                            )}
                            {isPendingEval && pendingJob?.status === 'retrying' && (
                              <Badge variant="outline" className="gap-1 text-xs border-warning/50 text-warning">
                                <Loader2 className="w-3 h-3 animate-spin" />
                                Retrying...
                              </Badge>
                            )}
                            {isPendingEval && pendingJob?.status === 'stale' && (
                              <Badge variant="outline" className="gap-1 text-xs border-warning/50 text-warning">
                                <AlertCircle className="w-3 h-3" />
                                Timed Out (Retry {pendingJob.retry_count || 0}/{MAX_RETRIES})
                              </Badge>
                            )}
                            {isPendingEval && pendingJob?.status === 'failed' && (
                              <Badge variant="outline" className="gap-1 text-xs border-destructive/50 text-destructive">
                                <AlertCircle className="w-3 h-3" />
                                Evaluation Failed
                              </Badge>
                            )}
                            {/* Client-side progress stages (before/during evaluation) */}
                            {clientTracker && ['preparing', 'converting', 'uploading', 'queuing', 'evaluating'].includes(clientTracker.stage) && (
                              <Badge variant="outline" className="gap-1.5 text-xs border-primary/50 text-primary animate-pulse">
                                {clientTracker.stage === 'preparing' && (
                                  <>
                                    <Loader2 className="w-3 h-3 animate-spin" />
                                    <span>Preparing...</span>
                                  </>
                                )}
                                {clientTracker.stage === 'converting' && (
                                  <>
                                    <AudioLines className="w-3 h-3 animate-pulse" />
                                    <span>Converting audio...</span>
                                  </>
                                )}
                                {clientTracker.stage === 'uploading' && (
                                  <>
                                    <Upload className="w-3 h-3 animate-pulse" />
                                    <span>Uploading...</span>
                                  </>
                                )}
                                {clientTracker.stage === 'queuing' && (
                                  <>
                                    <Clock className="w-3 h-3 animate-pulse" />
                                    <span>Queuing...</span>
                                  </>
                                )}
                                {clientTracker.stage === 'evaluating' && (
                                  <>
                                    <Zap className="w-3 h-3 animate-pulse" />
                                    <span>AI Evaluating...</span>
                                  </>
                                )}
                              </Badge>
                            )}
                            {/* Job-level progress (from DB realtime) with part progress */}
                            {isPendingEval && pendingJob && ['pending', 'processing'].includes(pendingJob.status) && pendingJob.current_part && pendingJob.total_parts && (
                              <Badge variant="outline" className="gap-1.5 text-xs border-primary/50 text-primary animate-pulse">
                                <Zap className="w-3 h-3 animate-pulse" />
                                <span>
                                  Evaluating Part {pendingJob.current_part} of {pendingJob.total_parts}
                                </span>
                              </Badge>
                            )}
                            {!hasResult && !hasFailedSub && !isPendingEval && !clientTracker && (
                              <Badge variant="outline" className="gap-1 text-xs border-warning/50 text-warning">
                                <AlertCircle className="w-3 h-3" />
                                Not Submitted
                              </Badge>
                            )}
                            {hasFailedSub && (
                              <Badge variant="outline" className="gap-1 text-xs border-destructive/50 text-destructive">
                                <RefreshCw className="w-3 h-3" />
                                Submission Failed
                              </Badge>
                            )}
                          </div>
                          
                          {/* Progress bar for evaluating jobs */}
                          {isPendingEval && pendingJob && pendingJob.status === 'processing' && pendingJob.progress !== undefined && pendingJob.progress > 0 && (
                            <div className="mt-2 mb-1">
                              <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
                                <div 
                                  className="h-full bg-primary transition-all duration-500 ease-out"
                                  style={{ width: `${pendingJob.progress}%` }}
                                />
                              </div>
                            </div>
                          )}
                          
                          <p className="text-sm text-muted-foreground mb-2 line-clamp-1">
                            {test.topic}
                          </p>
                          
                          <div className="flex items-center gap-4 text-xs text-muted-foreground flex-wrap">
                            <span className="flex items-center gap-1">
                              <Target className="w-3 h-3" />
                              {test.module === 'writing' 
                                ? formatWritingQuestionType(test.question_type) 
                                : formatQuestionType(test.question_type)}
                            </span>
                            <span className="flex items-center gap-1">
                              <Clock className="w-3 h-3" />
                              {test.time_minutes} min
                            </span>
                            <span title="Last updated">
                              {format(lastUpdated, 'MMM d, yyyy h:mm a')}
                            </span>
                            {/* Processing time display - use tracker timing if available, fallback to DB timestamps */}
                            {hasResult && result?.completed_at && (
                              <span className="flex items-center gap-1 text-success">
                                <Timer className="w-3 h-3" />
                                {(() => {
                                  // First check if we have timing from tracker (accuracy mode)
                                  const trackerTiming = clientTracker?.timing as Record<string, number> | undefined;
                                  const parallelTimingData = parallelTiming[test.id];
                                  
                                  // Prefer totalMs from parallel timing, then tracker
                                  const totalMs = parallelTimingData?.totalTimeMs || 
                                                  trackerTiming?.totalMs || 
                                                  0;
                                  
                                  // If we have actual timing data, show it
                                  if (totalMs > 0) {
                                    if (totalMs < 60000) {
                                      return `${Math.round(totalMs / 1000)}s`;
                                    } else if (totalMs < 3600000) {
                                      const mins = Math.floor(totalMs / 60000);
                                      const secs = Math.round((totalMs % 60000) / 1000);
                                      return `${mins}m ${secs}s`;
                                    } else {
                                      const hours = Math.floor(totalMs / 3600000);
                                      const mins = Math.floor((totalMs % 3600000) / 60000);
                                      return `${hours}h ${mins}m`;
                                    }
                                  }
                                  
                                  // Fallback to DB timestamps
                                  const startedAt = new Date((result as any).created_at || result.completed_at).getTime();
                                  const completedAt = new Date(result.completed_at).getTime();
                                  const durationMs = Math.max(0, completedAt - startedAt);

                                  // Don't show 0s - it's misleading
                                  if (durationMs === 0) return null;

                                  if (durationMs < 60000) {
                                    return `${Math.round(durationMs / 1000)}s`;
                                  } else if (durationMs < 3600000) {
                                    const mins = Math.floor(durationMs / 60000);
                                    const secs = Math.round((durationMs % 60000) / 1000);
                                    return `${mins}m ${secs}s`;
                                  } else {
                                    const hours = Math.floor(durationMs / 3600000);
                                    const mins = Math.floor((durationMs % 3600000) / 60000);
                                    return `${hours}h ${mins}m`;
                                  }
                                })()}
                              </span>
                            )}
                            {/* Live elapsed time for pending evaluations */}
                            {isPendingEval && pendingJob && ['pending', 'processing', 'retrying'].includes(pendingJob.status) && (
                              <LiveElapsedTime startTime={pendingJob.created_at} />
                            )}
                          </div>
                          
                          {/* Timing Breakdown */}
                          <TimingBreakdown 
                            timing={parallelTiming[test.id]} 
                            tracker={clientTracker}
                            testId={test.id}
                          />
                        </div>
                        
                        <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                          {hasResult && (
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => handleViewResults(test)}
                              className="text-primary hover:text-primary/80"
                              title="View Evaluation"
                            >
                              <Eye className="w-4 h-4" />
                            </Button>
                          )}
                          {/* Cancel button for pending/processing evaluations */}
                          {isPendingEval && pendingJob && ['pending', 'processing', 'retrying'].includes(pendingJob.status) && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleCancelEvaluation(test.id)}
                              disabled={cancellingJobId === pendingJob.id}
                              className="gap-1 border-destructive/50 text-destructive hover:bg-destructive/10"
                              title="Cancel evaluation"
                            >
                              {cancellingJobId === pendingJob.id ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                              ) : (
                                <AlertCircle className="w-4 h-4" />
                              )}
                              <span className="hidden sm:inline">Cancel</span>
                            </Button>
                          )}
                          {/* Retry button for stale, failed evaluations */}
                          {isPendingEval && pendingJob && ['stale', 'failed'].includes(pendingJob.status) && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleRetryEvaluation(test.id)}
                              disabled={retryingJobId === pendingJob.id}
                              className={cn(
                                "gap-1",
                                pendingJob.status === 'failed' 
                                  ? "border-destructive text-destructive hover:bg-destructive/10"
                                  : "border-warning text-warning hover:bg-warning/10"
                              )}
                              title={pendingJob.status === 'failed' 
                                ? `Failed: ${pendingJob.last_error || 'Unknown error'}` 
                                : 'Retry evaluation'}
                            >
                              {retryingJobId === pendingJob.id ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                              ) : (
                                <RefreshCw className="w-4 h-4" />
                              )}
                              <span className="hidden sm:inline">
                                {pendingJob.status === 'failed' ? 'Retry Failed' : `Retry`}
                              </span>
                            </Button>
                          )}
                          {/* Parallel Mode Resubmit button for speaking tests with completed jobs */}
                          {test.module === 'speaking' && hasResult && !isPendingEval && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleParallelResubmit(test.id)}
                              disabled={parallelResubmitting === test.id}
                              className="gap-1 border-primary/50 text-primary hover:bg-primary/10"
                              title="Resubmit using parallel accuracy mode (uses stored audio)"
                            >
                              {parallelResubmitting === test.id ? (
                                <>
                                  <Loader2 className="w-4 h-4 animate-spin" />
                                  <Timer className="w-3 h-3" />
                                </>
                              ) : (
                                <Zap className="w-4 h-4" />
                              )}
                              <span className="hidden sm:inline">
                                {parallelResubmitting === test.id ? 'Evaluating...' : 'Parallel Mode'}
                              </span>
                            </Button>
                          )}
                          {/* Timing display for parallel mode results with breakdown tooltip */}
                          {parallelTiming[test.id] && (
                            <Badge 
                              variant="outline" 
                              className="text-xs gap-1 border-success/50 text-success cursor-help"
                              title={(() => {
                                const t = parallelTiming[test.id];
                                const parts: string[] = [`Total: ${(t.totalTimeMs / 1000).toFixed(1)}s`];
                                if (t.timing) {
                                  if (t.timing.r2UploadMs) parts.push(`R2 Upload: ${(t.timing.r2UploadMs / 1000).toFixed(1)}s`);
                                  if (t.timing.googleUploadMs) parts.push(`Google Upload: ${(t.timing.googleUploadMs / 1000).toFixed(1)}s`);
                                  if (t.timing.evaluationMs) parts.push(`AI Evaluation: ${(t.timing.evaluationMs / 1000).toFixed(1)}s`);
                                  if (t.timing.saveResultMs) parts.push(`Save Result: ${(t.timing.saveResultMs / 1000).toFixed(1)}s`);
                                }
                                return parts.join('\n');
                              })()}
                            >
                              <Zap className="w-3 h-3" />
                              {(parallelTiming[test.id].totalTimeMs / 1000).toFixed(1)}s
                            </Badge>
                          )}
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleDelete(test.id)}
                            disabled={deletingId === test.id}
                            className="text-muted-foreground hover:text-destructive"
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                          <Button
                            onClick={() => handleStartTest(test)}
                            variant={hasResult ? "outline" : hasFailedSub ? "destructive" : "default"}
                            className="gap-1"
                          >
                            {hasFailedSub ? <RefreshCw className="w-4 h-4" /> : <RotateCcw className="w-4 h-4" />}
                            <span className="hidden sm:inline">
                              {hasResult ? 'Restart' : hasFailedSub ? 'Resubmit' : 'Take Test'}
                            </span>
                          </Button>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      </main>
      
      <Footer />
    </div>
  );
}
