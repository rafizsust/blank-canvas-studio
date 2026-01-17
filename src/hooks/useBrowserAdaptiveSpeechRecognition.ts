/**
 * Browser-Adaptive Speech Recognition Hook
 * 
 * ARCHITECTURE PRINCIPLES (ACCURACY FIRST):
 * 
 * 1. CAPTURE EVERYTHING THE USER SAYS
 *    - No aggressive deduplication that removes legitimate repeated sentences
 *    - No ghost word recovery that corrupts transcripts
 *    - Smart overlap detection to prevent sentence boundary issues
 * 
 * 2. ONE CENTRAL RECOGNITION INSTANCE per session
 *    - Only create one SpeechRecognition object per recording session
 *    - Attach handlers once and never recreate mid-session
 * 
 * 3. SEPARATE TRANSCRIPT BUFFER
 *    - Maintain own final/transcript storage
 *    - Don't rely on recognition's internal storage surviving restart
 * 
 * 4. PROACTIVE RESTART via watchdog timer (not reactive)
 *    - Chrome: ~35s max session before proactive restart
 *    - Edge: ~45s max session before proactive restart
 *    - Never call start() inside onresult
 * 
 * 5. BROWSER-ADAPTIVE CONFIG
 *    - Chrome: User-selected accent, controlled cycling
 *    - Edge: Auto-detect language, more tolerance
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import {
  detectBrowser,
  isSpeechRecognitionSupported,
  BrowserInfo,
  PauseTracker,
  PauseMetrics,
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
  ghostWords: string[]; // DEPRECATED: Always empty
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

// CRITICAL: Chrome max session before PROACTIVE restart (before Chrome's ~45s cutoff)
const CHROME_MAX_SESSION_MS = 35000;

// Edge max session - Edge has longer tolerance
const EDGE_MAX_SESSION_MS = 45000;

// Delay before restarting after stop (allows clean shutdown)
const RESTART_DELAY_MS = 200;

// Watchdog check interval
const WATCHDOG_INTERVAL_MS = 2000;

// Max time without results before forcing restart
const MAX_SILENCE_BEFORE_RESTART_MS = 12000;

// Maximum consecutive restart failures before giving up
const MAX_CONSECUTIVE_FAILURES = 10;

// Maximum retry attempts for transient errors
const MAX_TRANSIENT_RETRIES = 3;

/**
 * Normalize text for comparison (lowercase, trim, remove extra spaces and punctuation)
 */
