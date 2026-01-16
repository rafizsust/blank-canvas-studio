import { useState, useRef, useCallback, useEffect } from 'react';
import { detectBrowser } from '@/lib/speechRecognition/browserDetection';

interface SpeechSynthesisConfig {
  voiceName?: string;
  lang?: string;
  rate?: number;
  pitch?: number;
  volume?: number;
  onStart?: () => void;
  onEnd?: () => void;
  onError?: (error: Error) => void;
  onBoundary?: (charIndex: number) => void;
}

// Track current volume/muted state at module level for access during speech
// Initialize from localStorage for persistence across page loads
const VOLUME_STORAGE_KEY = 'speaking_tts_volume';
const MUTED_STORAGE_KEY = 'speaking_tts_muted';

const getSavedVolume = (): number => {
  try {
    const saved = localStorage.getItem(VOLUME_STORAGE_KEY);
    if (saved) return Math.max(0, Math.min(1, parseFloat(saved)));
  } catch {}
  return 1;
};

const getSavedMuted = (): boolean => {
  try {
    const saved = localStorage.getItem(MUTED_STORAGE_KEY);
    if (saved) return saved === 'true';
  } catch {}
  return false;
};

let currentTTSVolume = getSavedVolume();
let currentTTSMuted = getSavedMuted();

// Detect browser once at module level
const browserInfo = detectBrowser();

// Pre-load voices on module init to avoid delays when first speaking
if (typeof window !== 'undefined' && window.speechSynthesis) {
  // Trigger voice loading immediately
  window.speechSynthesis.getVoices();
  window.speechSynthesis.onvoiceschanged = () => {
    // Voices are now cached and ready
    console.log('[TTS] Voices preloaded on module init');
  };
}

