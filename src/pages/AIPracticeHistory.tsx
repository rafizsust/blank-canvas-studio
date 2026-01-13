import { useState, useEffect, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Navbar } from '@/components/Navbar';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/useAuth';
import { useBrowserNotifications } from '@/hooks/useBrowserNotifications';
import { supabase } from '@/integrations/supabase/client';
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

  // Load tests on mount
  useEffect(() => {
    if (!authLoading && user) {
      loadTests();
      loadPendingEvaluations();
    } else if (!authLoading && !user) {
      setLoading(false);
    }
  }, [user, authLoading]);

  // Realtime subscription for speaking evaluation jobs
  useEffect(() => {
    if (!user) return;

    const channel = supabase
      .channel('speaking-eval-history')
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

          console.log('[AIPracticeHistory] Evaluation job update:', job.status, job.test_id);

          if (job.status === 'completed') {
            // Remove from pending and reload results
            setPendingEvaluations(prev => {
              const updated = new Map(prev);
              updated.delete(job.test_id);
              return updated;
            });

            // Show toast notification
            toast({
              title: '🎉 Speaking Evaluation Ready!',
              description: 'Your speaking test results are now available.',
            });

            // Show browser push notification
            notifyEvaluationComplete(undefined, () => {
              navigate(`/ai-practice/speaking/results/${job.test_id}`);
            });

            // Reload results to show the new completion
            loadTests();
          } else if (job.status === 'failed') {
            // Check if max retries reached
            const isMaxRetriesReached = (job.retry_count || 0) >= MAX_RETRIES;
            
            // Keep in map to show "Failed" badge
            setPendingEvaluations(prev => {
              const updated = new Map(prev);
              updated.set(job.test_id, job as PendingEvaluation);
              return updated;
            });

            toast({
              title: isMaxRetriesReached ? 'Evaluation Permanently Failed' : 'Evaluation Failed',
              description: isMaxRetriesReached 
                ? 'Max retries exceeded. Please try generating a new test.'
                : (job.last_error || 'There was an issue evaluating your speaking test. You can retry.'),
              variant: 'destructive',
            });

            // Browser push notification for permanent failure
            if (isMaxRetriesReached) {
              notifyEvaluationFailed('Max retries exceeded. Please try generating a new test.');
            }
          } else if (job.status === 'stale') {
            // Job timed out - show as stale with retry option
            setPendingEvaluations(prev => {
              const updated = new Map(prev);
              updated.set(job.test_id, job as PendingEvaluation);
              return updated;
            });

            toast({
              title: 'Evaluation Timed Out',
              description: 'The evaluation timed out. Retrying automatically...',
              variant: 'destructive',
            });
          } else if (['pending', 'processing', 'retrying'].includes(job.status)) {
            setPendingEvaluations(prev => {
              const updated = new Map(prev);
              updated.set(job.test_id, job as PendingEvaluation);
              return updated;
            });
          }
        }
      )
      .subscribe((status) => {
        console.log('[AIPracticeHistory] Realtime subscription:', status);
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user, toast]);

  // Load pending evaluations on mount
  const loadPendingEvaluations = useCallback(async () => {
    if (!user) return;

    try {
      const { data: jobs } = await supabase
        .from('speaking_evaluation_jobs')
        .select('id, test_id, status, created_at, updated_at, last_error, retry_count')
        .eq('user_id', user.id)
        .in('status', ['pending', 'processing', 'stale', 'retrying', 'failed']);

      if (jobs && jobs.length > 0) {
        const pendingMap = new Map<string, PendingEvaluation>();
        jobs.forEach(job => {
          pendingMap.set(job.test_id, job as PendingEvaluation);
        });
        setPendingEvaluations(pendingMap);
      }
    } catch (err) {
      console.error('Failed to load pending evaluations:', err);
    }
  }, [user]);

  const loadTests = async () => {
    if (!user) return;
    
    try {
      // Load tests with a safe limit to prevent infinite loading
      const { data: testsData, error: testsError } = await supabase
        .from('ai_practice_tests')
        .select('*')
        .eq('user_id', user.id)
        .order('generated_at', { ascending: false })
        .limit(100); // Safe limit to prevent massive queries

      if (testsError) throw testsError;
      setTests(testsData || []);

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
                
                return (
                  <Card 
                    key={test.id} 
                    className={cn(
                      "transition-colors",
                      hasResult ? "hover:border-primary/50 cursor-pointer" : "hover:border-border",
                      isPendingEval && "border-primary/30 animate-pulse"
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
                            {hasResult && result?.band_score && (
                              <Badge className="bg-primary/20 text-primary border-primary/30">
                                Band {Number(result.band_score).toFixed(1)}
                              </Badge>
                            )}
                            {hasResult && (
                              <Badge variant="secondary" className="gap-1 text-xs">
                                <Eye className="w-3 h-3" />
                                Completed
                              </Badge>
                            )}
                            {isPendingEval && pendingJob && ['pending', 'processing'].includes(pendingJob.status) && (
                              <Badge variant="outline" className="gap-1 text-xs border-primary/50 text-primary">
                                <Loader2 className="w-3 h-3 animate-spin" />
                                {pendingJob.status === 'processing' ? 'Evaluating...' : 'Queued'}
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
                            {!hasResult && !hasFailedSub && !isPendingEval && (
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
                            <span>
                              {format(new Date(test.generated_at), 'MMM d, yyyy h:mm a')}
                            </span>
                          </div>
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
                          {/* Retry button for stale evaluations (not yet at max retries) */}
                          {isPendingEval && pendingJob?.status === 'stale' && (pendingJob.retry_count || 0) < MAX_RETRIES && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleRetryEvaluation(test.id)}
                              disabled={retryingJobId === pendingJob.id}
                              className="gap-1 border-warning text-warning hover:bg-warning/10"
                            >
                              {retryingJobId === pendingJob.id ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                              ) : (
                                <RefreshCw className="w-4 h-4" />
                              )}
                              <span className="hidden sm:inline">Retry ({(pendingJob.retry_count || 0) + 1}/{MAX_RETRIES})</span>
                            </Button>
                          )}
                          {/* Show failed message - no retry option */}
                          {isPendingEval && pendingJob?.status === 'failed' && (
                            <span className="text-xs text-destructive hidden sm:inline">
                              Max retries reached
                            </span>
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
