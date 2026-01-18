import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

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
  onCancel?: () => void;
  isCancelling?: boolean;
}

// Define the stages for the evaluation pipeline
const EVALUATION_STAGES = [
  { key: 'queued', label: 'Queued for evaluation', icon: '⏳', description: 'Your submission is in the queue' },
  { key: 'uploading', label: 'Uploading audio to AI', icon: '📤', description: 'Sending your recordings for analysis' },
  { key: 'transcribing', label: 'Transcribing speech', icon: '📝', description: 'Converting your speech to text' },
  { key: 'evaluating_part_1', label: 'Evaluating Part 1', icon: '🎯', description: 'Analyzing interview responses' },
  { key: 'evaluating_part_2', label: 'Evaluating Part 2', icon: '🎯', description: 'Analyzing long turn response' },
  { key: 'evaluating_part_3', label: 'Evaluating Part 3', icon: '🎯', description: 'Analyzing discussion responses' },
  { key: 'generating_feedback', label: 'Generating feedback', icon: '✨', description: 'Creating personalized suggestions' },
  { key: 'finalizing', label: 'Finalizing results', icon: '📊', description: 'Preparing your score report' },
];

function getActiveStageIndex(stage: 'queued' | 'processing', currentPart: number, jobStage?: string | null): number {
  if (stage === 'queued') return 0;
  
  // Map job stage to index
  if (jobStage === 'uploading') return 1;
  if (jobStage === 'transcribing') return 2;
  if (jobStage === 'generating_feedback' || jobStage === 'generating') return 6;
  if (jobStage === 'finalizing' || jobStage === 'saving') return 7;
  
  // Use currentPart for evaluation stages
  if (currentPart === 1) return 3;
  if (currentPart === 2) return 4;
  if (currentPart === 3) return 5;
  
  // Default to first evaluation stage if processing
  return 3;
}

export function ProcessingCardSkeleton({
  stage,
  progress: _progress = 0,
  currentPart = 0,
  totalParts: _totalParts = 3,
  retryCount = 0,
  jobStage,
  onCancel,
  isCancelling,
}: ProcessingCardSkeletonProps) {
  const activeStageIndex = getActiveStageIndex(stage, currentPart, jobStage);
  const activeStage = EVALUATION_STAGES[activeStageIndex];
  
  return (
    <Card className="max-w-md w-full animate-fade-in">
      <CardContent className="py-8">
        {/* Animated spinner */}
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
            {activeStage?.icon || '🎯'}
          </div>
        </div>
        
        <h2 className="text-xl font-bold mb-2 text-center animate-pulse">
          {activeStage?.label || 'Processing...'}
        </h2>
        
        <p className="text-muted-foreground mb-6 text-sm text-center">
          {activeStage?.description || 'Our AI examiner is reviewing your responses.'}
        </p>

        {/* Stage Progress Steps */}
        <div className="space-y-2 mb-6">
          {EVALUATION_STAGES.slice(0, Math.min(activeStageIndex + 3, EVALUATION_STAGES.length)).map((s, index) => {
            const isCompleted = index < activeStageIndex;
            const isActive = index === activeStageIndex;
            
            return (
              <div 
                key={s.key}
                className={`flex items-center gap-3 px-3 py-2 rounded-lg transition-all duration-300 ${
                  isActive 
                    ? 'bg-primary/10 border border-primary/30' 
                    : isCompleted 
                      ? 'bg-success/5' 
                      : 'opacity-50'
                }`}
              >
                <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium ${
                  isCompleted 
                    ? 'bg-success text-success-foreground' 
                    : isActive 
                      ? 'bg-primary text-primary-foreground animate-pulse' 
                      : 'bg-muted text-muted-foreground'
                }`}>
                  {isCompleted ? (
                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  ) : (
                    <span>{index + 1}</span>
                  )}
                </div>
                <span className={`text-sm ${isActive ? 'font-medium text-foreground' : isCompleted ? 'text-success' : 'text-muted-foreground'}`}>
                  {s.label}
                </span>
                {isActive && (
                  <div className="ml-auto flex gap-0.5">
                    {[0, 1, 2].map((i) => (
                      <div 
                        key={i}
                        className="w-1.5 h-1.5 rounded-full bg-primary"
                        style={{
                          animation: 'bounce 1.4s infinite ease-in-out',
                          animationDelay: `${i * 0.16}s`
                        }}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          
          {/* Show remaining steps indicator if there are more */}
          {activeStageIndex + 3 < EVALUATION_STAGES.length && (
            <div className="text-center text-xs text-muted-foreground mt-2">
              +{EVALUATION_STAGES.length - activeStageIndex - 3} more steps...
            </div>
          )}
        </div>

        {/* Progress bar */}
        <div className="mb-4">
          <div className="h-2 bg-muted rounded-full overflow-hidden">
            <div 
              className="h-full bg-gradient-to-r from-primary to-accent transition-all duration-700 ease-out rounded-full"
              style={{ 
                width: `${Math.round(((activeStageIndex + 1) / EVALUATION_STAGES.length) * 100)}%`
              }}
            />
          </div>
          <div className="flex justify-between text-xs text-muted-foreground mt-1">
            <span>Step {activeStageIndex + 1} of {EVALUATION_STAGES.length}</span>
            <span>~{stage === 'queued' ? '60-90' : Math.max(10, 60 - activeStageIndex * 8)}s remaining</span>
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