export function useSpeechSynthesis(config: SpeechSynthesisConfig = {}) {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [selectedVoice, setSelectedVoice] = useState<SpeechSynthesisVoice | null>(null);
  const [isSupported, setIsSupported] = useState(true);
  
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const speechQueueRef = useRef<{ text: string; options?: Partial<SpeechSynthesisConfig> }[]>([]);

  // Guard + chunking to avoid browser TTS repeating long prompts mid-sentence.
  const activeSessionRef = useRef<string | null>(null);
  const activeChunksRef = useRef<string[]>([]);
  const activeChunkIndexRef = useRef(0);
  const isCancellingRef = useRef(false);
  
  // Edge browser workaround: timeout refs for detecting stuck utterances
  const edgeSafetyTimerRef = useRef<number | null>(null);
  const edgeStartupTimerRef = useRef<number | null>(null);
  const utteranceStartTimeRef = useRef<number>(0);

  const sanitizeText = (t: string) =>
    t
      .replace(/<[^>]*>/g, '')
      .replace(/&[a-z]+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  const splitIntoChunks = (t: string, maxLen = 180): string[] => {
    const text = sanitizeText(t);
    if (!text) return [];
    if (text.length <= maxLen) return [text];

    const chunks: string[] = [];
    let remaining = text;

    // Prefer sentence-ish boundaries, otherwise split on spaces.
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

  // Load available voices
  useEffect(() => {
    if (!window.speechSynthesis) {
      setIsSupported(false);
      return;
    }

    // Helper to check if voice is local (not "Online" which requires server handshake)
    const isLocalVoice = (v: SpeechSynthesisVoice) => !v.name.includes('Online');

    const loadVoices = () => {
      const availableVoices = window.speechSynthesis.getVoices();
      setVoices(availableVoices);

      let voice: SpeechSynthesisVoice | null = null;

      // EDGE FIX: Prefer LOCAL voices to avoid server handshake issues with "Online" voices
      if (browserInfo.isEdge) {
        console.log('[TTS Edge] Filtering for LOCAL voices (avoiding unreliable Online voices)');
        
        // First try to match config voiceName with local voice
        if (config.voiceName) {
          voice = availableVoices.find(v => 
            isLocalVoice(v) && v.name.toLowerCase().includes(config.voiceName!.toLowerCase())
          ) || null;
        }

        // Then try local British English voice
        if (!voice) {
          voice = availableVoices.find(v => 
            isLocalVoice(v) && (v.lang === 'en-GB' || v.lang.startsWith('en-GB'))
          ) || null;
        }

        // Then any local English voice
        if (!voice) {
          voice = availableVoices.find(v => 
            isLocalVoice(v) && v.lang.startsWith('en')
          ) || null;
        }

        // Any local voice
        if (!voice) {
          voice = availableVoices.find(v => isLocalVoice(v)) || null;
        }

        // Last resort: any voice including Online (better than nothing)
        if (!voice && availableVoices.length > 0) {
          voice = availableVoices[0];
          console.warn('[TTS Edge] No local voices found, using Online voice (may be unreliable):', voice.name);
        }

        if (voice) {
          console.log('[TTS Edge] Selected voice:', voice.name, '| Local:', isLocalVoice(voice));
        }
      } else {
        // Non-Edge browsers: original logic
        const preferredVoices = [
          'Google UK English Male',
          'Microsoft George - English (United Kingdom)',
          'Daniel',
          'en-GB-George',
          'en-GB',
        ];

        // First try to match by config voiceName
        if (config.voiceName) {
          voice = availableVoices.find(v => 
            v.name.toLowerCase().includes(config.voiceName!.toLowerCase())
          ) || null;
        }

        // Then try preferred voices
        if (!voice) {
          for (const preferred of preferredVoices) {
            voice = availableVoices.find(v => 
              v.name.includes(preferred) || v.lang.includes(preferred)
            ) || null;
            if (voice) break;
          }
        }

        // Fallback to any British English voice
        if (!voice) {
          voice = availableVoices.find(v => 
            v.lang === 'en-GB' || v.lang.startsWith('en-GB')
          ) || null;
        }

        // Final fallback to any English voice
        if (!voice) {
          voice = availableVoices.find(v => 
            v.lang.startsWith('en')
          ) || null;
        }

        if (voice) {
          console.log('Selected TTS voice:', voice.name, voice.lang);
        }
      }

      if (voice) {
        setSelectedVoice(voice);
      }
    };

    // Voices may load asynchronously
    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices;

    return () => {
      window.speechSynthesis.onvoiceschanged = null;
    };
  }, [config.voiceName]);

  // Speak text (chunked)
  const speak = useCallback(
    (text: string, options?: Partial<SpeechSynthesisConfig>) => {
      if (!window.speechSynthesis) {
        config.onError?.(new Error('Speech synthesis not supported'));
        return;
      }

      const chunks = splitIntoChunks(text);
      if (chunks.length === 0) {
        setIsSpeaking(false);
        setIsPaused(false);
        return;
      }

      // Start a new session (so stale events cannot restart speech)
      const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      activeSessionRef.current = sessionId;
      activeChunksRef.current = chunks;
      activeChunkIndexRef.current = 0;

      // Cancel any current speech (barge-in)
      isCancellingRef.current = true;
      window.speechSynthesis.cancel();

      // Allow cancel to flush before starting again (prevents some Chrome repeat bugs)
      setTimeout(() => {
        isCancellingRef.current = false;

        const speakChunk = (index: number) => {
          if (!window.speechSynthesis) return;
          if (activeSessionRef.current !== sessionId) return;

          // Clear any existing Edge safety timers
          if (edgeSafetyTimerRef.current) {
            window.clearTimeout(edgeSafetyTimerRef.current);
            edgeSafetyTimerRef.current = null;
          }
          if (edgeStartupTimerRef.current) {
            window.clearTimeout(edgeStartupTimerRef.current);
            edgeStartupTimerRef.current = null;
          }

          const chunk = activeChunksRef.current[index];
          const utterance = new SpeechSynthesisUtterance(chunk);
          utteranceRef.current = utterance;

          if (selectedVoice) utterance.voice = selectedVoice;

          const rate = options?.rate ?? config.rate ?? 0.95;
          utterance.lang = options?.lang ?? config.lang ?? 'en-GB';
          utterance.rate = rate;
          utterance.pitch = options?.pitch ?? config.pitch ?? 1;
          // Use current muted state and volume
          utterance.volume = currentTTSMuted ? 0 : (options?.volume ?? currentTTSVolume ?? config.volume ?? 1);

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

            if (activeSessionRef.current !== sessionId) return;

            const nextIndex = index + 1;
            if (nextIndex < activeChunksRef.current.length) {
              activeChunkIndexRef.current = nextIndex;
              // Small async gap avoids edge cases where Chrome restarts long utterances.
              setTimeout(() => speakChunk(nextIndex), 0);
              return;
            }

            setIsSpeaking(false);
            setIsPaused(false);
            config.onEnd?.();

            // Process next full text in queue
            if (speechQueueRef.current.length > 0) {
              const next = speechQueueRef.current.shift()!;
              speak(next.text, next.options);
            }
          };

          utterance.onstart = () => {
            onstartFired = true;
            
            // Clear startup timer since onstart fired successfully
            if (edgeStartupTimerRef.current) {
              window.clearTimeout(edgeStartupTimerRef.current);
              edgeStartupTimerRef.current = null;
            }
            
            if (activeSessionRef.current !== sessionId) return;
            setIsSpeaking(true);
            setIsPaused(false);
            utteranceStartTimeRef.current = Date.now();
            if (index === 0) config.onStart?.();

            // Edge workaround: Set a safety timeout based on estimated speech duration
            // Edge sometimes doesn't fire onend, causing speech to appear stuck
            if (browserInfo.isEdge) {
              // Estimate: ~80ms per character at rate 0.95, plus 2s buffer
              const estimatedDuration = Math.max(3000, (chunk.length * 80 / rate) + 2000);
              console.log(`[TTS Edge] Safety timer set for ${estimatedDuration}ms for chunk ${index + 1}/${activeChunksRef.current.length}`);
              
              edgeSafetyTimerRef.current = window.setTimeout(() => {
                // Check if speech is actually still pending/speaking
                if (activeSessionRef.current === sessionId && !chunkEndFired) {
                  console.warn('[TTS Edge] Safety timeout triggered - forcing progression');
                  // Force cancel and move on
                  window.speechSynthesis.cancel();
                  handleChunkEnd();
                }
              }, estimatedDuration);
            }
          };

          utterance.onend = () => {
            handleChunkEnd();
          };

          utterance.onerror = (event) => {
            // Clear Edge safety timers on error too
            if (edgeSafetyTimerRef.current) {
              window.clearTimeout(edgeSafetyTimerRef.current);
              edgeSafetyTimerRef.current = null;
            }
            if (edgeStartupTimerRef.current) {
              window.clearTimeout(edgeStartupTimerRef.current);
              edgeStartupTimerRef.current = null;
            }

            // Ignore 'canceled' errors as they're intentional (barge-in)
            if (event.error === 'canceled' || isCancellingRef.current) {
              setIsSpeaking(false);
              return;
            }

            // Edge sometimes fires 'interrupted' error when we force progression - treat as success
            if (browserInfo.isEdge && event.error === 'interrupted') {
              console.log('[TTS Edge] Interrupted error treated as success');
              handleChunkEnd();
              return;
            }

            const err = new Error(`Speech synthesis error: ${event.error}`);
            config.onError?.(err);
            setIsSpeaking(false);
            setIsPaused(false);
          };

          utterance.onboundary = (event) => {
            // Reset safety timer on boundary events (proves speech is progressing)
            if (browserInfo.isEdge && edgeSafetyTimerRef.current) {
              utteranceStartTimeRef.current = Date.now();
            }
            config.onBoundary?.(event.charIndex);
          };

          window.speechSynthesis.speak(utterance);
          
          // Edge workaround: Set a STARTUP timeout - REDUCED from 3s to 1.5s for faster response
          // If onstart doesn't fire, force progression to avoid blocking the user
          if (browserInfo.isEdge) {
            console.log(`[TTS Edge] Startup timer set for 1500ms - chunk ${index + 1}`);
            edgeStartupTimerRef.current = window.setTimeout(() => {
              if (activeSessionRef.current === sessionId && !onstartFired && !chunkEndFired) {
                console.warn('[TTS Edge] Startup timeout - onstart never fired, forcing progression');
                window.speechSynthesis.cancel();
                handleChunkEnd();
              }
            }, 1500);
          }
        };

        speakChunk(0);
      }, 0);
    },
    [selectedVoice, config]
  );

  // Queue text for speaking
  const queueSpeak = useCallback(
    (text: string) => {
      if (isSpeaking) {
        speechQueueRef.current.push({ text });
      } else {
        speak(text);
      }
    },
    [isSpeaking, speak]
  );

  // Cancel all speech (barge-in support)
  const cancel = useCallback(() => {
    activeSessionRef.current = null;
    activeChunksRef.current = [];
    activeChunkIndexRef.current = 0;
    speechQueueRef.current = [];

    // Clear Edge safety timers
    if (edgeSafetyTimerRef.current) {
      window.clearTimeout(edgeSafetyTimerRef.current);
      edgeSafetyTimerRef.current = null;
    }
    if (edgeStartupTimerRef.current) {
      window.clearTimeout(edgeStartupTimerRef.current);
      edgeStartupTimerRef.current = null;
    }

    isCancellingRef.current = true;
    window.speechSynthesis?.cancel();
    setTimeout(() => {
      isCancellingRef.current = false;
    }, 0);

    setIsSpeaking(false);
    setIsPaused(false);
  }, []);

  // Pause speech
  const pause = useCallback(() => {
    window.speechSynthesis?.pause();
    setIsPaused(true);
  }, []);

  // Resume speech
  const resume = useCallback(() => {
    window.speechSynthesis?.resume();
    setIsPaused(false);
  }, []);

  // Get British male voices
  const getBritishVoices = useCallback(() => {
    return voices.filter(v => 
      v.lang === 'en-GB' || v.lang.startsWith('en-GB')
    );
  }, [voices]);

  // Set voice by name
  const setVoiceByName = useCallback((name: string) => {
    const voice = voices.find(v => v.name.includes(name));
    if (voice) {
      setSelectedVoice(voice);
    }
  }, [voices]);

  // Set volume for TTS (0-1) - persists to localStorage
  const setVolume = useCallback((vol: number) => {
    currentTTSVolume = Math.max(0, Math.min(1, vol));
    try {
      localStorage.setItem(VOLUME_STORAGE_KEY, String(currentTTSVolume));
    } catch {}
    
    // Update current utterance volume immediately if speaking
    if (utteranceRef.current && window.speechSynthesis?.speaking) {
      // Note: Some browsers don't allow changing volume mid-speech
      // In that case, we accept the delay - the new volume applies to the next chunk
      utteranceRef.current.volume = currentTTSMuted ? 0 : currentTTSVolume;
    }
  }, []);

  // Set muted state for TTS - persists to localStorage
  const setMuted = useCallback((muted: boolean) => {
    currentTTSMuted = muted;
    try {
      localStorage.setItem(MUTED_STORAGE_KEY, String(muted));
    } catch {}
    
    // Update current utterance volume immediately if speaking
    if (utteranceRef.current && window.speechSynthesis?.speaking) {
      utteranceRef.current.volume = muted ? 0 : currentTTSVolume;
    }
  }, []);

  return {
    isSpeaking,
    isPaused,
    isSupported,
    voices,
    selectedVoice,
    speak,
    queueSpeak,
    cancel,
    pause,
    resume,
    getBritishVoices,
    setVoiceByName,
    setVolume,
    setMuted,
  };
}
