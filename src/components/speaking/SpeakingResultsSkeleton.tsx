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
  onCancel?: () => void;
  isCancelling?: boolean;
}

export function ProcessingCardSkeleton({
  stage,
  progress = 0,
  currentPart = 0,
  // totalParts intentionally unused - we now show "Processing Part X" instead of "Part X of Y"
  totalParts: _totalParts = 3,
  retryCount = 0,
  onCancel,
  isCancelling,
}: ProcessingCardSkeletonProps) {
  return (
    <Card className="max-w-md w-full animate-fade-in">
      <CardContent className="py-8 text-center">
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
          <div className="absolute inset-0 flex items-center justify-center">
            <svg className="w-6 h-6 text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 2a3 3 0 0 0-3 3v4a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <line x1="12" y1="19" x2="12" y2="22" />
            </svg>
          </div>
        </div>
        
        <h2 className="text-xl font-bold mb-2 animate-pulse">
          {stage === 'processing' ? 'Analyzing Your Speech…' : 'Preparing Evaluation…'}
        </h2>
        
        <p className="text-muted-foreground mb-4 text-sm">
          {stage === 'processing'
            ? 'Our AI examiner is carefully reviewing your responses against IELTS 2025 criteria.'
            : 'Your submission is queued and will start processing shortly.'}
        </p>

        {/* Animated progress bar */}
        {stage === 'processing' && (
          <div className="mb-4">
            <div className="flex justify-between text-xs text-muted-foreground mb-1.5">
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-primary animate-pulse"></span>
                {progress > 0 ? `Processing Part ${currentPart}` : 'Initializing...'}
              </span>
              <span>{progress > 0 ? `${progress}%` : ''}</span>
            </div>
            <div className="h-2 bg-muted rounded-full overflow-hidden">
              <div 
                className="h-full bg-gradient-to-r from-primary to-accent transition-all duration-500 ease-out rounded-full"
                style={{ 
                  width: progress > 0 ? `${progress}%` : '100%',
                  animation: progress === 0 ? 'shimmer 2s infinite' : undefined 
                }}
              />
            </div>
          </div>
        )}

        {/* Queued skeleton pulse */}
        {stage === 'queued' && (
          <div className="mb-4 space-y-2">
            <div className="flex justify-center gap-1">
              {[0, 1, 2].map((i) => (
                <div 
                  key={i}
                  className="w-2 h-2 rounded-full bg-primary"
                  style={{
                    animation: 'bounce 1.4s infinite ease-in-out',
                    animationDelay: `${i * 0.16}s`
                  }}
                />
              ))}
            </div>
          </div>
        )}

        {/* Time estimate */}
        <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground mb-4">
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <polyline points="12,6 12,12 16,14" />
          </svg>
          <span>{stage === 'processing' ? 'Usually 30–60 seconds' : 'Starting soon...'}</span>
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
          <button
            onClick={onCancel}
            disabled={isCancelling}
            className="mt-4 inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium rounded-md border border-input bg-background hover:bg-accent hover:text-accent-foreground transition-colors disabled:opacity-50 disabled:pointer-events-none"
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
        )}

        {/* Live update badge */}
        <div className="mt-4">
          <span className="inline-flex items-center gap-2 px-3 py-1 text-xs rounded-full border border-success/30 bg-success/10 text-success">
            <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse"></span>
            Live updates enabled
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
