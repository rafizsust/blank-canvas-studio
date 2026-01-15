import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { loadGeneratedTestAsync, GeneratedTest } from '@/types/aiPractice';
import { useToast } from '@/hooks/use-toast';
import { useTopicCompletions } from '@/hooks/useTopicCompletions';
import { useSpeechSynthesis } from '@/hooks/useSpeechSynthesis';
// TestStartOverlay removed - mic test is now the only entry point
// AILoadingScreen removed - using custom inline progress UI
import { ExitTestConfirmDialog } from '@/components/common/ExitTestConfirmDialog';
import { MicrophoneTest } from '@/components/speaking/MicrophoneTest';
import { describeApiError } from '@/lib/apiErrors';
import { supabase } from '@/integrations/supabase/client';
import {
  saveAllAudioSegments,
  deleteAudioSegments,
  loadAudioSegments,
  cleanupOldAudio,
} from '@/hooks/useSpeakingAudioPersistence';
import {
  Clock,
  Mic,
  Volume2,
  Loader2,
  Play,
  Pause,
  RotateCcw,
  ArrowLeft,
  WifiOff,
} from 'lucide-react';
import { useNetworkStatus } from '@/hooks/useNetworkStatus';
import { useAudioPreloader } from '@/hooks/useAudioPreloader';
import { SubmissionErrorState } from '@/components/common/SubmissionErrorState';
import { ApiErrorDescriptor } from '@/lib/apiErrors';
import { cn } from '@/lib/utils';
import { AudioLevelIndicator, AudioVolumeControl } from '@/components/speaking';
import { useFullscreenTest } from '@/hooks/useFullscreenTest';
import { compressAudio } from '@/utils/audioCompressor';
import { useAdvancedSpeechAnalysis, SpeechAnalysisResult } from '@/hooks/useAdvancedSpeechAnalysis';
import { InstantSpeechFeedback } from '@/components/speaking/InstantSpeechFeedback';
import { BrowserCompatibilityCheck } from '@/components/speaking/BrowserCompatibilityCheck';

// IELTS Official Timings
const TIMING = {
  PART1_QUESTION: 30, // 30 seconds per Part 1 question
  PART2_PREP: 60,     // 1 minute preparation
  PART2_SPEAK: 120,   // 2 minutes speaking
  PART3_QUESTION: 60, // 1 minute per Part 3 question
} as const;

// Minimum Part 2 speaking for fluency flag
const PART2_MIN_SPEAKING = 80;

type TestPhase =
  | 'loading'
  | 'ready'
  | 'part1_intro'
  | 'part1_question'
  | 'part1_recording'
  | 'part1_transition'
  | 'part2_intro'
  | 'part2_prep_reveal'  // New phase: after part2_prep_start audio, before showing cue card
  | 'part2_prep'
  | 'part2_recording'
  | 'part2_transition'
  | 'part3_intro'
  | 'part3_question'
  | 'part3_recording'
  | 'ending'
  | 'submitting'
  | 'submission_error'
  | 'done';

interface AudioSegmentMeta {
  key: string;
  partNumber: 1 | 2 | 3;
  questionId: string;
  questionNumber: number;
  questionText: string;
  chunks: Blob[];
  duration: number;
}

interface PartRecordingMeta {
  startTime: number;
  duration?: number;
}

