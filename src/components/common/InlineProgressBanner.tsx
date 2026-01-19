import { Progress } from '@/components/ui/progress';
import { Button } from '@/components/ui/button';
import { Loader2, X, Timer } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useEffect, useState, useRef } from 'react';

export type EvaluationStage = 
  | 'preparing'
  | 'converting'
  | 'uploading'
  | 'queuing'
  | 'pending'
  | 'pending_upload'
  | 'pending_text_eval'
  | 'transcribing'
  | 'evaluating'
  | 'evaluating_text'
  | 'evaluating_part_1'
  | 'evaluating_part_2'
  | 'evaluating_part_3'
  | 'generating_feedback'
  | 'generating'
  | 'finalizing'
  | 'saving'
  | 'completed'
  | 'cancelled'
  | 'failed';

interface InlineProgressBannerProps {
  stage: EvaluationStage | string | null;
  currentPart?: number;
  totalParts?: number;
  progress?: number;
  startTime?: string;
  mode?: 'basic' | 'accuracy';
  onCancel?: () => void;
  isCancelling?: boolean;
  className?: string;
}

// Format milliseconds to human readable time
function formatElapsedTime(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.round((ms % 60000) / 1000);
  return `${mins}m ${secs}s`;
}

// Live elapsed time component
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
    <span className="flex items-center gap-1 text-xs text-muted-foreground">
      <Timer className="w-3 h-3" />
      {elapsed}
    </span>
  );
}

// Get stage label for display - user-friendly step names
function getStageLabel(stage: string | null | undefined, currentPart?: number): string {
  if (!stage) return 'Processing...';

  switch (stage) {
    case 'preparing':
      return 'Preparing audio...';
    case 'converting':
      return 'Converting audio...';
    case 'uploading':
      return 'Uploading audio...';
    case 'pending_upload':
    case 'pending_text_eval':
    case 'pending':
    case 'queuing':
      return 'Evaluation queued...';
    case 'transcribing':
      return 'Transcribing audio...';
    case 'evaluating_text':
    case 'evaluating':
    case 'evaluating_part_1':
      return `Evaluating Part ${currentPart && currentPart > 0 ? currentPart : 1}...`;
    case 'evaluating_part_2':
      return 'Evaluating Part 2...';
    case 'evaluating_part_3':
      return 'Evaluating Part 3...';
    case 'generating_feedback':
    case 'generating':
      return 'Generating feedback...';
    case 'finalizing':
    case 'saving':
      return 'Finalizing...';
    case 'completed':
      return 'Complete';
    case 'cancelled':
      return 'Cancelled';
    case 'failed':
      return 'Failed';
    default:
      return 'Processing...';
  }
}

/**
 * Calculate progress percentage based on realistic time distribution:
 * - Converting: ~3s (2%)
 * - Uploading: ~5s (3%)
 * - Queuing: instant (5%)
 * - Preparing audio: ~2s (2%)
 * - Evaluating Part 1: ~25s (25%)
 * - Evaluating Part 2: ~30s (30%)
 * - Evaluating Part 3: ~25s (25%)
 * - Finalizing: ~3s (3%)
 * 
 * Total typical time: ~95s for 3-part test
 * Evaluation takes ~85% of total time
 */
function getProgressFromStage(
  stage: string | null | undefined, 
  progress?: number, 
  currentPart?: number,
  totalParts?: number
): number {
  if (typeof progress === 'number' && progress > 0) return progress;
  
  if (!stage) return 2;
  
  // Pre-evaluation stages (0-12%)
  switch (stage) {
    case 'preparing': return 2;
    case 'converting': return 5;
    case 'uploading': return 8;
    case 'pending_upload':
    case 'pending_text_eval':
    case 'pending':
    case 'queuing': return 10;
    case 'transcribing': return 12;
  }
  
  // Evaluation stages take the bulk of time (12-92%)
  // Distribute based on number of parts
  const parts = totalParts || 3;
  const evalStartPct = 12;
  const evalEndPct = 92;
  const evalRange = evalEndPct - evalStartPct;
  const perPartPct = evalRange / parts;
  
  if (stage === 'evaluating' || stage === 'evaluating_text') {
    // Use currentPart if available, otherwise assume part 1
    const part = currentPart || 1;
    // Return progress at the START of evaluating this part
    return Math.round(evalStartPct + (part - 1) * perPartPct);
  }
  
  if (stage === 'evaluating_part_1') {
    return Math.round(evalStartPct + perPartPct * 0.5); // Midpoint of part 1
  }
  if (stage === 'evaluating_part_2') {
    return Math.round(evalStartPct + perPartPct + perPartPct * 0.5); // Midpoint of part 2
  }
  if (stage === 'evaluating_part_3') {
    return Math.round(evalStartPct + 2 * perPartPct + perPartPct * 0.5); // Midpoint of part 3
  }
  
  // Post-evaluation stages (92-100%)
  switch (stage) {
    case 'generating_feedback':
    case 'generating': return 94;
    case 'finalizing':
    case 'saving': return 97;
    case 'completed': return 100;
    default: return 15;
  }
}

export function InlineProgressBanner({
  stage,
  currentPart,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  totalParts,
  progress,
  startTime,
  mode,
  onCancel,
  isCancelling,
  className,
}: InlineProgressBannerProps) {
  const calculatedProgress = getProgressFromStage(stage, progress, currentPart, totalParts);
  const stageLabel = getStageLabel(stage, currentPart);

  // Prevent the progress bar from "jumping backwards" when the backend stage briefly returns
  // to a low-progress label (e.g., "queuing" between parts). Reset only when startTime changes.
  const maxProgressRef = useRef<{ key: string; max: number }>({ key: '', max: 0 });
  const progressKey = startTime ? String(startTime) : '__no_start_time__';
  
  // Reset max progress only when the evaluation job itself restarts (new startTime)
  if (maxProgressRef.current.key !== progressKey) {
    maxProgressRef.current.key = progressKey;
    maxProgressRef.current.max = 0;
  }
  
  // Always advance max progress - never go backwards
  maxProgressRef.current.max = Math.max(maxProgressRef.current.max, calculatedProgress);
  const displayProgress = maxProgressRef.current.max;

  return (
    <div
      className={cn(
        "flex items-center gap-3 p-2 rounded-lg bg-primary/5 border border-primary/20",
        className
      )}
    >
      {/* Spinner */}
      <Loader2 className="w-4 h-4 animate-spin text-primary shrink-0" />

      {/* Stage + Progress */}
      <div className="flex-1 min-w-0 space-y-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-primary truncate">
            {stageLabel}
            {mode && (
              <span className="ml-1.5 text-muted-foreground font-normal">
                ({mode === 'accuracy' ? 'Accuracy' : 'Basic'})
              </span>
            )}
          </span>
          {startTime && <LiveElapsedTime startTime={startTime} />}
        </div>
        <Progress value={displayProgress} className="h-1.5" />
      </div>

      {/* Cancel button */}
      {onCancel && (
        <Button
          variant="ghost"
          size="icon"
          onClick={(e) => {
            e.stopPropagation();
            onCancel();
          }}
          disabled={isCancelling}
          className="h-6 w-6 text-muted-foreground hover:text-destructive shrink-0"
          title="Cancel evaluation"
        >
          {isCancelling ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <X className="w-3 h-3" />
          )}
        </Button>
      )}
    </div>
  );
}

