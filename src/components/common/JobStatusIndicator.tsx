import { Loader2, CheckCircle2, XCircle, Clock } from 'lucide-react';
import { cn } from '@/lib/utils';

export type JobStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'queued';

interface JobStatusIndicatorProps {
  status: JobStatus;
  className?: string;
  showLabel?: boolean;
  size?: 'sm' | 'md' | 'lg';
  retryCount?: number;
  maxRetries?: number;
}

const statusConfig: Record<JobStatus, { 
  icon: typeof Loader2; 
  label: string; 
  color: string;
  bgColor: string;
  animate?: boolean;
}> = {
  queued: {
    icon: Clock,
    label: 'Queued',
    color: 'text-muted-foreground',
    bgColor: 'bg-muted',
  },
  pending: {
    icon: Clock,
    label: 'Pending',
    color: 'text-amber-600',
    bgColor: 'bg-amber-100',
  },
  processing: {
    icon: Loader2,
    label: 'Processing',
    color: 'text-blue-600',
    bgColor: 'bg-blue-100',
    animate: true,
  },
  completed: {
    icon: CheckCircle2,
    label: 'Completed',
    color: 'text-green-600',
    bgColor: 'bg-green-100',
  },
  failed: {
    icon: XCircle,
    label: 'Failed',
    color: 'text-destructive',
    bgColor: 'bg-destructive/10',
  },
};

const sizeConfig = {
  sm: { icon: 14, text: 'text-xs', padding: 'px-2 py-0.5' },
  md: { icon: 16, text: 'text-sm', padding: 'px-3 py-1' },
  lg: { icon: 20, text: 'text-base', padding: 'px-4 py-2' },
};

export function JobStatusIndicator({
  status,
  className,
  showLabel = true,
  size = 'md',
  retryCount,
  maxRetries,
}: JobStatusIndicatorProps) {
  const config = statusConfig[status];
  const sizeConf = sizeConfig[size];
  const Icon = config.icon;

  return (
    <div
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full font-medium',
        config.bgColor,
        config.color,
        sizeConf.padding,
        sizeConf.text,
        className
      )}
    >
      <Icon
        size={sizeConf.icon}
        className={cn(config.animate && 'animate-spin')}
      />
      {showLabel && (
        <span>
          {config.label}
          {status === 'processing' && retryCount !== undefined && retryCount > 0 && (
            <span className="ml-1 opacity-70">
              (retry {retryCount}/{maxRetries || 5})
            </span>
          )}
        </span>
      )}
    </div>
  );
}
