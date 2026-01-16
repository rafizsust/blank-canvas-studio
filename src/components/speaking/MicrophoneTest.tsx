import { useState, useRef, useCallback, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Mic, Play, Pause, StopCircle, Loader2, CheckCircle2, XCircle, Volume2, VolumeX, ArrowLeft, Globe, Info } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Slider } from '@/components/ui/slider';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';

import { detectBrowser, ACCENT_OPTIONS, getStoredAccent, setStoredAccent } from '@/lib/speechRecognition';

// Re-export for backwards compatibility
export { ACCENT_OPTIONS };
export type AccentCode = typeof ACCENT_OPTIONS[number]['value'];
export type EvaluationMode = 'basic' | 'accuracy';

interface MicrophoneTestProps {
  onTestComplete: (selectedAccent: AccentCode, evaluationMode: EvaluationMode) => void;
  onBack?: () => void;
  initialAccent?: AccentCode;
  initialEvaluationMode?: EvaluationMode;
}

// Helper to check if microphone permission is already granted
async function checkMicrophonePermission(): Promise<'granted' | 'denied' | 'prompt'> {
  try {
    if (navigator.permissions && navigator.permissions.query) {
      const result = await navigator.permissions.query({ name: 'microphone' as PermissionName });
      return result.state;
    }
  } catch {
    // Permissions API not supported or failed
  }
  return 'prompt';
}

// Optimized audio constraints for better speech recognition accuracy
const OPTIMIZED_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
  sampleRate: { ideal: 48000 },
};

