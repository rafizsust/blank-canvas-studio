import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Navbar } from '@/components/Navbar';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ToastAction } from '@/components/ui/toast';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/useAuth';
import { useBrowserNotifications } from '@/hooks/useBrowserNotifications';
import { supabase } from '@/integrations/supabase/client';
import { 
  getSpeakingSubmissionTracker,
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
  stage?: string | null;
  created_at: string;
  updated_at?: string;
  last_error?: string | null;
  retry_count?: number;
  max_retries?: number;
  progress?: number;
  current_part?: number;
  total_parts?: number;
}

const MAX_RETRIES = 5;

type AIPracticeTest = Tables<'ai_practice_tests'>;
type AIPracticeResult = Tables<'ai_practice_results'> & {
  evaluation_timing?: { totalTimeMs: number; timing: Record<string, number> } | null;
};

const MODULE_ICONS: Record<string, typeof BookOpen> = {
  reading: BookOpen,
  listening: Headphones,
  writing: PenTool,
  speaking: Mic,
};

const DIFFICULTY_COLORS: Record<string, string> = {
  easy: 'bg-success/10 text-success border-success/20',
  medium: 'bg-warning/10 text-warning border-warning/20',
  hard: 'bg-destructive/10 text-destructive border-destructive/20',
};

const MODULE_COLORS: Record<string, string> = {
  reading: 'from-blue-500/20 to-blue-600/5 text-blue-600 dark:text-blue-400',
  listening: 'from-purple-500/20 to-purple-600/5 text-purple-600 dark:text-purple-400',
  writing: 'from-orange-500/20 to-orange-600/5 text-orange-600 dark:text-orange-400',
  speaking: 'from-primary/20 to-primary/5 text-primary',
};

// Format milliseconds to human readable time
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.round((ms % 60000) / 1000);
  return `${mins}m ${secs}s`;
}

