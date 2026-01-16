import { useState, useRef, useCallback, useEffect } from 'react';
import { Play, Pause, Volume2, VolumeX, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from '@/lib/utils';
import { detectBrowser } from '@/lib/speechRecognition/browserDetection';

// Detect browser once at module level
const browserInfo = detectBrowser();

interface SimulatedAudioPlayerProps {
  text: string;
  accentHint?: 'US' | 'GB' | 'AU';
  onComplete?: () => void;
  className?: string;
  autoPlay?: boolean; // Auto-start TTS when component mounts
}

const playbackSpeeds = [0.5, 0.75, 1, 1.25, 1.5];

/**
 * SimulatedAudioPlayer - A TTS-based audio player that mimics the premium player UI
 * Features:
 * - Play/Pause toggle
 * - Simulated progress bar based on word count estimation
 * - Time display (0:15 / 1:45)
 * - Source badge indicating "Device Voice"
 * - Volume controls
 * - Playback speed controls
 */
export function SimulatedAudioPlayer({
  text,
  accentHint = 'GB',
  onComplete,
  className,
  autoPlay = false,
}: SimulatedAudioPlayerProps) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [isSupported, setIsSupported] = useState(true);
  
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const startTimeRef = useRef<number>(0);
  const pausedTimeRef = useRef<number>(0);

  // Session/chunk guards to prevent repeating long prompts mid-playback
  const ttsSessionRef = useRef(0);
  const chunksRef = useRef<string[]>([]);
  
  // Edge browser workaround: timeout refs for detecting stuck utterances
  const edgeSafetyTimerRef = useRef<number | null>(null);
  const edgeStartupTimerRef = useRef<number | null>(null);
  
  // Estimate duration: ~2.5 words per second for TTS
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const estimatedDuration = Math.ceil(wordCount / 2.5);

  // Get best available voice
  const getBestVoice = useCallback((): SpeechSynthesisVoice | null => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return null;
    
    const voices = window.speechSynthesis.getVoices();
    if (voices.length === 0) return null;

    const accentMap: Record<string, string[]> = {
      US: ['en-US', 'en_US'],
      GB: ['en-GB', 'en_GB', 'en-UK'],
      AU: ['en-AU', 'en_AU'],
    };

    const preferredLangs = accentMap[accentHint] || ['en-GB'];

    // Priority order for voice selection - prefer high-quality voices
    const voicePriorities = [
      // 1. Match accent + high-quality voices (Google, Microsoft, Natural)
      (v: SpeechSynthesisVoice) =>
        preferredLangs.some((l) => v.lang.includes(l.replace('_', '-'))) &&
        (v.name.includes('Google') || v.name.includes('Microsoft') || v.name.includes('Natural')),
      // 2. Match accent
      (v: SpeechSynthesisVoice) =>
        preferredLangs.some((l) => v.lang.includes(l.replace('_', '-'))),
      // 3. Any high-quality English voice
      (v: SpeechSynthesisVoice) =>
        v.lang.startsWith('en') &&
        (v.name.includes('Google') || v.name.includes('Microsoft') || v.name.includes('Natural')),
      // 4. Any English voice
      (v: SpeechSynthesisVoice) => v.lang.startsWith('en'),
    ];

    for (const priority of voicePriorities) {
      const match = voices.find(priority);
      if (match) return match;
    }

    return voices[0];
  }, [accentHint]);

  // Animate progress bar
  const animateProgress = useCallback(() => {
    if (!startTimeRef.current) return;

    const now = Date.now();
    const elapsed = (now - startTimeRef.current) / 1000; // in seconds
    const adjustedElapsed = elapsed * playbackRate;
    const newProgress = Math.min((adjustedElapsed / estimatedDuration) * 100, 100);
    const newTime = Math.min(adjustedElapsed, estimatedDuration);

    setProgress(newProgress);
    setCurrentTime(newTime);

    // For chunked TTS, `speechSynthesis.speaking` can briefly flicker between chunks.
    if (newProgress < 100 && !isPaused && (isPlaying || window.speechSynthesis.speaking)) {
      animationFrameRef.current = requestAnimationFrame(animateProgress);
    }
  }, [estimatedDuration, playbackRate, isPlaying, isPaused]);

  // Start speech (chunked)
  const startSpeech = useCallback(() => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      setIsSupported(false);
      return;
    }

    // New session so stale events can't restart speech mid-play
    const mySession = ++ttsSessionRef.current;

    // Cancel any existing speech
    window.speechSynthesis.cancel();

    // Sanitize text to remove SSML/XML tags before browser TTS speaks
    const safeText = text
      .replace(/<[^>]*>/g, '')
      .replace(/&[a-z]+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const splitIntoChunks = (t: string, maxLen = 180) => {
      if (!t) return [] as string[];
      if (t.length <= maxLen) return [t];

      const chunks: string[] = [];
      let remaining = t;
      const boundary = /([.!?;:])\s+/;

      while (remaining.length > maxLen) {
        const slice = remaining.slice(0, maxLen + 1);
        const match = slice.match(boundary);

        let cut = maxLen;
        if (match && match.index != null) {
          cut = Math.min(remaining.length, match.index + match[0].length);
        } else {
          const lastSpace = slice.lastIndexOf(' ');
          if (lastSpace > 60) cut = lastSpace + 1;
        }

        chunks.push(remaining.slice(0, cut).trim());
        remaining = remaining.slice(cut).trim();
      }

      if (remaining) chunks.push(remaining);
      return chunks.filter(Boolean);
    };

    chunksRef.current = splitIntoChunks(safeText);
    if (chunksRef.current.length === 0) return;

    const applyVoiceSettings = (utterance: SpeechSynthesisUtterance) => {
      const voice = getBestVoice();
      if (voice) {
        utterance.voice = voice;
        console.log('[SimulatedAudio] Using voice:', voice.name);
      } else {
        console.warn('[SimulatedAudio] No voice found, using default');
      }
      utterance.rate = playbackRate * 0.9;
      utterance.pitch = 1;
      utterance.volume = isMuted ? 0 : volume;
    };

    const speakChunk = (index: number, retryCount = 0) => {
      if (ttsSessionRef.current !== mySession) return;

      // Clear any existing Edge safety timers
      if (edgeSafetyTimerRef.current) {
        window.clearTimeout(edgeSafetyTimerRef.current);
        edgeSafetyTimerRef.current = null;
      }
      if (edgeStartupTimerRef.current) {
        window.clearTimeout(edgeStartupTimerRef.current);
        edgeStartupTimerRef.current = null;
      }

      const chunk = chunksRef.current[index];
      const utterance = new SpeechSynthesisUtterance(chunk);
      utteranceRef.current = utterance;

      applyVoiceSettings(utterance);
      const rate = playbackRate * 0.9;

      // Track if this chunk's onend has fired
      let chunkEndFired = false;
      let onstartFired = false;

      const handleChunkEnd = () => {
        if (chunkEndFired) return;
        chunkEndFired = true;

        // Clear Edge safety timers
        if (edgeSafetyTimerRef.current) {
          window.clearTimeout(edgeSafetyTimerRef.current);
          edgeSafetyTimerRef.current = null;
        }
        if (edgeStartupTimerRef.current) {
          window.clearTimeout(edgeStartupTimerRef.current);
          edgeStartupTimerRef.current = null;
        }

        if (ttsSessionRef.current !== mySession) return;

        const nextIndex = index + 1;
        if (nextIndex < chunksRef.current.length) {
          setTimeout(() => speakChunk(nextIndex), 0);
          return;
        }

        setIsPlaying(false);
        setIsPaused(false);
        setProgress(100);
        setCurrentTime(estimatedDuration);
        if (animationFrameRef.current) {
          cancelAnimationFrame(animationFrameRef.current);
        }
        onComplete?.();
      };

      utterance.onstart = () => {
        onstartFired = true;
        
        // Clear startup timer since onstart fired successfully
        if (edgeStartupTimerRef.current) {
          window.clearTimeout(edgeStartupTimerRef.current);
          edgeStartupTimerRef.current = null;
        }
        
        if (ttsSessionRef.current !== mySession) return;
        if (index === 0) {
          setIsPlaying(true);
          setIsPaused(false);
          startTimeRef.current = Date.now() - pausedTimeRef.current * 1000;
          animationFrameRef.current = requestAnimationFrame(animateProgress);
        }

        // Edge workaround: Set a safety timeout based on estimated speech duration
        if (browserInfo.isEdge) {
          const estimatedChunkDuration = Math.max(3000, (chunk.length * 80 / rate) + 2000);
          console.log(`[SimulatedAudio Edge] Safety timer set for ${estimatedChunkDuration}ms for chunk ${index + 1}/${chunksRef.current.length}`);
          
          edgeSafetyTimerRef.current = window.setTimeout(() => {
            if (ttsSessionRef.current === mySession && !chunkEndFired) {
              console.warn('[SimulatedAudio Edge] Safety timeout triggered - forcing progression');
              window.speechSynthesis.cancel();
              handleChunkEnd();
            }
          }, estimatedChunkDuration);
        }
      };

      utterance.onend = () => {
        handleChunkEnd();
      };

      utterance.onerror = (e) => {
        // Clear Edge safety timers on error
        if (edgeSafetyTimerRef.current) {
          window.clearTimeout(edgeSafetyTimerRef.current);
          edgeSafetyTimerRef.current = null;
        }
        if (edgeStartupTimerRef.current) {
          window.clearTimeout(edgeStartupTimerRef.current);
          edgeStartupTimerRef.current = null;
        }

        // Ignore barge-in cancels
        const err = (e as any)?.error;
        if (err === 'canceled') return;

        // Edge sometimes fires 'interrupted' error when we force progression
        if (browserInfo.isEdge && err === 'interrupted') {
          console.log('[SimulatedAudio Edge] Interrupted error treated as success');
          handleChunkEnd();
          return;
        }

        console.error('TTS error:', e);
        setIsPlaying(false);
        setIsPaused(false);
        if (animationFrameRef.current) {
          cancelAnimationFrame(animationFrameRef.current);
        }
      };

      window.speechSynthesis.speak(utterance);
      
      // Edge workaround: Set a STARTUP timeout - if onstart doesn't fire within 2 seconds,
      // retry with a fresh utterance (voices may not be loaded yet)
      if (browserInfo.isEdge) {
        const startupTimeout = retryCount === 0 ? 2000 : 3000;
        console.log(`[SimulatedAudio Edge] Startup timer set for ${startupTimeout}ms - chunk ${index + 1}, retry ${retryCount}`);
        edgeStartupTimerRef.current = window.setTimeout(() => {
          if (ttsSessionRef.current === mySession && !onstartFired && !chunkEndFired) {
            if (retryCount < 2) {
              // Retry: cancel and try again - voices might be loaded now
              console.warn(`[SimulatedAudio Edge] Startup timeout - retrying (attempt ${retryCount + 1})`);
              window.speechSynthesis.cancel();
              // Force voice refresh before retry
              window.speechSynthesis.getVoices();
              setTimeout(() => speakChunk(index, retryCount + 1), 100);
            } else {
              // Give up after 2 retries - skip to completion
              console.warn('[SimulatedAudio Edge] Startup timeout - max retries reached, forcing progression');
              window.speechSynthesis.cancel();
              handleChunkEnd();
            }
          }
        }, startupTimeout);
      }
    };

    // Reset progress for a fresh play
    setProgress(0);
    setCurrentTime(0);
    pausedTimeRef.current = 0;

    // Edge workaround: Ensure voices are loaded before speaking
    // Edge sometimes needs getVoices() called to trigger voice loading
    if (browserInfo.isEdge) {
      const voices = window.speechSynthesis.getVoices();
      if (voices.length === 0) {
        console.log('[SimulatedAudio Edge] No voices loaded, waiting for voiceschanged...');
        const voicesLoaded = () => {
          window.speechSynthesis.onvoiceschanged = null;
          console.log('[SimulatedAudio Edge] Voices loaded, starting speech');
          speakChunk(0);
        };
        window.speechSynthesis.onvoiceschanged = voicesLoaded;
        // Fallback: start anyway after 500ms if voices don't load
        setTimeout(() => {
          if (ttsSessionRef.current === mySession) {
            window.speechSynthesis.onvoiceschanged = null;
            console.log('[SimulatedAudio Edge] Fallback: starting speech without waiting for voices');
            speakChunk(0);
          }
        }, 500);
      } else {
        speakChunk(0);
      }
    } else {
      speakChunk(0);
    }
  }, [text, getBestVoice, playbackRate, isMuted, volume, animateProgress, estimatedDuration, onComplete]);

  // Toggle play/pause
  const togglePlayPause = useCallback(() => {
    if (!isPlaying && !isPaused) {
      // Start fresh
      startSpeech();
    } else if (isPlaying && !isPaused) {
      // Pause
      window.speechSynthesis.pause();
      setIsPaused(true);
      pausedTimeRef.current = currentTime;
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    } else if (isPaused) {
      // Resume
      window.speechSynthesis.resume();
      setIsPaused(false);
      startTimeRef.current = Date.now() - (pausedTimeRef.current * 1000 / playbackRate);
      animationFrameRef.current = requestAnimationFrame(animateProgress);
    }
  }, [isPlaying, isPaused, startSpeech, currentTime, animateProgress, playbackRate]);

  // Handle volume change
  const handleVolumeChange = useCallback((value: number[]) => {
    const v = value[0] / 100;
    setVolume(v);
    if (v === 0) setIsMuted(true);
    else if (isMuted) setIsMuted(false);
    
    // Update current utterance volume
    if (utteranceRef.current) {
      utteranceRef.current.volume = v;
    }
  }, [isMuted]);

  const toggleMute = useCallback(() => {
    setIsMuted((m) => {
      if (utteranceRef.current) {
        utteranceRef.current.volume = m ? volume : 0;
      }
      return !m;
    });
  }, [volume]);

  // Handle playback rate change
  const handlePlaybackRateChange = useCallback((value: string) => {
    const rate = parseFloat(value);
    setPlaybackRate(rate);
    
    // Restart with new rate if currently playing
    if (isPlaying) {
      pausedTimeRef.current = currentTime;
      window.speechSynthesis.cancel();
      setTimeout(() => startSpeech(), 50);
    }
  }, [isPlaying, currentTime, startSpeech]);

  // Format time helper
  const formatTime = (t: number) => {
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      // Clear Edge safety timers
      if (edgeSafetyTimerRef.current) {
        window.clearTimeout(edgeSafetyTimerRef.current);
      }
      if (edgeStartupTimerRef.current) {
        window.clearTimeout(edgeStartupTimerRef.current);
      }
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  // Check support on mount
  useEffect(() => {
    setIsSupported(typeof window !== 'undefined' && 'speechSynthesis' in window);
  }, []);

  // Track if we've already auto-played to prevent loops
  const hasAutoPlayedRef = useRef(false);
  
  // Auto-play on mount if enabled - with guard to prevent repeated triggers
  useEffect(() => {
    if (autoPlay && isSupported && !isPlaying && !isPaused && !hasAutoPlayedRef.current) {
      hasAutoPlayedRef.current = true;
      // Small delay to ensure voices are loaded
      const timer = setTimeout(() => {
        startSpeech();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [autoPlay, isSupported]); // Only run on mount
  
  // Reset the guard when text changes (new question) and cancel any ongoing speech
  useEffect(() => {
    hasAutoPlayedRef.current = false;
    // Cancel any ongoing speech when text changes to prevent overlap
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    setIsPlaying(false);
    setIsPaused(false);
    setProgress(0);
    setCurrentTime(0);
  }, [text]);

  if (!isSupported) {
    return (
      <div className={cn("flex items-center justify-center p-2 bg-destructive/10 text-destructive rounded-md", className)}>
        <span className="text-sm">Audio playback not supported in this browser</span>
      </div>
    );
  }

  return (
    <div className={cn("flex items-center gap-2", className)}>
      {/* Play/Pause Button */}
      <Button
        variant="ghost"
        size="icon"
        onClick={togglePlayPause}
        className="flex-shrink-0 h-8 w-8"
      >
        {isPlaying && !isPaused ? <Pause size={20} /> : <Play size={20} />}
      </Button>

      {/* Progress Bar */}
      <div className="flex-1 flex items-center gap-1 min-w-0">
        <span className="text-xs text-muted-foreground w-10 text-right flex-shrink-0">
          {formatTime(currentTime)}
        </span>
        <Slider
          value={[progress]}
          max={100}
          step={0.1}
          disabled
          className="flex-1 min-w-[60px]"
        />
        <span className="text-xs text-muted-foreground w-10 text-left flex-shrink-0">
          {formatTime(estimatedDuration)}
        </span>
      </div>

      {/* Volume Control */}
      <div className="flex items-center gap-1 flex-shrink-0">
        <Button variant="ghost" size="icon" onClick={toggleMute} className="h-7 w-7">
          {isMuted || volume === 0 ? <VolumeX size={16} /> : <Volume2 size={16} />}
        </Button>
        <Slider
          value={[isMuted ? 0 : volume * 100]}
          max={100}
          step={1}
          onValueChange={handleVolumeChange}
          className="w-14"
        />
      </div>

      {/* Playback Speed */}
      <Select value={playbackRate.toString()} onValueChange={handlePlaybackRateChange}>
        <SelectTrigger className="w-[70px] h-7 text-xs">
          <SelectValue placeholder="Speed" />
        </SelectTrigger>
        <SelectContent>
          {playbackSpeeds.map((speed) => (
            <SelectItem key={speed} value={speed.toString()}>
              {speed}x
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Source Badge */}
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex items-center gap-1 px-2 py-0.5 bg-muted rounded-full text-xs text-muted-foreground flex-shrink-0">
              <Zap size={12} className="text-amber-500" />
              <span className="hidden sm:inline">Device Voice</span>
            </div>
          </TooltipTrigger>
          <TooltipContent>
            <p>Premium audio unavailable. Using system voice.</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}

export default SimulatedAudioPlayer;
