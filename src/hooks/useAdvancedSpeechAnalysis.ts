/**
 * Advanced Speech Analysis Hook
 * Orchestrates browser-adaptive speech recognition and audio analysis for text-based evaluation
 *
 * BROWSER-ADAPTIVE DESIGN:
 * - Edge: Natural mode (no forced language), preserves fillers and pauses
 * - Chrome: Forced accent for stability, ghost word tracking
 *
 * CRITICAL: SINGLE SpeechRecognition INSTANCE per session
 * - No primary/secondary recognizers
 * - No seamless overlap cycling
 * - Proactive restart via watchdog (stop only)
 * - Restart occurs ONLY inside onend (same instance)
 */

import { useState, useRef, useCallback } from 'react';
import { AudioFeatureExtractor, AudioAnalysisResult } from '@/lib/audioFeatureExtractor';
import { analyzeProsody, ProsodyMetrics, createEmptyProsodyMetrics } from '@/lib/prosodyAnalyzer';
import { WordConfidenceTracker, WordConfidence } from '@/lib/wordConfidenceTracker';
import { calculateFluency, FluencyMetrics, createEmptyFluencyMetrics } from '@/lib/fluencyCalculator';
import {
  detectBrowser,
  PauseTracker,
  GhostWordTracker,
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
  ghostWords: string[];            // Recovered filler words (Chrome only)
  pauseBreakdowns: number;         // Number of significant pauses
  browserMode: 'edge-natural' | 'chrome-accent' | 'other';
}

interface UseAdvancedSpeechAnalysisOptions {
  language?: string;
  onInterimResult?: (transcript: string) => void;
  onError?: (error: Error) => void;
  onGhostWordRecovered?: (word: string) => void;
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

  const finalTranscriptRef = useRef('');
  const startTimeRef = useRef(0);
  const isAnalyzingRef = useRef(false);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const rmsMonitorRef = useRef<number | null>(null);

  // Browser-adaptive tracking
  const pauseTrackerRef = useRef<PauseTracker | null>(null);
  const ghostTrackerRef = useRef<GhostWordTracker | null>(null);
  const ghostWordsRef = useRef<string[]>([]);
  const consecutiveFailuresRef = useRef(0);
  const lastProcessedTextRef = useRef(new Set<string>());
  const lastFinalTextRef = useRef('');
  