export function MicrophoneTest({ onTestComplete, onBack, initialAccent, initialEvaluationMode }: MicrophoneTestProps) {
  // Browser detection for conditional UI
  const [browser] = useState(() => detectBrowser());
  
  const [isRecording, setIsRecording] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [mediaRecorder, setMediaRecorder] = useState<MediaRecorder | null>(null);
  const audioChunks = useRef<Blob[]>([]);
  const recordedAudioUrl = useRef<string | null>(null);
  const audioPlayerRef = useRef<HTMLAudioElement>(null);
  const [loading, setLoading] = useState(false);
  const [checkingPermission, setCheckingPermission] = useState(true);
  const [testPassed, setTestPassed] = useState<boolean | null>(null);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [micAccessGranted, setMicAccessGranted] = useState(false);
  
  // Evaluation mode selection - basic (text-based) or accuracy (audio-based)
  const [evaluationMode, setEvaluationMode] = useState<EvaluationMode>(initialEvaluationMode || 'basic');
  
  // Accent selection - use stored accent or default based on browser
  const [selectedAccent, setSelectedAccent] = useState<AccentCode>(() => {
    if (initialAccent) return initialAccent;
    // For Edge, accent doesn't matter but we still need a value
    // For Chrome, use stored preference
    return getStoredAccent() as AccentCode;
  });

  // Check if microphone permission is already granted on mount
  useEffect(() => {
    async function checkAndSetPermission() {
      const permissionState = await checkMicrophonePermission();
      
      if (permissionState === 'granted') {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ 
            audio: OPTIMIZED_AUDIO_CONSTRAINTS 
          });
          stream.getTracks().forEach(track => track.stop());
          console.log('[MicrophoneTest] Microphone permission already granted');
          setMicAccessGranted(true);
          setTestPassed(true);
        } catch {
          console.warn('[MicrophoneTest] Permission granted but failed to access mic');
          setMicAccessGranted(false);
        }
      } else {
        setMicAccessGranted(false);
      }
      
      setCheckingPermission(false);
    }
    
    checkAndSetPermission();
  }, []);

  const handleAccentChange = useCallback((accent: AccentCode) => {
    setSelectedAccent(accent);
    setStoredAccent(accent);
  }, []);

  const startRecording = useCallback(async () => {
    setLoading(true);
    setTestPassed(null);
    recordedAudioUrl.current = null;
    if (audioPlayerRef.current) {
      audioPlayerRef.current.pause();
      audioPlayerRef.current.currentTime = 0;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: OPTIMIZED_AUDIO_CONSTRAINTS 
      });
      const recorder = new MediaRecorder(stream);
      
      audioChunks.current = [];
      recorder.ondataavailable = (event) => {
        audioChunks.current.push(event.data);
      };

      recorder.onstop = () => {
        const audioBlob = new Blob(audioChunks.current, { type: 'audio/webm' });
        const url = URL.createObjectURL(audioBlob);
        recordedAudioUrl.current = url;
        setTestPassed(true);
        setMicAccessGranted(true);
        stream.getTracks().forEach(track => track.stop());
        setLoading(false);
      };

      recorder.start();
      setIsRecording(true);
      setMediaRecorder(recorder);
      setLoading(false);
    } catch (err) {
      console.error('Error accessing microphone:', err);
      setLoading(false);
      setTestPassed(false);
      setMicAccessGranted(false);
      toast.error('Failed to start recording. Please check microphone permissions.');
    }
  }, []);

  const stopRecording = useCallback(() => {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
      setIsRecording(false);
    }
  }, [mediaRecorder]);

  const playRecording = useCallback(() => {
    if (recordedAudioUrl.current && audioPlayerRef.current) {
      audioPlayerRef.current.src = recordedAudioUrl.current;
      audioPlayerRef.current.play().catch(e => console.error("Error playing audio:", e));
      setIsPlaying(true);
    } else {
      toast.error('No recording available to play.');
    }
  }, []);

  const handleAudioPlayerTimeUpdate = useCallback(() => {
    if (audioPlayerRef.current) {
      setCurrentTime(audioPlayerRef.current.currentTime);
      setDuration(audioPlayerRef.current.duration);
    }
  }, []);

  const handleAudioPlayerEnded = useCallback(() => {
    setIsPlaying(false);
    setCurrentTime(0);
  }, []);

  const handleSeek = useCallback((value: number[]) => {
    if (audioPlayerRef.current) {
      audioPlayerRef.current.currentTime = value[0];
      setCurrentTime(value[0]);
    }
  }, []);

  const handleVolumeChange = useCallback((value: number[]) => {
    const newVolume = value[0] / 100;
    if (audioPlayerRef.current) {
      audioPlayerRef.current.volume = newVolume;
      setVolume(newVolume);
      if (newVolume === 0) {
        setIsMuted(true);
      } else if (isMuted) {
        setIsMuted(false);
      }
    }
  }, [isMuted]);

  const toggleMute = useCallback(() => {
    if (audioPlayerRef.current) {
      audioPlayerRef.current.muted = !audioPlayerRef.current.muted;
      setIsMuted(audioPlayerRef.current.muted);
    }
  }, []);

  const formatTime = (time: number) => {
    const minutes = Math.floor(time / 60);
    const seconds = Math.floor(time % 60);
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  };

  if (checkingPermission) {
    return (
      <div className="p-6 max-w-md mx-auto bg-card border border-border rounded-lg shadow-lg space-y-6 text-center">
        <Loader2 className="w-8 h-8 mx-auto animate-spin text-primary" />
        <p className="text-muted-foreground">Checking microphone access...</p>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-md mx-auto bg-card border border-border rounded-lg shadow-lg space-y-6 text-center">
      {/* Back button */}
      {onBack && (
        <div className="flex justify-start -mt-2 -ml-2">
          <Button variant="ghost" size="sm" onClick={onBack} className="gap-1">
            <ArrowLeft className="w-4 h-4" />
            Back
          </Button>
        </div>
      )}
      
      <h2 className="text-2xl font-bold text-foreground">Microphone Test</h2>
      <p className="text-muted-foreground">
        {micAccessGranted 
          ? 'Your microphone is ready. You can test it below or start the speaking test directly.'
          : 'Click "Record" to test your microphone. Speak a few words, then click "Stop" and "Play" to listen.'
        }
      </p>

      {/* Browser Mode Badge */}
      <div className="flex justify-center">
        {browser.isEdge ? (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="secondary" className="gap-1.5">
                  <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
                  Edge Natural Mode
                </Badge>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                <p className="text-xs">
                  Edge uses natural speech optimization that preserves pauses and fillers for accurate fluency scoring. No accent selection needed.
                </p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : browser.isChrome ? (
          <Badge variant="outline" className="gap-1.5">
            <span className="w-2 h-2 bg-blue-500 rounded-full" />
            Chrome Accent Mode
          </Badge>
        ) : (
          <Badge variant="outline">{browser.browserName}</Badge>
        )}
      </div>

      {/* Accent Selection - ONLY shown on Chrome, not on Edge */}
      {browser.isChrome && (
        <div className="bg-muted/50 rounded-lg p-4 space-y-3">
          <div className="flex items-center justify-center gap-2 text-sm font-medium text-foreground">
            <Globe className="w-4 h-4" />
            Select Your Accent
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className="w-3.5 h-3.5 text-muted-foreground cursor-help" />
                </TooltipTrigger>
                <TooltipContent className="max-w-xs">
                  <p className="text-xs">
                    Chrome requires accent selection for stable speech recognition. 
                    This setting is remembered for future tests.
                  </p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
          <p className="text-xs text-muted-foreground">
            Choosing the correct accent improves speech recognition accuracy by ~30%
          </p>
          <Select value={selectedAccent} onValueChange={(v) => handleAccentChange(v as AccentCode)}>
            <SelectTrigger className="w-full bg-background">
              <SelectValue placeholder="Select your accent" />
            </SelectTrigger>
            <SelectContent className="bg-popover z-50">
              {ACCENT_OPTIONS.map((accent) => (
                <SelectItem key={accent.value} value={accent.value}>
                  {accent.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Edge info panel */}
      {browser.isEdge && (
        <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-4 space-y-2">
          <p className="text-sm font-medium text-green-700 dark:text-green-400">
            ✓ Optimal browser detected
          </p>
          <p className="text-xs text-muted-foreground">
            Microsoft Edge provides the best speech recognition experience with natural pause and filler detection for accurate fluency scoring.
          </p>
        </div>
      )}

      {/* Recording indicator */}
      {isRecording && (
        <div className="flex items-center justify-center gap-3 py-3 px-4 bg-destructive/10 border border-destructive/30 rounded-lg animate-pulse">
          <div className="relative">
            <div className="w-4 h-4 bg-destructive rounded-full animate-ping absolute" />
            <div className="w-4 h-4 bg-destructive rounded-full relative" />
          </div>
          <span className="text-destructive font-medium">Recording in progress...</span>
        </div>
      )}

      <div className="flex justify-center gap-4">
        <Button
          onClick={isRecording ? stopRecording : startRecording}
          disabled={loading || isPlaying}
          className={cn(
            "h-12 w-28",
            isRecording ? "bg-destructive hover:bg-destructive/90" : "bg-primary hover:bg-primary/90"
          )}
        >
          {loading ? <Loader2 size={20} className="animate-spin" /> : isRecording ? <StopCircle size={20} className="mr-2" /> : <Mic size={20} className="mr-2" />}
          {loading ? 'Loading...' : isRecording ? 'Stop' : 'Record'}
        </Button>
        <Button
          onClick={playRecording}
          disabled={!recordedAudioUrl.current || isRecording || isPlaying}
          className="h-12 w-28"
          variant="outline"
        >
          {isPlaying ? <Pause size={20} className="mr-2" /> : <Play size={20} className="mr-2" />}
          {isPlaying ? 'Playing...' : 'Play'}
        </Button>
      </div>

      {recordedAudioUrl.current && (
        <div className="space-y-3 mt-4">
          <audio
            ref={audioPlayerRef}
            onTimeUpdate={handleAudioPlayerTimeUpdate}
            onEnded={handleAudioPlayerEnded}
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
            preload="auto"
          />
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground w-10 text-right">
              {formatTime(currentTime)}
            </span>
            <Slider
              value={[currentTime]}
              max={duration}
              step={1}
              onValueChange={handleSeek}
              className="flex-1"
              disabled={isRecording || !recordedAudioUrl.current}
            />
            <span className="text-sm text-muted-foreground w-10 text-left">
              {formatTime(duration)}
            </span>
          </div>
          <div className="flex items-center justify-center gap-2">
            <Button variant="ghost" size="icon" onClick={toggleMute} className="h-8 w-8">
              {isMuted || volume === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}
            </Button>
            <Slider
              value={[isMuted ? 0 : volume * 100]}
              max={100}
              step={1}
              onValueChange={handleVolumeChange}
              className="w-24"
              disabled={isRecording || !recordedAudioUrl.current}
            />
          </div>
        </div>
      )}

      {/* Status messages */}
      {testPassed === true && recordedAudioUrl.current && (
        <p className="text-success flex items-center justify-center gap-2 mt-4">
          <CheckCircle2 size={20} /> Microphone test successful!
        </p>
      )}
      {testPassed === false && (
        <p className="text-destructive flex items-center justify-center gap-2 mt-4">
          <XCircle size={20} /> Microphone test failed. Please try again.
        </p>
      )}
      {micAccessGranted && !recordedAudioUrl.current && (
        <p className="text-success flex items-center justify-center gap-2 mt-4">
          <CheckCircle2 size={20} /> Microphone access granted
        </p>
      )}

      {/* Evaluation Mode Selection */}
      <div className="bg-muted/50 rounded-lg p-4 space-y-3">
        <div className="flex items-center justify-center gap-2 text-sm font-medium text-foreground">
          <Info className="w-4 h-4" />
          Evaluation Mode
        </div>
        <RadioGroup
          value={evaluationMode}
          onValueChange={(v) => setEvaluationMode(v as EvaluationMode)}
          className="grid grid-cols-1 gap-3"
        >
          <div className="flex items-start space-x-3 p-3 rounded-lg border bg-background cursor-pointer hover:bg-muted/30 transition-colors"
               onClick={() => setEvaluationMode('basic')}>
            <RadioGroupItem value="basic" id="eval-basic" className="mt-0.5" />
            <div className="flex-1">
              <label htmlFor="eval-basic" className="font-medium cursor-pointer">Basic Evaluation</label>
              <p className="text-xs text-muted-foreground mt-0.5">
                Uses browser speech recognition for evaluation. Faster and uses less AI tokens.
              </p>
            </div>
          </div>
          <div className="flex items-start space-x-3 p-3 rounded-lg border bg-background cursor-pointer hover:bg-muted/30 transition-colors"
               onClick={() => setEvaluationMode('accuracy')}>
            <RadioGroupItem value="accuracy" id="eval-accuracy" className="mt-0.5" />
            <div className="flex-1">
              <label htmlFor="eval-accuracy" className="font-medium cursor-pointer">Accuracy Mode</label>
              <p className="text-xs text-muted-foreground mt-0.5">
                Sends audio directly to AI for evaluation. More accurate but uses more tokens.
              </p>
            </div>
          </div>
        </RadioGroup>

        {/* Warning messages based on selection */}
        {evaluationMode === 'basic' && browser.isChrome && (
          <div className="flex items-start gap-2 p-2 bg-warning/10 border border-warning/30 rounded text-xs text-warning">
            <Info className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <p>For better accuracy in Basic mode, we recommend using <strong>Microsoft Edge</strong> browser.</p>
          </div>
        )}
        {evaluationMode === 'accuracy' && (
          <div className="flex items-start gap-2 p-2 bg-destructive/10 border border-destructive/30 rounded text-xs text-destructive">
            <Info className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <p>Accuracy Mode uses significantly more AI tokens. You may hit your daily limit faster.</p>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-3 mt-6">
        <Button
          onClick={() => onTestComplete(selectedAccent, evaluationMode)}
          disabled={!micAccessGranted && testPassed !== true}
          className="w-full"
        >
          Start Speaking Test
        </Button>
        <p className="text-xs text-muted-foreground text-center">
          {micAccessGranted 
            ? 'Microphone access is ready. You can proceed or test your microphone first.'
            : 'Microphone access is required to take the speaking test.'
          }
        </p>
      </div>
    </div>
  );
}
