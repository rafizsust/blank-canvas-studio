import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Button } from '@/components/ui/button';
import { JobStatusIndicator, JobStatus } from './JobStatusIndicator';
import { RefreshCw, Home, RotateCcw } from 'lucide-react';
import { cn } from '@/lib/utils';

interface JobProcessingCardProps {
  title?: string;
  description?: string;
  status: JobStatus;
  progress?: number;
  estimatedTime?: string;
  retryCount?: number;
  maxRetries?: number;
  error?: string | null;
  onRetry?: () => void;
  onGoHome?: () => void;
  onRefresh?: () => void;
  className?: string;
  children?: React.ReactNode;
}

const statusMessages: Record<JobStatus, string> = {
  queued: 'Your request is in the queue and will be processed shortly.',
  pending: 'Your request is being prepared for processing.',
  processing: 'Your request is being processed. This may take a few moments.',
  completed: 'Processing complete! Your results are ready.',
  failed: 'Something went wrong during processing.',
};

export function JobProcessingCard({
  title = 'Processing Your Request',
  description,
  status,
  progress,
  estimatedTime,
  retryCount,
  maxRetries,
  error,
  onRetry,
  onGoHome,
  onRefresh,
  className,
  children,
}: JobProcessingCardProps) {
  const isActive = status === 'pending' || status === 'processing' || status === 'queued';
  const isFailed = status === 'failed';
  const isCompleted = status === 'completed';

  return (
    <Card className={cn('w-full max-w-md mx-auto', className)}>
      <CardHeader className="text-center pb-2">
        <div className="flex justify-center mb-3">
          <JobStatusIndicator
            status={status}
            size="lg"
            retryCount={retryCount}
            maxRetries={maxRetries}
          />
        </div>
        <CardTitle className="text-xl">{title}</CardTitle>
        <CardDescription>
          {description || statusMessages[status]}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Progress bar for active jobs */}
        {isActive && progress !== undefined && (
          <div className="space-y-2">
            <Progress value={progress} className="h-2" />
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>{Math.round(progress)}%</span>
              {estimatedTime && <span>~{estimatedTime} remaining</span>}
            </div>
          </div>
        )}

        {/* Animated dots for processing without progress */}
        {isActive && progress === undefined && (
          <div className="flex justify-center py-4">
            <div className="flex gap-1">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="w-2 h-2 rounded-full bg-primary animate-bounce"
                  style={{ animationDelay: `${i * 0.15}s` }}
                />
              ))}
            </div>
          </div>
        )}

        {/* Error message */}
        {isFailed && error && (
          <div className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
            {error}
          </div>
        )}

        {/* Custom children content */}
        {children}

        {/* Action buttons */}
        <div className="flex gap-2 justify-center pt-2">
          {isActive && onRefresh && (
            <Button variant="outline" size="sm" onClick={onRefresh}>
              <RefreshCw className="w-4 h-4 mr-1" />
              Refresh Status
            </Button>
          )}

          {isFailed && onRetry && (
            <Button variant="default" size="sm" onClick={onRetry}>
              <RotateCcw className="w-4 h-4 mr-1" />
              Retry
            </Button>
          )}

          {(isFailed || isCompleted) && onGoHome && (
            <Button variant="outline" size="sm" onClick={onGoHome}>
              <Home className="w-4 h-4 mr-1" />
              Go Home
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
