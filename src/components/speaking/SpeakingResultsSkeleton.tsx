import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Progress } from '@/components/ui/progress';
import { Timer, CheckCircle2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useEffect, useState } from 'react';

interface SpeakingResultsSkeletonProps {
  className?: string;
}

export function SpeakingResultsSkeleton({ className }: SpeakingResultsSkeletonProps) {
  return (
    <div className={cn("animate-fade-in", className)}>
      {/* Header skeleton */}
      <div className="text-center mb-6 md:mb-8">
        <Skeleton className="h-8 w-48 mx-auto mb-3 rounded-full" />
        <Skeleton className="h-8 w-64 mx-auto mb-2" />
        <Skeleton className="h-5 w-80 mx-auto" />
      </div>

      {/* Overall Band Score skeleton */}
      <Card className="mb-4 md:mb-6 overflow-hidden">
        <div className="bg-gradient-to-br from-primary/5 to-accent/5 p-4 md:p-8">
          <div className="text-center">
            <Skeleton className="h-16 md:h-24 w-28 md:w-36 mx-auto mb-3 md:mb-4 rounded-lg" />
            <Skeleton className="h-5 w-40 mx-auto" />
          </div>
          
          {/* Criteria overview skeleton */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-4 mt-6 md:mt-8">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="text-center p-2 md:p-0">
                <Skeleton className="h-8 w-16 mx-auto mb-1" />
                <Skeleton className="h-3 w-20 mx-auto" />
              </div>
            ))}
          </div>
        </div>
      </Card>

      {/* Tabs skeleton */}
      <div className="mb-6">
        <div className="flex gap-1 p-1 bg-muted rounded-lg mb-4">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <Skeleton key={i} className="h-8 flex-1 rounded-md" />
          ))}
        </div>

        {/* Content skeleton */}
        <div className="space-y-3 md:space-y-4">
          {[1, 2, 3, 4].map((i) => (
            <Card key={i}>
              <CardHeader className="pb-2 md:pb-3 p-3 md:p-6">
                <div className="flex items-center justify-between gap-2">
                  <Skeleton className="h-5 w-40" />
                  <Skeleton className="h-8 w-16 rounded-md" />
                </div>
                <Skeleton className="h-2 mt-2 w-full" />
              </CardHeader>
              <CardContent className="space-y-3 p-3 md:p-6 pt-0">
                <div className="space-y-2">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-3 w-full" />
                  <Skeleton className="h-3 w-3/4" />
                </div>
                <div className="space-y-2">
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="h-3 w-full" />
                  <Skeleton className="h-3 w-5/6" />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}

interface ProcessingCardSkeletonProps {
  stage: 'queued' | 'processing';
  progress?: number;
  currentPart?: number;
  totalParts?: number;
  retryCount?: number;
  jobStage?: string | null;
  jobCreatedAt?: string | null;
  onCancel?: () => void;
  isCancelling?: boolean;
}

// Format milliseconds to human readable time
function formatElapsedTime(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.round((ms % 60000) / 1000);
  return `${mins}m ${secs}s`;
}

// Live elapsed time component - matches history page style
function LiveElapsedTime({ startTime }: { startTime: string }) {
  const [elapsed, setElapsed] = useState('');
  
  useEffect(() => {
    const start = new Date(startTime).getTime();
    
    const update = () => {
      const now = Date.now();
      const durationMs = now - start;
      setElapsed(formatElapsedTime(durationMs));
    };
    
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [startTime]);
  
  return (
    <span className="flex items-center gap-1.5 text-sm text-primary font-medium animate-pulse">
      <Timer className="w-4 h-4" />
      {elapsed}
    </span>
  );
}

// Define the stages for the evaluation pipeline - matches history page
const EVALUATION_STAGES = [
  { key: 'queued', label: 'Queued for evaluation' },
  { key: 'uploading', label: 'Uploading audio to AI' },
  { key: 'transcribing', label: 'Transcribing speech' },
  { key: 'evaluating_part_1', label: 'Evaluating Part 1' },
  { key: 'evaluating_part_2', label: 'Evaluating Part 2' },
  { key: 'evaluating_part_3', label: 'Evaluating Part 3' },
];

function getActiveStageIndex(stage: 'queued' | 'processing', currentPart: number, jobStage?: string | null): number {
  if (stage === 'queued') return 0;

  const js = String(jobStage || '');

  // Map explicit job stages
  if (js === 'pending_upload' || js === 'pending' || js === 'queuing') return 0;
  if (js === 'uploading') return 1;
  if (js === 'transcribing') return 2;

  // Map part-specific stages if present
  if (js === 'evaluating_part_1') return 3;
  if (js === 'evaluating_part_2') return 4;
  if (js === 'evaluating_part_3') return 5;

  // Text-based pipeline sometimes reports 'evaluating_text' with current_part
  if (js === 'evaluating_text' || js === 'evaluating' || js === 'pending_eval') {
    if (currentPart === 2) return 4;
    if (currentPart === 3) return 5;
    if (currentPart >= 1) return 3;
  }

  // Default to first stage if processing
  return stage === 'processing' ? 1 : 0;
}

/**
 * ProcessingCardSkeleton - Matches the history page progress UI style
 * Shows a step-by-step checklist with live elapsed time, no progress bar jumps
 */
export function ProcessingCardSkeleton({
  stage,
  progress: _progress = 0,
  currentPart = 0,
  totalParts: _totalParts = 3,
  retryCount = 0,
  jobStage,
  jobCreatedAt,
  onCancel,
  isCancelling,
}: ProcessingCardSkeletonProps) {
  const activeStageIndex = getActiveStageIndex(stage, currentPart, jobStage);
  const activeStage = EVALUATION_STAGES[activeStageIndex];
  
  // Calculate smooth progress based on stage index (never resets backwards)
  const smoothProgress = Math.round(((activeStageIndex + 1) / EVALUATION_STAGES.length) * 100);
  
  return (
    <Card className="max-w-md w-full animate-fade-in">
      <CardContent className="py-8">
        {/* Animated spinner - same as before but smaller */}
        <div className="relative mx-auto w-20 h-20 mb-6">
          <div className="absolute inset-0 rounded-full border-4 border-primary/20"></div>
          <div 
            className="absolute inset-0 rounded-full border-4 border-primary border-t-transparent animate-spin"
            style={{ animationDuration: '1.5s' }}
          ></div>
          <div 
            className="absolute inset-2 rounded-full border-2 border-accent/30 border-b-transparent animate-spin"
            style={{ animationDuration: '2s', animationDirection: 'reverse' }}
          ></div>
          <div className="absolute inset-0 flex items-center justify-center text-2xl">
            🎯
          </div>
        </div>
        
        <h2 className="text-xl font-bold mb-2 text-center">
          {activeStage?.label || 'Processing...'}
        </h2>
        
        <p className="text-muted-foreground mb-4 text-sm text-center">
          Our AI examiner is reviewing your responses
        </p>

        {/* Live elapsed time - prominent display like history page */}
        {jobCreatedAt && (
          <div className="flex justify-center mb-6">
            <LiveElapsedTime startTime={jobCreatedAt} />
          </div>
        )}

        {/* Stage Progress Steps - Checklist style like history page */}
        <div className="space-y-2 mb-6">
          {EVALUATION_STAGES.map((s, index) => {
            const isCompleted = index < activeStageIndex;
            const isActive = index === activeStageIndex;
            
            return (
              <div 
                key={s.key}
                className={cn(
                  "flex items-center gap-3 px-3 py-2 rounded-lg transition-all duration-300",
                  isActive && "bg-primary/10 border border-primary/30",
                  isCompleted && "bg-success/5",
                  !isActive && !isCompleted && "opacity-40"
                )}
              >
                <div className={cn(
                  "w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium shrink-0",
                  isCompleted && "bg-success text-success-foreground",
                  isActive && "bg-primary text-primary-foreground",
                  !isActive && !isCompleted && "bg-muted text-muted-foreground"
                )}>
                  {isCompleted ? (
                    <CheckCircle2 className="w-4 h-4" />
                  ) : (
                    <span>{index + 1}</span>
                  )}
                </div>
                <span className={cn(
                  "text-sm",
                  isActive && "font-medium text-foreground",
                  isCompleted && "text-success",
                  !isActive && !isCompleted && "text-muted-foreground"
                )}>
                  {s.label}
                </span>
                {isActive && (
                  <div className="ml-auto flex gap-0.5">
                    {[0, 1, 2].map((i) => (
                      <div 
                        key={i}
                        className="w-1.5 h-1.5 rounded-full bg-primary animate-bounce"
                        style={{
                          animationDelay: `${i * 0.16}s`
                        }}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Smooth progress bar that never resets */}
        <div className="mb-4">
          <Progress value={smoothProgress} className="h-2" />
          <div className="flex justify-between text-xs text-muted-foreground mt-1">
            <span>Step {activeStageIndex + 1} of {EVALUATION_STAGES.length}</span>
            <span>{smoothProgress}%</span>
          </div>
        </div>

        {/* Retry indicator */}
        {retryCount > 0 && (
          <div className="flex items-center justify-center gap-2 text-sm text-warning mb-3">
            <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
              <path d="M21 3v5h-5" />
            </svg>
            <span>Retry attempt {retryCount}...</span>
          </div>
        )}

        {/* Cancel button */}
        {onCancel && (
          <div className="text-center">
            <button
              onClick={onCancel}
              disabled={isCancelling}
              className="inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium rounded-md border border-input bg-background hover:bg-accent hover:text-accent-foreground transition-colors disabled:opacity-50 disabled:pointer-events-none"
            >
              {isCancelling ? (
                <>
                  <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
                    <path d="M12 2a10 10 0 0 1 10 10" strokeOpacity="1" />
                  </svg>
                  Cancelling...
                </>
              ) : (
                <>
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="15" y1="9" x2="9" y2="15" />
                    <line x1="9" y1="9" x2="15" y2="15" />
                  </svg>
                  Cancel Evaluation
                </>
              )}
            </button>
          </div>
        )}

        {/* Live update badge */}
        <div className="mt-4 text-center">
          <span className="inline-flex items-center gap-2 px-3 py-1 text-xs rounded-full border border-success/30 bg-success/10 text-success">
            <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse"></span>
            Live updates enabled
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
