/**
 * Advanced Speech Analysis Hook
 * Orchestrates speech recognition and audio analysis for text-based evaluation
 */

import { useState, useRef, useCallback } from 'react';
import { AudioFeatureExtractor, AudioAnalysisResult } from '@/lib/audioFeatureExtractor';
import { analyzeProsody, ProsodyMetrics, createEmptyProsodyMetrics } from '@/lib/prosodyAnalyzer';
import { WordConfidenceTracker, WordConfidence } from '@/lib/wordConfidenceTracker';
import { calculateFluency, FluencyMetrics, createEmptyFluencyMetrics } from '@/lib/fluencyCalculator';

export interface SpeechAnalysisResult {
  rawTranscript: string;           // What browser heard (with fillers)
  cleanedTranscript: string;       // Fillers removed
  wordConfidences: WordConfidence[];
  fluencyMetrics: FluencyMetrics;
  prosodyMetrics: ProsodyMetrics;
  audioAnalysis: AudioAnalysisResult;
  durationMs: number;
  overallClarityScore: number;     // 0-100
}

interface UseAdvancedSpeechAnalysisOptions {
  language?: string;
  onInterimResult?: (transcript: string) => void;
  onError?: (error: Error) => void;
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

export function useAdvancedSpeechAnalysis(options: UseAdvancedSpeechAnalysisOptions = {}) {
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState('');
  const [error, setError] = useState<Error | null>(null);
  const [isSupported, setIsSupported] = useState(true);
  const [currentRms, setCurrentRms] = useState(0); // Real-time volume for monitoring

  const audioExtractorRef = useRef<AudioFeatureExtractor | null>(null);
  const wordTrackerRef = useRef<WordConfidenceTracker | null>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const finalTranscriptRef = useRef('');
  const startTimeRef = useRef(0);
  const isAnalyzingRef = useRef(false);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const rmsMonitorRef = useRef<number | null>(null);
  
  // Store the language for dynamic updates
  const languageRef = useRef(options.language || 'en-GB');
  
  // Update language ref when options change
  if (options.language && options.language !== languageRef.current) {
    languageRef.current = options.language;
  }

  const start = useCallback(async (stream: MediaStream) => {
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
    setInterimTranscript('');
    setCurrentRms(0);
    finalTranscriptRef.current = '';
    startTimeRef.current = Date.now();

    // Request screen wake lock to prevent phone sleep during long recordings
    try {
      if ('wakeLock' in navigator) {
        wakeLockRef.current = await navigator.wakeLock.request('screen');
        console.log('[SpeechAnalysis] Wake lock acquired');
      }
    } catch (err) {
      console.warn('[SpeechAnalysis] Wake lock not available:', err);
    }

    // Start audio feature extraction
    audioExtractorRef.current = new AudioFeatureExtractor();
    await audioExtractorRef.current.start(stream);

    // Start RMS monitoring for real-time volume feedback
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

    // Start speech recognition with the current language setting
    const recognition = new SpeechRecognitionClass();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = languageRef.current; // Use the dynamic language from ref
    
    console.log(`[SpeechAnalysis] Starting recognition with language: ${recognition.lang}`);

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interimText = '';
      let finalText = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0].transcript;

        if (result.isFinal) {
          finalText += text + ' ';
          wordTrackerRef.current?.addSnapshot(text, true);
        } else {
          interimText += text;
          wordTrackerRef.current?.addSnapshot(text, false);
        }
      }

      if (finalText) {
        finalTranscriptRef.current += finalText;
      }

      const combined = finalTranscriptRef.current + interimText;
      setInterimTranscript(combined);
      options.onInterimResult?.(combined);
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      if (event.error !== 'no-speech' && event.error !== 'aborted') {
        const err = new Error(`Speech recognition error: ${event.error}`);
        setError(err);
        options.onError?.(err);
      }
    };

    // Speech Watchdog: Auto-restart recognition if it stops during silence
    recognition.onend = () => {
      if (isAnalyzingRef.current && recognitionRef.current) {
        console.log('[SpeechAnalysis] Recognition ended, restarting watchdog...');
        try {
          setTimeout(() => {
            if (isAnalyzingRef.current && recognitionRef.current) {
              recognition.start();
            }
          }, 100);
        } catch {
          // Already started or stopped
        }
      }
    };

    recognitionRef.current = recognition;
    
    try {
      recognition.start();
    } catch {
      // Already started
    }

    return true;
  }, [options]);

  const stop = useCallback((): SpeechAnalysisResult | null => {
    setIsAnalyzing(false);
    isAnalyzingRef.current = false;
    setCurrentRms(0);

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

    // Stop speech recognition
    if (recognitionRef.current) {
      try {
        recognitionRef.current.abort();
      } catch {
        // Already stopped
      }
      recognitionRef.current = null;
    }

    // Get audio analysis results
    const audioAnalysis = audioExtractorRef.current?.stop() || AudioFeatureExtractor.createEmptyResult();

    const prosodyMetrics = analyzeProsody(audioAnalysis);

    // Get final transcript
    const rawTranscript = (finalTranscriptRef.current.trim() || interimTranscript.trim());

    // Silence Safety Gate: If audio is silent but text exists (hallucination), discard
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

    // Calculate duration
    const durationMs = Date.now() - startTimeRef.current;

    // Calculate fluency metrics
    const fluencyMetrics = calculateFluency(
      wordConfidences,
      audioAnalysis,
      prosodyMetrics,
      durationMs
    );

    // Create cleaned transcript (remove fillers and repetitions)
    const cleanedTranscript = wordConfidences
      .filter(w => !w.isFiller && !w.isRepeat)
      .map(w => w.word)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    // Calculate overall clarity score
    const avgConfidence = wordConfidences.length > 0
      ? wordConfidences.reduce((sum, w) => sum + w.confidence, 0) / wordConfidences.length
      : 0;

    const overallClarityScore = Math.round(
      (avgConfidence * 0.4) + 
      (fluencyMetrics.overallFluencyScore * 0.3) + 
      (prosodyMetrics.pitchVariation * 0.15) +
      (prosodyMetrics.rhythmConsistency * 0.15)
    );

    return {
      rawTranscript,
      cleanedTranscript,
      wordConfidences,
      fluencyMetrics,
      prosodyMetrics,
      audioAnalysis,
      durationMs,
      overallClarityScore,
    };
  }, [interimTranscript]);

  const abort = useCallback(() => {
    setIsAnalyzing(false);
    isAnalyzingRef.current = false;
    setCurrentRms(0);

    // Stop RMS monitor
    if (rmsMonitorRef.current) {
      clearInterval(rmsMonitorRef.current);
      rmsMonitorRef.current = null;
    }

    // Release wake lock
    if (wakeLockRef.current) {
      wakeLockRef.current.release().catch(() => {});
      wakeLockRef.current = null;
    }

    if (recognitionRef.current) {
      try {
        recognitionRef.current.abort();
      } catch {
        // Already stopped
      }
      recognitionRef.current = null;
    }

    if (audioExtractorRef.current) {
      audioExtractorRef.current.stop();
      audioExtractorRef.current = null;
    }

    wordTrackerRef.current = null;
    setInterimTranscript('');
  }, []);

  return {
    isAnalyzing,
    isSupported,
    interimTranscript,
    currentRms,
    error,
    start,
    stop,
    abort,
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
  };
}