// Live elapsed time component for pending evaluations
function LiveElapsedTime({ startTime }: { startTime: string }) {
  const [elapsed, setElapsed] = useState('');
  
  useEffect(() => {
    const start = new Date(startTime).getTime();
    
    const update = () => {
      const now = Date.now();
      const durationMs = now - start;
      setElapsed(formatDuration(durationMs));
    };
    
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [startTime]);
  
  return (
    <span className="flex items-center gap-1 text-primary animate-pulse">
      <Timer className="w-3 h-3" />
      {elapsed}
    </span>
  );
}

// Get stage label for display
function getStageLabel(stage: string | null | undefined, currentPart?: number): string {
  if (!stage) return 'Processing...';
  
  switch (stage) {
    case 'pending_upload':
    case 'pending':
      return 'Queued';
    case 'uploading':
      return 'Uploading audio';
    case 'transcribing':
      return 'Transcribing';
    case 'evaluating_part_1':
    case 'evaluating':
      return currentPart ? `Evaluating Part ${currentPart}/3` : 'Evaluating Part 1/3';
    case 'evaluating_part_2':
      return 'Evaluating Part 2/3';
    case 'evaluating_part_3':
      return 'Evaluating Part 3/3';
    case 'generating_feedback':
    case 'generating':
      return 'Generating feedback';
    case 'finalizing':
    case 'saving':
      return 'Saving results';
    case 'completed':
      return 'Complete';
    default:
      return 'Processing...';
  }
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
  const [clientTrackers, setClientTrackers] = useState<Map<string, SpeakingSubmissionTracker>>(new Map());
  
  const testResultsRef = useRef<Record<string, AIPracticeResult>>({});
  useEffect(() => {
    testResultsRef.current = testResults;
  }, [testResults]);

  const channelsSetupRef = useRef(false);
  const channelIdsRef = useRef<{ evalChannel: string | null; resultsChannel: string | null }>({
    evalChannel: null,
    resultsChannel: null,
  });

  // Listen for client-side tracker updates
  useEffect(() => {
    const checkExistingTrackers = () => {
      const newTrackers = new Map<string, SpeakingSubmissionTracker>();
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
    const pollInterval = setInterval(checkExistingTrackers, 2000);

    return () => {
      window.removeEventListener('speaking-submission-tracker', handleTrackerUpdate as EventListener);
      clearInterval(pollInterval);
    };
  }, []);

  const loadTests = useCallback(async () => {
    if (!user) return;
    
    try {
      const { data: testsData, error: testsError } = await supabase
        .from('ai_practice_tests')
        .select('*')
        .eq('user_id', user.id)
        .order('generated_at', { ascending: false });

      if (testsError) throw testsError;

      setTests(testsData || []);

      if (testsData && testsData.length > 0) {
        const testIds = testsData.map(t => t.id);
        const { data: resultsData, error: resultsError } = await supabase
          .from('ai_practice_results')
          .select('*')
          .in('test_id', testIds)
          .eq('user_id', user.id);

        if (resultsError) throw resultsError;

        const resultsMap: Record<string, AIPracticeResult> = {};
        resultsData?.forEach(r => {
          const existing = resultsMap[r.test_id];
          if (!existing || new Date(r.completed_at) > new Date(existing.completed_at)) {
            // Parse evaluation_timing from answers if present (for backward compatibility)
            const answers = r.answers as Record<string, unknown>;
            const evaluationTiming = (r as any).evaluation_timing || 
              (answers?.evaluation_timing as { totalTimeMs: number; timing: Record<string, number> } | undefined);
            resultsMap[r.test_id] = { ...r, evaluation_timing: evaluationTiming };
          }
        });
        setTestResults(resultsMap);
      }
    } catch (err) {
      console.error('Failed to load tests:', err);
      toast({
        title: 'Error',
        description: 'Failed to load practice history',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  }, [user, toast]);

  const loadPendingEvaluations = useCallback(async () => {
    if (!user) return;
    
    try {
      const { data, error } = await supabase
        .from('speaking_evaluation_jobs')
        .select('*')
        .eq('user_id', user.id)
        .in('status', ['pending', 'processing', 'failed', 'stale', 'retrying'])
        .order('created_at', { ascending: false });

      if (error) throw error;

      const pendingMap = new Map<string, PendingEvaluation>();
      data?.forEach(job => {
        const existing = pendingMap.get(job.test_id);
        if (!existing || new Date(job.created_at) > new Date(existing.created_at)) {
          pendingMap.set(job.test_id, job as PendingEvaluation);
        }
      });
      setPendingEvaluations(pendingMap);
    } catch (err) {
      console.error('Failed to load pending evaluations:', err);
    }
  }, [user]);

  useEffect(() => {
    if (!authLoading && user) {
      loadTests();
      loadPendingEvaluations();
    } else if (!authLoading && !user) {
      setLoading(false);
    }
  }, [user, authLoading, loadTests, loadPendingEvaluations]);

  // Realtime subscription for speaking evaluation jobs
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

          if (job.status === 'failed' && hasNewerResult(job.test_id, job.created_at)) {
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
          
          if (job.status === 'failed' && job.last_error?.includes('Cancelled:')) {
            return;
          }

          setPendingEvaluations((prev) => {
            const existing = prev.get(job.test_id);
            if (existing && !isNewer(job, existing)) {
              return prev;
            }

            const updated = new Map(prev);

            if (job.status === 'completed') {
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

    channelsSetupRef.current = true;

    return () => {
      supabase.removeChannel(channel);
      channelsSetupRef.current = false;
      channelIdsRef.current.evalChannel = null;
    };
  }, [user, toast, navigate, notifyEvaluationComplete, notifyEvaluationFailed, loadTests]);

  // Realtime subscription for ai_practice_results
  useEffect(() => {
    if (!user) return;
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

          setTestResults(prev => {
            const existing = prev[newResult.test_id];
            if (!existing || new Date(newResult.completed_at) > new Date(existing.completed_at)) {
              return { ...prev, [newResult.test_id]: newResult };
            }
            return prev;
          });

          setPendingEvaluations(prev => {
            if (prev.has(newResult.test_id)) {
              const updated = new Map(prev);
              updated.delete(newResult.test_id);
              return updated;
            }
            return prev;
          });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(resultsChannel);
      channelIdsRef.current.resultsChannel = null;
    };
  }, [user]);

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

  const [retryingJobId, setRetryingJobId] = useState<string | null>(null);
  const [cancellingJobId, setCancellingJobId] = useState<string | null>(null);
  const [parallelResubmitting, setParallelResubmitting] = useState<string | null>(null);
  const [confirmResubmitTestId, setConfirmResubmitTestId] = useState<string | null>(null);

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

  // Handle resubmit (uses stored R2 audio, single API call)
  const handleResubmit = async (testId: string) => {
    setParallelResubmitting(testId);
    
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        toast({ title: 'Error', description: 'Please log in to resubmit', variant: 'destructive' });
        return;
      }

      toast({
        title: 'Re-evaluation Started',
        description: 'Re-evaluating your speaking test... This may take a few minutes.',
      });

      const response = await supabase.functions.invoke('resubmit-parallel', {
        body: { testId },
      });

      if (response.error) {
        throw new Error(response.error.message);
      }

      const data = response.data;
      
      if (data?.success) {
        toast({
          title: `✅ Re-evaluation Complete!`,
          description: `Band ${data.overallBand?.toFixed(1)} - Evaluation took ${formatDuration(data.totalTimeMs)}`,
        });

        // Reload tests to show updated results
        loadTests();
      } else if (data?.error) {
        throw new Error(data.error);
      }
    } catch (err: any) {
      console.error('[AIPracticeHistory] Resubmission error:', err);
      toast({
        title: 'Re-evaluation Failed',
        description: err.message || 'Failed to re-evaluate speaking test',
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

    if (test.module === 'writing') {
      navigate(`/ai-practice/writing/results/${test.id}`);
    } else if (test.module === 'speaking') {
      navigate(`/ai-practice/speaking/results/${test.id}`);
    } else {
      navigate(`/ai-practice/results/${test.id}`);
    }
  };

  const handleStartTest = (test: AIPracticeTest) => {
    const payload = typeof test.payload === 'object' && test.payload !== null ? (test.payload as Record<string, any>) : {};

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
        return 'Task 1';
      case 'TASK_2':
        return 'Task 2';
      case 'FULL_TEST':
        return 'Full Test';
      default:
        return formatQuestionType(type);
    }
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

      <AlertDialog open={Boolean(confirmResubmitTestId)} onOpenChange={(open) => !open && setConfirmResubmitTestId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Re-evaluate this speaking test?</AlertDialogTitle>
            <AlertDialogDescription>
              This will overwrite your previous score/report for this test with a new evaluation.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!confirmResubmitTestId) return;
                void handleResubmit(confirmResubmitTestId);
                setConfirmResubmitTestId(null);
              }}
            >
              Yes, re-evaluate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      
      <main className="flex-1 py-6 md:py-8">
        <div className="container max-w-4xl mx-auto px-4">
          {/* Header */}
          <div className="flex items-center gap-4 mb-6">
            <Link to="/ai-practice">
              <Button variant="ghost" size="icon">
                <ArrowLeft className="w-5 h-5" />
              </Button>
            </Link>
            <div className="flex-1">
              <h1 className="text-2xl md:text-3xl font-bold flex items-center gap-2">
                <History className="w-7 h-7 text-primary" />
                Practice History
              </h1>
              <p className="text-muted-foreground text-sm">
                Review and retake your AI practice tests
              </p>
            </div>
            
            {notificationsSupported && (
              <Button
                variant="outline"
                size="sm"
                onClick={requestPermission}
                className={cn(
                  "gap-2",
                  notificationPermission === 'granted' && "text-primary border-primary/50"
                )}
              >
                {notificationPermission === 'granted' ? (
                  <Bell className="w-4 h-4" />
                ) : (
                  <BellOff className="w-4 h-4" />
                )}
                <span className="hidden sm:inline">
                  {notificationPermission === 'granted' ? 'On' : 'Notify'}
                </span>
              </Button>
            )}
          </div>

          {/* Module Filter */}
          <Tabs value={activeModule} onValueChange={setActiveModule} className="mb-6">
            <TabsList className="grid w-full grid-cols-5 h-auto p-1">
              <TabsTrigger value="all" className="py-2 text-xs sm:text-sm">All</TabsTrigger>
              <TabsTrigger value="reading" className="flex items-center gap-1 py-2">
                <BookOpen className="w-4 h-4" />
                <span className="hidden sm:inline text-sm">Reading</span>
              </TabsTrigger>
              <TabsTrigger value="listening" className="flex items-center gap-1 py-2">
                <Headphones className="w-4 h-4" />
                <span className="hidden sm:inline text-sm">Listening</span>
              </TabsTrigger>
              <TabsTrigger value="writing" className="flex items-center gap-1 py-2">
                <PenTool className="w-4 h-4" />
                <span className="hidden sm:inline text-sm">Writing</span>
              </TabsTrigger>
              <TabsTrigger value="speaking" className="flex items-center gap-1 py-2">
                <Mic className="w-4 h-4" />
                <span className="hidden sm:inline text-sm">Speaking</span>
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
            <div className="space-y-3">
              {filteredTests.map((test) => {
                const ModuleIcon = MODULE_ICONS[test.module] || BookOpen;
                const hasResult = !!testResults[test.id];
                const result = testResults[test.id];
                const testType = `ai-${test.module}` as const;
                const hasFailedSub = hasFailedSubmission(test.id, testType);
                const isPendingEval = pendingEvaluations.has(test.id);
                const pendingJob = pendingEvaluations.get(test.id);
                const clientTracker = test.module === 'speaking' ? clientTrackers.get(test.id) : null;
                const isClientProgressing =
                  !!clientTracker &&
                  ['preparing', 'converting', 'uploading', 'queuing', 'evaluating', 'finalizing'].includes(clientTracker.stage);
                const isEvaluating = isPendingEval && pendingJob && ['pending', 'processing', 'retrying'].includes(pendingJob.status);
                
                // Get timing from database (persisted) 
                const evaluationTiming = result?.evaluation_timing;
                
                // Compute display band
                const displayBand = (() => {
                  if (!hasResult || !result?.band_score) return null;
                  const qr = result.question_results as any;
                  const criteria = qr?.criteria || qr || {};
                  const fluency = criteria?.fluency_coherence?.band ?? criteria?.fluency_coherence?.score ?? 0;
                  const lexical = criteria?.lexical_resource?.band ?? criteria?.lexical_resource?.score ?? 0;
                  const grammar = criteria?.grammatical_range?.band ?? criteria?.grammatical_range?.score ?? 0;
                  const pronunciation = criteria?.pronunciation?.band ?? criteria?.pronunciation?.score ?? 0;
                  const avg = (fluency + lexical + grammar + pronunciation) / 4;
                  const floor = Math.floor(avg);
                  const fraction = avg - floor;
                  const computedBand = fraction < 0.25 ? floor : fraction < 0.75 ? floor + 0.5 : floor + 1;
                  return computedBand > 0 ? computedBand : Number(result.band_score);
                })();
                
                return (
                    <Card 
                     key={test.id} 
                     className={cn(
                       "overflow-hidden transition-all duration-200",
                       hasResult && "hover:shadow-md cursor-pointer",
                       (isPendingEval || isClientProgressing) && "ring-1 ring-primary/30"
                     )}
                     onClick={() => hasResult && handleViewResults(test)}
                   >
                    <CardContent className="p-0">
                      <div className="flex">
                        {/* Module Color Bar */}
                        <div className={cn(
                          "w-1.5 bg-gradient-to-b shrink-0",
                          MODULE_COLORS[test.module] || 'from-primary/20 to-primary/5'
                        )} />
                        
                        <div className="flex-1 p-4">
                          <div className="flex items-start gap-3">
                            {/* Module Icon */}
                            <div className={cn(
                              "p-2 rounded-lg bg-gradient-to-br shrink-0",
                              MODULE_COLORS[test.module] || 'from-primary/20 to-primary/5'
                            )}>
                              <ModuleIcon className="w-5 h-5" />
                            </div>
                            
                            {/* Content */}
                            <div className="flex-1 min-w-0">
                              {/* Title Row */}
                              <div className="flex items-center gap-2 flex-wrap mb-1">
                                <h3 className="font-semibold capitalize text-sm">
                                  {test.module} Practice
                                </h3>
                                <Badge variant="outline" className={cn("text-xs", DIFFICULTY_COLORS[test.difficulty])}>
                                  {test.difficulty}
                                </Badge>
                                {hasResult && displayBand && (
                                  <Badge className="bg-primary/10 text-primary border-primary/20 text-xs">
                                    Band {displayBand.toFixed(1)}
                                  </Badge>
                                )}
                              </div>
                              
                              {/* Topic */}
                              <p className="text-sm text-muted-foreground line-clamp-1 mb-2">
                                {test.topic}
                              </p>
                              
                              {/* Meta Info */}
                              <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
                                <span className="flex items-center gap-1">
                                  <Target className="w-3 h-3" />
                                  {test.module === 'writing' 
                                    ? formatWritingQuestionType(test.question_type) 
                                    : formatQuestionType(test.question_type)}
                                </span>
                                <span className="flex items-center gap-1">
                                  <Clock className="w-3 h-3" />
                                  {test.time_minutes}min
                                </span>
                                <span>{format(new Date(test.generated_at), 'MMM d, yyyy')}</span>
                                
                                {/* Evaluation timing from database */}
                                {hasResult && evaluationTiming?.totalTimeMs && (
                                  <span className="flex items-center gap-1 text-success">
                                    <Zap className="w-3 h-3" />
                                    Evaluated in {formatDuration(evaluationTiming.totalTimeMs)}
                                  </span>
                                )}
                                
                                {/* Live elapsed time for pending evaluations */}
                                {isEvaluating && pendingJob && (
                                  <LiveElapsedTime startTime={pendingJob.created_at} />
                                )}
                              </div>
                              
                               {/* Status Badges Row */}
                               {(isEvaluating || isPendingEval || isClientProgressing || hasFailedSub || (!hasResult && !isPendingEval && !clientTracker)) && (
                                 <div className="flex items-center gap-2 mt-2 flex-wrap">
                                   {/* Evaluating status with stage (server job) */}
                                   {isEvaluating && pendingJob && (
                                     <Badge variant="outline" className="gap-1.5 text-xs border-primary/40 text-primary animate-pulse">
                                       <Loader2 className="w-3 h-3 animate-spin" />
                                       {getStageLabel(pendingJob.stage, pendingJob.current_part)}
                                     </Badge>
                                   )}
                                   
                                   {/* Client-side progress (accuracy/parallel mode or early upload stages) */}
                                   {!isEvaluating && isClientProgressing && clientTracker && (
                                     <Badge variant="outline" className="gap-1.5 text-xs border-primary/40 text-primary animate-pulse">
                                       <Loader2 className="w-3 h-3 animate-spin" />
                                       {clientTracker.stage === 'preparing' && 'Preparing...'}
                                       {clientTracker.stage === 'converting' && 'Converting audio...'}
                                       {clientTracker.stage === 'uploading' && 'Uploading audio...'}
                                       {clientTracker.stage === 'queuing' && 'Queued'}
                                       {clientTracker.stage === 'evaluating' && 'Evaluating'}
                                       {clientTracker.stage === 'finalizing' && 'Finalizing'}
                                       {clientTracker.detail ? ` — ${clientTracker.detail}` : ''}
                                     </Badge>
                                   )}
                                   
                                   {/* Failed/Stale status */}
                                   {isPendingEval && pendingJob?.status === 'stale' && (
                                     <Badge variant="outline" className="gap-1 text-xs border-warning/40 text-warning">
                                       <AlertCircle className="w-3 h-3" />
                                       Timed Out
                                     </Badge>
                                   )}
                                  {isPendingEval && pendingJob?.status === 'failed' && (
                                    <Badge variant="outline" className="gap-1 text-xs border-destructive/40 text-destructive">
                                      <AlertCircle className="w-3 h-3" />
                                      Failed
                                    </Badge>
                                  )}
                                  
                                  {/* Not submitted status */}
                                  {!hasResult && !hasFailedSub && !isPendingEval && !clientTracker && (
                                    <Badge variant="outline" className="gap-1 text-xs border-muted-foreground/30 text-muted-foreground">
                                      Not Submitted
                                    </Badge>
                                  )}
                                  
                                  {/* Failed submission status */}
                                  {hasFailedSub && (
                                    <Badge variant="outline" className="gap-1 text-xs border-destructive/40 text-destructive">
                                      <RefreshCw className="w-3 h-3" />
                                      Submission Failed
                                    </Badge>
                                  )}
                                </div>
                              )}
                            </div>
                            
                            {/* Actions */}
                            <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                              {hasResult && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => handleViewResults(test)}
                                  className="h-8 w-8 text-primary"
                                  title="View Results"
                                >
                                  <Eye className="w-4 h-4" />
                                </Button>
                              )}
                              
                              {/* Cancel button for pending evaluations */}
                              {isEvaluating && pendingJob && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => handleCancelEvaluation(test.id)}
                                  disabled={cancellingJobId === pendingJob.id}
                                  className="h-8 w-8 text-destructive hover:text-destructive"
                                  title="Cancel"
                                >
                                  {cancellingJobId === pendingJob.id ? (
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                  ) : (
                                    <AlertCircle className="w-4 h-4" />
                                  )}
                                </Button>
                              )}
                              
                              {/* Retry button for failed/stale */}
                              {isPendingEval && pendingJob && ['stale', 'failed'].includes(pendingJob.status) && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => handleRetryEvaluation(test.id)}
                                  disabled={retryingJobId === pendingJob.id}
                                  className="h-8 w-8 text-warning hover:text-warning"
                                  title="Retry"
                                >
                                  {retryingJobId === pendingJob.id ? (
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                  ) : (
                                    <RefreshCw className="w-4 h-4" />
                                  )}
                                </Button>
                              )}
                              
                              {/* Resubmit button for speaking tests */}
                              {test.module === 'speaking' && hasResult && !isPendingEval && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setConfirmResubmitTestId(test.id);
                                  }}
                                  disabled={parallelResubmitting === test.id}
                                  className="h-8 w-8 text-primary hover:text-primary"
                                  title="Resubmit for re-evaluation"
                                >
                                  {parallelResubmitting === test.id ? (
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                  ) : (
                                    <RotateCcw className="w-4 h-4" />
                                  )}
                                </Button>
                              )}
                              
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => handleDelete(test.id)}
                                disabled={deletingId === test.id}
                                className="h-8 w-8 text-muted-foreground hover:text-destructive"
                                title="Delete"
                              >
                                <Trash2 className="w-4 h-4" />
                              </Button>
                              
                              <Button
                                onClick={() => handleStartTest(test)}
                                size="sm"
                                variant={hasResult ? "outline" : hasFailedSub ? "destructive" : "default"}
                                className="h-8 gap-1"
                              >
                                {hasFailedSub ? <RefreshCw className="w-3.5 h-3.5" /> : <RotateCcw className="w-3.5 h-3.5" />}
                                <span className="hidden sm:inline text-xs">
                                  {hasResult ? 'Restart' : hasFailedSub ? 'Retry' : 'Start'}
                                </span>
                              </Button>
                            </div>
                          </div>
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