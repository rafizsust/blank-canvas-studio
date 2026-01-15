/**
 * Browser-Adaptive Speech Recognition Hook
 * 
 * CRITICAL DESIGN PRINCIPLE:
 * Edge and Chrome are treated as DIFFERENT speech engines.
 * 
 * - Edge: Natural mode, no forced language, preserves fillers
 * - Chrome: Forced accent for stability, ghost word tracking, seamless overlap cycling
 * 
 * KEY FIX: Uses OVERLAPPING recognition instances to eliminate gaps during cycling/restarts
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import {
  detectBrowser,
  isSpeechRecognitionSupported,
  BrowserInfo,
  PauseTracker,
  PauseMetrics,
  GhostWordTracker,
  TranscriptState,
  SpeechRecognitionConfig,
  DEFAULT_CONFIG,
  getStoredAccent,
  setStoredAccent,
} from '@/lib/speechRecognition';

// Web Speech API types
type SpeechRecognitionType = typeof window.SpeechRecognition extends new (...args: unknown[]) => infer R ? R : never;

interface UseSpeechRecognitionReturn {
  isListening: boolean;
  isSupported: boolean;
  error: Error | null;
  rawTranscript: string;
  finalTranscript: string;
  interimTranscript: string;
  words: TranscriptState['words'];
  ghostWords: string[];
  pauseMetrics: PauseMetrics | null;
  sessionDuration: number;
  browser: BrowserInfo;
  startListening: () => void;
  stopListening: () => void;
  abort: () => void;
  clearTranscript: () => void;
  selectedAccent: string;
  setAccent: (accent: string) => void;
}

// CRITICAL: Chrome cycle interval BEFORE Chrome's ~45-second cutoff
const CHROME_CYCLE_INTERVAL_MS = 35000;

// Edge cycle interval - Edge has longer tolerance but still needs cycling
const EDGE_CYCLE_INTERVAL_MS = 55000;

// Overlap duration: how long both instances run together during transition
const OVERLAP_DURATION_MS = 3000;

// Maximum consecutive restart failures
const MAX_CONSECUTIVE_FAILURES = 10;

export function useBrowserAdaptiveSpeechRecognition(
  config: SpeechRecognitionConfig = {}
): UseSpeechRecognitionReturn {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  
  const [browser] = useState<BrowserInfo>(() => detectBrowser());
  const [isSupported] = useState(() => isSpeechRecognitionSupported());
  const [isListening, setIsListening] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [rawTranscript, setRawTranscript] = useState('');
  const [finalTranscript, setFinalTranscript] = useState('');
  const [interimTranscript, setInterimTranscript] = useState('');
  const [words, setWords] = useState<TranscriptState['words']>([]);
  const [ghostWords, setGhostWords] = useState<string[]>([]);
  const [pauseMetrics, setPauseMetrics] = useState<PauseMetrics | null>(null);
  const [sessionDuration, setSessionDuration] = useState(0);
  const [selectedAccent, setSelectedAccent] = useState(() => config.accent || getStoredAccent());
  
  // DUAL RECOGNITION INSTANCES for seamless overlap transitions
  const primaryRecognitionRef = useRef<SpeechRecognitionType | null>(null);
  const secondaryRecognitionRef = useRef<SpeechRecognitionType | null>(null);
  const activeInstanceRef = useRef<'primary' | 'secondary'>('primary');

  // Restart guard: prevents intentionally aborted instances (during cycling/cleanup)
  // from auto-restarting in their `onend` handler.
  const restartAllowedRef = useRef<{ primary: boolean; secondary: boolean }>({
    primary: true,
    secondary: true,
  });

  // Watchdog: Chrome sometimes stops emitting results without firing `end`.
  // If we haven't seen results in a while, force a seamless cycle.
  const lastResultAtRef = useRef<number>(0);
  const lastCycleAtRef = useRef<number>(0);
  const watchdogTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  
  const isManualStopRef = useRef(false);
  const isListeningRef = useRef(false);
  const wordIdCounterRef = useRef(0);
  const sessionStartTimeRef = useRef(0);
  const cycleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pauseTrackerRef = useRef(new PauseTracker());
  const ghostTrackerRef = useRef(new GhostWordTracker());
  const consecutiveFailuresRef = useRef(0);
  const lastProcessedTextRef = useRef(new Set<string>());
  const lastFinalTextRef = useRef('');
  
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null;
    if (isListening && sessionStartTimeRef.current > 0) {
      interval = setInterval(() => setSessionDuration(Date.now() - sessionStartTimeRef.current), 1000);
    }
    return () => { if (interval) clearInterval(interval); };
  }, [isListening]);

  // Chrome watchdog: if recognition stops producing results without firing `end`, force a seamless cycle.
  useEffect(() => {
    if (!browser.isChrome || !isListening) {
      if (watchdogTimerRef.current) {
        clearInterval(watchdogTimerRef.current);
        watchdogTimerRef.current = null;
      }
      return;
    }

    if (watchdogTimerRef.current) clearInterval(watchdogTimerRef.current);

    watchdogTimerRef.current = setInterval(() => {
      if (!isListeningRef.current || isManualStopRef.current) return;

      const now = Date.now();
      const sinceResult = now - (lastResultAtRef.current || now);
      const sinceCycle = now - (lastCycleAtRef.current || 0);

      // If we haven't received anything for a while, Chrome has likely wedged.
      // Force a cycle (but not too frequently).
      if (sinceResult > 12000 && sinceCycle > 6000) {
        console.warn('[SpeechRecognition] Watchdog: no results recently; forcing seamless cycle');
        performSeamlessCycle();
      }
    }, 2500);

    return () => {
      if (watchdogTimerRef.current) {
        clearInterval(watchdogTimerRef.current);
        watchdogTimerRef.current = null;
      }
    };
  }, [browser.isChrome, isListening, performSeamlessCycle]);
  
  useEffect(() => {
    return () => {
      primaryRecognitionRef.current?.abort();
      secondaryRecognitionRef.current?.abort();
      if (cycleTimerRef.current) clearTimeout(cycleTimerRef.current);
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      if (watchdogTimerRef.current) clearInterval(watchdogTimerRef.current);
    };
  }, []);

  const resetSilenceTimeout = useCallback(() => {
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    silenceTimerRef.current = setTimeout(() => {
      if (isListeningRef.current && !isManualStopRef.current) {
        setError(new Error('No speech detected for extended period'));
      }
    }, mergedConfig.silenceTimeoutMs);
  }, [mergedConfig.silenceTimeoutMs]);

  const createRecognitionInstance = useCallback((): SpeechRecognitionType | null => {
    const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognitionAPI) return null;
    
    const recognition = new SpeechRecognitionAPI();
    recognition.continuous = true;
    recognition.interimResults = true;
    
    if (browser.isEdge) {
      // Edge: DO NOT set lang - preserves fillers
      console.log('[SpeechRecognition] Creating Edge instance: Natural mode');
    } else if (browser.isChrome) {
      recognition.lang = selectedAccent;
      console.log(`[SpeechRecognition] Creating Chrome instance: ${selectedAccent}`);
    } else {
      recognition.lang = selectedAccent;
    }
    
    return recognition;
  }, [browser.isEdge, browser.isChrome, selectedAccent]);

  const handleResult = useCallback((event: Event, instanceId: string) => {
    if (!isListeningRef.current) return;

    lastResultAtRef.current = Date.now();

    const e = event as unknown as { resultIndex: number; results: SpeechRecognitionResultList };
    resetSilenceTimeout();
    pauseTrackerRef.current.recordSpeechEvent();
    consecutiveFailuresRef.current = 0;

    let newFinalText = '';
    let newInterimText = '';
    const newWords: TranscriptState['words'] = [];

    for (let i = e.resultIndex; i < e.results.length; i++) {
      const result = e.results[i];
      const transcript = result[0].transcript;

      if (result.isFinal) {
        // CRITICAL: Deduplicate across all instances
        const normalizedText = transcript.trim().toLowerCase();
        if (lastProcessedTextRef.current.has(normalizedText) || transcript === lastFinalTextRef.current) {
          console.log(`[SpeechRecognition] Skipping duplicate from ${instanceId}`);
          continue;
        }

        lastProcessedTextRef.current.add(normalizedText);
        lastFinalTextRef.current = transcript;

        // Keep set size manageable
        if (lastProcessedTextRef.current.size > 50) {
          const entries = Array.from(lastProcessedTextRef.current);
          lastProcessedTextRef.current = new Set(entries.slice(-30));
        }

        const finalWords = transcript.trim().split(/\s+/).filter((w: string) => w.length > 0);
        const finalWordsSet = new Set<string>(finalWords.map((w: string) => w.toLowerCase()));

        if (browser.isChrome) {
          const recovered = ghostTrackerRef.current.extractAcceptedGhosts(finalWordsSet);
          if (recovered.length > 0) {
            console.log('[SpeechRecognition] Recovered ghost words:', recovered);
            setGhostWords(prev => [...prev, ...recovered]);
          }
        }

        finalWords.forEach((text: string) => {
          newWords.push({
            text,
            timestamp: Date.now(),
            wordId: wordIdCounterRef.current++,
            isGhost: false,
            isFiller: GhostWordTracker.isFillerWord(text)
          });
        });
        newFinalText += transcript + ' ';
        console.log(`[SpeechRecognition] Final from ${instanceId}:`, transcript.substring(0, 40));
      } else {
        newInterimText = transcript;
        if (browser.isChrome) {
          ghostTrackerRef.current.trackInterimWords(transcript.trim().split(/\s+/).filter((w: string) => w.length > 0));
        }
      }
    }

    if (newFinalText) {
      const trimmed = newFinalText.trim();
      setFinalTranscript(prev => (prev ? `${prev} ${trimmed}` : trimmed).trim());
      setRawTranscript(prev => (prev ? `${prev} ${trimmed}` : trimmed).trim());
      setWords(prev => [...prev, ...newWords]);
    }
    setInterimTranscript(newInterimText);
  }, [browser.isChrome, resetSilenceTimeout]);

  const handleError = useCallback((event: Event, instanceId: string) => {
    const e = event as unknown as { error: string };
    if (e.error === 'no-speech' || e.error === 'aborted') return;
    
    console.warn(`[SpeechRecognition] Error from ${instanceId}:`, e.error);
    consecutiveFailuresRef.current++;
    
    if (consecutiveFailuresRef.current >= MAX_CONSECUTIVE_FAILURES) {
      setError(new Error(`Speech recognition error: ${e.error}`));
    }
  }, []);

  const handleEnd = useCallback((recognition: SpeechRecognitionType, instanceId: string) => {
    if (!isListeningRef.current || isManualStopRef.current) return;

    const id = instanceId === 'primary' || instanceId === 'secondary'
      ? instanceId
      : (activeInstanceRef.current as 'primary' | 'secondary');

    // If we intentionally aborted this instance (during seamless cycling), do NOT restart it.
    if (!restartAllowedRef.current[id]) {
      return;
    }

    console.log(`[SpeechRecognition] Instance ${instanceId} ended, restarting...`);

    // Immediate restart
    setTimeout(() => {
      if (isListeningRef.current && !isManualStopRef.current && recognition) {
        // Re-check in case we toggled the guard after scheduling
        if (!restartAllowedRef.current[id]) return;
        try {
          recognition.start();
          console.log(`[SpeechRecognition] Instance ${instanceId} restarted`);
        } catch {
          // Already started or failed
        }
      }
    }, 50);
  }, []);

  const setupRecognitionHandlers = useCallback((recognition: SpeechRecognitionType, instanceId: string) => {
    recognition.onresult = (event: Event) => handleResult(event, instanceId);
    recognition.onerror = (event: Event) => handleError(event, instanceId);
    recognition.onend = () => handleEnd(recognition, instanceId);
    recognition.onstart = () => {
      if (!isListening) {
        setIsListening(true);
        setError(null);
      }
    };
  }, [handleResult, handleError, handleEnd, isListening]);

  const performSeamlessCycle = useCallback(() => {
    if (!isListeningRef.current || isManualStopRef.current) return;

    const currentActive = activeInstanceRef.current;
    const nextActive = currentActive === 'primary' ? 'secondary' : 'primary';

    // Prevent a storm of cycles if Chrome is glitching
    lastCycleAtRef.current = Date.now();

    console.log(`[SpeechRecognition] Starting seamless cycle: ${currentActive} -> ${nextActive}`);

    // Create and start new instance FIRST
    const newRecognition = createRecognitionInstance();
    if (!newRecognition) {
      console.error('[SpeechRecognition] Failed to create new instance');
      return;
    }

    // New instance is allowed to restart (it's now the active one)
    restartAllowedRef.current[nextActive] = true;

    setupRecognitionHandlers(newRecognition, nextActive);

    try {
      newRecognition.start();

      if (nextActive === 'primary') {
        primaryRecognitionRef.current = newRecognition;
      } else {
        secondaryRecognitionRef.current = newRecognition;
      }

      // After overlap, stop old instance
      setTimeout(() => {
        if (!isListeningRef.current) return;

        const oldRecognition = currentActive === 'primary'
          ? primaryRecognitionRef.current
          : secondaryRecognitionRef.current;

        if (oldRecognition) {
          try {
            // This abort is intentional; block its onend auto-restart.
            restartAllowedRef.current[currentActive] = false;
            oldRecognition.abort();
            console.log(`[SpeechRecognition] Old instance ${currentActive} stopped`);
          } catch {
            // Already stopped
          }
        }

        activeInstanceRef.current = nextActive;
      }, OVERLAP_DURATION_MS);

    } catch (err) {
      console.error('[SpeechRecognition] Failed to start new instance:', err);
    }

    // Schedule next cycle
    scheduleCycle();
  }, [createRecognitionInstance, setupRecognitionHandlers, scheduleCycle]);

  const scheduleCycle = useCallback(() => {
    if (cycleTimerRef.current) {
      clearTimeout(cycleTimerRef.current);
    }
    
    const cycleInterval = browser.isChrome ? CHROME_CYCLE_INTERVAL_MS : EDGE_CYCLE_INTERVAL_MS;
    
    cycleTimerRef.current = setTimeout(() => {
      if (isListeningRef.current && !isManualStopRef.current) {
        performSeamlessCycle();
      }
    }, cycleInterval);
  }, [browser.isChrome, performSeamlessCycle]);

  const startListening = useCallback(() => {
    if (!isSupported) {
      setError(new Error('Speech recognition not supported'));
      return;
    }
    
    console.log('[SpeechRecognition] Starting...');
    
    const recognition = createRecognitionInstance();
    if (!recognition) {
      setError(new Error('Failed to create speech recognition'));
      return;
    }
    
    setupRecognitionHandlers(recognition, 'primary');
    primaryRecognitionRef.current = recognition;
    activeInstanceRef.current = 'primary';
    
    isManualStopRef.current = false;
    isListeningRef.current = true;
    consecutiveFailuresRef.current = 0;
    lastProcessedTextRef.current = new Set();
    lastFinalTextRef.current = '';
    wordIdCounterRef.current = 0;
    sessionStartTimeRef.current = Date.now();
    pauseTrackerRef.current.start();
    ghostTrackerRef.current.reset();
    
    try {
      recognition.start();
      resetSilenceTimeout();
      scheduleCycle();
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to start'));
    }
  }, [isSupported, createRecognitionInstance, setupRecognitionHandlers, resetSilenceTimeout, scheduleCycle]);

  const stopListening = useCallback(() => {
    console.log('[SpeechRecognition] Stopping...');
    
    isManualStopRef.current = true;
    isListeningRef.current = false;
    
    if (cycleTimerRef.current) clearTimeout(cycleTimerRef.current);
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    
    // Stop both instances
    [primaryRecognitionRef.current, secondaryRecognitionRef.current].forEach(recognition => {
      if (recognition) {
        try {
          recognition.stop();
        } catch {
          // Already stopped
        }
      }
    });
    
    setIsListening(false);
    pauseTrackerRef.current.stop();
    setPauseMetrics(pauseTrackerRef.current.getMetrics());
  }, []);

  const abort = useCallback(() => {
    isManualStopRef.current = true;
    isListeningRef.current = false;
    
    if (cycleTimerRef.current) clearTimeout(cycleTimerRef.current);
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    
    [primaryRecognitionRef.current, secondaryRecognitionRef.current].forEach(recognition => {
      if (recognition) {
        try {
          recognition.abort();
        } catch {
          // Already stopped
        }
      }
    });
    
    primaryRecognitionRef.current = null;
    secondaryRecognitionRef.current = null;
    setIsListening(false);
  }, []);

  const clearTranscript = useCallback(() => {
    setRawTranscript('');
    setFinalTranscript('');
    setInterimTranscript('');
    setWords([]);
    setGhostWords([]);
    setPauseMetrics(null);
    setSessionDuration(0);
    wordIdCounterRef.current = 0;
    lastProcessedTextRef.current = new Set();
    lastFinalTextRef.current = '';
    ghostTrackerRef.current.reset();
    pauseTrackerRef.current.reset();
  }, []);

  const setAccent = useCallback((accent: string) => {
    setSelectedAccent(accent);
    setStoredAccent(accent);
    if (browser.isChrome && isListening) {
      stopListening();
      setTimeout(() => startListening(), 200);
    }
  }, [browser.isChrome, isListening, stopListening, startListening]);

  return {
    isListening,
    isSupported,
    error,
    rawTranscript,
    finalTranscript,
    interimTranscript,
    words,
    ghostWords,
    pauseMetrics,
    sessionDuration,
    browser,
    startListening,
    stopListening,
    abort,
    clearTranscript,
    selectedAccent,
    setAccent
  };
}
