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

export function useSpeechRecognition(config: SpeechRecognitionConfig = {}) {
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [interimTranscript, setInterimTranscript] = useState('');
  const [error, setError] = useState<Error | null>(null);
  const [isSupported, setIsSupported] = useState(true);
  
  const recognitionRef = useRef<InstanceType<typeof window.SpeechRecognition> | null>(null);
  const isManualStop = useRef(false);

  // Initialize speech recognition
  useEffect(() => {
    const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
    
    if (!SpeechRecognitionAPI) {
      setIsSupported(false);
      setError(new Error('Speech recognition not supported in this browser'));
      return;
    }

    const recognition = new SpeechRecognitionAPI();
    recognition.continuous = config.continuous ?? true;
    recognition.interimResults = config.interimResults ?? true;
    recognition.lang = config.language ?? 'en-GB'; // British English by default

    recognition.onresult = (event) => {
      let finalTranscript = '';
      let interimText = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0].transcript;
        
        if (result.isFinal) {
          finalTranscript += text + ' ';
          config.onResult?.(text, true);
        } else {
          interimText += text;
          config.onResult?.(text, false);
        }
      }

      if (finalTranscript) {
        setTranscript(prev => prev + finalTranscript);
      }
      setInterimTranscript(interimText);
    };

    recognition.onerror = (event) => {
      // Ignore 'no-speech' and 'aborted' errors as they're common
      if (event.error === 'no-speech' || event.error === 'aborted') {
        return;
      }
      
      const err = new Error(`Speech recognition error: ${event.error}`);
      setError(err);
      config.onError?.(err);
    };

    recognition.onstart = () => {
      setIsListening(true);
      setError(null);
      config.onStart?.();
    };

    recognition.onend = () => {
      setIsListening(false);
      setInterimTranscript('');
      config.onEnd?.();
      
      // Auto-restart if not manually stopped (for continuous listening)
      if (!isManualStop.current && config.continuous) {
        try {
          recognition.start();
        } catch {
          // Ignore if already started
        }
      }
    };

    recognitionRef.current = recognition;

    return () => {
      recognition.abort();
    };
  }, [config.language, config.continuous, config.interimResults]);

  // Start listening
  const startListening = useCallback(() => {
    if (!recognitionRef.current) {
      setError(new Error('Speech recognition not initialized'));
      return;
    }

    try {
      isManualStop.current = false;
      setTranscript('');
      setInterimTranscript('');
      recognitionRef.current.start();
    } catch (err) {
      // May already be started
      console.warn('Speech recognition start error:', err);
    }
  }, []);

  // Stop listening
  const stopListening = useCallback(() => {
    if (!recognitionRef.current) return;

    isManualStop.current = true;
    recognitionRef.current.stop();
    setIsListening(false);
  }, []);

  // Abort (immediate stop)
  const abort = useCallback(() => {
    if (!recognitionRef.current) return;

    isManualStop.current = true;
    recognitionRef.current.abort();
    setIsListening(false);
  }, []);

  // Clear transcript
  const clearTranscript = useCallback(() => {
    setTranscript('');
    setInterimTranscript('');
  }, []);

  return {
    isListening,
    isSupported,
    transcript,
    interimTranscript,
    fullTranscript: transcript + interimTranscript,
    error,
    startListening,
    stopListening,
    abort,
    clearTranscript
  };
}
