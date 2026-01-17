/**
 * Simple Speech Recognition Hook
 * 
 * SINGLE INSTANCE ARCHITECTURE:
 * - ONE SpeechRecognition instance per session
 * - Controlled self-restart via watchdog
 * - Transcript buffer survives restarts
 * - No dual-instance cycling
 * 
 * WORD LOSS PREVENTION:
 * - Interim text is tracked and flushed on restarts and stops
 * - Pre-restart capture ensures words during restart gap aren't lost
 * - Grace period for late final results after stop()
 */

import { useState, useRef, useCallback, useEffect } from 'react';

interface SpeechRecognitionConfig {
  language?: string;
  continuous?: boolean;
  interimResults?: boolean;
  onResult?: (transcript: string, isFinal: boolean) => void;
  onError?: (error: Error) => void;
  onStart?: () => void;
  onEnd?: () => void;
}

// Chrome max session before proactive restart (before Chrome's ~45s cutoff)
const CHROME_MAX_SESSION_MS = 35000;
// Edge max session - Edge has longer tolerance
const EDGE_MAX_SESSION_MS = 45000;
// Delay before restarting after stop
const RESTART_DELAY_MS = 200;
// Watchdog check interval
const WATCHDOG_INTERVAL_MS = 2000;
// Grace period for late finals after stop
const STOP_GRACE_PERIOD_MS = 200;

// Browser detection
const detectBrowser = () => {
  const ua = navigator.userAgent;
  const isChrome = ua.includes('Chrome') && !ua.includes('Edg');
  const isEdge = ua.includes('Edg');
  return { isChrome, isEdge };
};

