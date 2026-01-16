/**
 * Advanced Speech Analysis Hook
 * Orchestrates browser-adaptive speech recognition and audio analysis for text-based evaluation
 *
 * ARCHITECTURE PRINCIPLES (ACCURACY FIRST):
 * 
 * 1. CAPTURE EVERYTHING THE USER SAYS
 *    - No aggressive deduplication that removes legitimate repeated sentences
 *    - No ghost word recovery that corrupts transcripts
 *    - Simple exact-duplicate prevention only
 * 
 * 2. SINGLE SpeechRecognition INSTANCE per session
 *    - Proactive restart via watchdog (stop only)
 *    - Restart occurs ONLY inside onend (same instance)
 * 
 * 3. BROWSER-ADAPTIVE CONFIG
 *    - Chrome: User-selected accent, controlled cycling
 *    - Edge: Auto-detect language, more tolerance
 */

import { useState, useRef, useCallback } from 'react';
import { AudioFeatureExtractor, AudioAnalysisResult } from '@/lib/audioFeatureExtractor';
import { analyzeProsody, ProsodyMetrics, createEmptyProsodyMetrics } from '@/lib/prosodyAnalyzer';
import { WordConfidenceTracker, WordConfidence } from '@/lib/wordConfidenceTracker';
import { calculateFluency, FluencyMetrics, createEmptyFluencyMetrics } from '@/lib/fluencyCalculator';
import {
  detectBrowser,
  PauseTracker,
  getStoredAccent,
  BrowserInfo
} from '@/lib/speechRecognition';

export interface SpeechAnalysisResult {
  rawTranscript: string;           // What browser heard (with fillers, for fluency)
  cleanedTranscript: string;       // Fillers removed (for vocab/grammar)
  wordConfidences: WordConfidence[];
  fluencyMetrics: FluencyMetrics;
  prosodyMetrics: ProsodyMetrics;
  audioAnalysis: AudioAnalysisResult;
  durationMs: number;
  overallClarityScore: number;     // 0-100
  // Browser-adaptive additions
  ghostWords: string[];            // DEPRECATED: Always empty now (ghost recovery removed)
  pauseBreakdowns: number;         // Number of significant pauses
  browserMode: 'edge-natural' | 'chrome-accent' | 'other';
}

interface UseAdvancedSpeechAnalysisOptions {
  language?: string;
  onInterimResult?: (transcript: string) => void;
  onError?: (error: Error) => void;
  onGhostWordRecovered?: (word: string) => void; // DEPRECATED: No longer called
}

// Browser SpeechRecognition types
interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
  resultIndex: number;
}

interface SpeechRecognitionResultList {
  length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: {
    isFinal: boolean;
    [index: number]: { transcript: string };
  };
}

interface SpeechRecognitionResult {
  isFinal: boolean;
  [index: number]: { transcript: string };
}

interface SpeechRecognitionErrorEvent extends Event {
  error: string;
  message?: string;
}

interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onstart: (() => void) | null;
  onend: (() => void) | null;
}

declare global {
  interface Window {
    SpeechRecognition: new () => SpeechRecognition;
    webkitSpeechRecognition: new () => SpeechRecognition;
  }
}

// Proactive restart BEFORE Chrome's ~45-second cutoff
const CHROME_MAX_SESSION_MS = 35000;

// Edge restart interval
const EDGE_MAX_SESSION_MS = 45000;

// Delay before restarting after onend (Edge needs extra time for late results)
const RESTART_DELAY_MS = 250;
const EDGE_LATE_RESULT_DELAY_MS = 300;

// Watchdog check interval
const WATCHDOG_INTERVAL_MS = 2000;

// Maximum consecutive restart attempts before giving up
const MAX_CONSECUTIVE_FAILURES = 10;

