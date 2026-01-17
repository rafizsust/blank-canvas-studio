import { useState, useRef, useCallback, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Mic, Play, Square, Loader2, CheckCircle2, XCircle, Volume2, VolumeX, ArrowLeft, Globe, Info, AlertTriangle, Headphones, Radio } from 'lucide-react';
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

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Alert, AlertDescription } from '@/components/ui/alert';

import { detectBrowser, ACCENT_OPTIONS, getStoredAccent, setStoredAccent, getStoredAccentAsync } from '@/lib/speechRecognition';

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

// Helper to check if browser TTS is working
function checkTTSSupport(): { supported: boolean; hasVoices: boolean } {
  const supported = typeof window !== 'undefined' && 'speechSynthesis' in window;
  if (!supported) return { supported: false, hasVoices: false };
  
  const voices = window.speechSynthesis.getVoices();
  return { supported: true, hasVoices: voices.length > 0 };
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
  
  // TTS support detection
  const [ttsStatus, setTtsStatus] = useState<{ supported: boolean; hasVoices: boolean }>({ supported: true, hasVoices: true });
  
  // Evaluation mode selection - DEFAULT to 'accuracy' (more reliable)
  const [evaluationMode, setEvaluationMode] = useState<EvaluationMode>(initialEvaluationMode || 'accuracy');
  
  // Accent selection - use stored accent or default based on browser
  const [selectedAccent, setSelectedAccent] = useState<AccentCode>(() => {
    if (initialAccent) return initialAccent;
    // Initial sync value - will be updated async
    return getStoredAccent() as AccentCode;
  });

  // Try async geolocation-based detection on mount
  useEffect(() => {
    if (!initialAccent) {
      getStoredAccentAsync().then((accent) => {
        setSelectedAccent((current) => {
          // Only update if different from current
          if (accent && accent !== current) {
            return accent as AccentCode;
          }
          return current;
        });
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialAccent]);

  // Check if microphone permission is already granted on mount
  // Also check TTS support
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
      
      // Check TTS support
      const tts = checkTTSSupport();
      setTtsStatus(tts);
      
      // If TTS not working, wait for voices to load
      if (tts.supported && !tts.hasVoices) {
        const checkVoices = () => {
          const voices = window.speechSynthesis.getVoices();
          if (voices.length > 0) {
            setTtsStatus({ supported: true, hasVoices: true });
          }
        };
        window.speechSynthesis.addEventListener('voiceschanged', checkVoices);
        // Also try checking after a short delay
        setTimeout(checkVoices, 500);
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
      if (isPlaying) {
        audioPlayerRef.current.pause();
        setIsPlaying(false);
      } else {
        audioPlayerRef.current.src = recordedAudioUrl.current;
        audioPlayerRef.current.play().catch(e => console.error("Error playing audio:", e));
        setIsPlaying(true);
      }
    } else {
      toast.error('No recording available to play.');
    }
  }, [isPlaying]);

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
      <div className="p-8 max-w-lg mx-auto">
        <div className="flex flex-col items-center justify-center gap-4">
          <div className="relative w-16 h-16">
            <div className="absolute inset-0 rounded-full border-4 border-primary/20"></div>
            <div className="absolute inset-0 rounded-full border-4 border-primary border-t-transparent animate-spin"></div>
            <Mic className="absolute inset-0 m-auto w-6 h-6 text-primary" />
          </div>
          <p className="text-muted-foreground text-sm">Checking microphone access...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-lg mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        {onBack && (
          <Button variant="ghost" size="icon" onClick={onBack} className="shrink-0">
            <ArrowLeft className="w-5 h-5" />
          </Button>
        )}
        <div>
          <h2 className="text-xl font-semibold text-foreground">Microphone Setup</h2>
          <p className="text-sm text-muted-foreground">
            {micAccessGranted 
              ? 'Ready to go! Test your mic or start the test.'
              : 'Record a quick sample to verify your microphone works.'}
          </p>
        </div>
      </div>

      {/* Microphone Test Section */}
      <div className="bg-card border border-border rounded-xl p-6 mb-4">
        <div className="flex items-center gap-3 mb-4">
          <div className={cn(
            "w-10 h-10 rounded-full flex items-center justify-center shrink-0",
            micAccessGranted ? "bg-success/10 text-success" : "bg-muted text-muted-foreground"
          )}>
            <Mic className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <h3 className="font-medium text-sm">Microphone Check</h3>
            <p className="text-xs text-muted-foreground">
              {micAccessGranted ? 'Microphone access granted' : 'Click Record to test'}
            </p>
          </div>
          {micAccessGranted && !recordedAudioUrl.current && (
            <CheckCircle2 className="w-5 h-5 text-success shrink-0" />
          )}
        </div>

        {/* Recording Controls */}
        <div className="flex items-center gap-3 justify-center">
          <Button
            onClick={isRecording ? stopRecording : startRecording}
            disabled={loading || isPlaying}
            variant={isRecording ? "destructive" : "default"}
            size="lg"
            className="min-w-32"
          >
            {loading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : isRecording ? (
              <>
                <Square className="w-4 h-4 mr-2" />
                Stop
              </>
            ) : (
              <>
                <Radio className="w-4 h-4 mr-2" />
                Record
              </>
            )}
          </Button>
          
          {recordedAudioUrl.current && (
            <Button
              onClick={playRecording}
              disabled={isRecording}
              variant="outline"
              size="lg"
              className="min-w-32"
            >
              {isPlaying ? (
                <>
                  <Square className="w-4 h-4 mr-2" />
                  Stop
                </>
              ) : (
                <>
                  <Play className="w-4 h-4 mr-2" />
                  Play
                </>
              )}
            </Button>
          )}
        </div>

        {/* Recording Indicator */}
        {isRecording && (
          <div className="flex items-center justify-center gap-2 mt-4 py-2 px-4 bg-destructive/10 rounded-lg">
            <span className="w-2 h-2 rounded-full bg-destructive animate-pulse" />
            <span className="text-sm text-destructive font-medium">Recording...</span>
          </div>
        )}

        {/* Audio Player */}
        {recordedAudioUrl.current && !isRecording && (
          <div className="mt-4 pt-4 border-t border-border">
            <audio
              ref={audioPlayerRef}
              onTimeUpdate={handleAudioPlayerTimeUpdate}
              onEnded={handleAudioPlayerEnded}
              onPlay={() => setIsPlaying(true)}
              onPause={() => setIsPlaying(false)}
              preload="auto"
            />
            
            {/* Progress */}
            <div className="flex items-center gap-3 mb-3">
              <span className="text-xs text-muted-foreground w-10 text-right font-mono">
                {formatTime(currentTime)}
              </span>
              <Slider
                value={[currentTime]}
                max={duration || 1}
                step={0.1}
                onValueChange={handleSeek}
                className="flex-1"
              />
              <span className="text-xs text-muted-foreground w-10 font-mono">
                {formatTime(duration)}
              </span>
            </div>
            
            {/* Volume */}
            <div className="flex items-center justify-center gap-2">
              <Button variant="ghost" size="icon" onClick={toggleMute} className="h-8 w-8">
                {isMuted || volume === 0 ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
              </Button>
              <Slider
                value={[isMuted ? 0 : volume * 100]}
                max={100}
                step={1}
                onValueChange={handleVolumeChange}
                className="w-24"
              />
            </div>
          </div>
        )}

        {/* Status Messages */}
        {testPassed === true && recordedAudioUrl.current && (
          <div className="flex items-center justify-center gap-2 mt-4 py-2 px-4 bg-success/10 rounded-lg">
            <CheckCircle2 className="w-4 h-4 text-success" />
            <span className="text-sm text-success font-medium">Test successful!</span>
          </div>
        )}
        {testPassed === false && (
          <div className="flex items-center justify-center gap-2 mt-4 py-2 px-4 bg-destructive/10 rounded-lg">
            <XCircle className="w-4 h-4 text-destructive" />
            <span className="text-sm text-destructive font-medium">Microphone access denied</span>
          </div>
        )}
      </div>

      {/* Evaluation Mode Section */}
      <div className="bg-card border border-border rounded-xl p-6 mb-4">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-primary/10 text-primary flex items-center justify-center shrink-0">
            <Headphones className="w-5 h-5" />
          </div>
          <div>
            <h3 className="font-medium text-sm">Evaluation Mode</h3>
            <p className="text-xs text-muted-foreground">Choose how your speech is analyzed</p>
          </div>
        </div>

        <RadioGroup
          value={evaluationMode}
          onValueChange={(v) => setEvaluationMode(v as EvaluationMode)}
          className="space-y-2"
        >
          <label 
            className={cn(
              "flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors",
              evaluationMode === 'accuracy' 
                ? "border-primary bg-primary/5" 
                : "border-border hover:bg-muted/50"
            )}
            onClick={() => setEvaluationMode('accuracy')}
          >
            <RadioGroupItem value="accuracy" className="mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-medium text-sm">Accuracy Mode</span>
                <span className="text-xs px-1.5 py-0.5 rounded bg-primary/10 text-primary">Recommended</span>
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                Audio sent directly to AI for precise evaluation
              </p>
            </div>
          </label>

          <label 
            className={cn(
              "flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors",
              evaluationMode === 'basic' 
                ? "border-primary bg-primary/5" 
                : "border-border hover:bg-muted/50"
            )}
            onClick={() => setEvaluationMode('basic')}
          >
            <RadioGroupItem value="basic" className="mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-medium text-sm">Basic Mode</span>
                <span className="text-xs px-1.5 py-0.5 rounded bg-warning/10 text-warning">Less reliable</span>
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                Uses browser speech recognition (faster, less accurate)
              </p>
            </div>
          </label>
        </RadioGroup>

        {/* TTS Not Working Warning */}
        {evaluationMode === 'basic' && (!ttsStatus.supported || !ttsStatus.hasVoices) && (
          <Alert variant="destructive" className="mt-3">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription className="text-xs">
              Text-to-Speech unavailable. Questions will be shown as text.
            </AlertDescription>
          </Alert>
        )}

        {/* Accent Selection - ONLY shown on Chrome AND Basic Evaluation mode */}
        {browser.isChrome && evaluationMode === 'basic' && (
          <div className="mt-4 pt-4 border-t border-border">
            <div className="flex items-center gap-2 mb-2">
              <Globe className="w-4 h-4 text-muted-foreground" />
              <span className="text-sm font-medium">Your Accent</span>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Info className="w-3.5 h-3.5 text-muted-foreground cursor-help" />
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    <p className="text-xs">
                      Chrome requires accent selection for speech recognition. This is saved for future tests.
                    </p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
            <Select value={selectedAccent} onValueChange={(v) => handleAccentChange(v as AccentCode)}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select your accent" />
              </SelectTrigger>
              <SelectContent>
                {ACCENT_OPTIONS.map((accent) => (
                  <SelectItem key={accent.value} value={accent.value}>
                    {accent.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {/* Mode-specific hints */}
        {evaluationMode === 'basic' && browser.isChrome && (
          <div className="flex items-start gap-2 mt-3 p-2 bg-warning/5 border border-warning/20 rounded-lg text-xs text-muted-foreground">
            <Info className="w-3.5 h-3.5 mt-0.5 shrink-0 text-warning" />
            <p>For better accuracy in Basic mode, consider using Microsoft Edge.</p>
          </div>
        )}

        {evaluationMode === 'accuracy' && (
          <div className="flex items-start gap-2 mt-3 p-2 bg-primary/5 border border-primary/20 rounded-lg text-xs text-muted-foreground">
            <Info className="w-3.5 h-3.5 mt-0.5 shrink-0 text-primary" />
            <p>Audio is sent directly to AI — no browser speech recognition needed.</p>
          </div>
        )}
      </div>

      {/* Start Button */}
      <Button
        onClick={() => onTestComplete(selectedAccent, evaluationMode)}
        disabled={!micAccessGranted && testPassed !== true}
        className="w-full h-12 text-base"
        size="lg"
      >
        Start Speaking Test
      </Button>
      
      <p className="text-xs text-muted-foreground text-center mt-3">
        {micAccessGranted 
          ? 'Your microphone is ready. Good luck!'
          : 'Please grant microphone access to continue.'}
      </p>
    </div>
  );
}