function normalizeForComparison(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[.,!?;:'"]/g, '')
    .replace(/\s+/g, ' ');
}

/**
 * Check if two texts are similar enough to be considered duplicates
 * Uses fuzzy matching to handle punctuation/case differences
 */
function areSimilarTexts(text1: string, text2: string): boolean {
  const norm1 = normalizeForComparison(text1);
  const norm2 = normalizeForComparison(text2);
  
  if (norm1 === norm2) return true;
  
  // Check if one contains the other (substring match)
  if (norm1.includes(norm2) || norm2.includes(norm1)) {
    const shorter = norm1.length < norm2.length ? norm1 : norm2;
    const longer = norm1.length >= norm2.length ? norm1 : norm2;
    // Only consider similar if the shorter is at least 80% of the longer
    if (shorter.length / longer.length > 0.8) return true;
  }
  
  return false;
}

/**
 * Check if text overlaps significantly with the end of the last segment
 * This prevents the "Almost therapeutic to me." + "You know, it's kind of therapeutic to me." issue
 */
function getOverlapWithLastSegment(newText: string, lastSegment: string): { hasOverlap: boolean; trimmedText: string } {
  if (!lastSegment || !newText) return { hasOverlap: false, trimmedText: newText };
  
  const normNew = normalizeForComparison(newText);
  const normLast = normalizeForComparison(lastSegment);
  
  // Get the last few words of the previous segment
  const lastWords = normLast.split(' ').slice(-5).join(' ');
  
  // Check if the new text starts with words that overlap with the end of the last segment
  const newWords = normNew.split(' ');
  
  for (let i = 1; i <= Math.min(5, newWords.length - 1); i++) {
    const prefix = newWords.slice(0, i).join(' ');
    if (lastWords.includes(prefix) || prefix.includes(lastWords.slice(-prefix.length))) {
      // Found overlap - trim the overlapping portion
      const trimmed = newWords.slice(i).join(' ').trim();
      if (trimmed.length > 0) {
        return { hasOverlap: true, trimmedText: trimmed };
      }
    }
  }
  
  return { hasOverlap: false, trimmedText: newText };
}

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
  const [pauseMetrics, setPauseMetrics] = useState<PauseMetrics | null>(null);
  const [sessionDuration, setSessionDuration] = useState(0);
  const [selectedAccent, setSelectedAccent] = useState(() => config.accent || getStoredAccent());
  
  // ==================== REFS ====================
  // SINGLE RECOGNITION INSTANCE - one per session, attached once
  const recognitionRef = useRef<SpeechRecognitionType | null>(null);
  
  // Lifecycle flags
  const isRecordingRef = useRef(false);        // True while user wants to record
  const isRestartingRef = useRef(false);       // True during proactive restart cycle
  const isManualStopRef = useRef(false);       // True when user explicitly stops
  
  // Timing
  const sessionStartRef = useRef(0);           // When current recognition session started
  const lastResultAtRef = useRef(0);           // Last time we got a result
  const overallStartRef = useRef(0);           // When recording started (for session duration display)
  
  // Watchdog timer
  const watchdogTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  
  // Silence timeout (for extended periods of no speech)
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  
  // Pending flush timer - waits for final result before flushing interim
  const pendingFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  
  // Failure tracking
  const consecutiveFailuresRef = useRef(0);
  const transientRetryCountRef = useRef(0);
  
  // CRITICAL: Append-only segment storage
  const finalSegmentsRef = useRef<string[]>([]);
  const wordIdCounterRef = useRef(0);

  // Track latest interim text so we can flush it on stop/onend (prevents tail cut-offs)
  const latestInterimRef = useRef('');
  
  // Pending interim text waiting to be flushed (with smarter deduplication)
  const pendingInterimRef = useRef('');

  // Last final text for smarter duplicate prevention
  const lastFinalTextRef = useRef('');
  
  // Helpers
  const pauseTrackerRef = useRef(new PauseTracker());
  
  // ==================== SESSION DURATION DISPLAY ====================
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null;
    if (isListening && overallStartRef.current > 0) {
      interval = setInterval(() => {
        setSessionDuration(Date.now() - overallStartRef.current);
      }, 1000);
    }
    return () => { if (interval) clearInterval(interval); };
  }, [isListening]);

  // ==================== CLEANUP ON UNMOUNT ====================
  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        try { recognitionRef.current.abort(); } catch { /* ignore */ }
      }
      if (watchdogTimerRef.current) clearInterval(watchdogTimerRef.current);
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      if (pendingFlushTimerRef.current) clearTimeout(pendingFlushTimerRef.current);
    };
  }, []);

  // ==================== HELPER: Should restart on this error? ====================
  const shouldRestartOnError = useCallback((errorType: string): boolean => {
    // Errors that should trigger restart
    const restartableErrors = ['network', 'audio-capture', 'service-not-allowed'];
    // Errors that are transient or expected
    const ignoredErrors = ['no-speech', 'aborted'];
    
    if (ignoredErrors.includes(errorType)) return false;
    if (restartableErrors.includes(errorType)) return true;
    
    // For Edge: network errors often fire incorrectly, treat as restartable
    if (browser.isEdge && errorType === 'network') return true;
    
    return false;
  }, [browser.isEdge]);

  // ==================== HELPER: Reset silence timeout ====================
  const resetSilenceTimeout = useCallback(() => {
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    silenceTimerRef.current = setTimeout(() => {
      if (isRecordingRef.current && !isManualStopRef.current) {
        console.warn('[SpeechRecognition] Extended silence detected');
        // Don't set error - just log for fluency scoring
      }
    }, mergedConfig.silenceTimeoutMs);
  }, [mergedConfig.silenceTimeoutMs]);

  // ==================== HELPER: Clear pending flush ====================
  const clearPendingFlush = useCallback(() => {
    if (pendingFlushTimerRef.current) {
      clearTimeout(pendingFlushTimerRef.current);
      pendingFlushTimerRef.current = null;
    }
    pendingInterimRef.current = '';
  }, []);

  // ==================== CORE: Create recognition instance ====================
  const createRecognitionInstance = useCallback((): SpeechRecognitionType | null => {
    const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognitionAPI) return null;
    
    const recognition = new SpeechRecognitionAPI();
    recognition.continuous = true;
    recognition.interimResults = true;
    
    if (browser.isEdge) {
      // Edge: DO NOT set lang - auto-detect, preserves fillers
      console.log('[SpeechRecognition] Creating Edge instance: Natural/auto-detect mode');
    } else if (browser.isChrome) {
      recognition.lang = selectedAccent;
      console.log(`[SpeechRecognition] Creating Chrome instance: ${selectedAccent}`);
    } else {
      recognition.lang = selectedAccent;
      console.log(`[SpeechRecognition] Creating instance for ${browser.browserName}: ${selectedAccent}`);
    }
    
    return recognition;
  }, [browser, selectedAccent]);

  // ==================== CORE: Safe restart (watchdog-triggered only) ====================
  // This only STOPS the recognition - onend handler will restart it
  const safeRestartRef = useRef<() => void>(() => {});
  
  const safeRestart = useCallback(() => {
    if (!isRecordingRef.current || isManualStopRef.current) {
      console.log('[SpeechRecognition] safeRestart: not recording or manual stop, skipping');
      return;
    }
    
    if (isRestartingRef.current) {
      console.log('[SpeechRecognition] safeRestart: already restarting, skipping');
      return;
    }
    
    isRestartingRef.current = true;
    console.log('[SpeechRecognition] Performing safe restart (stop only, onend will restart)...');
    
    // Stop current instance gracefully - onend will handle restart
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        // Already stopped - manually trigger restart logic
        console.log('[SpeechRecognition] Already stopped, triggering manual restart');
        const delay = browser.isEdge ? 300 : RESTART_DELAY_MS;
        
        setTimeout(() => {
          if (!isRecordingRef.current || isManualStopRef.current) {
            isRestartingRef.current = false;
            return;
          }
          
          isRestartingRef.current = false;
          sessionStartRef.current = Date.now();
          lastFinalTextRef.current = ''; // Clear duplicate check for new session
          clearPendingFlush();
          
          if (recognitionRef.current) {
            try {
              recognitionRef.current.start();
              console.log('[SpeechRecognition] Restarted successfully');
              transientRetryCountRef.current = 0;
            } catch (err) {
              console.error('[SpeechRecognition] Restart failed:', err);
              consecutiveFailuresRef.current++;
            }
          }
        }, delay);
      }
    }
  }, [browser.isEdge, clearPendingFlush]);
  
  // Keep ref in sync
  useEffect(() => {
    safeRestartRef.current = safeRestart;
  }, [safeRestart]);

  // ==================== HANDLER: onresult ====================
  /**
   * IMPROVED: Smart duplicate detection with overlap handling
   * - Fuzzy matching for similar texts
   * - Overlap detection to prevent sentence boundary issues
   * - Pending flush buffer for better interim handling
   */
  const handleResult = useCallback((event: Event) => {
    if (!isRecordingRef.current) return;
    
    // Update timing for watchdog
    lastResultAtRef.current = Date.now();
    resetSilenceTimeout();
    pauseTrackerRef.current.recordSpeechEvent();
    
    // Reset failure counters on successful result
    consecutiveFailuresRef.current = 0;
    transientRetryCountRef.current = 0;
    
    const e = event as unknown as { resultIndex: number; results: SpeechRecognitionResultList };
    
    let newInterimText = '';
    const newWords: TranscriptState['words'] = [];

    for (let i = e.resultIndex; i < e.results.length; i++) {
      const result = e.results[i];
      const transcript = result[0].transcript;

      if (result.isFinal) {
        const trimmed = transcript.trim();

        // Clear any pending interim flush since we got a real final
        clearPendingFlush();
        latestInterimRef.current = '';

        // Skip if this is similar to the last final (fuzzy duplicate detection)
        if (areSimilarTexts(trimmed, lastFinalTextRef.current)) {
          console.log('[SpeechRecognition] Skipping similar duplicate:', trimmed.substring(0, 30));
          continue;
        }

        if (trimmed.length > 0) {
          // Check for overlap with last segment and trim if needed
          const lastSegment = finalSegmentsRef.current[finalSegmentsRef.current.length - 1] || '';
          const { hasOverlap, trimmedText } = getOverlapWithLastSegment(trimmed, lastSegment);
          
          const textToAdd = hasOverlap ? trimmedText : trimmed;
          
          if (textToAdd.length > 0) {
            // Store as the last final for duplicate check
            lastFinalTextRef.current = trimmed;

            // APPEND to our segments array - never modify previous segments
            finalSegmentsRef.current.push(textToAdd);

            // Create word entries
            const finalWords = textToAdd.split(/\s+/).filter((w: string) => w.length > 0);
            finalWords.forEach((text: string) => {
              newWords.push({
                text,
                timestamp: Date.now(),
                wordId: wordIdCounterRef.current++,
                isGhost: false,
                isFiller: false,
              });
            });

            console.log('[SpeechRecognition] Final segment added:', textToAdd.substring(0, 50), hasOverlap ? '(overlap trimmed)' : '');
          }
        }
      } else {
        newInterimText = transcript;
        latestInterimRef.current = transcript;
      }
    }

    // Update state with new transcripts
    if (newWords.length > 0) {
      const fullTranscript = finalSegmentsRef.current.join(' ');
      setFinalTranscript(fullTranscript);
      setRawTranscript(fullTranscript);
      setWords((prev) => [...prev, ...newWords]);
    }

    setInterimTranscript(newInterimText);
  }, [resetSilenceTimeout, clearPendingFlush]);

  // ==================== HANDLER: onerror ====================
  const handleError = useCallback((event: Event) => {
    const e = event as unknown as { error: string; message?: string };
    const errorType = e.error;
    
    console.warn('[SpeechRecognition] Error:', errorType, e.message || '');
    
    // Ignore expected errors
    if (errorType === 'no-speech' || errorType === 'aborted') {
      return;
    }
    
    // Check if we should attempt restart
    if (isRecordingRef.current && !isManualStopRef.current && shouldRestartOnError(errorType)) {
      transientRetryCountRef.current++;
      
      if (transientRetryCountRef.current <= MAX_TRANSIENT_RETRIES) {
        console.log(`[SpeechRecognition] Transient error, retrying (${transientRetryCountRef.current}/${MAX_TRANSIENT_RETRIES})`);
        safeRestartRef.current();
        return;
      }
    }
    
    // Track consecutive failures
    consecutiveFailuresRef.current++;
    
    // Only show error to user if critical
    if (consecutiveFailuresRef.current >= MAX_CONSECUTIVE_FAILURES) {
      setError(new Error(`Speech recognition error: ${errorType}`));
    }
  }, [shouldRestartOnError]);

  // ==================== HANDLER: onend ====================
  const handleEnd = useCallback(() => {
    console.log('[SpeechRecognition] onend fired', {
      isRecording: isRecordingRef.current,
      isManualStop: isManualStopRef.current,
      isRestarting: isRestartingRef.current,
      segmentCount: finalSegmentsRef.current.length,
      hasInterimToFlush: Boolean(latestInterimRef.current?.trim()),
    });

    // Smart interim flush with pending buffer
    const flushInterimIfAny = () => {
      const interim = latestInterimRef.current?.trim();
      if (!interim) return;

      // Check if it's similar to the last final (fuzzy match)
      if (areSimilarTexts(interim, lastFinalTextRef.current)) {
        latestInterimRef.current = '';
        return;
      }

      // Check for overlap with last segment
      const lastSegment = finalSegmentsRef.current[finalSegmentsRef.current.length - 1] || '';
      const { hasOverlap, trimmedText } = getOverlapWithLastSegment(interim, lastSegment);
      
      const textToFlush = hasOverlap ? trimmedText : interim;
      
      if (textToFlush.length > 0) {
        finalSegmentsRef.current.push(textToFlush);
        console.log('[SpeechRecognition] Flushed interim:', textToFlush.substring(0, 50), hasOverlap ? '(overlap trimmed)' : '');
      }
      
      latestInterimRef.current = '';

      const fullTranscript = finalSegmentsRef.current.join(' ');
      setFinalTranscript(fullTranscript);
      setRawTranscript(fullTranscript);
    };

    flushInterimIfAny();

    // If user stopped or we're in manual stop mode, don't restart
    if (!isRecordingRef.current || isManualStopRef.current) {
      return;
    }

    // If we're in the middle of a planned restart cycle, handle the delayed restart
    if (isRestartingRef.current) {
      // Edge-specific: wait for late results before restarting
      const delay = browser.isEdge ? 300 : RESTART_DELAY_MS;

      setTimeout(() => {
        if (!isRecordingRef.current || isManualStopRef.current) {
          isRestartingRef.current = false;
          return;
        }

        isRestartingRef.current = false;
        sessionStartRef.current = Date.now();
        lastFinalTextRef.current = ''; // Clear duplicate check for new session
        clearPendingFlush();

        if (recognitionRef.current) {
          try {
            recognitionRef.current.start();
            console.log('[SpeechRecognition] Restarted after controlled cycle');
            transientRetryCountRef.current = 0;
          } catch (err) {
            console.error('[SpeechRecognition] Restart failed:', err);
            consecutiveFailuresRef.current++;
          }
        }
      }, delay);
      return;
    }

    // Unexpected end - browser cutoff - restart with delay
    console.log('[SpeechRecognition] Unexpected end detected, scheduling restart...');
    isRestartingRef.current = true;

    // Edge-specific: wait for late results
    const delay = browser.isEdge ? 300 : RESTART_DELAY_MS;

    setTimeout(() => {
      if (!isRecordingRef.current || isManualStopRef.current) {
        isRestartingRef.current = false;
        return;
      }

      isRestartingRef.current = false;
      sessionStartRef.current = Date.now();
      lastFinalTextRef.current = ''; // Clear duplicate check for new session
      clearPendingFlush();

      if (recognitionRef.current) {
        try {
          recognitionRef.current.start();
          console.log('[SpeechRecognition] Restarted after unexpected end');
          transientRetryCountRef.current = 0;
        } catch (err) {
          console.error('[SpeechRecognition] Restart failed:', err);
          consecutiveFailuresRef.current++;
        }
      }
    }, delay);
  }, [browser.isEdge, clearPendingFlush]);

  // ==================== HANDLER: onstart ====================
  const handleStart = useCallback(() => {
    console.log('[SpeechRecognition] onstart fired');
    if (!isListening) {
      setIsListening(true);
      setError(null);
    }
  }, [isListening]);

  // ==================== ATTACH HANDLERS (once per instance) ====================
  const attachHandlers = useCallback((recognition: SpeechRecognitionType) => {
    recognition.onresult = handleResult;
    recognition.onerror = handleError;
    recognition.onend = handleEnd;
    recognition.onstart = handleStart;
  }, [handleResult, handleError, handleEnd, handleStart]);

  // ==================== WATCHDOG TIMER ====================
  // Proactively restarts before Chrome's cutoff AND detects wedged state
  useEffect(() => {
    // Clear existing watchdog
    if (watchdogTimerRef.current) {
      clearInterval(watchdogTimerRef.current);
      watchdogTimerRef.current = null;
    }
    
    if (!isListening) {
      return;
    }
    
    const maxSessionMs = browser.isChrome ? CHROME_MAX_SESSION_MS : EDGE_MAX_SESSION_MS;
    
    watchdogTimerRef.current = setInterval(() => {
      if (!isRecordingRef.current || isManualStopRef.current) {
        return;
      }
      
      const now = Date.now();
      const elapsed = now - sessionStartRef.current;
      const sinceLastResult = now - (lastResultAtRef.current || sessionStartRef.current);
      
      // PROACTIVE RESTART: Before browser's cutoff
      if (elapsed > maxSessionMs) {
        console.log(`[SpeechRecognition] Watchdog: Proactive restart after ${Math.round(elapsed / 1000)}s`);
        safeRestartRef.current();
        return;
      }
      
      // WEDGE DETECTION: No results for too long (but session hasn't timed out)
      // This catches Chrome's silent cutoff bug where it stops emitting results
      if (sinceLastResult > MAX_SILENCE_BEFORE_RESTART_MS && elapsed > 5000) {
        console.warn(`[SpeechRecognition] Watchdog: No results for ${Math.round(sinceLastResult / 1000)}s, forcing restart`);
        safeRestartRef.current();
        return;
      }
    }, WATCHDOG_INTERVAL_MS);
    
    return () => {
      if (watchdogTimerRef.current) {
        clearInterval(watchdogTimerRef.current);
        watchdogTimerRef.current = null;
      }
    };
  }, [isListening, browser.isChrome]);

  // ==================== PUBLIC: startListening ====================
  const startListening = useCallback(() => {
    if (!isSupported) {
      setError(new Error('Speech recognition not supported'));
      return;
    }
    
    console.log('[SpeechRecognition] Starting...');
    
    // Create single instance for this session
    const recognition = createRecognitionInstance();
    if (!recognition) {
      setError(new Error('Failed to create speech recognition'));
      return;
    }
    
    // Attach handlers ONCE
    attachHandlers(recognition);
    recognitionRef.current = recognition;
    
    // Reset all state
    isManualStopRef.current = false;
    isRecordingRef.current = true;
    isRestartingRef.current = false;
    consecutiveFailuresRef.current = 0;
    transientRetryCountRef.current = 0;
    wordIdCounterRef.current = 0;
    
    // CRITICAL: Reset to empty segments array
    finalSegmentsRef.current = [];
    lastFinalTextRef.current = '';
    clearPendingFlush();
    
    // Timing
    const now = Date.now();
    sessionStartRef.current = now;
    overallStartRef.current = now;
    lastResultAtRef.current = now;
    
    // Helpers
    pauseTrackerRef.current.start();
    
    // Start recognition
    try {
      recognition.start();
      resetSilenceTimeout();
      console.log('[SpeechRecognition] Started successfully');
    } catch (err) {
      console.error('[SpeechRecognition] Failed to start:', err);
      setError(err instanceof Error ? err : new Error('Failed to start speech recognition'));
    }
  }, [isSupported, createRecognitionInstance, attachHandlers, resetSilenceTimeout, clearPendingFlush]);

  // ==================== PUBLIC: stopListening ====================
  /**
   * CRITICAL: Stop with a small grace period to capture late finals.
   * Chrome/Edge often deliver the last final result ~100-200ms AFTER stop() is called.
   * We defer the flush to the end of onend OR after a timeout, whichever comes first.
   */
  const stopListening = useCallback(() => {
    console.log('[SpeechRecognition] Stopping...', {
      segmentCount: finalSegmentsRef.current.length,
      hasInterimToFlush: Boolean(latestInterimRef.current?.trim()),
    });

    // Mark that the user wants to stop - prevents restarts in onend
    isManualStopRef.current = true;
    // Keep isRecordingRef TRUE briefly so late onresult events still get processed
    
    // Clear watchdog immediately (no more proactive restarts)
    if (watchdogTimerRef.current) {
      clearInterval(watchdogTimerRef.current);
      watchdogTimerRef.current = null;
    }
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }

    // Stop recognition - this triggers final results before onend
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        // Already stopped
      }
    }

    // Give browser 150ms grace period for late final results before flushing interim
    // onend handler also flushes, so this is a fallback
    setTimeout(() => {
      // Now mark as truly not recording
      isRecordingRef.current = false;
      
      // Flush any remaining interim that wasn't converted to final
      const interim = latestInterimRef.current?.trim();
      if (interim && !areSimilarTexts(interim, lastFinalTextRef.current)) {
        // Check for overlap
        const lastSegment = finalSegmentsRef.current[finalSegmentsRef.current.length - 1] || '';
        const { hasOverlap, trimmedText } = getOverlapWithLastSegment(interim, lastSegment);
        const textToFlush = hasOverlap ? trimmedText : interim;
        
        if (textToFlush.length > 0) {
          console.log('[SpeechRecognition] Flushing remaining interim:', textToFlush.substring(0, 50));
          finalSegmentsRef.current.push(textToFlush);
          const fullTranscript = finalSegmentsRef.current.join(' ');
          setFinalTranscript(fullTranscript);
          setRawTranscript(fullTranscript);
        }
      }
      latestInterimRef.current = '';
      setInterimTranscript('');
      
      setIsListening(false);
      pauseTrackerRef.current.stop();
      setPauseMetrics(pauseTrackerRef.current.getMetrics());
      
      console.log('[SpeechRecognition] Stopped with', finalSegmentsRef.current.length, 'segments');
    }, 150);
  }, []);

  // ==================== PUBLIC: abort ====================
  const abort = useCallback(() => {
    console.log('[SpeechRecognition] Aborting...');
    
    isManualStopRef.current = true;
    isRecordingRef.current = false;
    
    if (watchdogTimerRef.current) {
      clearInterval(watchdogTimerRef.current);
      watchdogTimerRef.current = null;
    }
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    clearPendingFlush();
    
    if (recognitionRef.current) {
      try {
        recognitionRef.current.abort();
      } catch {
        // Already stopped
      }
      recognitionRef.current = null;
    }
    
    setIsListening(false);
  }, [clearPendingFlush]);

  // ==================== PUBLIC: clearTranscript ====================
  const clearTranscript = useCallback(() => {
    setRawTranscript('');
    setFinalTranscript('');
    setInterimTranscript('');
    setWords([]);
    setPauseMetrics(null);
    setSessionDuration(0);
    wordIdCounterRef.current = 0;
    finalSegmentsRef.current = [];
    lastFinalTextRef.current = '';
    clearPendingFlush();
    pauseTrackerRef.current.reset();
  }, [clearPendingFlush]);

  // ==================== PUBLIC: setAccent ====================
  const setAccent = useCallback((accent: string) => {
    setSelectedAccent(accent);
    setStoredAccent(accent);
    
    // For Chrome, restart with new accent if currently listening
    if (browser.isChrome && isListening) {
      stopListening();
      setTimeout(() => startListening(), 300);
    }
  }, [browser.isChrome, isListening, stopListening, startListening]);

  // ==================== RETURN ====================
  return {
    isListening,
    isSupported,
    error,
    rawTranscript,
    finalTranscript,
    interimTranscript,
    words,
    ghostWords: [], // DEPRECATED: Always empty
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
