import { useState, useRef, useCallback, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Mic, Play, Pause, StopCircle, Loader2, CheckCircle2, XCircle, Volume2, VolumeX, ArrowLeft, Globe } from 'lucide-react';
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

// Accent options for speech recognition
export const ACCENT_OPTIONS = [
  { value: 'en-US', label: 'American English' },
  { value: 'en-GB', label: 'British English' },
  { value: 'en-IN', label: 'Indian English' },
  { value: 'en-AU', label: 'Australian English' },
] as const;

export type AccentCode = typeof ACCENT_OPTIONS[number]['value'];

interface MicrophoneTestProps {
  onTestComplete: (selectedAccent: AccentCode) => void;
  onBack?: () => void;
  initialAccent?: AccentCode;
}

// Helper to check if microphone permission is already granted
async function checkMicrophonePermission(): Promise<'granted' | 'denied' | 'prompt'> {
  try {
    // Use Permissions API if available
    if (navigator.permissions && navigator.permissions.query) {
      const result = await navigator.permissions.query({ name: 'microphone' as PermissionName });
      return result.state;
    }
  } catch (e) {
    // Permissions API not supported or failed
  }
  return 'prompt'; // Default to prompt if we can't determine
}

// Optimized audio constraints for better speech recognition accuracy
const OPTIMIZED_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
  // Prefer higher sample rate for better audio quality
  sampleRate: { ideal: 48000 },
};

export function MicrophoneTest({ onTestComplete, onBack, initialAccent = 'en-GB' }: MicrophoneTestProps) {
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
  
  // Track if mic access is already granted (allows skipping the test)
  const [micAccessGranted, setMicAccessGranted] = useState(false);
  
  // Accent selection state
  const [selectedAccent, setSelectedAccent] = useState<AccentCode>(initialAccent);

  // Check if microphone permission is already granted on mount
  useEffect(() => {
    async function checkAndSetPermission() {
      const permissionState = await checkMicrophonePermission();
      
      if (permissionState === 'granted') {
        // Permission already granted - verify it works by getting a stream briefly
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ 
            audio: OPTIMIZED_AUDIO_CONSTRAINTS 
          });
          stream.getTracks().forEach(track => track.stop());
          // Permission is valid and working - allow user to skip test
          console.log('[MicrophoneTest] Microphone permission already granted');
          setMicAccessGranted(true);
          setTestPassed(true); // Pre-mark as passed so Start Test button is active
        } catch (e) {
          // Permission was granted but failed - require the test
          console.warn('[MicrophoneTest] Permission granted but failed to access mic:', e);
          setMicAccessGranted(false);
        }
      } else {
        setMicAccessGranted(false);
      }
      
      setCheckingPermission(false);
    }
    
    checkAndSetPermission();
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
      // Use optimized audio constraints for better speech recognition
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
        setTestPassed(true); // Assume test passed if recording successful
        setMicAccessGranted(true); // User now has mic access
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

  // Note: stopPlaying is kept for potential future use
  // @ts-expect-error - kept for potential future use
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const stopPlaying = useCallback(() => {
    if (audioPlayerRef.current) {
      audioPlayerRef.current.pause();
      audioPlayerRef.current.currentTime = 0;
      setIsPlaying(false);
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

  // Show loading while checking permission
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

      {/* Accent Selection */}
      <div className="bg-muted/50 rounded-lg p-4 space-y-3">
        <div className="flex items-center justify-center gap-2 text-sm font-medium text-foreground">
          <Globe className="w-4 h-4" />
          Select Your Accent
        </div>
        <p className="text-xs text-muted-foreground">
          Choosing the correct accent improves speech recognition accuracy by ~30%
        </p>
        <Select value={selectedAccent} onValueChange={(v) => setSelectedAccent(v as AccentCode)}>
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

      <div className="flex flex-col gap-3 mt-6">
        <Button
          onClick={() => onTestComplete(selectedAccent)}
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