  // CRITICAL: Track last interim text to preserve during restart
  // This captures words that might be lost during the stop/start gap
  const lastInterimTextRef = useRef('');

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
   */
  const handleResult = useCallback((event: SpeechRecognitionEvent) => {
    if (!isAnalyzingRef.current) return;

    const browser = browserRef.current;

    // Record speech event for pause tracking
    pauseTrackerRef.current?.recordSpeechEvent();

    // Reset failure counter on successful result
    consecutiveFailuresRef.current = 0;

    let interimText = '';
    let newFinalText = '';

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const text = result[0].transcript;

      if (result.isFinal) {
        // CRITICAL: Improved deduplication using suffix-based detection
        // This prevents losing new content when Chrome sends overlapping results during restarts
        const normalizedText = text.trim().toLowerCase();
        const words = normalizedText.split(/\s+/).filter(w => w.length > 0);
        
        // Skip if exact same text or empty
        if (normalizedText === lastFinalTextRef.current.toLowerCase() || words.length === 0) {
          console.log('[SpeechAnalysis] Skipping exact duplicate:', text.substring(0, 30));
          continue;
        }
        
        // Check for overlap with previous text using suffix matching
        // This allows new content to be appended even if there's partial overlap
        let newContent = text;
        const lastWords = lastFinalTextRef.current.trim().toLowerCase().split(/\s+/).filter(w => w.length > 0);
        
        if (lastWords.length > 0 && words.length > 0) {
          // Find the longest suffix of lastWords that is a prefix of words
          let overlapLen = 0;
          const maxCheck = Math.min(lastWords.length, words.length, 15); // Limit check for performance
          
          for (let len = 1; len <= maxCheck; len++) {
            const suffix = lastWords.slice(-len).join(' ');
            const prefix = words.slice(0, len).join(' ');
            if (suffix === prefix) {
              overlapLen = len;
            }
          }
          
          if (overlapLen > 0) {
            // Extract only the new portion after the overlap
            const newWords = text.trim().split(/\s+/).slice(overlapLen);
            if (newWords.length === 0) {
              console.log('[SpeechAnalysis] Skipping fully overlapping segment:', text.substring(0, 30));
              continue;
            }
            newContent = newWords.join(' ');
            console.log(`[SpeechAnalysis] Overlap detected (${overlapLen} words), extracting new: "${newContent.substring(0, 40)}..."`);
          }
        }
        
        // Also check if this new content is a substring of recent finals (prevent duplicates from restarts)
        const newNormalized = newContent.trim().toLowerCase();
        let isDuplicate = false;
        for (const processed of lastProcessedTextRef.current) {
          if (processed.includes(newNormalized) && newNormalized.length > 3) {
            isDuplicate = true;
            console.log('[SpeechAnalysis] Skipping substring duplicate:', newContent.substring(0, 30));
            break;
          }
        }
        
        if (isDuplicate) continue;
        
        // Track this segment to prevent future duplicates
        lastProcessedTextRef.current.add(newNormalized);
        lastFinalTextRef.current = (lastFinalTextRef.current + ' ' + newContent).trim();

        // Keep set size manageable
        if (lastProcessedTextRef.current.size > 50) {
          const entries = Array.from(lastProcessedTextRef.current);
          lastProcessedTextRef.current = new Set(entries.slice(-30));
        }
        
        // Use the deduplicated new content instead of the full text
        const textToProcess = newContent;

        // CHROME: Extract ghost words before they disappear
        // Use textToProcess (deduplicated content) for ghost word extraction
        if (browser.isChrome && ghostTrackerRef.current) {
          const finalWords = textToProcess.trim().split(/\s+/).filter((w: string) => w.length > 0);
          const finalWordsSet = new Set<string>(finalWords.map((w: string) => w.toLowerCase()));
          const recovered = ghostTrackerRef.current.extractAcceptedGhosts(finalWordsSet);

          if (recovered.length > 0) {
            console.log('[SpeechAnalysis] Recovered ghost words:', recovered);
            ghostWordsRef.current.push(...recovered);
            recovered.forEach(word => options.onGhostWordRecovered?.(word));
          }
        }

        // Use textToProcess (deduplicated content) to prevent duplicates in final transcript
        newFinalText += textToProcess + ' ';
        wordTrackerRef.current?.addSnapshot(textToProcess, true);
        console.log('[SpeechAnalysis] Final:', textToProcess.substring(0, 50));
      } else {
        interimText += text;
        wordTrackerRef.current?.addSnapshot(text, false);

        // CHROME: Track interim words for ghost detection
        if (browser.isChrome && ghostTrackerRef.current) {
          const interimWords = text.trim().split(/\s+/).filter((w: string) => w.length > 0);
          ghostTrackerRef.current.trackInterimWords(interimWords);
        }
      }
    }

    if (newFinalText) {
      finalTranscriptRef.current += newFinalText;
    }

    // CRITICAL: Store interim text for potential recovery during restart
    // This captures words that might be lost when watchdog triggers stop()
    if (interimText.trim()) {
      lastInterimTextRef.current = interimText.trim();
    }

    const combined = (finalTranscriptRef.current + interimText).trim();
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
   * 
   * ENHANCED: Preserves interim text that might be lost during restart gap
   */
  const handleEnd = useCallback(() => {
    if (!isAnalyzingRef.current) return;

    const browser = browserRef.current;

    console.log('[SpeechAnalysis] onend', {
      isAnalyzing: isAnalyzingRef.current,
      isManualStop: isManualStopRef.current,
      isRestarting: isRestartingRef.current,
      lastInterim: lastInterimTextRef.current?.substring(0, 30),
    });

    if (!isAnalyzingRef.current || isManualStopRef.current) return;

    // CRITICAL FIX: If we have interim text when stopping, promote it to final
    // This prevents losing words that were in-progress during restart
    if (isRestartingRef.current && lastInterimTextRef.current && browser.isChrome) {
      const interimToPromote = lastInterimTextRef.current.trim();
      if (interimToPromote.length > 0) {
        // Check if this interim text is meaningfully different from last final
        const lastFinalWords = lastFinalTextRef.current.toLowerCase().split(/\s+/).slice(-10);
        const interimWords = interimToPromote.toLowerCase().split(/\s+/);
        
        // Find words in interim that are NOT in recent finals
        const newWords = interimWords.filter(w => 
          w.length > 2 && !lastFinalWords.includes(w)
        );
        
        if (newWords.length >= 2) {
          console.log('[SpeechAnalysis] Promoting interim to final before restart:', newWords.join(' '));
          // Only add the new words to prevent duplicates
          const newContent = newWords.join(' ');
          finalTranscriptRef.current += ' ' + newContent;
          lastFinalTextRef.current = (lastFinalTextRef.current + ' ' + newContent).trim();
        }
      }
      // Clear the interim ref after processing
      lastInterimTextRef.current = '';
    }

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

    finalTranscriptRef.current = '';
    startTimeRef.current = Date.now();
    sessionStartRef.current = Date.now();

    ghostWordsRef.current = [];
    consecutiveFailuresRef.current = 0;
    lastProcessedTextRef.current = new Set();
    lastFinalTextRef.current = '';

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

    if (browser.isChrome) {
      ghostTrackerRef.current = new GhostWordTracker();
    }

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

    console.log('[SpeechAnalysis] Stopping...');

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

    // Get final transcript (include ghost words for raw transcript)
    const baseTranscript = finalTranscriptRef.current.trim() || interimTranscript.trim();

    // Build raw transcript with recovered ghost words
    const ghostWords = ghostWordsRef.current;
    const rawTranscript = ghostWords.length > 0
      ? `${baseTranscript} [recovered: ${ghostWords.join(', ')}]`
      : baseTranscript;

    // Silence Safety Gate
    const isSilentAudio = audioAnalysis.silenceRatio > 0.95 && audioAnalysis.averageRms < 0.01;
    if (isSilentAudio && rawTranscript.length > 0) {
      console.warn('[SpeechAnalysis] Silent audio with text detected - possible hallucination, discarding');
      return null;
    }

    if (!baseTranscript) {
      return null;
    }

    // Calculate word confidences
    const wordConfidences = wordTrackerRef.current?.getWordConfidences(baseTranscript) ||
                            WordConfidenceTracker.createEmptyConfidences(baseTranscript);

    const durationMs = Date.now() - startTimeRef.current;

    const fluencyMetrics = calculateFluency(
      wordConfidences,
      audioAnalysis,
      prosodyMetrics,
      durationMs
    );

    // Create cleaned transcript
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
      ghostWords,
      pauseBreakdowns: pauseMetrics?.fluencyBreakdowns || 0,
      browserMode,
    };
  }, [interimTranscript, startWatchdog, stopWatchdog]);

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
    ghostTrackerRef.current = null;
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