export function useSpeechRecognition(config: SpeechRecognitionConfig = {}) {
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [interimTranscript, setInterimTranscript] = useState('');
  const [error, setError] = useState<Error | null>(null);
  const [isSupported, setIsSupported] = useState(true);
  
  // SINGLE RECOGNITION INSTANCE - one per session
  const recognitionRef = useRef<InstanceType<typeof window.SpeechRecognition> | null>(null);
  
  // Lifecycle flags
  const isRecordingRef = useRef(false);      // True while user wants to record
  const isRestartingRef = useRef(false);     // True during controlled restart cycle
  const isManualStopRef = useRef(false);     // True when user explicitly stops
  
  // Timing
  const sessionStartRef = useRef(0);         // When current recognition session started
  
  // Watchdog timer
  const watchdogTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  
  // CRITICAL: Append-only transcript storage (survives restarts)
  const finalSegmentsRef = useRef<string[]>([]);
  
  // CRITICAL: Track latest interim text for flushing on restart/stop
  const latestInterimRef = useRef('');
  
  // Duplicate prevention (only exact back-to-back)
  const lastExactFinalRef = useRef('');
  
  // Browser info
  const browserRef = useRef(detectBrowser());

  // DEV ASSERTION: Ensure only one instance exists
  const instanceCountRef = useRef(0);

  // Helper: Build full transcript from segments
  const buildFullTranscript = useCallback(() => {
    return finalSegmentsRef.current.join(' ');
  }, []);

  // Helper: Flush interim text to final segments (called before restart and on stop)
  const flushInterimToFinal = useCallback(() => {
    const interim = latestInterimRef.current?.trim();
    if (!interim) return false;
    
    // Don't flush if it's exactly the same as last final (prevents duplicates)
    if (interim === lastExactFinalRef.current) {
      latestInterimRef.current = '';
      return false;
    }
    
    console.log('[SpeechRecognition] Flushing interim to final:', interim.substring(0, 50));
    finalSegmentsRef.current.push(interim);
    lastExactFinalRef.current = interim;
    latestInterimRef.current = '';
    
    const fullTranscript = buildFullTranscript();
    setTranscript(fullTranscript);
    config.onResult?.(interim, true);
    
    return true;
  }, [buildFullTranscript, config]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        try { recognitionRef.current.abort(); } catch { /* ignore */ }
      }
      if (watchdogTimerRef.current) {
        clearInterval(watchdogTimerRef.current);
      }
    };
  }, []);

  // Create recognition instance with handlers
  const createRecognition = useCallback(() => {
    const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
    
    if (!SpeechRecognitionAPI) {
      setIsSupported(false);
      setError(new Error('Speech recognition not supported in this browser'));
      return null;
    }

    // DEV ASSERTION: Check for multiple instances
    instanceCountRef.current++;
    if (instanceCountRef.current > 1) {
      console.error('[SpeechRecognition] CRITICAL: Multiple instances detected!', instanceCountRef.current);
    }

    const recognition = new SpeechRecognitionAPI();
    recognition.continuous = config.continuous ?? true;
    recognition.interimResults = config.interimResults ?? true;
    recognition.lang = config.language ?? 'en-GB';

    recognition.onresult = (event) => {
      if (!isRecordingRef.current) return;
      
      let interimText = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0].transcript;
        
        if (result.isFinal) {
          const trimmed = text.trim();
          
          // Clear interim since we got a final (final supersedes any buffered interim)
          if (latestInterimRef.current) {
            latestInterimRef.current = '';
          }
          
          // ONLY skip if this is EXACTLY the same as the last final (back-to-back duplicate)
          // This prevents the SAME recognition result from being processed twice
          // But ALLOWS the user to intentionally repeat sentences
          if (trimmed === lastExactFinalRef.current) {
            console.log('[SpeechRecognition] Skipping exact back-to-back duplicate');
            continue;
          }
          
          if (trimmed.length > 0) {
            lastExactFinalRef.current = trimmed;
            finalSegmentsRef.current.push(trimmed);
            
            const fullTranscript = buildFullTranscript();
            setTranscript(fullTranscript);
            config.onResult?.(text, true);
            
            console.log('[SpeechRecognition] Final segment added:', trimmed.substring(0, 50));
          }
        } else {
          interimText = text;
          // CRITICAL: Track latest interim for flushing on restart/stop
          latestInterimRef.current = text;
          config.onResult?.(text, false);
        }
      }

      setInterimTranscript(interimText);
    };

    recognition.onerror = (event) => {
      // Ignore expected errors
      if (event.error === 'no-speech' || event.error === 'aborted') {
        return;
      }
      
      console.warn('[SpeechRecognition] Error:', event.error);
      const err = new Error(`Speech recognition error: ${event.error}`);
      setError(err);
      config.onError?.(err);
    };

    recognition.onstart = () => {
      console.log('[SpeechRecognition] onstart');
      setIsListening(true);
      setError(null);
      config.onStart?.();
    };

    recognition.onend = () => {
      console.log('[SpeechRecognition] onend', {
        isRecording: isRecordingRef.current,
        isRestarting: isRestartingRef.current,
        isManualStop: isManualStopRef.current,
        segmentCount: finalSegmentsRef.current.length,
        hasInterim: Boolean(latestInterimRef.current?.trim())
      });

      // CRITICAL: Flush any interim text before doing anything else
      // This prevents word loss during restarts
      flushInterimToFinal();

      // If user stopped, don't restart
      if (!isRecordingRef.current || isManualStopRef.current) {
        setIsListening(false);
        setInterimTranscript('');
        config.onEnd?.();
        return;
      }

      // If we're in a controlled restart cycle, handle it
      if (isRestartingRef.current) {
        // Edge-specific: wait for late results before restarting
        const delay = browserRef.current.isEdge ? 300 : RESTART_DELAY_MS;
        
        setTimeout(() => {
          if (!isRecordingRef.current || isManualStopRef.current) {
            isRestartingRef.current = false;
            return;
          }
          
          isRestartingRef.current = false;
          sessionStartRef.current = Date.now();
          // Clear duplicate check for new session to prevent false positives
          lastExactFinalRef.current = '';
          
          try {
            recognition.start();
            console.log('[SpeechRecognition] Restarted after controlled cycle');
          } catch (err) {
            console.error('[SpeechRecognition] Restart failed:', err);
          }
        }, delay);
        return;
      }

      // Unexpected end (browser cutoff) - restart
      console.log('[SpeechRecognition] Unexpected end, restarting...');
      isRestartingRef.current = true;
      
      const delay = browserRef.current.isEdge ? 300 : RESTART_DELAY_MS;
      setTimeout(() => {
        if (!isRecordingRef.current || isManualStopRef.current) {
          isRestartingRef.current = false;
          return;
        }
        
        isRestartingRef.current = false;
        sessionStartRef.current = Date.now();
        // Clear duplicate check for new session
        lastExactFinalRef.current = '';
        
        try {
          recognition.start();
          console.log('[SpeechRecognition] Restarted after unexpected end');
        } catch (err) {
          console.error('[SpeechRecognition] Restart failed:', err);
        }
      }, delay);
    };

    return recognition;
  }, [config, buildFullTranscript, flushInterimToFinal]);

  // Start listening
  const startListening = useCallback(() => {
    console.log('[SpeechRecognition] Starting...');
    
    // Reset instance count for new session
    instanceCountRef.current = 0;
    
    // Create single instance for this session
    const recognition = createRecognition();
    if (!recognition) return;
    
    recognitionRef.current = recognition;
    
    // Reset state
    isManualStopRef.current = false;
    isRecordingRef.current = true;
    isRestartingRef.current = false;
    sessionStartRef.current = Date.now();
    
    // CRITICAL: Reset transcript storage
    finalSegmentsRef.current = [];
    latestInterimRef.current = '';
    lastExactFinalRef.current = '';
    
    setTranscript('');
    setInterimTranscript('');
    setError(null);
    
    // Start watchdog timer for proactive restarts
    const maxSessionMs = browserRef.current.isChrome ? CHROME_MAX_SESSION_MS : EDGE_MAX_SESSION_MS;
    
    watchdogTimerRef.current = setInterval(() => {
      if (!isRecordingRef.current || isManualStopRef.current || isRestartingRef.current) {
        return;
      }
      
      const elapsed = Date.now() - sessionStartRef.current;
      
      if (elapsed > maxSessionMs) {
        console.log(`[SpeechRecognition] Watchdog: Proactive restart after ${Math.round(elapsed / 1000)}s`);
        isRestartingRef.current = true;
        
        // CRITICAL: Flush interim BEFORE stopping to prevent word loss
        flushInterimToFinal();
        
        try {
          recognitionRef.current?.stop();
        } catch {
          // Already stopped
        }
      }
    }, WATCHDOG_INTERVAL_MS);

    try {
      recognition.start();
      console.log('[SpeechRecognition] Started');
    } catch (err) {
      console.error('[SpeechRecognition] Start error:', err);
      setError(err instanceof Error ? err : new Error('Failed to start'));
    }
  }, [createRecognition, flushInterimToFinal]);

  // Stop listening with grace period for late finals
  const stopListening = useCallback(() => {
    console.log('[SpeechRecognition] Stopping...', {
      segmentCount: finalSegmentsRef.current.length,
      hasInterim: Boolean(latestInterimRef.current?.trim())
    });
    
    // Set manual stop flag to prevent restart, but keep recording flag true briefly
    isManualStopRef.current = true;
    
    // Clear watchdog
    if (watchdogTimerRef.current) {
      clearInterval(watchdogTimerRef.current);
      watchdogTimerRef.current = null;
    }
    
    // Stop recognition - this triggers final results before onend
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        // Already stopped
      }
    }
    
    // Give browser grace period for late final results before final cleanup
    // The onend handler will also flush, but this is a fallback
    setTimeout(() => {
      isRecordingRef.current = false;
      
      // Flush any remaining interim that wasn't converted to final
      const flushed = flushInterimToFinal();
      if (flushed) {
        console.log('[SpeechRecognition] Flushed remaining interim on stop');
      }
      
      setInterimTranscript('');
      setIsListening(false);
      instanceCountRef.current = 0;
      
      console.log('[SpeechRecognition] Stopped with', finalSegmentsRef.current.length, 'segments');
    }, STOP_GRACE_PERIOD_MS);
  }, [flushInterimToFinal]);

  // Abort (immediate stop)
  const abort = useCallback(() => {
    console.log('[SpeechRecognition] Aborting...');
    
    isManualStopRef.current = true;
    isRecordingRef.current = false;
    
    if (watchdogTimerRef.current) {
      clearInterval(watchdogTimerRef.current);
      watchdogTimerRef.current = null;
    }
    
    if (recognitionRef.current) {
      try {
        recognitionRef.current.abort();
      } catch {
        // Already stopped
      }
      recognitionRef.current = null;
    }
    
    setIsListening(false);
    instanceCountRef.current = 0;
  }, []);

  // Clear transcript
  const clearTranscript = useCallback(() => {
    finalSegmentsRef.current = [];
    latestInterimRef.current = '';
    lastExactFinalRef.current = '';
    setTranscript('');
    setInterimTranscript('');
  }, []);

  return {
    isListening,
    isSupported,
    transcript,
    interimTranscript,
    fullTranscript: transcript + (interimTranscript ? ' ' + interimTranscript : ''),
    error,
    startListening,
    stopListening,
    abort,
    clearTranscript
  };
}