export default function AIPracticeSpeakingTest() {
  const { testId } = useParams<{ testId: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { incrementCompletion } = useTopicCompletions('speaking');
  
  // Network status for offline/device audio indicators
  const { isOnline, onNetworkRestored } = useNetworkStatus();
  const [usingDeviceAudio, setUsingDeviceAudio] = useState(false);
  
  // Audio preloader for proactive fetching
  const { preloadMultiple, getPreloadedUrl, isPreloaded } = useAudioPreloader();
  
  // Fullscreen mode
  const { enterFullscreen, exitFullscreen } = useFullscreenTest();
  
  // Session guard to prevent TTS from repeating the same text
  const activeSpeakSessionRef = useRef<string | null>(null);

  // Test data
  const [test, setTest] = useState<GeneratedTest | null>(null);
  const [loading, setLoading] = useState(true);
  // showStartOverlay removed - mic test is now the only entry point
  const [showMicrophoneTest, setShowMicrophoneTest] = useState(true);
  
  // Shared audio for presets (instructions, transitions, endings - fetched from speaking_shared_audio table)
  const [sharedAudio, setSharedAudio] = useState<Record<string, { audio_url: string | null; fallback_text: string }>>({});
  const [sharedAudioFetched, setSharedAudioFetched] = useState(false);
  const [showExitDialog, setShowExitDialog] = useState(false);

  // Guards to prevent background submission/evaluation from hijacking navigation after exit
  const isMountedRef = useRef(true);
  const exitRequestedRef = useRef(false);

  // Test state
  const [phase, setPhase] = useState<TestPhase>('loading');
  const [currentPart, setCurrentPart] = useState<1 | 2 | 3>(1);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [timeLeft, setTimeLeft] = useState(0);
  const [isPaused, setIsPaused] = useState(false);

  // TTS state
  const [isMuted, setIsMuted] = useState(false);
  const [volume, setVolume] = useState(1); // Volume level 0-1
  const [currentSpeakingText, setCurrentSpeakingText] = useState('');

  // Recording state
  const [isRecording, setIsRecording] = useState(false);

  // Background evaluation state (kept for compatibility but not used in async flow)
  const [_partEvaluations] = useState<Record<number, unknown>>({});
  const [_evaluatingParts] = useState<Set<number>>(new Set());
  const [evaluationStep, setEvaluationStep] = useState(0);
  
  // Detailed submission progress for real-time UI updates
  const [submissionProgress, setSubmissionProgress] = useState({
    step: '',
    detail: '',
    currentItem: 0,
    totalItems: 0,
  });
  
  // Track failed upload attempts for retry functionality
  const [failedUploads, setFailedUploads] = useState<Array<{ key: string; error: string }>>([]);

  
  // Submission error state (for resubmit capability)
  const [submissionError, setSubmissionError] = useState<ApiErrorDescriptor | null>(null);
  const [isResubmitting, setIsResubmitting] = useState(false);

  const [recordings, setRecordings] = useState<Record<number, PartRecordingMeta>>({
    1: { startTime: 0 },
    2: { startTime: 0 },
    3: { startTime: 0 },
  });

  // Store audio per question (so we can transcribe + show transcript question-by-question)
  const [audioSegments, setAudioSegments] = useState<Record<string, AudioSegmentMeta>>({});

  // Speech analysis state for text-based evaluation
  const [segmentAnalyses, setSegmentAnalyses] = useState<Record<string, SpeechAnalysisResult>>({});
  const [currentAnalysis, setCurrentAnalysis] = useState<SpeechAnalysisResult | null>(null);
  const [showInstantFeedback, setShowInstantFeedback] = useState(false);

  // Advanced speech analysis hook
  const speechAnalysis = useAdvancedSpeechAnalysis({
    language: 'en-GB',
    onInterimResult: (transcript) => {
      // Live transcript available for display if needed
      console.log('[SpeakingTest] Live transcript:', transcript.slice(-50));
    },
  });

  // Refs for state access in callbacks (avoid stale closures)
  const phaseRef = useRef<TestPhase>(phase);
  const questionIndexRef = useRef(questionIndex);
  const currentPartRef = useRef(currentPart);
  const isMutedRef = useRef(isMuted);
  const volumeRef = useRef(volume);
  const currentSpeakingTextRef = useRef(currentSpeakingText);
  
  // Update refs when state changes
  useEffect(() => { phaseRef.current = phase; }, [phase]);
  useEffect(() => { questionIndexRef.current = questionIndex; }, [questionIndex]);
  useEffect(() => { currentPartRef.current = currentPart; }, [currentPart]);
  useEffect(() => { isMutedRef.current = isMuted; }, [isMuted]);
  useEffect(() => { volumeRef.current = volume; }, [volume]);
  useEffect(() => { currentSpeakingTextRef.current = currentSpeakingText; }, [currentSpeakingText]);

  // Other refs
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const part2SpeakStartRef = useRef<number>(0);
  const presetAudioRef = useRef<HTMLAudioElement | null>(null);

  // Prevent repeated TTS when audio retries/timeouts fire multiple times
  const presetAudioAttemptRef = useRef(0);
  const presetAudioTimersRef = useRef<{ load?: number; retry?: number; simulatedEnd?: number; endingSafety?: number }>({});
  const ttsFallbackSessionRef = useRef<string | null>(null);

  const activeAudioKeyRef = useRef<string | null>(null);
  const activeAudioStartRef = useRef<number>(0);
  const pendingStopMetaRef = useRef<{ key: string; meta: Omit<AudioSegmentMeta, 'chunks' | 'duration'>; startMs: number } | null>(null);

  const recordingsRef = useRef(recordings);
  useEffect(() => {
    recordingsRef.current = recordings;
  }, [recordings]);

  const audioSegmentsRef = useRef(audioSegments);
  useEffect(() => {
    audioSegmentsRef.current = audioSegments;
  }, [audioSegments]);

  // Get audio URLs from preset test
  const audioUrls = useMemo(() => {
    const urls = test?.speakingAudioUrls || {};
    if (Object.keys(urls).length > 0) {
      console.log('[SpeakingTest] Available audio URLs:', Object.keys(urls));
    }
    return urls;
  }, [test]);

  // Proactive audio prefetching - preload all audio when test loads
  useEffect(() => {
    if (!audioUrls || Object.keys(audioUrls).length === 0) return;
    
    const urlsToPreload = Object.values(audioUrls).filter((url): url is string => !!url);
    if (urlsToPreload.length > 0) {
      console.log(`[SpeakingTest] Preloading ${urlsToPreload.length} audio files...`);
      preloadMultiple(urlsToPreload);
    }
  }, [audioUrls, preloadMultiple]);

  // Retry preloading when network is restored
  useEffect(() => {
    const unsubscribe = onNetworkRestored(() => {
      if (!audioUrls || Object.keys(audioUrls).length === 0) return;
      
      const urlsToPreload = Object.values(audioUrls).filter((url): url is string => !!url);
      if (urlsToPreload.length > 0) {
        console.log('[SpeakingTest] Network restored - retrying audio preload...');
        preloadMultiple(urlsToPreload);
        setUsingDeviceAudio(false); // Reset device audio indicator
      }
    });
    return unsubscribe;
  }, [audioUrls, preloadMultiple, onNetworkRestored]);

  // Helper to prefetch upcoming part audio - prefetches ALL remaining questions in a part
  const prefetchPartAudio = useCallback((partNum: 1 | 2 | 3) => {
    if (!audioUrls || Object.keys(audioUrls).length === 0) return;
    
    // Prefetch all audio for the specified part (instruction + all questions)
    const keysToPreload = Object.keys(audioUrls).filter(key => key.startsWith(`part${partNum}_`));
    const urlsToPreload: string[] = [];
    
    keysToPreload.forEach(key => {
      const url = audioUrls[key];
      if (url && !isPreloaded(url)) {
        console.log(`[SpeakingTest] Prefetching: ${key}`);
        urlsToPreload.push(url);
      }
    });
    
    // Also prefetch part instruction/transition audio
    const instructionKey = `part${partNum}_instruction`;
    if (audioUrls[instructionKey] && !isPreloaded(audioUrls[instructionKey])) {
      urlsToPreload.push(audioUrls[instructionKey]);
    }
    
    // Also prefetch ending audio
    if (audioUrls['test_ending'] && !isPreloaded(audioUrls['test_ending'])) {
      urlsToPreload.push(audioUrls['test_ending']);
    }
    
    // Batch prefetch for efficiency
    if (urlsToPreload.length > 0) {
      console.log(`[SpeakingTest] Batch prefetching ${urlsToPreload.length} audio files for Part ${partNum}`);
      preloadMultiple(urlsToPreload);
    }
  }, [audioUrls, preloadMultiple, isPreloaded]);

  // Get current part data
  const speakingParts = useMemo(() => {
    const parts = test?.speakingParts || [];
    return {
      part1: parts.find((p) => p.part_number === 1) || null,
      part2: parts.find((p) => p.part_number === 2) || null,
      part3: parts.find((p) => p.part_number === 3) || null,
    };
  }, [test]);

  // Keep a ref to speakingParts for callbacks
  const speakingPartsRef = useRef(speakingParts);
  useEffect(() => { speakingPartsRef.current = speakingParts; }, [speakingParts]);

  // Browser TTS - create handler ref first
  const handleTTSCompleteRef = useRef<() => void>(() => {});
  
  const tts = useSpeechSynthesis({
    voiceName: sessionStorage.getItem('speaking_voice_preference') || undefined,
    onEnd: () => {
      setCurrentSpeakingText('');
      handleTTSCompleteRef.current();
    },
  });

  const clearPromptTimers = () => {
    const timers = presetAudioTimersRef.current;
    if (timers.load) window.clearTimeout(timers.load);
    if (timers.retry) window.clearTimeout(timers.retry);
    if (timers.simulatedEnd) window.clearTimeout(timers.simulatedEnd);
    if (timers.endingSafety) window.clearTimeout(timers.endingSafety);
    presetAudioTimersRef.current = {};
  };

  const stopPromptAudio = () => {
    // Invalidate any in-flight audio attempts/timeouts so they can't re-trigger TTS
    presetAudioAttemptRef.current += 1;
    clearPromptTimers();
    ttsFallbackSessionRef.current = null;

    tts.cancel();
    window.speechSynthesis?.cancel();

    if (presetAudioRef.current) {
      presetAudioRef.current.onended = null;
      presetAudioRef.current.onerror = null;
      presetAudioRef.current.onloadeddata = null;
      presetAudioRef.current.onloadedmetadata = null;
      presetAudioRef.current.pause();
      presetAudioRef.current.src = '';
      presetAudioRef.current = null;
    }
  };

  const blobToDataUrl = (blob: Blob) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Failed to read audio data'));
      reader.onloadend = () => resolve(String(reader.result));
      reader.readAsDataURL(blob);
    });

  // Convert recordings to MP3 before sending to Gemini / storing in R2.
  // This avoids WebM "0:00" metadata issues on some browsers and improves playback compatibility.
  const toMp3DataUrl = async (blob: Blob, key: string) => {
    try {
      const file = new File([blob], `${key}.audio`, { type: blob.type || 'audio/webm' });
      const mp3File = await compressAudio(file);
      return await blobToDataUrl(mp3File);
    } catch (err) {
      console.warn('[AIPracticeSpeakingTest] MP3 conversion failed, falling back to original blob:', err);
      return await blobToDataUrl(blob);
    }
  };

  // Forward declarations for functions (to handle circular dependencies)
  const getActiveSegmentMeta = (): Omit<AudioSegmentMeta, 'chunks' | 'duration'> | null => {
    const part = currentPartRef.current;
    const parts = speakingPartsRef.current;
    const qIdx = questionIndexRef.current;

    if (part === 1) {
      const q = parts.part1?.questions?.[qIdx];
      if (!q) return null;
      return {
        key: `part1-q${q.id}`,
        partNumber: 1,
        questionId: q.id,
        questionNumber: q.question_number,
        questionText: q.question_text,
      };
    }

    if (part === 2) {
      const q = parts.part2?.questions?.[0];
      if (!q) return null;
      return {
        key: `part2-q${q.id}`,
        partNumber: 2,
        questionId: q.id,
        questionNumber: q.question_number,
        questionText: q.question_text,
      };
    }

    const q = parts.part3?.questions?.[qIdx];
    if (!q) return null;
    return {
      key: `part3-q${q.id}`,
      partNumber: 3,
      questionId: q.id,
      questionNumber: q.question_number,
      questionText: q.question_text,
    };
  };

  const startRecording = async () => {
    // Cancel any ongoing prompt audio AND prevent any pending retries/timeouts from firing.
    stopPromptAudio();
    activeSpeakSessionRef.current = null;
    setShowInstantFeedback(false);
    setCurrentAnalysis(null);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // Use a supported mimeType. Recording in many chunks and concatenating them can produce invalid WebM
      // (0:00 duration + "No speech detected"). So we record WITHOUT a timeslice and let the browser
      // produce a single, valid container.
      const preferredTypes = [
        'audio/webm;codecs=opus',
        'audio/webm',
      ];
      const mimeType = preferredTypes.find((t) => (window as any).MediaRecorder?.isTypeSupported?.(t)) || undefined;
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);

      const meta = getActiveSegmentMeta();
      if (!meta) {
        stream.getTracks().forEach((t) => t.stop());
        throw new Error('Could not determine which question to record.');
      }

      activeAudioKeyRef.current = meta.key;
      activeAudioStartRef.current = Date.now();

      audioChunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          audioChunksRef.current.push(e.data);
        }
      };

      // Start speech analysis in parallel for text-based evaluation
      if (speechAnalysis.isSupported) {
        await speechAnalysis.start(stream);
      }

      // IMPORTANT: no timeslice
      recorder.start();
      mediaRecorderRef.current = recorder;
      setIsRecording(true);

      // Update part recording start time
      const part = currentPartRef.current;
      setRecordings((prev) => ({
        ...prev,
        [part]: {
          ...prev[part],
          startTime: Date.now(),
        },
      }));
    } catch (err) {
      console.error('Recording error:', err);
      toast({
        title: 'Microphone Error',
        description: 'Could not access microphone',
        variant: 'destructive',
      });
    }
  };

  const stopRecording = () => {
    const recorder = mediaRecorderRef.current;

    const meta = getActiveSegmentMeta();
    const key = activeAudioKeyRef.current ?? meta?.key;
    if (!recorder || !key || !meta) {
      setIsRecording(false);
      return;
    }

    // Stop speech analysis and capture results
    if (speechAnalysis.isAnalyzing) {
      const analysis = speechAnalysis.stop();
      if (analysis && key) {
        console.log(`[SpeakingTest] Speech analysis for ${key}:`, {
          rawTranscript: analysis.rawTranscript.slice(0, 100),
          wordCount: analysis.wordConfidences.length,
          fluencyScore: analysis.fluencyMetrics.overallFluencyScore,
          clarityScore: analysis.overallClarityScore,
        });
        setSegmentAnalyses(prev => ({
          ...prev,
          [key]: analysis,
        }));
        setCurrentAnalysis(analysis);
        // Show instant feedback for a few seconds
        setShowInstantFeedback(true);
        setTimeout(() => setShowInstantFeedback(false), 5000);
      }
    }

    // Save after MediaRecorder flushes the final dataavailable event.
    pendingStopMetaRef.current = {
      key,
      meta,
      startMs: activeAudioStartRef.current,
    };

    recorder.onstop = () => {
      try {
        const pending = pendingStopMetaRef.current;
        if (!pending) return;

        const duration = Math.max(0, (Date.now() - pending.startMs) / 1000);

        setAudioSegments((prev) => ({
          ...prev,
          [pending.key]: {
            ...pending.meta,
            chunks: [...audioChunksRef.current],
            duration,
          },
        }));
      } finally {
        pendingStopMetaRef.current = null;
      }
    };

    if (recorder.state === 'recording') {
      recorder.stop();
      recorder.stream.getTracks().forEach((t) => t.stop());
    }

    setIsRecording(false);
  };

  // Restart recording for the current question - clears chunks and restarts
  const restartRecording = async () => {
    const currentPhase = phaseRef.current;
    const resetSeconds =
      currentPhase === 'part1_recording'
        ? TIMING.PART1_QUESTION
        : currentPhase === 'part2_recording'
          ? TIMING.PART2_SPEAK
          : currentPhase === 'part3_recording'
            ? TIMING.PART3_QUESTION
            : null;

    // Stop current recording if active
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state === 'recording') {
      recorder.stop();
      recorder.stream.getTracks().forEach((t) => t.stop());
    }

    // Clear current chunks
    audioChunksRef.current = [];

    // Clear the audio segment for the current question
    const meta = getActiveSegmentMeta();
    if (meta?.key) {
      setAudioSegments((prev) => {
        const next = { ...prev };
        delete next[meta.key];
        return next;
      });
    }

    setIsRecording(false);

    // Reset the countdown back to the full time for this question
    if (resetSeconds != null) {
      setTimeLeft(resetSeconds);
      if (currentPhase === 'part2_recording') {
        part2SpeakStartRef.current = Date.now();
      }
    }

    // Small delay then restart
    await new Promise((resolve) => setTimeout(resolve, 200));
    await startRecording();

    toast({
      title: 'Recording Restarted',
      description: 'Your previous recording has been cleared.',
    });
  };

  // Play pre-recorded audio URL with fallback to TTS
  // Includes retry logic with .mp3 -> .wav format fallback
  // IMPORTANT: must never re-trigger TTS for the same prompt (no loops)
  const playPresetAudio = (audioKey: string, text: string, sessionId: string): boolean => {
    // First check test.audioUrls (for preset question audio)
    let originalUrl = audioUrls[audioKey];
    
    // For presets, also check shared audio (for instruction/transition keys)
    if (!originalUrl && test?.isPreset && sharedAudio[audioKey]?.audio_url) {
      originalUrl = sharedAudio[audioKey].audio_url;
      console.log(`[playPresetAudio] Using shared audio URL for key: ${audioKey}`);
    }
    
    if (!originalUrl) {
      console.warn(
        `[playPresetAudio] No URL found for key: ${audioKey}, available keys:`,
        Object.keys(audioUrls)
      );
      return false;
    }

    // Check for preloaded URL first (instant playback, works offline)
    const preloadedUrl = getPreloadedUrl(originalUrl);

    // If we are offline and do NOT have a preloaded URL, do not wait/retry — speak once via TTS.
    if (!isOnline && !preloadedUrl) {
      // Only trigger fallback once for this session
      if (ttsFallbackSessionRef.current !== sessionId) {
        ttsFallbackSessionRef.current = sessionId;
        clearPromptTimers();
        setUsingDeviceAudio(true);
        setCurrentSpeakingText(text);

        if (!isMutedRef.current) {
          tts.speak(text);
        } else {
          const attemptToken = ++presetAudioAttemptRef.current;
          presetAudioTimersRef.current.simulatedEnd = window.setTimeout(() => {
            if (
              activeSpeakSessionRef.current === sessionId &&
              presetAudioAttemptRef.current === attemptToken
            ) {
              setCurrentSpeakingText('');
              handleTTSCompleteRef.current();
            }
          }, Math.max(2000, text.length * 50));
        }
      }
      return true;
    }

    // URL normalization helpers (prefer .mp3, fallback to .wav)
    const normalizeToMp3 = (u: string) => (u.endsWith('.wav') ? u.replace(/\.wav$/, '.mp3') : u);
    const getAlternativeUrl = (u: string) => {
      if (u.endsWith('.mp3')) return u.replace(/\.mp3$/, '.wav');
      if (u.endsWith('.wav')) return u.replace(/\.wav$/, '.mp3');
      return null;
    };

    // Use preloaded URL if available, otherwise normalize the original
    const primaryUrl = preloadedUrl || normalizeToMp3(originalUrl);
    const fallbackUrl = preloadedUrl ? null : getAlternativeUrl(normalizeToMp3(originalUrl)); // No fallback if using preloaded

    const TOTAL_BUDGET_MS = 2000; // total wait before falling back to device TTS
    const startedAt = Date.now();
    const TIMEOUT_MS = 2000;

    // Attempt token: invalidated whenever we call stopPromptAudio()
    const attemptToken = ++presetAudioAttemptRef.current;

    // Within this attemptToken, we also guard against stale Audio instances
    let playInstanceId = 0;

    const isActive = () =>
      activeSpeakSessionRef.current === sessionId && presetAudioAttemptRef.current === attemptToken;

    const stopCurrentAudio = () => {
      if (!presetAudioRef.current) return;
      try {
        presetAudioRef.current.onended = null;
        presetAudioRef.current.onerror = null;
        presetAudioRef.current.onloadeddata = null;
        presetAudioRef.current.onloadedmetadata = null;
        presetAudioRef.current.pause();
        presetAudioRef.current.src = '';
      } catch {
        // ignore
      }
      presetAudioRef.current = null;
    };

    const triggerTTSFallback = () => {
      if (!isActive()) return;

      // Never restart TTS for the same prompt
      if (ttsFallbackSessionRef.current === sessionId) return;
      ttsFallbackSessionRef.current = sessionId;

      clearPromptTimers();
      stopCurrentAudio();

      console.warn(`[playPresetAudio] Falling back to browser TTS for: ${audioKey}`);
      setUsingDeviceAudio(true);
      setCurrentSpeakingText(text);

      if (!isMutedRef.current) {
        tts.speak(text);
      } else {
        presetAudioTimersRef.current.simulatedEnd = window.setTimeout(() => {
          if (isActive()) {
            setCurrentSpeakingText('');
            handleTTSCompleteRef.current();
          }
        }, Math.max(2000, text.length * 50));
      }
    };

    const attemptPlay = (url: string, attempt: number, isFallback: boolean) => {
      if (!isActive()) return;
      if (ttsFallbackSessionRef.current === sessionId) return;

      const elapsed = Date.now() - startedAt;
      const remainingBudget = TOTAL_BUDGET_MS - elapsed;
      if (remainingBudget <= 0) {
        triggerTTSFallback();
        return;
      }

      const myInstanceId = ++playInstanceId;

      // New attempt instance: clear timers + stop prior audio instance
      clearPromptTimers();
      stopCurrentAudio();

      console.log(`[playPresetAudio] Attempt ${attempt}, fallback: ${isFallback}, URL: ${url}`);

      const audio = new Audio(url);
      audio.crossOrigin = 'anonymous';
      audio.volume = volumeRef.current;
      audio.muted = isMutedRef.current;
      presetAudioRef.current = audio;
      setCurrentSpeakingText(text);

      // Single budgeted timeout (total budget across attempts)
      presetAudioTimersRef.current.load = window.setTimeout(() => {
        if (!isActive() || myInstanceId !== playInstanceId) return;
        if (ttsFallbackSessionRef.current === sessionId) return;

        console.warn(`[playPresetAudio] Load timeout (${TOTAL_BUDGET_MS}ms total budget) - falling back to TTS`);
        try {
          audio.src = '';
        } catch {
          // ignore
        }
        triggerTTSFallback();
      }, Math.min(TIMEOUT_MS, Math.max(100, remainingBudget)));

      audio.onloadeddata = () => {
        if (!isActive() || myInstanceId !== playInstanceId) return;
        if (presetAudioTimersRef.current.load) {
          window.clearTimeout(presetAudioTimersRef.current.load);
          presetAudioTimersRef.current.load = undefined;
        }
      };

      audio.onended = () => {
        if (!isActive() || myInstanceId !== playInstanceId) return;
        clearPromptTimers();
        presetAudioRef.current = null;
        setCurrentSpeakingText('');
        handleTTSCompleteRef.current();
      };

      audio.onerror = (e) => {
        if (!isActive() || myInstanceId !== playInstanceId) return;
        if (ttsFallbackSessionRef.current === sessionId) return;

        console.warn(`[playPresetAudio] Load error (attempt ${attempt}, fallback: ${isFallback}):`, e);
        if (presetAudioTimersRef.current.load) {
          window.clearTimeout(presetAudioTimersRef.current.load);
          presetAudioTimersRef.current.load = undefined;
        }

        // If we fail quickly on the primary format, try the alternate format once (no extra waiting).
        const budgetLeft = TOTAL_BUDGET_MS - (Date.now() - startedAt);
        if (!isFallback && fallbackUrl && budgetLeft > 250) {
          console.log(`[playPresetAudio] Trying fallback format (within budget): ${fallbackUrl}`);
          attemptPlay(fallbackUrl, 1, true);
          return;
        }

        triggerTTSFallback();
      };

      if (!isMutedRef.current) {
        audio.play().catch((err) => {
          if (!isActive() || myInstanceId !== playInstanceId) return;
          console.error('[playPresetAudio] Play failed:', err);
          triggerTTSFallback();
        });
      } else {
        // Muted mode - simulate audio duration
        clearPromptTimers();
        presetAudioTimersRef.current.simulatedEnd = window.setTimeout(() => {
          if (!isActive() || myInstanceId !== playInstanceId) return;
          presetAudioRef.current = null;
          setCurrentSpeakingText('');
          handleTTSCompleteRef.current();
        }, Math.max(2000, text.length * 50));
      }
    };

    attemptPlay(primaryUrl, 1, false);
    return true;
  };

  // Helper to get audio key for question
  const getQuestionAudioKey = (partNum: number, qIdx: number): string => {
    return `part${partNum}_q${qIdx + 1}`;
  };

  // Shared audio keys for instructions/transitions (used by presets)
  // These keys match the speaking_shared_audio table exactly
  const SHARED_AUDIO_KEYS = new Set([
    'part1_intro', 'part1_ending',
    'part2_intro', 'part2_prep_start', 'part2_prep_end', 'part2_ending',
    'part3_intro', 'part3_ending',
    'test_ending'
  ]);

  const speakText = (rawText: unknown, audioKey?: string) => {
    // Stop anything currently happening (audio, TTS, retries) before starting a new prompt.
    stopPromptAudio();

    // Generate a unique session ID to track this speak request
    const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    activeSpeakSessionRef.current = sessionId;
    ttsFallbackSessionRef.current = null;

    // Always coerce to a safe string (fresh-generated tests sometimes have null/undefined instructions)
    let text = typeof rawText === 'string' ? rawText : '';

    // For PRESET tests: check if this is an instruction key and use shared audio
    if (test?.isPreset && sharedAudioFetched && audioKey && SHARED_AUDIO_KEYS.has(audioKey)) {
      const sharedItem = getSharedAudioItem(audioKey);
      if (sharedItem.audio_url) {
        console.log(`[AIPracticeSpeakingTest] Using shared audio for: ${audioKey}`);
        if (playPresetAudio(audioKey, sharedItem.fallback_text, sessionId)) {
          return;
        }
      } else if (sharedItem.fallback_text) {
        // Use fallback text from shared audio system
        text = sharedItem.fallback_text;
      }
    }

    // For NON-PRESET tests (fresh generation with TTS): use fallback text for shared audio keys
    // This ensures Part 2 intros etc. work even if the AI didn't generate an instruction
    if (!test?.isPreset && audioKey && SHARED_AUDIO_KEYS.has(audioKey)) {
      const sharedItem = getSharedAudioItem(audioKey);
      // Only use fallback if original text is empty/whitespace
      if ((!text || !text.trim()) && sharedItem.fallback_text) {
        console.log(`[AIPracticeSpeakingTest] Using fallback text for TTS (empty instruction): ${audioKey}`);
        text = sharedItem.fallback_text;
      }
    }

    // If we STILL don't have any text, do not call browser TTS (it won't fire onEnd for empty strings).
    // Instead, auto-advance the state machine so the test doesn't get stuck.
    if (!text || !text.trim()) {
      console.warn(`[AIPracticeSpeakingTest] Empty prompt for ${audioKey ?? 'unknown'} - auto-advancing`);
      setCurrentSpeakingText('');
      setUsingDeviceAudio(false);
      window.setTimeout(() => {
        if (activeSpeakSessionRef.current === sessionId) {
          handleTTSCompleteRef.current();
        }
      }, 0);
      return;
    }

    // Try to play preset audio (from test.audioUrls) for question audio
    if (audioKey && Object.keys(audioUrls).length > 0) {
      if (playPresetAudio(audioKey, text, sessionId)) {
        return;
      }
    }

    // Fall back to browser TTS (single-shot)
    setUsingDeviceAudio(true);
    setCurrentSpeakingText(text);

    if (isMutedRef.current) {
      const attemptToken = ++presetAudioAttemptRef.current;
      presetAudioTimersRef.current.simulatedEnd = window.setTimeout(() => {
        if (
          activeSpeakSessionRef.current === sessionId &&
          presetAudioAttemptRef.current === attemptToken
        ) {
          setCurrentSpeakingText('');
          handleTTSCompleteRef.current();
        }
      }, Math.max(2000, text.length * 50));
    } else {
      tts.speak(text);
    }
  };

  const endTest = () => {
    setTimeLeft(0);
    setPhase('ending');
    speakText('Thank you. That is the end of the speaking test.', 'test_ending');
    
    // Safety timeout: if TTS/audio fails and completion callback never fires,
    // auto-submit after 10 seconds to prevent getting stuck in 'ending' phase
    const safetyTimeout = window.setTimeout(() => {
      if (phaseRef.current === 'ending' && isMountedRef.current && !exitRequestedRef.current) {
        console.warn('[AIPracticeSpeakingTest] Safety timeout triggered - submitting test after audio failure');
        submitTest();
      }
    }, 10000);
    
    // Store timeout ID so it can be cleared if normal completion happens
    presetAudioTimersRef.current.endingSafety = safetyTimeout;
  };

  // Legacy per-part evaluation (deprecated).
  // The async speaking flow should make ONE call (evaluate-speaking-async) after upload.
  // Keeping this as a no-op prevents accidental extra Gemini calls + 500 spam.
  const evaluatePartInBackground = useCallback(async (_partNum: 1 | 2 | 3) => {
    return;
  }, []);


  const submitTest = async () => {
    if (exitRequestedRef.current || !isMountedRef.current) return;

    // Clear safety timer to prevent double submission
    if (presetAudioTimersRef.current.endingSafety) {
      window.clearTimeout(presetAudioTimersRef.current.endingSafety);
      presetAudioTimersRef.current.endingSafety = undefined;
    }

    setPhase('submitting');
    setEvaluationStep(0);
    setFailedUploads([]); // Reset failed uploads on new submission attempt
    setSubmissionProgress({ step: 'Preparing', detail: 'Getting ready to process your recordings...', currentItem: 0, totalItems: 0 });

    try {
      const segments = audioSegmentsRef.current;
      const keys = Object.keys(segments);

      if (!keys.length) {
        toast({
          title: 'No Recording Found',
          description: 'No audio was recorded. Please try again.',
          variant: 'destructive',
        });
        setPhase('done');
        return;
      }

      // Get user ID
      setSubmissionProgress({ step: 'Authenticating', detail: 'Verifying your session...', currentItem: 0, totalItems: 0 });
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('User not authenticated');

      setEvaluationStep(1);
      const totalAudioFiles = keys.length;
      setSubmissionProgress({ step: 'Converting Audio', detail: `Preparing ${totalAudioFiles} audio files for upload...`, currentItem: 0, totalItems: totalAudioFiles });
      console.log('[AIPracticeSpeakingTest] Step 1: Uploading audio files to R2...');

      // STEP 1: Upload all audio files to R2
      const filePaths: Record<string, string> = {};
      const durations: Record<string, number> = {};
      const uploadErrors: Array<{ key: string; error: string }> = [];

      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        if (exitRequestedRef.current || !isMountedRef.current) return;

        const seg = segments[key];
        const inferredType = seg.chunks?.[0]?.type || 'audio/webm';
        const blob = new Blob(seg.chunks, { type: inferredType });
        durations[key] = seg.duration;

        if (blob.size === 0) continue;

        // Update progress: Converting audio
        setSubmissionProgress({ 
          step: 'Converting Audio', 
          detail: `Converting recording ${i + 1} of ${totalAudioFiles} to MP3...`, 
          currentItem: i + 1, 
          totalItems: totalAudioFiles 
        });

        // Convert to MP3 for compatibility
        let mp3Blob: Blob;
        try {
          mp3Blob = await toMp3DataUrl(blob, key).then(async (dataUrl) => {
            const response = await fetch(dataUrl);
            return response.blob();
          });
        } catch (convErr) {
          console.error(`[AIPracticeSpeakingTest] Conversion error for ${key}:`, convErr);
          uploadErrors.push({ key, error: 'Audio conversion failed' });
          continue;
        }

        // Update progress: Uploading audio
        setSubmissionProgress({ 
          step: 'Uploading Audio', 
          detail: `Uploading recording ${i + 1} of ${totalAudioFiles}...`, 
          currentItem: i + 1, 
          totalItems: totalAudioFiles 
        });

        try {
          const { data: uploadResult, error: uploadError } = await supabase.functions.invoke('upload-speaking-audio', {
            body: {
              testId,
              partNumber: seg.partNumber,
              audioData: { [key]: await blobToDataUrl(mp3Blob) },
            },
          });

          if (uploadError) {
            console.error(`[AIPracticeSpeakingTest] Upload error for ${key}:`, uploadError);
            uploadErrors.push({ key, error: uploadError.message || 'Upload failed' });
            continue;
          }

          if (uploadResult?.uploadedUrls?.[key]) {
            const uploadedUrl = uploadResult.uploadedUrls[key];
            // Extract R2 path from URL
            const urlParts = uploadedUrl.split('/');
            const r2Key = urlParts.slice(3).join('/');
            filePaths[key] = r2Key;
            console.log(`[AIPracticeSpeakingTest] Uploaded ${key} -> ${r2Key}`);
          } else {
            uploadErrors.push({ key, error: 'Upload returned no URL' });
          }
        } catch (uploadErr) {
          console.error(`[AIPracticeSpeakingTest] Upload error for ${key}:`, uploadErr);
          uploadErrors.push({ key, error: uploadErr instanceof Error ? uploadErr.message : 'Upload failed' });
        }
      }

      // Track failed uploads for retry UI
      if (uploadErrors.length > 0) {
        setFailedUploads(uploadErrors);
        
        // If ALL uploads failed, show error state with retry
        if (Object.keys(filePaths).length === 0) {
          setSubmissionProgress({ 
            step: 'Upload Failed', 
            detail: `All ${uploadErrors.length} uploads failed. Click retry to try again.`, 
            currentItem: 0, 
            totalItems: uploadErrors.length 
          });
          throw new Error(`All audio uploads failed: ${uploadErrors.map(e => e.key).join(', ')}`);
        }
        
        // Some uploads failed - show warning but continue with what we have
        setSubmissionProgress({ 
          step: 'Partial Upload', 
          detail: `${Object.keys(filePaths).length} of ${totalAudioFiles} recordings uploaded. ${uploadErrors.length} failed.`, 
          currentItem: Object.keys(filePaths).length, 
          totalItems: totalAudioFiles 
        });
        console.warn(`[AIPracticeSpeakingTest] ${uploadErrors.length} uploads failed, continuing with ${Object.keys(filePaths).length} files`);
      } else {
        // All uploads successful
        setSubmissionProgress({ 
          step: 'Upload Complete', 
          detail: `All ${totalAudioFiles} recordings uploaded successfully!`, 
          currentItem: totalAudioFiles, 
          totalItems: totalAudioFiles 
        });
      }

      setEvaluationStep(2);
      setSubmissionProgress({ 
        step: 'Queuing Evaluation', 
        detail: 'Sending recordings to AI for analysis...', 
        currentItem: 0, 
        totalItems: 0 
      });
      console.log(`[AIPracticeSpeakingTest] Step 2: Calling ASYNC evaluation (${Object.keys(filePaths).length} files)...`);

      // Calculate Part 2 fluency flag
      const part2Duration = Object.entries(segments)
        .filter(([, s]) => s.partNumber === 2)
        .reduce((acc, [, s]) => acc + (s.duration || 0), 0);
      const fluencyFlag = part2Duration > 0 && part2Duration < PART2_MIN_SPEAKING;

      // Build transcript data from speech analysis for text-based evaluation
      const transcriptData: Record<string, unknown> = {};
      for (const [key, analysis] of Object.entries(segmentAnalyses)) {
        transcriptData[key] = {
          rawTranscript: analysis.rawTranscript,
          cleanedTranscript: analysis.cleanedTranscript,
          wordConfidences: analysis.wordConfidences,
          fluencyMetrics: analysis.fluencyMetrics,
          prosodyMetrics: {
            pitchVariation: analysis.prosodyMetrics.pitchVariation,
            stressEventCount: analysis.prosodyMetrics.stressEventCount,
            rhythmConsistency: analysis.prosodyMetrics.rhythmConsistency,
          },
          durationMs: analysis.durationMs,
          overallClarityScore: analysis.overallClarityScore,
        };
      }

      // STEP 2: Call ASYNC evaluation - returns immediately with 202
      // Include transcript data for text-based evaluation (much cheaper than audio)
      const { data, error } = await supabase.functions.invoke('evaluate-speaking-async', {
        body: {
          testId,
          filePaths,
          durations,
          topic: test?.topic,
          difficulty: test?.difficulty,
          fluencyFlag,
          // Include text-based analysis data for cheaper evaluation
          transcripts: Object.keys(transcriptData).length > 0 ? transcriptData : undefined,
        },
      });

      if (exitRequestedRef.current || !isMountedRef.current) return;

      if (error) {
        console.error('[AIPracticeSpeakingTest] Async evaluation error:', error);
        throw new Error(error.message || 'Submission failed');
      }

      // Async route returns jobId - evaluation happens in background
      if (data?.jobId || data?.success) {
        console.log('[AIPracticeSpeakingTest] Evaluation job queued:', data.jobId || 'preset');
        setEvaluationStep(3);
        setSubmissionProgress({ 
          step: 'Submitted!', 
          detail: 'Your test is now being evaluated by AI. Check your history for results.', 
          currentItem: 0, 
          totalItems: 0 
        });

        // Delete persisted audio (uploaded successfully)
        if (testId) await deleteAudioSegments(testId);

        // Track topic completion
        if (test?.topic) incrementCompletion(test.topic);

        // Show success toast - evaluation is processing in background
        toast({
          title: 'Test Submitted!',
          description: 'Your speaking test is being evaluated. Check your history for results.',
        });

        setPhase('done');

        // Navigate to history page - results will appear when ready
        if (!exitRequestedRef.current && isMountedRef.current) {
          await exitFullscreen();
          navigate('/ai-practice/history');
        }
      } else if (data?.error) {
        throw new Error(data.error);
      } else {
        throw new Error('Unexpected response from evaluation');
      }

    } catch (err: any) {
      console.error('[AIPracticeSpeakingTest] Submission error:', err);

      const errDesc = describeApiError(err);

      // Persist audio for retry
      const segments = audioSegmentsRef.current;
      if (testId && Object.keys(segments).length > 0) {
        await saveAllAudioSegments(testId, segments);
        console.log('[AIPracticeSpeakingTest] Audio persisted for retry');
      }

      if (isMountedRef.current) {
        setSubmissionError(errDesc);
        setPhase('submission_error');
        setIsResubmitting(false);

        toast({
          title: errDesc.title,
          description: 'Your recordings are preserved. You can try again.',
          variant: 'destructive',
        });
      }
    }
  };

  // Resubmit handler
  const handleResubmit = async () => {
    setIsResubmitting(true);
    setSubmissionError(null);
    await submitTest();
  };


  const startPart3 = () => {
    setCurrentPart(3);
    setQuestionIndex(0);
    const part3 = speakingPartsRef.current.part3;
    
    if (part3) {
      setPhase('part3_intro');
      // Use shared audio key for Part 3 intro (presets use pre-recorded audio)
      speakText(part3.instruction, 'part3_intro');
    } else {
      endTest();
    }
  };

  const transitionToPart3 = () => {
    setPhase('part2_transition');

    // Trigger background evaluation for Part 2
    evaluatePartInBackground(2);
    
    // Prefetch Part 3 audio while transitioning
    prefetchPartAudio(3);

    if (speakingPartsRef.current.part3) {
      // Use shared audio key for Part 2 ending (presets use pre-recorded audio)
      speakText("Thank you. That is the end of Part 2. Now we will move on to Part 3.", 'part2_ending');
    } else {
      endTest();
    }
  };

  const transitionAfterPart1 = () => {
    const parts = speakingPartsRef.current;

    // Trigger background evaluation for Part 1
    evaluatePartInBackground(1);

    if (parts.part2) {
      setPhase('part1_transition');
      // Prefetch Part 2 audio while transitioning
      prefetchPartAudio(2);
      // Use shared audio key for Part 1 ending (presets use pre-recorded audio)
      speakText("Thank you. That is the end of Part 1. Now we will move on to Part 2.", 'part1_ending');
      return;
    }

    if (parts.part3) {
      setPhase('part1_transition');
      // Prefetch Part 3 audio while transitioning  
      prefetchPartAudio(3);
      speakText("Thank you. That is the end of Part 1. Now we will move on to Part 3.", 'part1_ending');
      return;
    }

    endTest();
  };

  const startPart2 = () => {
    setCurrentPart(2);
    setQuestionIndex(0);
    const part2 = speakingPartsRef.current.part2;
    
    if (part2) {
      setPhase('part2_intro');
      // Use shared audio key for Part 2 intro (presets use pre-recorded audio)
      speakText(part2.instruction, 'part2_intro');
    } else if (speakingPartsRef.current.part3) {
      startPart3();
    } else {
      endTest();
    }
  };

  const startPart2Speaking = () => {
    // User clicked to start speaking early.
    // STOP any currently playing audio first
    stopPromptAudio();
    
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    setTimeLeft(0);

    // Start recording immediately instead of playing audio again
    setPhase('part2_recording');
    part2SpeakStartRef.current = Date.now();
    startRecording();
    // Set timeLeft AFTER starting recording to ensure timer effect triggers
    setTimeout(() => setTimeLeft(TIMING.PART2_SPEAK), 0);
  };

  // Handle stopping recording early and moving to next question/part
  const handleStopAndNext = () => {
    const currentPhase = phaseRef.current;
    const parts = speakingPartsRef.current;
    const qIdx = questionIndexRef.current;

    // Clear any running timer
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setTimeLeft(0);

    if (currentPhase === 'part1_recording') {
      stopRecording();
      const part1 = parts.part1;
      const nextIdx = qIdx + 1;
      
      if (part1?.questions && nextIdx < part1.questions.length) {
        setQuestionIndex(nextIdx);
        setPhase('part1_question');
        speakText(part1.questions[nextIdx].question_text, getQuestionAudioKey(1, nextIdx));
      } else {
        transitionAfterPart1();
      }
    } else if (currentPhase === 'part2_recording') {
      stopRecording();
      const duration = (Date.now() - part2SpeakStartRef.current) / 1000;
      setRecordings((prev) => ({
        ...prev,
        2: { ...prev[2], duration },
      }));
      transitionToPart3();
    } else if (currentPhase === 'part3_recording') {
      stopRecording();
      const part3 = parts.part3;
      const nextIdx = qIdx + 1;
      
      if (part3?.questions && nextIdx < part3.questions.length) {
        setQuestionIndex(nextIdx);
        setPhase('part3_question');
        speakText(part3.questions[nextIdx].question_text, getQuestionAudioKey(3, nextIdx));
      } else {
        endTest();
      }
    }
  };

  // Handle TTS completion - update ref with latest function
  handleTTSCompleteRef.current = () => {
    if (exitRequestedRef.current || !isMountedRef.current || showExitDialog) return;

    const currentPhase = phaseRef.current;
    const parts = speakingPartsRef.current;

    if (currentPhase === 'part1_intro') {
      // Start first Part 1 question
      const part1 = parts.part1;
      if (part1?.questions?.[0]) {
        setPhase('part1_question');
        speakText(part1.questions[0].question_text, getQuestionAudioKey(1, 0));
      }
    } else if (currentPhase === 'part1_question') {
      // Start recording for Part 1
      setPhase('part1_recording');
      setTimeLeft(TIMING.PART1_QUESTION);
      startRecording();
    } else if (currentPhase === 'part1_transition') {
      // Start the next part after Part 1 (based on which parts exist)
      if (parts.part2) {
        startPart2();
      } else if (parts.part3) {
        startPart3();
      } else {
        endTest();
      }
    } else if (currentPhase === 'part2_intro') {
      // After part2_intro audio ends, play part2_prep_start ("Here is your topic")
      // Set phase to part2_prep_reveal so we know what to do after prep_start audio ends
      setPhase('part2_prep_reveal');
      // Play part2_prep_start audio - uses shared audio for presets, browser TTS for fresh generation
      speakText("Here is your topic. You have one minute to prepare.", 'part2_prep_start');
    } else if (currentPhase === 'part2_prep_reveal') {
      // After part2_prep_start audio ends, show cue card and start 1-minute prep timer
      setPhase('part2_prep');
      setTimeLeft(TIMING.PART2_PREP);
    } else if (currentPhase === 'part2_prep') {
      // Start Part 2 recording after TTS completes (either prep-over or early start message)
      setPhase('part2_recording');
      part2SpeakStartRef.current = Date.now();
      startRecording();
      // Set timeLeft AFTER starting recording to ensure timer effect triggers
      setTimeout(() => setTimeLeft(TIMING.PART2_SPEAK), 0);
    } else if (currentPhase === 'part2_transition') {
      // Start Part 3 if it exists, otherwise end.
      if (parts.part3) {
        startPart3();
      } else {
        endTest();
      }
    } else if (currentPhase === 'part3_intro') {
      // Start first Part 3 question
      const part3 = parts.part3;
      if (part3?.questions?.[0]) {
        setPhase('part3_question');
        speakText(part3.questions[0].question_text, getQuestionAudioKey(3, 0));
      }
    } else if (currentPhase === 'part3_question') {
      // Start recording for Part 3
      setPhase('part3_recording');
      setTimeLeft(TIMING.PART3_QUESTION);
      startRecording();
    } else if (currentPhase === 'ending') {
      submitTest();
    }
  };

  // Handle timer completion
  const handleTimerComplete = () => {
    if (exitRequestedRef.current || !isMountedRef.current || showExitDialog) return;

    const currentPhase = phaseRef.current;
    const parts = speakingPartsRef.current;
    const qIdx = questionIndexRef.current;

    if (currentPhase === 'part1_recording') {
      stopRecording();
      const part1 = parts.part1;
      const nextIdx = qIdx + 1;

      if (part1?.questions && nextIdx < part1.questions.length) {
        setQuestionIndex(nextIdx);
        setPhase('part1_question');
        speakText(part1.questions[nextIdx].question_text, getQuestionAudioKey(1, nextIdx));
      } else {
        transitionAfterPart1();
      }
    } else if (currentPhase === 'part2_prep') {
      // Start Part 2 recording - use shared audio key for prep end (presets use pre-recorded audio)
      speakText("Your one minute preparation time is over. Please start speaking now. You have two minutes.", 'part2_prep_end');
    } else if (currentPhase === 'part2_recording') {
      stopRecording();
      const duration = (Date.now() - part2SpeakStartRef.current) / 1000;
      setRecordings((prev) => ({
        ...prev,
        2: { ...prev[2], duration },
      }));
      transitionToPart3();
    } else if (currentPhase === 'part3_recording') {
      stopRecording();
      const part3 = parts.part3;
      const nextIdx = qIdx + 1;

      if (part3?.questions && nextIdx < part3.questions.length) {
        setQuestionIndex(nextIdx);
        setPhase('part3_question');
        speakText(part3.questions[nextIdx].question_text, getQuestionAudioKey(3, nextIdx));
      } else {
        endTest();
      }
    }
  };

  // Fetch shared audio for presets (instructions, transitions, endings)
  // This runs when test loads and is a preset
  useEffect(() => {
    if (!test?.isPreset) {
      // For non-preset (fresh generation), skip fetching and mark as fetched
      setSharedAudioFetched(true);
      return;
    }

    async function fetchSharedAudio() {
      try {
        console.log('[AIPracticeSpeakingTest] Fetching shared audio for preset test...');
        const { data, error } = await supabase
          .from('speaking_shared_audio')
          .select('audio_key, audio_url, fallback_text');

        if (error) {
          console.warn('[AIPracticeSpeakingTest] Error fetching shared audio:', error);
          setSharedAudioFetched(true);
          return;
        }

        const audioMap: Record<string, { audio_url: string | null; fallback_text: string }> = {};
        (data || []).forEach((row) => {
          audioMap[row.audio_key] = {
            audio_url: row.audio_url,
            fallback_text: row.fallback_text,
          };
        });

        console.log('[AIPracticeSpeakingTest] Loaded shared audio keys:', Object.keys(audioMap));
        setSharedAudio(audioMap);
        
        // Preload shared audio URLs
        const urlsToPreload = Object.values(audioMap)
          .map(item => item.audio_url)
          .filter((url): url is string => !!url);
        if (urlsToPreload.length > 0) {
          console.log(`[AIPracticeSpeakingTest] Preloading ${urlsToPreload.length} shared audio files...`);
          preloadMultiple(urlsToPreload);
        }
      } catch (err) {
        console.warn('[AIPracticeSpeakingTest] Failed to fetch shared audio:', err);
      } finally {
        setSharedAudioFetched(true);
      }
    }

    fetchSharedAudio();
  }, [test?.isPreset, preloadMultiple]);

  // Helper to get shared audio item (with fallback texts)
  const getSharedAudioItem = useCallback((key: string): { audio_url: string | null; fallback_text: string } => {
    if (sharedAudio[key]) {
      return sharedAudio[key];
    }
    // Fallback texts if shared audio not loaded
    const fallbacks: Record<string, string> = {
      'part1_intro': "Welcome to the IELTS Speaking Test. This is Part 1. I'm going to ask you some questions about yourself and familiar topics. Let's begin.",
      'part1_ending': "Thank you. That is the end of Part 1.",
      'part2_intro': "Now, let's move on to Part 2. I'm going to give you a topic and I'd like you to talk about it for one to two minutes. Before you talk, you'll have one minute to think about what you're going to say. You can make some notes if you wish.",
      'part2_prep_start': "Here is your topic. You have one minute to prepare.",
      'part2_prep_end': "Your one minute preparation time is over. Please start speaking now. You have up to two minutes.",
      'part2_ending': "Thank you. That is the end of Part 2.",
      'part3_intro': "Now let's move on to Part 3. In this part, I'd like to discuss some more abstract questions related to the topic in Part 2.",
      'part3_ending': "Thank you. That is the end of Part 3.",
      'test_ending': "Thank you very much. That is the end of the speaking test.",
    };
    return { audio_url: null, fallback_text: fallbacks[key] || '' };
  }, [sharedAudio]);

  // Load test data and check for persisted audio
  useEffect(() => {
    async function loadTest() {
      if (!testId) {
        navigate('/ai-practice');
        return;
      }

      // Cleanup old audio on load
      cleanupOldAudio();

      const loadedTest = await loadGeneratedTestAsync(testId);
      if (!loadedTest) {
        toast({ title: 'Test Not Found', variant: 'destructive' });
        navigate('/ai-practice');
        return;
      }

      // Check for persisted audio from previous failed submission
      const persistedSegments = await loadAudioSegments(testId);
      if (persistedSegments.length > 0) {
        console.log(`[AIPracticeSpeakingTest] Found ${persistedSegments.length} persisted audio segments`);
        
        // Restore audio segments
        const restoredSegments: Record<string, AudioSegmentMeta> = {};
        for (const seg of persistedSegments) {
          const originalKey = seg.key.replace(`${testId}_`, '');
          restoredSegments[originalKey] = {
            key: originalKey,
            partNumber: seg.partNumber,
            questionId: seg.questionId,
            questionNumber: seg.questionNumber,
            questionText: seg.questionText,
            chunks: [seg.audioBlob],
            duration: seg.duration,
          };
        }
        setAudioSegments(restoredSegments);
        
        // Ask user if they want to resubmit
        toast({
          title: 'Previous Recording Found',
          description: 'Your previous recording was recovered. You can submit it or restart the test.',
        });
      }

      setTest(loadedTest);
      setLoading(false);
      setPhase('ready');
    }

    loadTest();
  }, [testId, navigate, toast]);

  // Cleanup all audio on unmount
  useEffect(() => {
    return () => {
      isMountedRef.current = false;

      // Stop prompt audio + cancel pending retries/timeouts
      stopPromptAudio();

      // Stop any active recording
      if (mediaRecorderRef.current?.state === 'recording') {
        mediaRecorderRef.current.stop();
        mediaRecorderRef.current.stream.getTracks().forEach((t) => t.stop());
      }

      // Clear timer
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  // Timer effect - use timeLeft and isPaused as dependencies
  useEffect(() => {
    // Clear any existing timer first
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    // Pause all countdown-driven transitions while the exit dialog is open (prevents background auto-submit)
    if (showExitDialog || exitRequestedRef.current) return;

    if (timeLeft <= 0 || isPaused) return;

    timerRef.current = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 1) {
          // Use setTimeout to call handleTimerComplete outside the setState
          setTimeout(() => handleTimerComplete(), 0);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [timeLeft, isPaused, showExitDialog]);

  // Pause/Resume toggle
  const togglePause = () => {
    if (isPaused) {
      // Resume
      setIsPaused(false);
      if (isMuted) return;
      // Resume TTS if it was speaking
      // Note: Browser TTS doesn't support resume, so we just continue
    } else {
      // Pause
      setIsPaused(true);
      tts.cancel(); // Stop TTS
    }
  };

  // Start test function
  const startTest = () => {
    // Prefetch all Part 1 audio when test starts
    
    // Prefetch all Part 1 audio when test starts
    prefetchPartAudio(1);
    
    // Determine which part to start with
    if (speakingParts.part1) {
      setCurrentPart(1);
      setPhase('part1_intro');
      // Use shared audio key for Part 1 intro (presets use pre-recorded audio)
      speakText(speakingParts.part1.instruction, 'part1_intro');
    } else if (speakingParts.part2) {
      prefetchPartAudio(2);
      startPart2();
    } else if (speakingParts.part3) {
      prefetchPartAudio(3);
      startPart3();
    }
  };

  // Format time display
  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  // Get current question
  const getCurrentQuestion = () => {
    if (currentPart === 1 && speakingParts.part1?.questions) {
      return speakingParts.part1.questions[questionIndex];
    }
    if (currentPart === 3 && speakingParts.part3?.questions) {
      return speakingParts.part3.questions[questionIndex];
    }
    return null;
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  // Show submission error state with resubmit option
  if (phase === 'submission_error' && submissionError) {
    return (
      <SubmissionErrorState
        error={submissionError}
        onResubmit={handleResubmit}
        isResubmitting={isResubmitting}
        testTopic={test?.topic}
      />
    );
  }

  // Show microphone test first (before anything else)
  // TestStartOverlay removed - mic test is the only entry point now
  if (showMicrophoneTest) {
    return (
      <div className="min-h-screen bg-secondary flex flex-col items-center justify-center gap-4">
        <MicrophoneTest 
          onTestComplete={() => {
            setShowMicrophoneTest(false);
            // Enter fullscreen mode automatically
            enterFullscreen();
            // Start test immediately after mic test passes
            startTest();
          }}
          onBack={() => navigate('/ai-practice')}
        />
        {/* Browser compatibility check for speech analysis */}
        <div className="max-w-md w-full px-4">
          <BrowserCompatibilityCheck />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Header */}
      <header className="border-b bg-card">
        <div className="container mx-auto px-2 md:px-4 py-2 md:py-3 flex items-center justify-between">
          <div className="flex items-center gap-1 md:gap-3">
            <Button 
              variant="ghost" 
              size="icon" 
              onClick={() => setShowExitDialog(true)}
              title="Exit Test"
              className="h-8 w-8 md:h-10 md:w-10"
            >
              <ArrowLeft className="w-4 h-4 md:w-5 md:h-5" />
            </Button>
            <ExitTestConfirmDialog
              open={showExitDialog}
              onOpenChange={setShowExitDialog}
              onConfirm={() => {
                // Mark exit immediately so no in-flight async work can navigate to results.
                exitRequestedRef.current = true;

                // Stop all audio/tts and cancel any pending retry timers before navigating
                stopPromptAudio();
                // Stop recording if active
                if (mediaRecorderRef.current?.state === 'recording') {
                  mediaRecorderRef.current.stop();
                  mediaRecorderRef.current.stream.getTracks().forEach(t => t.stop());
                }
                navigate('/ai-practice');
              }}
              testType="Speaking Test"
            />
            <Badge variant="outline" className="font-mono text-xs md:text-sm">
              Back
            </Badge>
            
            {/* Network status indicators */}
            {!isOnline && (
              <Badge variant="destructive" className="text-xs animate-pulse gap-1">
                <WifiOff className="w-3 h-3" />
                Offline
              </Badge>
            )}
            {usingDeviceAudio && (
              <Badge className="text-xs bg-amber-500/20 text-amber-600 border-amber-500/30 flex items-center gap-1">
                <Volume2 className="w-3 h-3" />
                Device Audio
              </Badge>
            )}
            
            <span className="text-xs md:text-sm text-muted-foreground hidden sm:inline truncate max-w-[120px] md:max-w-none">
              {test?.topic}
            </span>
          </div>
          
          <div className="flex items-center gap-1 md:gap-2">
            {/* Timer */}
            {timeLeft > 0 && (
              <div className={cn(
                "flex items-center gap-1 md:gap-2 px-2 md:px-3 py-1 rounded-full font-mono text-sm md:text-lg",
                isPaused ? "bg-warning/20 text-warning" :
                timeLeft <= 10 ? "bg-destructive/20 text-destructive animate-pulse" : "bg-muted"
              )}>
                <Clock className="w-3 h-3 md:w-4 md:h-4" />
                {formatTime(timeLeft)}
                {isPaused && <span className="text-xs ml-1 hidden sm:inline">(Paused)</span>}
              </div>
            )}
            
            {/* Central Pause/Resume button */}
            {(phase.includes('recording') || phase.includes('prep')) && (
              <Button
                variant={isPaused ? "default" : "outline"}
                size="sm"
                onClick={togglePause}
                className="gap-1 md:gap-2 h-8 px-2 md:px-3"
              >
                {isPaused ? (
                  <>
                    <Play className="w-3 h-3 md:w-4 md:h-4" />
                    <span className="hidden sm:inline">Resume</span>
                  </>
                ) : (
                  <>
                    <Pause className="w-3 h-3 md:w-4 md:h-4" />
                    <span className="hidden sm:inline">Pause</span>
                  </>
                )}
              </Button>
            )}
            
            {/* Volume control with mute button and waveform visualization */}
            <AudioVolumeControl
              volume={volume}
              setVolume={setVolume}
              isMuted={isMuted}
              setIsMuted={setIsMuted}
              audioRef={presetAudioRef}
              isPlaying={!!currentSpeakingText}
              onTTSVolumeChange={tts.setVolume}
              onTTSMutedChange={tts.setMuted}
            />
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="flex-1 container mx-auto px-3 md:px-4 py-4 md:py-8 max-w-3xl pb-24">
        {/* Current speaking text display */}
        {currentSpeakingText && (
          <Card className="mb-4 md:mb-6 border-primary/50 bg-primary/5">
            <CardContent className="p-3 md:p-4">
              <div className="flex items-start gap-2 md:gap-3">
                <Volume2 className="w-4 h-4 md:w-5 md:h-5 text-primary mt-1 animate-pulse flex-shrink-0" />
                <p className="text-base md:text-lg">{currentSpeakingText}</p>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Part 2 Cue Card */}
        {currentPart === 2 && (phase === 'part2_prep' || phase === 'part2_recording') && speakingParts.part2 && (
          <Card className="mb-4 md:mb-6">
            <CardContent className="p-4 md:p-6">
              {/* Cue card topic as main heading */}
              {(() => {
                // Get topic from cue_card_topic, or parse from questions if not available
                let topic = speakingParts.part2.cue_card_topic;
                let content = speakingParts.part2.cue_card_content;
                
                // If no separate topic/content, try to extract from first question
                if (!topic && !content && speakingParts.part2.questions?.[0]?.question_text) {
                  const questionText = speakingParts.part2.questions[0].question_text;
                  const lines = questionText.split('\n').map(l => l.trim()).filter(Boolean);
                  if (lines.length > 0) {
                    topic = lines[0];
                    content = lines.slice(1).join('\n');
                  }
                }
                
                if (!topic) {
                  topic = 'Part 2 Topic';
                }
                
                return (
                  <>
                    <h3 className="font-bold text-lg md:text-xl mb-3 md:mb-4">
                      {topic}
                    </h3>
                    {content && (
                      <ul className="space-y-2 text-sm md:text-base text-muted-foreground">
                        {content.split('\n').map(l => l.trim()).filter(Boolean).map((line, idx) => (
                          <li key={idx} className="flex items-start gap-2">
                            <span className="text-primary mt-1">•</span>
                            <span>{line.replace(/^[-•*]\s*/, '')}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                );
              })()}
            </CardContent>
          </Card>
        )}

        {/* Current Question Display - Only show during recording (not during question audio playback to avoid duplication) */}
        {phase.includes('recording') && getCurrentQuestion() && (
          <Card className="mb-4 md:mb-6">
            <CardContent className="p-4 md:p-6">
              <div className="flex items-center gap-2 mb-2 md:mb-3">
                <Badge className="text-xs md:text-sm">Question {getCurrentQuestion()?.question_number}</Badge>
              </div>
              <p className="text-base md:text-lg">{getCurrentQuestion()?.question_text}</p>
            </CardContent>
          </Card>
        )}

        {/* Recording indicator with Stop & Next and Restart buttons */}
        {isRecording && (
          <div className="flex flex-col items-center gap-3 md:gap-4 py-6 md:py-8">
            <div className="relative w-16 h-16 md:w-20 md:h-20">
              {/* Audio level indicator overlay */}
              <AudioLevelIndicator 
                stream={mediaRecorderRef.current?.stream || null}
                isActive={isRecording}
                variant="circle"
                className="absolute inset-0 w-full h-full"
              />
              <div className="absolute inset-0 rounded-full bg-destructive/20 flex items-center justify-center">
                <Mic className="w-8 h-8 md:w-10 md:h-10 text-destructive" />
              </div>
            </div>
            {/* Audio level bars */}
            <AudioLevelIndicator 
              stream={mediaRecorderRef.current?.stream || null}
              isActive={isRecording}
              variant="bars"
              className="mt-2"
            />
            <p className="text-sm md:text-base text-muted-foreground">Recording your response...</p>
            <p className="text-xs md:text-sm text-muted-foreground">Time remaining: {formatTime(timeLeft)}</p>
            
            {/* Action buttons - Restart and Stop */}
            <div className="flex flex-col sm:flex-row items-center gap-2 md:gap-3 mt-2 md:mt-4 w-full sm:w-auto px-4 sm:px-0">
              {/* Restart Recording button */}
              <Button 
                onClick={restartRecording} 
                variant="outline" 
                size="default"
                className="gap-2 border-destructive/50 text-destructive hover:bg-destructive/10 w-full sm:w-auto"
              >
                <RotateCcw className="w-4 h-4" />
                Restart
              </Button>
              
              {/* Stop & Move to Next button */}
              <Button 
                onClick={handleStopAndNext} 
                variant="default" 
                size="default"
                className="w-full sm:w-auto"
              >
                Stop & Next
              </Button>
            </div>
          </div>
        )}

        {/* Instant Speech Feedback - shown briefly after recording stops */}
        {showInstantFeedback && currentAnalysis && !isRecording && (
          <div className="mb-4 md:mb-6 animate-in fade-in slide-in-from-bottom-4 duration-300">
            <InstantSpeechFeedback 
              analysis={currentAnalysis} 
              showDisclaimer={true}
            />
          </div>
        )}

        {/* Live transcript during recording */}
        {isRecording && speechAnalysis.interimTranscript && (
          <Card className="mb-4 md:mb-6 border-muted bg-muted/30">
            <CardContent className="p-3 md:p-4">
              <div className="flex items-start gap-2 md:gap-3">
                <Mic className="w-4 h-4 md:w-5 md:h-5 text-primary mt-1 animate-pulse flex-shrink-0" />
                <p className="text-sm md:text-base text-muted-foreground italic">
                  {speechAnalysis.interimTranscript || 'Listening...'}
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Part 2 - Start Speaking Early Button */}
        {phase === 'part2_prep' && (
          <div className="flex justify-center py-4">
            <Button onClick={startPart2Speaking} size="lg">
              <Play className="w-5 h-5 mr-2" />
              Start Speaking Now
            </Button>
          </div>
        )}

        {/* Submitting state - Full screen with detailed progress */}
        {phase === 'submitting' && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/95 backdrop-blur-sm">
            <div className="flex flex-col items-center gap-6 p-8 max-w-md text-center">
              {/* Animated spinner */}
              <div className="relative">
                <Loader2 className="w-16 h-16 text-primary animate-spin" />
                {submissionProgress.totalItems > 0 && (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <span className="text-sm font-semibold">
                      {submissionProgress.currentItem}/{submissionProgress.totalItems}
                    </span>
                  </div>
                )}
              </div>

              {/* Main step indicator */}
              <div className="space-y-2">
                <h2 className="text-xl font-semibold">{submissionProgress.step || 'Processing...'}</h2>
                <p className="text-sm text-muted-foreground">{submissionProgress.detail}</p>
              </div>

              {/* Progress bar for uploads */}
              {submissionProgress.totalItems > 0 && (
                <div className="w-full space-y-2">
                  <Progress 
                    value={(submissionProgress.currentItem / submissionProgress.totalItems) * 100} 
                    className="h-2"
                  />
                  <p className="text-xs text-muted-foreground">
                    {submissionProgress.currentItem} of {submissionProgress.totalItems} files processed
                  </p>
                </div>
              )}

              {/* Failed uploads warning with retry button */}
              {failedUploads.length > 0 && (
                <div className="w-full p-3 rounded-lg bg-destructive/10 border border-destructive/30">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-medium text-destructive">
                      {failedUploads.length} upload{failedUploads.length > 1 ? 's' : ''} failed
                    </span>
                    <Button 
                      variant="outline" 
                      size="sm" 
                      onClick={handleResubmit}
                      disabled={isResubmitting}
                      className="border-destructive text-destructive hover:bg-destructive/10"
                    >
                      {isResubmitting ? (
                        <>
                          <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                          Retrying...
                        </>
                      ) : (
                        <>
                          <RotateCcw className="w-3 h-3 mr-1" />
                          Retry All
                        </>
                      )}
                    </Button>
                  </div>
                  <div className="text-xs text-muted-foreground space-y-1">
                    {failedUploads.slice(0, 3).map((f, i) => (
                      <div key={i} className="truncate">• {f.key}: {f.error}</div>
                    ))}
                    {failedUploads.length > 3 && (
                      <div>...and {failedUploads.length - 3} more</div>
                    )}
                  </div>
                </div>
              )}

              {/* Step indicators */}
              <div className="flex flex-col gap-2 w-full mt-4">
                {[
                  { step: 1, label: 'Preparing recordings', icon: '🎙️' },
                  { step: 2, label: 'Uploading audio files', icon: '☁️' },
                  { step: 3, label: 'Queuing for evaluation', icon: '🤖' },
                  { step: 4, label: 'Complete!', icon: '✅' },
                ].map(({ step, label, icon }) => (
                  <div 
                    key={step}
                    className={cn(
                      "flex items-center gap-3 px-4 py-2 rounded-lg transition-all",
                      evaluationStep >= step 
                        ? "bg-primary/10 text-primary" 
                        : "bg-muted/50 text-muted-foreground"
                    )}
                  >
                    <span className="text-lg">{icon}</span>
                    <span className={cn(
                      "text-sm",
                      evaluationStep >= step ? "font-medium" : ""
                    )}>
                      {label}
                    </span>
                    {evaluationStep === step && step < 4 && (
                      <Loader2 className="w-4 h-4 ml-auto animate-spin" />
                    )}
                    {evaluationStep > step && (
                      <span className="ml-auto text-green-500">✓</span>
                    )}
                  </div>
                ))}
              </div>

              {/* Encouraging message */}
              <p className="text-xs text-muted-foreground mt-4">
                Please wait while we process your speaking test. This usually takes 30-60 seconds.
              </p>
            </div>
          </div>
        )}

        {/* Progress indicator - Fixed bottom bar (matching Cambridge style) */}
        <div className="fixed bottom-0 left-0 right-0 bg-card border-t p-2 md:p-4 z-40">
          <div className="container mx-auto max-w-3xl">
            {(() => {
              const available = [
                speakingParts.part1 ? 1 : null,
                speakingParts.part2 ? 2 : null,
                speakingParts.part3 ? 3 : null,
              ].filter(Boolean) as Array<1 | 2 | 3>;

              const total = Math.max(1, available.length);
              const idx = Math.max(0, available.indexOf(currentPart));
              const pct = ((idx + 1) / total) * 100;
              
              // Get current questions for dots
              const currentQuestions = currentPart === 1 
                ? speakingParts.part1?.questions || []
                : currentPart === 3 
                  ? speakingParts.part3?.questions || []
                  : [];

              return (
                <>
                  <div className="flex items-center justify-center gap-4 mb-2 flex-wrap">
                    <div className="flex items-center gap-2 text-xs md:text-sm text-muted-foreground">
                      <span>Part {idx + 1} of {total}</span>
                    </div>

                    {/* Question progress within current part */}
                    {currentQuestions.length > 0 && (
                      <div className="flex items-center gap-1.5 text-xs md:text-sm">
                        <span className="text-muted-foreground">•</span>
                        <span className="font-medium text-foreground">
                          Question {questionIndex + 1} of {currentQuestions.length}
                        </span>
                      </div>
                    )}

                    {/* Dots indicator for questions in current part */}
                    {currentQuestions.length > 1 && (
                      <div className="flex items-center gap-1.5" aria-label="Question progress">
                        {currentQuestions.map((_, i) => (
                          <span
                            key={i}
                            className={cn(
                              'h-2 w-2 rounded-full transition-colors',
                              i === questionIndex ? 'bg-primary' : 'bg-muted-foreground/40'
                            )}
                            aria-hidden="true"
                          />
                        ))}
                      </div>
                    )}
                  </div>
                  <Progress value={pct} className="h-1.5 md:h-2" />
                </>
              );
            })()}
          </div>
        </div>
      </main>
    </div>
  );
}
