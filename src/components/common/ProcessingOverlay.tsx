import { JobStatusIndicator, JobStatus } from './JobStatusIndicator';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ProcessingOverlayProps {
  isVisible: boolean;
  status?: JobStatus;
  title?: string;
  message?: string;
  progress?: number;
  className?: string;
}

export function ProcessingOverlay({
  isVisible,
  status = 'processing',
  title = 'Processing',
  message = 'Please wait while we process your request...',
  progress,
  className,
}: ProcessingOverlayProps) {
  if (!isVisible) return null;

  return (
    <div
      className={cn(
        'fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm',
        className
      )}
    >
      <div className="flex flex-col items-center gap-4 p-8 rounded-xl bg-card border shadow-lg max-w-sm text-center">
        {/* Animated spinner or status indicator */}
        {status === 'processing' ? (
          <div className="relative">
            <Loader2 className="w-12 h-12 text-primary animate-spin" />
            {progress !== undefined && (
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="text-xs font-medium">{Math.round(progress)}%</span>
              </div>
            )}
          </div>
        ) : (
          <JobStatusIndicator status={status} size="lg" showLabel={false} />
        )}

        <div className="space-y-1">
          <h3 className="font-semibold text-lg">{title}</h3>
          <p className="text-sm text-muted-foreground">{message}</p>
        </div>

        {/* Progress bar */}
        {progress !== undefined && (
          <div className="w-full bg-secondary rounded-full h-2 overflow-hidden">
            <div
              className="h-full bg-primary transition-all duration-300 ease-out"
              style={{ width: `${progress}%` }}
            />
          </div>
        )}

        {/* Animated dots */}
        <div className="flex gap-1">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="w-1.5 h-1.5 rounded-full bg-primary animate-bounce"
              style={{ animationDelay: `${i * 0.15}s` }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