export function useAdvancedSpeechAnalysis(options: UseAdvancedSpeechAnalysisOptions = {}) {
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState('');
  const [error, setError] = useState<Error | null>(null);
  const [isSupported, setIsSupported] = useState(true);
  const [currentRms, setCurrentRms] = useState(0);

  // Browser detection
  const browserRef = useRef<BrowserInfo>(detectBrowser());

  const audioExtractorRef = useRef<AudioFeatureExtractor | null>(null);
  const wordTrackerRef = useRef<WordConfidenceTracker | null>(null);

  // SINGLE recognition instance (non-negotiable)
  const recognitionRef = useRef<SpeechRecognition | null>(null);

  // Controlled restart flags
  const isRestartingRef = useRef(false);
  const isManualStopRef = useRef(false);

  // Watchdog timer
  const watchdogTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // CRITICAL: Append-only transcript storage
  // We ONLY append new final results, never modify or deduplicate
  const finalSegmentsRef = useRef<string[]>([]);
  
  const startTimeRef = useRef(0);
  const isAnalyzingRef = useRef(false);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const rmsMonitorRef = useRef<number | null>(null);

  // Browser-adaptive tracking
  const pauseTrackerRef = useRef<PauseTracker | null>(null);
  const consecutiveFailuresRef = useRef(0);
  
  // Simple exact-duplicate prevention (only prevents the EXACT same segment from being added twice in a row)
  const lastExactFinalRef = useRef('');

  // Timing
  const sessionStartRef = useRef(0);

  // Store the language for dynamic updates
  const languageRef = useRef(options.language || getStoredAccent());

  // Update language ref when options change
  if (options.language && options.language !== languageRef.current) {
    languageRef.current = options.language;
  }

  /**
   * Create a new speech recognition instance with browser-specific configuration
   * IMPORTANT: Called ONLY once per recording session.
   */
  const createRecognitionInstance = useCallback((): SpeechRecognition | null => {
    const SpeechRecognitionClass = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognitionClass) return null;

    const browser = browserRef.current;
    const recognition = new SpeechRecognitionClass();

    recognition.continuous = true;
    recognition.interimResults = true;

    // CRITICAL: Browser-specific language configuration
    if (browser.isEdge) {
      // EDGE: DO NOT set lang - preserves fillers and natural punctuation
      console.log('[SpeechAnalysis] Creating Edge instance: Natural mode');
    } else if (browser.isChrome) {
      // CHROME: Force accent for stability
      recognition.lang = languageRef.current;
      console.log(`[SpeechAnalysis] Creating Chrome instance: ${recognition.lang}`);
    } else {
      recognition.lang = languageRef.current;
    }

    return recognition;
  }, []);

  /**
   * Handle speech recognition results
   * 
   * CRITICAL: This is the SIMPLE, ROBUST version.
   * - No overlap detection (it was removing repeated sentences)
   * - No ghost word recovery (it was corrupting transcripts)
   * - Only exact-duplicate prevention for immediate back-to-back duplicates
   */
  const handleResult = useCallback((event: SpeechRecognitionEvent) => {
    if (!isAnalyzingRef.current) return;

    // Record speech event for pause tracking
    pauseTrackerRef.current?.recordSpeechEvent();

    // Reset failure counter on successful result
    consecutiveFailuresRef.current = 0;

    let interimText = '';

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const text = result[0].transcript;

      if (result.isFinal) {
        const trimmed = text.trim();
        
        // ONLY skip if this is EXACTLY the same as the last final (back-to-back duplicate)
        // This prevents the SAME recognition result from being processed twice
        // But ALLOWS the user to intentionally repeat sentences
        if (trimmed === lastExactFinalRef.current) {
          console.log('[SpeechAnalysis] Skipping exact back-to-back duplicate');
          continue;
        }
        
        if (trimmed.length > 0) {
          // Store as the last exact final for duplicate check
          lastExactFinalRef.current = trimmed;
          
          // APPEND to our segments array - never modify previous segments
          finalSegmentsRef.current.push(trimmed);
          
          // Track for word confidence
          wordTrackerRef.current?.addSnapshot(trimmed, true);
          
          console.log('[SpeechAnalysis] Final segment added:', trimmed.substring(0, 60));
        }
      } else {
        interimText += text;
        wordTrackerRef.current?.addSnapshot(text, false);
      }
    }

    // Build combined transcript from all segments + current interim
    const finalPart = finalSegmentsRef.current.join(' ');
    const combined = (finalPart + ' ' + interimText).trim();
    
    setInterimTranscript(combined);
    options.onInterimResult?.(combined);
  }, [options]);

  /**
   * Handle recognition errors
   */
  const handleError = useCallback((event: SpeechRecognitionErrorEvent) => {
    if (event.error !== 'no-speech' && event.error !== 'aborted') {
      console.warn('[SpeechAnalysis] Error:', event.error);
      consecutiveFailuresRef.current++;

      if (consecutiveFailuresRef.current >= MAX_CONSECUTIVE_FAILURES) {
        const err = new Error(`Speech recognition failed repeatedly: ${event.error}`);
        setError(err);
        options.onError?.(err);
      }
    }
  }, [options]);

  /**
   * Handle recognition end with SAFE restart.
   * IMPORTANT: NEVER create a new instance here.
   */
  const handleEnd = useCallback(() => {
    if (!isAnalyzingRef.current) return;

    const browser = browserRef.current;

    console.log('[SpeechAnalysis] onend', {
      isAnalyzing: isAnalyzingRef.current,
      isManualStop: isManualStopRef.current,
      isRestarting: isRestartingRef.current,
      segmentCount: finalSegmentsRef.current.length,
    });

    if (!isAnalyzingRef.current || isManualStopRef.current) return;

    // Only restart if we intentionally stopped OR if browser cut off unexpectedly.
    // In both cases we restart the SAME instance.
    const delay = browser.isEdge ? EDGE_LATE_RESULT_DELAY_MS : RESTART_DELAY_MS;

    setTimeout(() => {
      if (!isAnalyzingRef.current || isManualStopRef.current) {
        isRestartingRef.current = false;
        return;
      }

      // Reset the per-session timer
      sessionStartRef.current = Date.now();
      isRestartingRef.current = false;
      
      // Clear the exact-match duplicate check for new session
      // This allows repeated content across restart boundaries
      lastExactFinalRef.current = '';

      try {
        recognitionRef.current?.start();
        console.log('[SpeechAnalysis] Restarted (same instance)');
      } catch (err) {
        console.warn('[SpeechAnalysis] Restart failed:', err);
        consecutiveFailuresRef.current++;
      }
    }, delay);
  }, []);

  /**
   * Setup event handlers for the single recognition instance
   */
  const setupRecognitionHandlers = useCallback((recognition: SpeechRecognition) => {
    recognition.onresult = (event: SpeechRecognitionEvent) => handleResult(event);
    recognition.onerror = (event: SpeechRecognitionErrorEvent) => handleError(event);
    recognition.onend = () => handleEnd();
  }, [handleResult, handleError, handleEnd]);

  /**
   * Watchdog: the ONLY place allowed to call stop() for proactive restart.
   */
  const startWatchdog = useCallback(() => {
    if (watchdogTimerRef.current) {
      clearInterval(watchdogTimerRef.current);
    }

    const browser = browserRef.current;
    const maxSessionMs = browser.isChrome ? CHROME_MAX_SESSION_MS : EDGE_MAX_SESSION_MS;

    watchdogTimerRef.current = setInterval(() => {
      if (!isAnalyzingRef.current || isManualStopRef.current) return;
      if (isRestartingRef.current) return;

      const elapsed = Date.now() - sessionStartRef.current;
      if (elapsed > maxSessionMs) {
        console.log(`[SpeechAnalysis] Watchdog: proactive restart after ${Math.round(elapsed / 1000)}s`);
        isRestartingRef.current = true;
        try {
          recognitionRef.current?.stop();
        } catch {
          // If stop throws, let onend path handle restart attempt via next end.
        }
      }
    }, WATCHDOG_INTERVAL_MS);
  }, []);

  const stopWatchdog = useCallback(() => {
    if (watchdogTimerRef.current) {
      clearInterval(watchdogTimerRef.current);
      watchdogTimerRef.current = null;
    }
  }, []);

  const start = useCallback(async (stream: MediaStream) => {
    const browser = browserRef.current;
    console.log(`[SpeechAnalysis] Starting with browser: ${browser.browserName}`);

    // Check browser support
    const SpeechRecognitionClass = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognitionClass) {
      setIsSupported(false);
      setError(new Error('Speech recognition not supported in this browser'));
      return false;
    }

    setError(null);
    setIsAnalyzing(true);
    isAnalyzingRef.current = true;
    isManualStopRef.current = false;
    isRestartingRef.current = false;

    setInterimTranscript('');
    setCurrentRms(0);

    // CRITICAL: Reset to empty segments array
    finalSegmentsRef.current = [];
    lastExactFinalRef.current = '';
    
    startTimeRef.current = Date.now();
    sessionStartRef.current = Date.now();

    consecutiveFailuresRef.current = 0;

    // Request screen wake lock
    try {
      if ('wakeLock' in navigator) {
        wakeLockRef.current = await navigator.wakeLock.request('screen');
        console.log('[SpeechAnalysis] Wake lock acquired');
      }
    } catch (err) {
      console.warn('[SpeechAnalysis] Wake lock not available:', err);
    }

    // Initialize browser-adaptive trackers
    pauseTrackerRef.current = new PauseTracker();
    pauseTrackerRef.current.start();

    // Start audio feature extraction
    audioExtractorRef.current = new AudioFeatureExtractor();
    await audioExtractorRef.current.start(stream);

    // Start RMS monitoring
    rmsMonitorRef.current = window.setInterval(() => {
      const frames = audioExtractorRef.current?.getRecentFrames?.(5) || [];
      if (frames.length > 0) {
        const avgRms = frames.reduce((sum, f) => sum + f.rms, 0) / frames.length;
        setCurrentRms(avgRms);
      }
    }, 200);

    // Start word confidence tracking
    wordTrackerRef.current = new WordConfidenceTracker();
    wordTrackerRef.current.start();

    // Create and start SINGLE recognition instance
    const recognition = createRecognitionInstance();
    if (!recognition) {
      setError(new Error('Failed to create speech recognition'));
      return false;
    }

    recognitionRef.current = recognition;
    setupRecognitionHandlers(recognition);

    try {
      recognition.start();
      console.log('[SpeechAnalysis] Recognition started');

      // Start watchdog for proactive restarts (stop only)
      startWatchdog();
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to start speech recognition'));
      return false;
    }

    return true;
  }, [createRecognitionInstance, setupRecognitionHandlers, startWatchdog]);

  const stop = useCallback((): SpeechAnalysisResult | null => {
    const browser = browserRef.current;

    console.log('[SpeechAnalysis] Stopping...', {
      segmentCount: finalSegmentsRef.current.length,
    });

    // Prevent any restart paths
    isManualStopRef.current = true;
    isRestartingRef.current = false;

    setIsAnalyzing(false);
    isAnalyzingRef.current = false;
    setCurrentRms(0);

    // Stop watchdog
    stopWatchdog();

    // Stop RMS monitor
    if (rmsMonitorRef.current) {
      clearInterval(rmsMonitorRef.current);
      rmsMonitorRef.current = null;
    }

    // Release wake lock
    if (wakeLockRef.current) {
      wakeLockRef.current.release().catch(() => {});
      wakeLockRef.current = null;
      console.log('[SpeechAnalysis] Wake lock released');
    }

    // Stop recognition instance
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        // Already stopped
      }
      // Clear ref to avoid any accidental reuse
      recognitionRef.current = null;
    }

    // Get pause metrics
    pauseTrackerRef.current?.stop();
    const pauseMetrics = pauseTrackerRef.current?.getMetrics();

    // Get audio analysis results
    const audioAnalysis = audioExtractorRef.current?.stop() || AudioFeatureExtractor.createEmptyResult();
    const prosodyMetrics = analyzeProsody(audioAnalysis);

    // Build final transcript from all segments
    const rawTranscript = finalSegmentsRef.current.join(' ').trim();
    
    console.log('[SpeechAnalysis] Final transcript:', rawTranscript.substring(0, 100));

    // Silence Safety Gate
    const isSilentAudio = audioAnalysis.silenceRatio > 0.95 && audioAnalysis.averageRms < 0.01;
    if (isSilentAudio && rawTranscript.length > 0) {
      console.warn('[SpeechAnalysis] Silent audio with text detected - possible hallucination, discarding');
      return null;
    }

    if (!rawTranscript) {
      return null;
    }

    // Calculate word confidences
    const wordConfidences = wordTrackerRef.current?.getWordConfidences(rawTranscript) ||
                            WordConfidenceTracker.createEmptyConfidences(rawTranscript);

    const durationMs = Date.now() - startTimeRef.current;

    const fluencyMetrics = calculateFluency(
      wordConfidences,
      audioAnalysis,
      prosodyMetrics,
      durationMs
    );

    // Create cleaned transcript (remove fillers and repeats)
    const cleanedTranscript = wordConfidences
      .filter(w => !w.isFiller && !w.isRepeat)
      .map(w => w.word)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    // Calculate clarity score
    const avgConfidence = wordConfidences.length > 0
      ? wordConfidences.reduce((sum, w) => sum + w.confidence, 0) / wordConfidences.length
      : 0;

    const overallClarityScore = Math.round(
      (avgConfidence * 0.4) +
      (fluencyMetrics.overallFluencyScore * 0.3) +
      (prosodyMetrics.pitchVariation * 0.15) +
      (prosodyMetrics.rhythmConsistency * 0.15)
    );

    // Determine browser mode
    let browserMode: SpeechAnalysisResult['browserMode'] = 'other';
    if (browser.isEdge) browserMode = 'edge-natural';
    else if (browser.isChrome) browserMode = 'chrome-accent';

    console.log(`[SpeechAnalysis] Complete. Duration: ${durationMs}ms, Words: ${wordConfidences.length}`);

    return {
      rawTranscript,
      cleanedTranscript,
      wordConfidences,
      fluencyMetrics,
      prosodyMetrics,
      audioAnalysis,
      durationMs,
      overallClarityScore,
      ghostWords: [], // DEPRECATED: No longer used
      pauseBreakdowns: pauseMetrics?.fluencyBreakdowns || 0,
      browserMode,
    };
  }, [stopWatchdog]);

  const abort = useCallback(() => {
    console.log('[SpeechAnalysis] Aborting...');

    isManualStopRef.current = true;
    isRestartingRef.current = false;

    setIsAnalyzing(false);
    isAnalyzingRef.current = false;
    setCurrentRms(0);

    // Stop watchdog
    stopWatchdog();

    if (rmsMonitorRef.current) {
      clearInterval(rmsMonitorRef.current);
      rmsMonitorRef.current = null;
    }

    if (wakeLockRef.current) {
      wakeLockRef.current.release().catch(() => {});
      wakeLockRef.current = null;
    }

    if (recognitionRef.current) {
      try {
        recognitionRef.current.abort();
      } catch {
        // ignore
      }
      recognitionRef.current = null;
    }

    if (audioExtractorRef.current) {
      audioExtractorRef.current.stop();
      audioExtractorRef.current = null;
    }

    pauseTrackerRef.current = null;
    wordTrackerRef.current = null;
  }, [stopWatchdog]);

  // Exports for backward compatibility and fluency calculations
  const getEmptyFluencyMetrics = useCallback(() => createEmptyFluencyMetrics(), []);
  const getEmptyProsodyMetrics = useCallback(() => createEmptyProsodyMetrics(), []);

  return {
    isAnalyzing,
    isSupported,
    error,
    interimTranscript,
    currentRms,
    start,
    stop,
    abort,
    getEmptyFluencyMetrics,
    getEmptyProsodyMetrics,
  };
}

/**
 * Create an empty speech analysis result for fallback scenarios
 */
export function createEmptySpeechAnalysisResult(): SpeechAnalysisResult {
  return {
    rawTranscript: '',
    cleanedTranscript: '',
    wordConfidences: [],
    fluencyMetrics: createEmptyFluencyMetrics(),
    prosodyMetrics: createEmptyProsodyMetrics(),
    audioAnalysis: AudioFeatureExtractor.createEmptyResult(),
    durationMs: 0,
    overallClarityScore: 0,
    ghostWords: [],
    pauseBreakdowns: 0,
    browserMode: 'other',
  };
}
