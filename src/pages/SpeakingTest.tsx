import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { useNetworkStatus } from '@/hooks/useNetworkStatus';
import { useAudioPreloader } from '@/hooks/useAudioPreloader';
import { useSpeechSynthesis } from '@/hooks/useSpeechSynthesis';

import { ArrowLeft, StickyNote, Mic as MicIcon, Pause, WifiOff, Volume2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { HighlightNoteProvider } from '@/hooks/useHighlightNotes';
import { NoteSidebar } from '@/components/common/NoteSidebar';
import { SubmissionErrorState } from '@/components/common/SubmissionErrorState';
import { OfflineBanner } from '@/components/common/OfflineBanner';
import { useAuth } from '@/hooks/useAuth';
import { toast } from 'sonner';
import { describeApiError, ApiErrorDescriptor } from '@/lib/apiErrors';
import { Tables, TablesInsert } from '@/integrations/supabase/types';
import { SpeakingTestControls, AudioLevelIndicator, AudioVolumeControl } from '@/components/speaking';
import { SpeakingTimer } from '@/components/speaking/SpeakingTimer';
import { Badge } from '@/components/ui/badge';
import { MicrophoneTest } from '@/components/speaking/MicrophoneTest';
import { AILoadingScreen } from '@/components/common/AILoadingScreen';
import { useFullscreenTest } from '@/hooks/useFullscreenTest';

type SpeakingTest = Tables<'speaking_tests'>;

// IELTS Official Timings (same as AI Practice)
const TIMING = {
  PART1_QUESTION: 30,  // 30 seconds per Part 1 question
  PART2_PREP: 60,      // 1 minute preparation
  PART2_SPEAK: 120,    // 2 minutes speaking
  PART3_QUESTION: 60,  // 60 seconds per Part 3 question (increased from 45)
} as const;

// Extend SpeakingQuestionGroup to include the joined speaking_questions
interface SpeakingQuestionGroupWithQuestions extends Tables<'speaking_question_groups'> {
  speaking_questions: Array<Tables<'speaking_questions'>>;
}
// Extend SpeakingQuestion to include audio_url from the database
interface SpeakingQuestionWithAudio extends Tables<'speaking_questions'> {
  // audio_url is now in the table schema
}

// Helper to render rich text (markdown-like formatting)
const renderRichText = (text: string): string => {
  if (!text) return '';
  
  return text
    .replace(/^### (.+)$/gm, '<h3 class="text-lg font-semibold mt-2 mb-1">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 class="text-xl font-bold mt-3 mb-2">$1</h2>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/^• (.+)$/gm, '<li class="ml-4 list-disc">$1</li>')
    .replace(/^\d+\. (.+)$/gm, '<li class="ml-4 list-decimal">$1</li>')
    .replace(/\n/g, '<br/>');
};

// Local storage key for guest drafts
const SPEAKING_TEST_GUEST_DRAFT_KEY = 'speaking_test_guest_draft';
// Local storage key for failed AI submissions (logged-in users)
const SPEAKING_TEST_FAILED_SUBMISSION_KEY = 'speaking_test_failed_submission';

export default function SpeakingTest() {
  const { testId } = useParams<{ testId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();

  // Guard to prevent in-flight submission/evaluation from navigating after user leaves
  const isMountedRef = useRef(true);
  const exitRequestedRef = useRef(false);
  
  // Network status for offline indicator (consistent with AI Speaking Test)
  const { isOnline } = useNetworkStatus();
  
  // Audio preloader for Cambridge Speaking Test examiner audio files
  const { preloadMultiple } = useAudioPreloader();

  const [speakingTest, setSpeakingTest] = useState<SpeakingTest | null>(null);
  const [questionGroups, setQuestionGroups] = useState<SpeakingQuestionGroupWithQuestions[]>([]);
  const [allQuestions, setAllQuestions] = useState<SpeakingQuestionWithAudio[]>([]);
  
  // Shared audio for intros, endings, Part 2 instructions (fetched from speaking_shared_audio table)
  const [sharedAudio, setSharedAudio] = useState<Record<string, { audio_url: string | null; fallback_text: string }>>({});
  const [sharedAudioFetched, setSharedAudioFetched] = useState(false);

  const [currentPartIndex, setCurrentPartIndex] = useState(0);
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [part2Phase, setPart2Phase] = useState<'intro' | 'preparation' | 'speaking' | 'done'>('intro');

  const [isRecording, setIsRecording] = useState(false);
  const isRecordingRef = useRef(false);
  useEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);

  const [mediaRecorder, setMediaRecorder] = useState<MediaRecorder | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  useEffect(() => {
    mediaRecorderRef.current = mediaRecorder;
  }, [mediaRecorder]);

  const audioChunks = useRef<Blob[]>([]);
  const audioBlobUrls = useRef<Record<string, string>>({}); // Stores blob URLs for each question/part
  const audioBlobs = useRef<Record<string, Blob>>({}); // Stores actual Blob objects
  // Removed transcripts.current ref

  const [loading, setLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0); // New state for recording duration
  const recordingIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const [timeLeft, setTimeLeft] = useState(0);
  const [overallPartTimeLeft, setOverallPartTimeLeft] = useState(0);
  const [fontSize, setFontSize] = useState(14);
  const [isPaused, setIsPaused] = useState(false);
  const [customTime, setCustomTime] = useState(15);

  // Fullscreen mode
  const { enterFullscreen, exitFullscreen, toggleFullscreen, isFullscreen } = useFullscreenTest();

  const [isNoteSidebarOpen, setIsNoteSidebarOpen] = useState(false);
  const [showMicrophoneTest, setShowMicrophoneTest] = useState(true); // New state for mic test

  // AI Loading Screen states
  const [showAILoadingScreen, setShowAILoadingScreen] = useState(false);
  const [aiProgressSteps, setAiProgressSteps] = useState<string[]>([]);
  const [currentAIStepIndex, setCurrentAIStepIndex] = useState(0);

  // Part transition overlay state
  const [showPartTransitionOverlay, setShowPartTransitionOverlay] = useState(false);
  const [partTransitionMessage, setPartTransitionMessage] = useState('');

  // Submission error state
  const [submissionError, setSubmissionError] = useState<ApiErrorDescriptor | null>(null);
  const [isResubmitting, setIsResubmitting] = useState(false);

  // Examiner voice state
  const [isMuted, setIsMuted] = useState(false);
  const [volume, setVolume] = useState(1); // Volume level 0-1
  const [, setCurrentSpeakingText] = useState('');
  const [isPlayingExaminerAudio, setIsPlayingExaminerAudio] = useState(false);
  // NOTE: currentSpeakingText is set but not displayed after UI cleanup. Can be used for debugging.
  const [usingDeviceAudio, setUsingDeviceAudio] = useState(false);
  const examinerAudioRef = useRef<HTMLAudioElement | null>(null);
  const isMutedRef = useRef(isMuted);
  const volumeRef = useRef(volume);
  
  // Update refs when state changes
  useEffect(() => { isMutedRef.current = isMuted; }, [isMuted]);
  useEffect(() => { volumeRef.current = volume; }, [volume]);

// Test phases - similar to AI Practice Speaking
  type TestPhase = 
    | 'mic_test'
    | 'ready'
    | 'part_intro'        // Playing part introduction
    | 'question_audio'    // Playing question audio
    | 'recording'         // User is recording
    | 'submitting'
    | 'done';
  
  const [testPhase, setTestPhase] = useState<TestPhase>('mic_test');
  const testPhaseRef = useRef<TestPhase>('mic_test');
  useEffect(() => { testPhaseRef.current = testPhase; }, [testPhase]);

  // TTS hook for fallback when audio URLs not available
  const handleTTSCompleteRef = useRef<() => void>(() => {});
  const tts = useSpeechSynthesis({
    onEnd: () => {
      setCurrentSpeakingText('');
      setIsPlayingExaminerAudio(false);
      setUsingDeviceAudio(false);
      handleTTSCompleteRef.current();
    },
  });

  const isNewSubmissionRequest = location.pathname.endsWith('/new-submission');

  // --- Helper Functions ---
  const currentGroup = useMemo(() => questionGroups[currentPartIndex] || null, [questionGroups, currentPartIndex]);
  const currentQuestionsInGroup = useMemo(() => {
    return allQuestions.filter(q => q.group_id === currentGroup?.id).sort((a, b) => a.order_index - b.order_index);
  }, [allQuestions, currentGroup]);
  const currentQuestion = useMemo(() => currentQuestionsInGroup[currentQuestionIndex] || null, [currentQuestionsInGroup, currentQuestionIndex]);

  // --- Navigation Logic Variables ---
  const canGoNextQuestion = currentQuestionIndex < currentQuestionsInGroup.length - 1;
  const canGoNextPart = currentPartIndex < questionGroups.length - 1;
  // isLastQuestionOfLastPart removed - Back/Next buttons no longer shown in bottom bar

  // Examiner voice playback function with fast TTS fallback
  const playExaminerAudio = useCallback((text: string, audioUrl?: string | null) => {
    // Hard-stop any browser TTS (prevents overlap between a TTS intro + recorded audio)
    window.speechSynthesis?.cancel();
    setTimeout(() => window.speechSynthesis?.cancel(), 0);

    // Stop any currently playing audio
    if (examinerAudioRef.current) {
      examinerAudioRef.current.pause();
      examinerAudioRef.current = null;
    }

    // Stop our hook TTS too
    tts.cancel();
    setUsingDeviceAudio(false);

    if (isMutedRef.current) {
      // Skip playback if muted but still set the text briefly for visual feedback
      setCurrentSpeakingText(text);
      setIsPlayingExaminerAudio(true);
      setTimeout(() => {
        setCurrentSpeakingText('');
        setIsPlayingExaminerAudio(false);
        handleTTSCompleteRef.current();
      }, 1500);
      return;
    }

    setCurrentSpeakingText(text);
    setIsPlayingExaminerAudio(true);

    const triggerTTSFallback = () => {
      console.warn('[SpeakingTest] Falling back to TTS');
      setUsingDeviceAudio(true);
      tts.speak(text);
    };

    if (audioUrl) {
      // Play pre-recorded examiner audio with conservative timeout fallback.
      // Cache-bust to avoid “ghost audio” from the browser cache after you delete/regenerate files.
      const cacheBustedUrl = `${audioUrl}${audioUrl.includes('?') ? '&' : '?'}v=${Date.now()}`;
      const audio = new Audio(cacheBustedUrl);
      audio.crossOrigin = 'anonymous';
      audio.volume = volumeRef.current;
      audio.muted = isMutedRef.current;
      examinerAudioRef.current = audio;

      // Timeout fallback: keep this conservative, otherwise we unnecessarily drop to browser TTS (voice mismatch)
      const AUDIO_TIMEOUT_MS = 4500;
      let didFallback = false;
      const timeoutId = window.setTimeout(() => {
        // If audio hasn't buffered enough to play AND hasn't started playing, fall back.
        if (!didFallback && audio.readyState < 3 && (audio.paused || audio.currentTime === 0)) {
          didFallback = true;
          console.warn('[SpeakingTest] Audio load timeout, falling back to TTS');
          audio.src = '';
          examinerAudioRef.current = null;
          triggerTTSFallback();
        }
      }, AUDIO_TIMEOUT_MS);

      audio.onloadeddata = () => {
        window.clearTimeout(timeoutId);
      };

      audio.onended = () => {
        window.clearTimeout(timeoutId);
        setCurrentSpeakingText('');
        setIsPlayingExaminerAudio(false);
        setUsingDeviceAudio(false);
        examinerAudioRef.current = null;
        handleTTSCompleteRef.current();
      };

      audio.onerror = () => {
        if (didFallback) return;
        didFallback = true;
        window.clearTimeout(timeoutId);
        triggerTTSFallback();
      };

      audio.play().catch(() => {
        if (didFallback) return;
        didFallback = true;
        window.clearTimeout(timeoutId);
        triggerTTSFallback();
      });
    } else {
      // Use TTS immediately when no audio URL is available
      setUsingDeviceAudio(true);
      tts.speak(text);
    }
  }, [tts]);


  // Stop examiner audio on unmount or when recording starts
  const stopExaminerAudio = useCallback(() => {
    if (examinerAudioRef.current) {
      examinerAudioRef.current.pause();
      examinerAudioRef.current = null;
    }
    tts.cancel();
    setCurrentSpeakingText('');
    setIsPlayingExaminerAudio(false);
  }, [tts]);



  // Helper to convert Blob to Base64
  const blobToBase64 = (blob: Blob): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  };

  // Helper to convert Base64 to Blob
  const base64ToBlob = (base64: string, contentType: string = 'audio/webm'): Blob => {
    const byteString = atob(base64.split(',')[1]);
    const ab = new ArrayBuffer(byteString.length);
    const ia = new Uint8Array(ab);
    for (let i = 0; i < byteString.length; i++) {
      ia[i] = byteString.charCodeAt(i);
    }
    return new Blob([ab], { type: contentType });
  };

  const stopRecording = useCallback(async (): Promise<void> => {
    return new Promise(resolve => {
      const recorder = mediaRecorderRef.current;

      // Always stop the incremental timer
      if (recordingIntervalRef.current) clearInterval(recordingIntervalRef.current);
      recordingIntervalRef.current = null;

      const setStoppedState = () => {
        isRecordingRef.current = false;
        mediaRecorderRef.current = null;
        setRecordingDuration(0);
        setIsRecording(false);
        setMediaRecorder(null);
      };

      // If we have no active recorder, ensure UI state is consistent and resolve.
      if (!recorder || recorder.state === 'inactive') {
        setStoppedState();
        resolve();
        return;
      }

      const finalize = () => {
        try {
          const audioBlob = new Blob(audioChunks.current, { type: 'audio/webm' });
          const url = URL.createObjectURL(audioBlob);

          // Use refs for current question/group to avoid stale closures
          const q = currentQuestion;
          const g = currentGroup;
          if (q && g) {
            const key = `part${g.part_number}-q${q.id}`;
            audioBlobUrls.current = { ...audioBlobUrls.current, [key]: url };
            audioBlobs.current = { ...audioBlobs.current, [key]: audioBlob };
            console.log(`Recorded audio for ${key}: ${url}`);
          }
        } catch (e) {
          console.warn('[SpeakingTest] Failed to finalize recording blob:', e);
        }

        // Stop all tracks in the stream
        try {
          recorder.stream?.getTracks()?.forEach(track => track.stop());
        } catch {
          // ignore
        }

        setStoppedState();

        if (currentGroup?.part_number === 2 && part2Phase === 'speaking') {
          setPart2Phase('done');
        }

        resolve();
      };

      // Safety: ensure we never hang waiting for onstop.
      const SAFETY_TIMEOUT_MS = 2000;
      const safetyId = window.setTimeout(() => {
        console.warn('[SpeakingTest] stopRecording safety timeout fired');
        finalize();
      }, SAFETY_TIMEOUT_MS);

      recorder.onstop = () => {
        window.clearTimeout(safetyId);
        finalize();
      };

      try {
        recorder.stop();
      } catch (e) {
        window.clearTimeout(safetyId);
        console.warn('[SpeakingTest] recorder.stop() threw, finalizing anyway:', e);
        finalize();
      }
    });
  }, [currentQuestion, currentGroup, part2Phase]);

  const startRecording = useCallback(async () => {
    // IMPORTANT: never gate on React state here; it can be stale right after a stop (Retake).
    // Use the ref/recorder state as source of truth.
    const existing = mediaRecorderRef.current;
    if (isRecordingRef.current || (existing && existing.state !== 'inactive')) return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      
      // Use native WebM/Opus recording - tiny files, zero CPU overhead, no compression needed
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') 
        ? 'audio/webm;codecs=opus' 
        : 'audio/webm';
      
      const recorder = new MediaRecorder(stream, {
        mimeType,
        audioBitsPerSecond: 32000, // 32kbps - high quality, small files
      });

      audioChunks.current = [];
      recorder.ondataavailable = (event) => {
        audioChunks.current.push(event.data);
      };

      // Set refs FIRST so any synchronous code (or fast clicks) see the correct state.
      isRecordingRef.current = true;
      mediaRecorderRef.current = recorder;

      recorder.start();
      setIsRecording(true);
      setMediaRecorder(recorder);
      setIsPaused(false);
      setTestPhase('recording');

      // Set the countdown timer ONLY when recording starts (like AI Practice)
      if (currentGroup) {
        if (currentGroup.part_number === 1) {
          setTimeLeft(TIMING.PART1_QUESTION);
        } else if (currentGroup.part_number === 2 && part2Phase === 'speaking') {
          setTimeLeft(currentGroup.speaking_time_seconds || TIMING.PART2_SPEAK);
        } else if (currentGroup.part_number === 3) {
          setTimeLeft(TIMING.PART3_QUESTION);
        }
      }

      // Start recording duration timer (incremental) - only increments while recorder is actually recording
      setRecordingDuration(0);
      if (recordingIntervalRef.current) clearInterval(recordingIntervalRef.current);
      recordingIntervalRef.current = setInterval(() => {
        const r = mediaRecorderRef.current;
        if (r && r.state === 'recording') {
          setRecordingDuration(prev => prev + 1);
        }
      }, 1000);

      if (currentGroup?.part_number === 2 && part2Phase === 'preparation') {
        setPart2Phase('speaking');
      }
    } catch (err) {
      // Roll back refs if we fail to acquire mic
      isRecordingRef.current = false;
      mediaRecorderRef.current = null;

      console.error('Error accessing microphone:', err);
      toast.error('Failed to start recording. Please check microphone permissions.');
    }
  }, [currentGroup, part2Phase]);

  // Phase-based audio flow (similar to AI Practice Speaking)
  // Handles: part_intro → question_audio → recording
  
  // Helper to get part instruction from shared audio (with fallback)
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
  
  // Track if we've played the intro for this part
  const lastPlayedPartRef = useRef<number | null>(null);
  const lastPlayedQuestionIdRef = useRef<string | null>(null);
  
  // Phase-based audio and recording flow
  // This effect orchestrates: part_intro → question_audio → recording
  useEffect(() => {
    // Don't start the exam flow until we've attempted to fetch shared-audio rows.
    // Otherwise we may start with browser TTS fallback and later also start MP3 audio (overlap).
    if (!sharedAudioFetched) return;

    // Skip if mic test showing, data not loaded, already recording, or we're already playing examiner audio.
    // This prevents overlapping intro + question audio when React re-runs the effect.
    if (showMicrophoneTest || !currentQuestion || !currentGroup || isRecording || isPlayingExaminerAudio) {
      return;
    }

    const partNumber = currentGroup.part_number;
    const questionId = currentQuestion.id;

    // 1. Play part intro when entering a new part
    if (lastPlayedPartRef.current !== partNumber) {
      lastPlayedPartRef.current = partNumber;
      lastPlayedQuestionIdRef.current = null;

      // Ensure Part 2 starts hidden until prep_start finishes
      if (partNumber === 2) {
        setPart2Phase('intro');
        setTimeLeft(0);
      }

      setTestPhase('part_intro');
      const introKey = `part${partNumber}_intro`;
      const introItem = getSharedAudioItem(introKey);

      // After intro ends...
      handleTTSCompleteRef.current = () => {
        // For Part 2: play prep_start, then reveal cue card + start the 1-min prep timer.
        if (partNumber === 2) {
          const prepStartItem = getSharedAudioItem('part2_prep_start');
          handleTTSCompleteRef.current = () => {
            // Mark question "handled" so we don't try to play question audio for Part 2.
            lastPlayedQuestionIdRef.current = questionId;
            setTestPhase('ready');
            setPart2Phase('preparation');
          };
          playExaminerAudio(prepStartItem.fallback_text, prepStartItem.audio_url);
          return;
        }

        // For Part 1 and 3, play question audio then start recording
        setTestPhase('question_audio');
        const audioUrl = (currentQuestion as any).audio_url;
        const plainText = currentQuestion.question_text.replace(/<[^>]*>/g, '');
        lastPlayedQuestionIdRef.current = questionId;

        handleTTSCompleteRef.current = () => {
          setTestPhase('recording');
          startRecording();
        };

        playExaminerAudio(plainText, audioUrl);
      };

      playExaminerAudio(introItem.fallback_text, introItem.audio_url);
      return;
    }

    // Part 2 has no per-question examiner prompt after prep_start; skip this phase entirely.
    if (partNumber === 2) return;

    // 2. Play question audio when question changes within same part
    if (lastPlayedQuestionIdRef.current !== questionId) {
      lastPlayedQuestionIdRef.current = questionId;
      setTestPhase('question_audio');

      const audioUrl = (currentQuestion as any).audio_url;
      const plainText = currentQuestion.question_text.replace(/<[^>]*>/g, '');

      handleTTSCompleteRef.current = () => {
        setTestPhase('recording');
        startRecording();
      };

      playExaminerAudio(plainText, audioUrl);
    }

    // Note: No cleanup that stops audio - that was causing issues when effect re-ran
  }, [currentQuestion?.id, currentGroup?.id, currentGroup?.part_number, part2Phase, isRecording, showMicrophoneTest, startRecording, playExaminerAudio, getSharedAudioItem]);

  const resetCurrentRecording = useCallback(async () => {
    // Stop any examiner audio
    stopExaminerAudio();

    // Stop current recording (if any) and wait for cleanup
    if (isRecordingRef.current) {
      await stopRecording();
    }

    if (currentQuestion && currentGroup) {
      const key = `part${currentGroup.part_number}-q${currentQuestion.id}`;
      const newAudioBlobUrls = { ...audioBlobUrls.current };
      delete newAudioBlobUrls[key];
      audioBlobUrls.current = newAudioBlobUrls;
      const newAudioBlobs = { ...audioBlobs.current };
      delete newAudioBlobs[key];
      audioBlobs.current = newAudioBlobs;

      toast.info('Recording cleared. Starting fresh...');

      // Reset BOTH timers; countdown will be set again when recording actually starts.
      setTimeLeft(0);
      setRecordingDuration(0);

      setIsPaused(false);

      // Immediately restart recording
      await startRecording();
    }
  }, [stopRecording, stopExaminerAudio, currentQuestion, currentGroup, startRecording]);

  const saveGuestDraft = useCallback(async () => {
    if (!testId) return;

    const audioBlobsBase64: Record<string, string> = {};
    for (const key in audioBlobs.current) {
      audioBlobsBase64[key] = await blobToBase64(audioBlobs.current[key]);
    }

    const draft = {
      testId,
      currentPartIndex,
      currentQuestionIndex,
      part2Phase,
      audioBlobsBase64, // Save Base64 representation
      // Removed transcripts from draft
      timeLeft,
      overallPartTimeLeft,
      fontSize,
      isFullscreen,
      isPaused,
      customTime,
      savedAt: Date.now(),
    };
    localStorage.setItem(`${SPEAKING_TEST_GUEST_DRAFT_KEY}_${testId}`, JSON.stringify(draft));
    toast.info('Your progress has been saved locally. Please log in to submit.');
  }, [testId, currentPartIndex, currentQuestionIndex, part2Phase, timeLeft, overallPartTimeLeft, fontSize, isFullscreen, isPaused, customTime]);

  const clearGuestDraft = useCallback(() => {
    if (testId) {
      localStorage.removeItem(`${SPEAKING_TEST_GUEST_DRAFT_KEY}_${testId}`);
    }
  }, [testId]);

  const saveFailedSubmissionLocally = useCallback(async (submissionData: TablesInsert<'speaking_submissions'>) => {
    if (!testId || !user) return;

    const audioBlobsBase64: Record<string, string> = {};
    for (const key in audioBlobs.current) {
      audioBlobsBase64[key] = await blobToBase64(audioBlobs.current[key]);
    }

    const failedSubmission = {
      testId,
      userId: user.id,
      submissionData, // The data that was attempted to be submitted
      audioBlobsBase64,
      // Removed transcripts from failed submission draft
      failedAt: new Date().toISOString(),
    };

    // Store as an array of failed submissions
    const existingFailed = JSON.parse(localStorage.getItem(SPEAKING_TEST_FAILED_SUBMISSION_KEY) || '[]') as typeof failedSubmission[];
    localStorage.setItem(SPEAKING_TEST_FAILED_SUBMISSION_KEY, JSON.stringify([...existingFailed, failedSubmission]));
    toast.error('AI evaluation failed. Your submission has been saved locally for re-submission.', { duration: 8000 });
  }, [testId, user]);


  const handleSubmit = useCallback(async () => {
    if (exitRequestedRef.current || !isMountedRef.current) return;
    if (isSubmitting) return; // Prevent re-entry

    if (isRecording) {
      await stopRecording(); // Wait for recording to fully stop and process
    }

    // Now, check if any audio was actually recorded across all parts/questions
    const hasAnyRecordedAudio = Object.keys(audioBlobs.current).length > 0;
    if (!hasAnyRecordedAudio) {
      toast.error('Please record your speaking response before submitting.');
      setIsSubmitting(false); // Reset submitting state
      return;
    }

    if (!user) {
      saveGuestDraft();
      navigate(`/auth?redirect=/speaking/test/${testId}/submit-guest`);
      return;
    }

    if (!speakingTest) {
      toast.error('Test data not loaded.');
      setIsSubmitting(false); // Reset state on error
      return;
    }

    setIsSubmitting(true); // Set submitting state BEFORE confirmation
    if (!confirm('Are you sure you want to submit your speaking test? You cannot edit it after submission.')) {
      setIsSubmitting(false); // Reset if user cancels
      return;
    }

    // Show AI Loading Screen
    setShowAILoadingScreen(true);
    setAiProgressSteps([
      'Processing your recordings',
      'Analyzing your speaking performance',
      'Generating detailed feedback report',
      'Calculating your overall band score',
    ]);
    setCurrentAIStepIndex(0);

    const simulateProgress = (step: number, delay: number = 2000) => {
      return new Promise(resolve => setTimeout(() => {
        setCurrentAIStepIndex(step);
        resolve(null);
      }, delay));
    };

    try {
      await simulateProgress(0, 500); // Step 0: Processing recordings

      const submissionTimestamp = new Date().toISOString();
      
      // Prepare submission data (audio_url_partX and transcript_partX will be NULL)
      const submissionData: TablesInsert<'speaking_submissions'> = {
        user_id: user.id,
        test_id: speakingTest.id!,
        submitted_at: submissionTimestamp,
        audio_url_part1: null,
        audio_url_part2: null,
        audio_url_part3: null,
        transcript_part1: null,
        transcript_part2: null,
        transcript_part3: null,
      };

      // Insert new submission
      const { data: newSubmission, error: insertError } = await supabase
        .from('speaking_submissions')
        .insert(submissionData)
        .select()
        .single();

      if (insertError) throw insertError;

      // PARALLEL APPROACH: Convert audio blobs to base64 and send directly to evaluation
      // The edge function handles both evaluation AND R2 upload in background
      const audioDataPromises: Promise<{ key: string; dataUrl: string }>[] = [];
      
      for (const key in audioBlobs.current) {
        const blob = audioBlobs.current[key];
        audioDataPromises.push(
          new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
              resolve({ key, dataUrl: reader.result as string });
            };
            reader.onerror = () => reject(new Error(`Failed to read audio blob for ${key}`));
            reader.readAsDataURL(blob);
          })
        );
      }

      const audioDataArray = await Promise.all(audioDataPromises);
      const audioData: Record<string, string> = {};
      for (const { key, dataUrl } of audioDataArray) {
        audioData[key] = dataUrl;
      }

      console.log('[SpeakingTest] Audio data prepared:', Object.keys(audioData).length, 'segments');

      await simulateProgress(1); // Step 1: Analyzing with AI

      // Call the parallel evaluation function - it handles both evaluation and R2 upload
      const { data, error: evaluationError } = await supabase.functions.invoke('evaluate-speaking-parallel', {
        body: { 
          testId: speakingTest.id,
          audioData,
        },
      });

      if (evaluationError) {
        console.error('AI evaluation failed:', evaluationError);
        const errDesc = describeApiError(evaluationError);

        // Save to local storage if AI evaluation failed
        await saveFailedSubmissionLocally(submissionData);
        toast.error(errDesc.description, { 
          id: 'ai-eval-toast', 
          duration: 8000,
          action: errDesc.action ? {
            label: errDesc.action.label,
            onClick: () => navigate(errDesc.action!.href)
          } : undefined
        });
        return; // Stop submission process here
      }

      await simulateProgress(2); // Step 2: Generating feedback
      await simulateProgress(3); // Step 3: Calculating band score

      clearGuestDraft(); // Clear guest draft after successful submission
      toast.success('Speaking test submitted! Evaluation will be available shortly.', { id: 'ai-eval-toast', duration: 5000 });

      if (!exitRequestedRef.current && isMountedRef.current) {
        // Exit fullscreen before navigating to results
        await exitFullscreen();
        // Navigate to results using the result ID from the evaluation response
        const resultId = data?.resultId;
        if (resultId) {
          navigate(`/ai-speaking/results/${speakingTest.id}/${resultId}`);
        } else {
          navigate(`/speaking/evaluation/${testId}/${newSubmission.id}`);
        }
      }
    } catch (error: any) {
      console.error('Error submitting speaking test:', error);
      const errDesc = describeApiError(error);
      setSubmissionError(errDesc);
      setIsResubmitting(false);
      toast.error(errDesc.title, { 
        description: 'Your recordings are preserved. You can try again.',
        id: 'ai-eval-toast' 
      });
    } finally {
      setIsSubmitting(false);
      setShowAILoadingScreen(false); // Hide loading screen
    }
  }, [user, speakingTest, testId, isRecording, stopRecording, navigate, questionGroups, saveGuestDraft, clearGuestDraft, isSubmitting, saveFailedSubmissionLocally]);

  // Resubmit handler
  const handleResubmit = useCallback(async () => {
    setIsResubmitting(true);
    setSubmissionError(null);
    await handleSubmit();
  }, [handleSubmit]);

  const handleCurrentTimerEnd = useCallback(async () => { // Make it async
    if (isRecordingRef.current) {
      await stopRecording(); // Await here too
    }

    if (!currentGroup) {
      handleSubmit(); // This handleSubmit will now correctly check for audio
      return;
    }

    if (currentGroup.part_number === 1) {
      if (canGoNextQuestion) { // Use canGoNextQuestion
        setCurrentQuestionIndex(prev => prev + 1);
      } else {
        // Play Part 1 ending audio before transitioning to Part 2
        const part1EndItem = getSharedAudioItem('part1_ending');
        setTestPhase('part_intro');

        handleTTSCompleteRef.current = () => {
          const nextPartNumber = questionGroups[currentPartIndex + 1]?.part_number;
          if (nextPartNumber) {
            setPartTransitionMessage(`Moving to Part ${nextPartNumber}`);
            setShowPartTransitionOverlay(true);
            setTimeout(() => setShowPartTransitionOverlay(false), 500);
          }
          setCurrentPartIndex(prev => prev + 1);
          setCurrentQuestionIndex(0);
          setPart2Phase('intro');
        };

        playExaminerAudio(part1EndItem.fallback_text, part1EndItem.audio_url);
      }
    } else if (currentGroup.part_number === 2) {
      if (part2Phase === 'preparation') {
        // Play "preparation time is over" audio then start recording
        // NOTE: This is an instruction audio, not a question audio, so use 'part_intro' phase
        const prepEndItem = getSharedAudioItem('part2_prep_end');
        setTestPhase('part_intro');
        
        handleTTSCompleteRef.current = () => {
          setTimeLeft(currentGroup.speaking_time_seconds || TIMING.PART2_SPEAK);
          setPart2Phase('speaking');
          setTestPhase('recording');
          startRecording();
        };
        
        playExaminerAudio(prepEndItem.fallback_text, prepEndItem.audio_url);
      } else if (part2Phase === 'speaking' || part2Phase === 'done') {
        // Part 2 recording done, move to next part
        setPart2Phase('done');
        if (canGoNextPart) {
          // Play Part 2 ending audio before transitioning
          const part2EndItem = getSharedAudioItem('part2_ending');
          setTestPhase('part_intro');
          
          handleTTSCompleteRef.current = () => {
            const nextPartNumber = questionGroups[currentPartIndex + 1]?.part_number;
            if (nextPartNumber) {
              setPartTransitionMessage(`Moving to Part ${nextPartNumber}`);
              setShowPartTransitionOverlay(true);
              setTimeout(() => setShowPartTransitionOverlay(false), 500);
            }
            setCurrentPartIndex(prev => prev + 1);
            setCurrentQuestionIndex(0);
          };
          
          playExaminerAudio(part2EndItem.fallback_text, part2EndItem.audio_url);
        } else {
          handleSubmit();
        }
      }
    } else if (currentGroup.part_number === 3) {
      if (canGoNextQuestion) {
        setCurrentQuestionIndex(prev => prev + 1);
      } else {
        // Play Part 3 ending and test ending audio before submission
        const part3EndItem = getSharedAudioItem('part3_ending');
        setTestPhase('part_intro');
        
        handleTTSCompleteRef.current = () => {
          // After Part 3 ending, play the final test ending
          const testEndItem = getSharedAudioItem('test_ending');
          
          handleTTSCompleteRef.current = () => {
            handleSubmit();
          };
          
          playExaminerAudio(testEndItem.fallback_text, testEndItem.audio_url);
        };
        
        playExaminerAudio(part3EndItem.fallback_text, part3EndItem.audio_url);
      }
    }
  }, [isRecording, stopRecording, currentGroup, canGoNextQuestion, currentQuestionIndex, currentPartIndex, questionGroups.length, part2Phase, canGoNextPart, handleSubmit, questionGroups, getSharedAudioItem, playExaminerAudio, startRecording]);

  // Part 3 time end handler removed - not currently used

  // --- Effects ---
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (testId) {
      fetchTestData();
    }
  }, [testId, isNewSubmissionRequest]);

  // Auto-enter fullscreen on mount
  useEffect(() => {
    const timer = setTimeout(() => {
      enterFullscreen();
    }, 500);
    return () => clearTimeout(timer);
  }, [enterFullscreen]);

  // Load guest draft on mount if available and user is not logged in
  useEffect(() => {
    if (!user && testId) {
      const savedDraft = localStorage.getItem(`${SPEAKING_TEST_GUEST_DRAFT_KEY}_${testId}`);
      if (savedDraft) {
        try {
          const draft = JSON.parse(savedDraft);
          setCurrentPartIndex(draft.currentPartIndex);
          setCurrentQuestionIndex(draft.currentQuestionIndex);
          setPart2Phase(draft.part2Phase);
          // Convert Base64 audio back to Blob and create URL
          const loadedAudioBlobs: Record<string, Blob> = {};
          const loadedAudioBlobUrls: Record<string, string> = {};
          for (const key in draft.audioBlobsBase64) {
            const blob = base64ToBlob(draft.audioBlobsBase64[key]);
            loadedAudioBlobs[key] = blob;
            loadedAudioBlobUrls[key] = URL.createObjectURL(blob);
          }
          audioBlobs.current = loadedAudioBlobs;
          audioBlobUrls.current = loadedAudioBlobUrls;
          // Removed transcripts.current = draft.transcripts;
          setTimeLeft(draft.timeLeft);
          setOverallPartTimeLeft(draft.overallPartTimeLeft);
          setFontSize(draft.fontSize);
          // isFullscreen is handled by hook, skip restoring
          setIsPaused(draft.isPaused);
          setCustomTime(draft.customTime);
          toast.info('Your previous session has been restored. Please log in to submit.');
          setShowMicrophoneTest(false); // Skip mic test if draft loaded
        } catch (e) {
          console.error('Failed to restore guest draft:', e);
          clearGuestDraft();
        }
      }
    }
  }, [user, testId, clearGuestDraft]);

  // Handle post-login submission redirect
  useEffect(() => {
    const queryParams = new URLSearchParams(location.search);
    const redirect = queryParams.get('redirect');

    if (user && redirect === `/speaking/test/${testId}/submit-guest`) {
      // Clear the redirect parameter from the URL
      navigate(location.pathname, { replace: true });
      // Trigger submission after successful login and state restoration
      handleSubmit();
    }
  }, [user, location.search, testId, navigate, handleSubmit]);


  // Effect for question/phase specific timer (timeLeft)
  // Timer is ONLY set when recording starts (via startRecording), NOT on question change.
  // Exception: Part 2 preparation phase sets the prep timer when prep actually starts.
  useEffect(() => {
    if (!currentGroup || !currentQuestion) return;

    if (currentGroup.part_number === 2) {
      if (part2Phase === 'preparation') {
        const prepSeconds = currentGroup.preparation_time_seconds || TIMING.PART2_PREP;
        // Start (or reset) the prep timer when preparation begins.
        setTimeLeft(prepSeconds);
      } else if (part2Phase === 'intro' || part2Phase === 'done') {
        setTimeLeft(0);
      }
    }

    // For Part 1 and 3, timer is set when startRecording is called (see startRecording callback)
  }, [currentGroup?.id, currentQuestion?.id, currentGroup?.part_number, part2Phase]);

  // Effect for overall Part 3 timer (overallPartTimeLeft)
  const prevPartIndexRef = useRef(currentPartIndex);
  useEffect(() => {
    // If we just entered Part 3
    if (currentGroup?.part_number === 3 && prevPartIndexRef.current !== currentPartIndex) {
      setOverallPartTimeLeft(currentGroup.total_part_time_limit_seconds || 300);
    } 
    // If we just left Part 3
    else if (currentGroup?.part_number !== 3 && prevPartIndexRef.current === 3) {
      setOverallPartTimeLeft(0);
    }
    prevPartIndexRef.current = currentPartIndex; // Update ref for next render
  }, [currentPartIndex, currentGroup]); // Only depends on part index and group


  const fetchTestData = async () => {
    setLoading(true);
    setSharedAudioFetched(false);
    try {
      // Fetch shared audio settings (common across all tests)
      const { data: sharedAudioData, error: sharedAudioError } = await supabase
        .from('speaking_shared_audio')
        .select('audio_key, audio_url, fallback_text');

      if (sharedAudioError) {
        console.warn('Failed to load shared audio settings:', sharedAudioError);
      } else if (sharedAudioData) {
        const audioMap: Record<string, { audio_url: string | null; fallback_text: string }> = {};
        sharedAudioData.forEach(item => {
          audioMap[item.audio_key] = { audio_url: item.audio_url, fallback_text: item.fallback_text };
        });
        setSharedAudio(audioMap);

        // Preload shared audio files
        const sharedAudioUrls = sharedAudioData
          .map(item => item.audio_url)
          .filter((url): url is string => !!url);
        if (sharedAudioUrls.length > 0) {
          console.log(`[SpeakingTest] Preloading ${sharedAudioUrls.length} shared audio files...`);
          preloadMultiple(sharedAudioUrls);
        }
      }

      // Mark as fetched even if table is empty or errored (so the test can still proceed with fallback).
      setSharedAudioFetched(true);

      const { data: testData, error: testError } = await supabase
        .from('speaking_tests')
        .select('*')
        .eq('id', testId!)
        .single();

      if (testError) throw testError;
      setSpeakingTest(testData);

      const { data: groupsData, error: groupsError } = await supabase
        .from('speaking_question_groups')
        .select('*, speaking_questions(*)')
        .eq('test_id', testId!)
        .order('part_number')
        .order('order_index', { foreignTable: 'speaking_questions' });

      if (groupsError) throw groupsError;

      const fetchedGroups: SpeakingQuestionGroupWithQuestions[] = (groupsData || []).map(g => ({
        ...g,
        speaking_questions: (g.speaking_questions || []).sort((a: any, b: any) => a.order_index - b.order_index),
      }));
      setQuestionGroups(fetchedGroups);

      const allQs: SpeakingQuestionWithAudio[] = fetchedGroups.flatMap(group => 
        (group.speaking_questions || []).map(q => ({
          ...q,
        }))
      );
      setAllQuestions(allQs);

      // Preload examiner audio files if they exist (for offline support)
      const audioUrlsToPreload = allQs
        .map((q: any) => q.audio_url)
        .filter((url: string | null | undefined): url is string => !!url);
      
      if (audioUrlsToPreload.length > 0) {
        console.log(`[SpeakingTest] Preloading ${audioUrlsToPreload.length} examiner audio files...`);
        preloadMultiple(audioUrlsToPreload);
      }

      if (allQs.length > 0) {
        setCurrentQuestionIndex(0);
        setCurrentPartIndex(0);
      } else {
        toast.error('No questions found for this speaking test.');
        navigate('/speaking/cambridge-ielts-a');
        return;
      }

    } catch (error) {
      console.error('Error fetching test data:', error);
      toast.error('Failed to load speaking test');
      navigate('/speaking/cambridge-ielts-a');
    } finally {
      setLoading(false);
    }
  };

  const togglePause = useCallback(() => {
    setIsPaused(prev => !prev);
    if (isRecording) {
      if (mediaRecorder?.state === 'recording') {
        mediaRecorder.pause();
      } else if (mediaRecorder?.state === 'paused') {
        mediaRecorder.resume();
      }
    }
  }, [isRecording, mediaRecorder]);

  // Custom time change removed - not currently used

  const handleNext = useCallback(async () => { // Make it async
    // Stop any examiner audio first
    stopExaminerAudio();
    
    if (isRecordingRef.current) {
      await stopRecording();
    }

    if (currentGroup?.part_number === 2) {
      if (part2Phase === 'preparation') {
        setTimeLeft(currentGroup.speaking_time_seconds || 120); // Start speaking timer
        setPart2Phase('speaking');
      } else if (part2Phase === 'speaking' || part2Phase === 'done') { // Combine these
        setPart2Phase('done'); // Ensure it's marked done
        
        // Play Part 2 ending audio before transitioning to next part
        const part2EndItem = getSharedAudioItem('part2_ending');
        setTestPhase('part_intro');
        
        handleTTSCompleteRef.current = () => {
          if (canGoNextPart) {
            const nextPartNumber = questionGroups[currentPartIndex + 1]?.part_number;
            if (nextPartNumber) {
              setPartTransitionMessage(`Moving to Part ${nextPartNumber}`);
              setShowPartTransitionOverlay(true);
              setTimeout(() => setShowPartTransitionOverlay(false), 500);
            }
            setCurrentPartIndex(prev => prev + 1);
            setCurrentQuestionIndex(0);
            if (questionGroups[currentPartIndex + 1]?.part_number === 2) {
              setPart2Phase('intro');
            }
          } else {
            handleSubmit();
          }
        };
        
        playExaminerAudio(part2EndItem.fallback_text, part2EndItem.audio_url);
      }
    } else if (canGoNextQuestion) {
      setCurrentQuestionIndex(prev => prev + 1); // Corrected: increment question index
    } else if (canGoNextPart) {
      const nextPartNumber = questionGroups[currentPartIndex + 1]?.part_number;
      if (nextPartNumber) {
        setPartTransitionMessage(`Moving to Part ${nextPartNumber}`);
        setShowPartTransitionOverlay(true);
        setTimeout(() => setShowPartTransitionOverlay(false), 500); // Reduced to 500ms
      }
      setCurrentPartIndex(prev => prev + 1);
      setCurrentQuestionIndex(0);
      if (questionGroups[currentPartIndex + 1]?.part_number === 2) {
        setPart2Phase('intro');
      }
    } else {
      handleSubmit();
    }
  }, [isRecording, stopRecording, stopExaminerAudio, currentGroup, part2Phase, canGoNextQuestion, canGoNextPart, currentPartIndex, questionGroups, handleSubmit]);

  // handlePrev removed - Back button no longer shown to avoid confusion when audio is playing


  if (showMicrophoneTest) {
    return (
      <div className="min-h-screen bg-secondary flex items-center justify-center">
        <MicrophoneTest 
          onTestComplete={(_accent) => {
            setShowMicrophoneTest(false);
            setTestPhase('ready');
            // Enter fullscreen mode automatically
            enterFullscreen();
          }}
          onBack={() => navigate('/speaking/cambridge-ielts-a')}
        />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-secondary flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Loading test...</div>
      </div>
    );
  }

  if (!speakingTest || !currentGroup || !currentQuestion) {
    return (
      <div className="min-h-screen bg-secondary flex items-center justify-center">
        <div className="text-destructive">Speaking test or questions not found</div>
      </div>
    );
  }

  // Show submission error state
  if (submissionError) {
    return (
      <SubmissionErrorState
        error={submissionError}
        onResubmit={handleResubmit}
        isResubmitting={isResubmitting}
        testTopic={speakingTest?.name}
        module="speaking"
        backLink="/speaking"
        backLabel="Return to Speaking Tests"
      />
    );
  }

  return (
    <HighlightNoteProvider testId={testId!}>
      <div className="min-h-screen bg-background flex flex-col">
        {/* Offline Banner */}
        <OfflineBanner hasPendingAnswers={Object.keys(audioBlobs.current).length > 0} />
        
        {/* Header - Clean Cambridge Style */}
        <header className="border-b bg-card">
          <div className="container mx-auto px-2 md:px-4 py-2 md:py-3 flex items-center justify-between">
            <div className="flex items-center gap-1 md:gap-3">
              <Button 
                variant="ghost" 
                size="icon" 
                onClick={() => {
                  exitRequestedRef.current = true;
                  navigate('/speaking/cambridge-ielts-a');
                }}
                title="Back to Speaking Tests"
                className="h-8 w-8 md:h-10 md:w-10"
              >
                <ArrowLeft className="w-4 h-4 md:w-5 md:h-5" />
              </Button>
              <Badge variant="outline" className="font-mono text-xs md:text-sm">
                Back
              </Badge>
              
              {/* Device Audio indicator - shows when using browser TTS */}
              {usingDeviceAudio && (
                <Badge 
                  variant="secondary" 
                  className="flex items-center gap-1 bg-amber-500/20 text-amber-600 dark:text-amber-400 border-amber-500/30"
                >
                  <Volume2 className="h-3 w-3" />
                  <span className="text-xs">Device Audio</span>
                </Badge>
              )}
              
              {/* Network status indicator */}
              {!isOnline && (
                <Badge variant="destructive" className="text-xs animate-pulse gap-1">
                  <WifiOff className="w-3 h-3" />
                  Offline
                </Badge>
              )}
              
              <span className="text-xs md:text-sm text-muted-foreground hidden sm:inline truncate max-w-[120px] md:max-w-none">
                {speakingTest.name}
              </span>
            </div>
            
            <div className="flex items-center gap-1 md:gap-2">
              {/* Timer: ONLY runs during recording (or Part 2 preparation). */}
              {(() => {
                const isCountdownActive =
                  (currentGroup?.part_number === 2 && part2Phase === 'preparation') ||
                  testPhase === 'recording';

                if (!isCountdownActive || timeLeft <= 0) return null;

                return (
                  <div
                    className={cn(
                      "flex items-center gap-1 md:gap-2 px-2 md:px-3 py-1 rounded-full font-mono text-sm md:text-lg",
                      isPaused ? "bg-warning/20 text-warning" :
                      timeLeft <= 10 ? "bg-destructive/20 text-destructive animate-pulse" : "bg-muted"
                    )}
                  >
                    <SpeakingTimer
                      timeLeft={timeLeft}
                      setTimeLeft={setTimeLeft}
                      isPaused={isPaused}
                      onTimeEnd={handleCurrentTimerEnd}
                      isDone={currentGroup?.part_number === 2 && part2Phase === 'done'}
                    />
                    {isPaused && <span className="text-xs ml-1 hidden sm:inline">(Paused)</span>}
                  </div>
                );
              })()}
              
              {/* Pause/Resume button */}
              {isRecording && (
                <Button
                  variant={isPaused ? "default" : "outline"}
                  size="sm"
                  onClick={togglePause}
                  className="gap-1 md:gap-2 h-8 px-2 md:px-3"
                >
                  {isPaused ? (
                    <>
                      <MicIcon className="w-3 h-3 md:w-4 md:h-4" />
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
              
              <SpeakingTestControls
                fontSize={fontSize}
                setFontSize={setFontSize}
                isFullscreen={isFullscreen}
                toggleFullscreen={toggleFullscreen}
                isPaused={isPaused}
                togglePause={togglePause}
              />
              {/* Volume control with mute button and waveform visualization */}
              <AudioVolumeControl
                volume={volume}
                setVolume={setVolume}
                isMuted={isMuted}
                setIsMuted={setIsMuted}
                audioRef={examinerAudioRef}
                isPlaying={isPlayingExaminerAudio}
              />
              <Button variant="ghost" size="icon" onClick={() => setIsNoteSidebarOpen(true)} className="relative h-8 w-8 md:h-10 md:w-10">
                <StickyNote size={18} />
              </Button>
            </div>
          </div>
        </header>

        {/* Main content - Centered like AI Speaking Test */}
        <main className="flex-1 container mx-auto px-3 md:px-4 py-4 md:py-8 max-w-3xl pb-24">
          {/* Examiner speaking text display - REMOVED: Now only shown in the waiting indicator section below */}

          {/* Part 2 Cue Card Display */}
          {currentGroup.part_number === 2 && part2Phase !== 'intro' && (
            <Card className="mb-4 md:mb-6">
              <CardContent className="p-4 md:p-6">
                <h3 className="font-bold text-lg md:text-xl mb-3 md:mb-4 text-primary">{currentGroup.cue_card_topic}</h3>
                <div 
                  className="whitespace-pre-line text-sm md:text-base text-muted-foreground prose prose-sm max-w-none"
                  dangerouslySetInnerHTML={{ __html: renderRichText(currentGroup.cue_card_content || '') }}
                />
                {part2Phase === 'preparation' && (
                  <p className="text-xs text-muted-foreground mt-4">
                    Preparation Time: {currentGroup.preparation_time_seconds} seconds
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          {/* Current Question Display - Hidden during part_intro/question_audio phases */}
          {currentGroup.part_number !== 2 &&
            testPhase !== 'part_intro' &&
            testPhase !== 'question_audio' && (
              <Card className="mb-4 md:mb-6">
                <CardContent className="p-4 md:p-6">
                  <div className="flex items-center gap-2 mb-2 md:mb-3">
                    <Badge className="text-xs md:text-sm">
                      {`Question ${currentQuestion.question_number}`}
                    </Badge>
                  </div>
                  <p className="text-base md:text-lg" style={{ fontSize: `${fontSize}px` }}>
                    <span dangerouslySetInnerHTML={{ __html: renderRichText(currentQuestion.question_text) }} />
                  </p>
                </CardContent>
              </Card>
            )}

          {/* Recording indicator with controls - Clean style like AI Speaking Test */}
          {isRecording ? (
            <div className="flex flex-col items-center gap-3 md:gap-4 py-6 md:py-8">
              <div className="relative w-16 h-16 md:w-20 md:h-20">
                {/* Audio level indicator overlay */}
                <AudioLevelIndicator 
                  stream={mediaRecorder?.stream || null}
                  isActive={isRecording}
                  variant="circle"
                  className="absolute inset-0 w-full h-full"
                />
                <div className="absolute inset-0 rounded-full bg-destructive/20 flex items-center justify-center">
                  <MicIcon className="w-8 h-8 md:w-10 md:h-10 text-destructive" />
                </div>
              </div>
              {/* Audio level bars */}
              <AudioLevelIndicator 
                stream={mediaRecorder?.stream || null}
                isActive={isRecording}
                variant="bars"
                className="mt-2"
              />
              <p className="text-sm md:text-base text-muted-foreground">Recording your response...</p>
              <p className="text-xs md:text-sm text-muted-foreground font-mono">
                Recording: {Math.floor(recordingDuration / 60).toString().padStart(2, '0')}:{String(recordingDuration % 60).padStart(2, '0')}
              </p>
              
              {/* Action buttons */}
              <div className="flex flex-col sm:flex-row items-center gap-2 md:gap-3 mt-2 md:mt-4 w-full sm:w-auto px-4 sm:px-0">
                <Button 
                  onClick={resetCurrentRecording} 
                  variant="outline" 
                  size="default"
                  className="gap-2 border-destructive/50 text-destructive hover:bg-destructive/10 w-full sm:w-auto"
                  disabled={isSubmitting || isPaused}
                >
                  Retake
                </Button>
                
                <Button 
                  onClick={async () => {
                    // Single source of truth: handleNext stops recording and advances.
                    await handleNext();
                  }}
                  variant="default" 
                  size="default"
                  className="w-full sm:w-auto"
                >
                  Stop & Next
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-4 py-6 md:py-8">
              {/* Show waiting indicator while examiner audio is playing */}
              {(isPlayingExaminerAudio || testPhase === 'part_intro' || testPhase === 'question_audio') && (
                <div className="flex flex-col items-center gap-3">
                  <div className="relative">
                    <div className="rounded-full h-16 w-16 flex items-center justify-center bg-muted animate-pulse">
                      <Volume2 className="w-8 h-8 text-primary" />
                    </div>
                  </div>
                  <span className="text-sm font-medium text-muted-foreground">
                    {testPhase === 'part_intro' ? 'Listen to the introduction...' : 'Listen to the question...'}
                  </span>
                  {/* Show current speaking text with phase indicator - REMOVED third instance */}
                </div>
              )}
            </div>
          )}

          {/* Part 2 - Start Speaking Early Button */}
          {currentGroup.part_number === 2 && part2Phase === 'preparation' && (
            <div className="flex justify-center py-4">
              <Button
                onClick={() => {
                  // Stop any currently playing audio first
                  stopExaminerAudio();
                  setTimeLeft(currentGroup.speaking_time_seconds || TIMING.PART2_SPEAK);
                  setPart2Phase('speaking');
                  startRecording();
                }}
                size="lg"
                variant="default"
              >
                <MicIcon className="w-5 h-5 mr-2" />
                Start Speaking Now
              </Button>
            </div>
          )}
        </main>

        {/* Progress indicator - Fixed bottom bar (Back/Next removed to prevent audio confusion) */}
        <div className="fixed bottom-0 left-0 right-0 bg-card border-t p-2 md:p-4 z-40">
          <div className="container mx-auto max-w-3xl">
            <div className="flex items-center justify-center gap-4 mb-2 flex-wrap">
              <div className="flex items-center gap-2 text-xs md:text-sm text-muted-foreground">
                <span>Part {currentPartIndex + 1} of {questionGroups.length}</span>
              </div>

              {/* Question progress within current part */}
              {currentQuestionsInGroup.length > 0 && (
                <div className="flex items-center gap-1.5 text-xs md:text-sm">
                  <span className="text-muted-foreground">•</span>
                  <span className="font-medium text-foreground">
                    Question {currentQuestionIndex + 1} of {currentQuestionsInGroup.length}
                  </span>
                </div>
              )}

              {/* Dots indicator for questions in current part */}
              {currentQuestionsInGroup.length > 1 && (
                <div className="flex items-center gap-1.5" aria-label="Question progress">
                  {currentQuestionsInGroup.map((q, idx) => (
                    <span
                      key={q.id}
                      className={cn(
                        'h-2 w-2 rounded-full transition-colors',
                        idx === currentQuestionIndex ? 'bg-primary' : 'bg-muted-foreground/40'
                      )}
                      aria-hidden="true"
                    />
                  ))}
                </div>
              )}
            </div>
            <Progress value={((currentPartIndex + 1) / questionGroups.length) * 100} className="h-1.5 md:h-2" />
          </div>
        </div>
      </div>
      {testId && (
        <NoteSidebar 
          testId={testId} 
          isOpen={isNoteSidebarOpen} 
          onOpenChange={setIsNoteSidebarOpen} 
          renderRichText={renderRichText}
        />
      )}
      {showAILoadingScreen && (
        <AILoadingScreen
          title="Evaluating Your Speaking Performance"
          description="Our AI is analyzing your audio and crafting your personalized feedback report."
          progressSteps={aiProgressSteps}
          currentStepIndex={currentAIStepIndex}
          estimatedTime="30-60 seconds"
        />
      )}
      {/* Non-intrusive part transition indicator */}
      <div 
        className={cn(
          "fixed top-20 left-1/2 -translate-x-1/2 z-50 transition-all duration-500 ease-out pointer-events-none",
          showPartTransitionOverlay 
            ? "opacity-100 translate-y-0" 
            : "opacity-0 -translate-y-4"
        )}
      >
        <div className="relative flex items-center gap-3 px-6 py-3 rounded-full bg-gradient-to-r from-primary/90 to-primary shadow-lg shadow-primary/25 border border-primary/20">
          <div className="flex items-center justify-center w-8 h-8 rounded-full bg-white/20 animate-pulse">
            <svg className="w-4 h-4 text-primary-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
            </svg>
          </div>
          <span className="text-lg font-semibold text-primary-foreground tracking-wide">
            {partTransitionMessage}
          </span>
          <div className="absolute inset-0 rounded-full bg-white/10 animate-ping opacity-20" />
        </div>
      </div>
    </HighlightNoteProvider>
  );
}