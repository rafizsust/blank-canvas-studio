/**
 * Audio Silence Trimmer - Production Grade v2.0
 * 
 * DESIGN PRINCIPLES:
 * 1. NEVER cut speech - when in doubt, keep audio
 * 2. Generous trailing padding for Whisper
 * 3. Energy slope detection for gradual fade-outs
 * 4. Minimum duration guarantee
 * 
 * TESTED AGAINST:
 * - Soft-spoken endings
 * - Trailing "um", "uh", "so..."
 * - Background noise environments
 * - Various accents and speaking speeds
 */

export interface TrimConfig {
  /** RMS threshold for START detection (0-1). Default 0.008 */
  silenceThreshold?: number;
  /** Multiplier for END detection threshold (lower = more sensitive). Default 0.5 */
  endThresholdMultiplier?: number;
  /** Analysis window size in seconds. Default 0.03 (30ms) */
  windowSize?: number;
  /** Minimum duration of silence before trimming (seconds). Default 0.3 */
  minSilenceDuration?: number;
  /** Trim trailing silence. Default false (safer) */
  trimTrailing?: boolean;
  /** Maximum leading silence to trim (seconds). Default 2 */
  maxLeadingTrim?: number;
  /** Maximum trailing silence to trim (seconds). Default 5 */
  maxTrailingTrim?: number;
  /** CRITICAL: Trailing padding to ALWAYS preserve (seconds). Default 0.5 */
  trailingPadding?: number;
  /** Minimum audio duration to keep (seconds). Default 2.0 */
  minAudioDuration?: number;
  /** Enable energy slope detection for fade-outs. Default true */
  detectFadeOut?: boolean;
}

const DEFAULT_CONFIG: Required<TrimConfig> = {
  silenceThreshold: 0.008,         // Lower threshold for sensitive detection
  endThresholdMultiplier: 0.5,     // 50% more sensitive for endings
  windowSize: 0.03,                // 30ms windows for finer granularity
  minSilenceDuration: 0.3,         // Require 300ms silence before trimming
  trimTrailing: false,             // Default OFF - safer
  maxLeadingTrim: 2,               // Max 2s leading trim
  maxTrailingTrim: 5,              // Max 5s trailing trim
  trailingPadding: 0.5,            // 500ms padding - CRITICAL for Whisper
  minAudioDuration: 2.0,           // Never trim below 2 seconds
  detectFadeOut: true,             // Detect gradual volume decrease
};

/**
 * Compute RMS (Root Mean Square) energy of audio samples
 */
function computeRMS(samples: Float32Array, start: number, length: number): number {
  let sumSquares = 0;
  const end = Math.min(start + length, samples.length);
  const actualLength = end - start;
  if (actualLength <= 0) return 0;

  for (let i = start; i < end; i++) {
    sumSquares += samples[i] * samples[i];
  }
  return Math.sqrt(sumSquares / actualLength);
}

/**
 * Compute peak amplitude in a window (alternative to RMS)
 */
function computePeak(samples: Float32Array, start: number, length: number): number {
  let peak = 0;
  const end = Math.min(start + length, samples.length);
  
  for (let i = start; i < end; i++) {
    const abs = Math.abs(samples[i]);
    if (abs > peak) peak = abs;
  }
  return peak;
}

/**
 * Find where speech starts (first audio above threshold)
 */
function findSpeechStart(
  samples: Float32Array,
  sampleRate: number,
  config: Required<TrimConfig>
): number {
  const windowSamples = Math.floor(sampleRate * config.windowSize);
  const maxTrimSamples = Math.floor(sampleRate * config.maxLeadingTrim);
  const minSilenceSamples = Math.floor(sampleRate * config.minSilenceDuration);

  let consecutiveSilentSamples = 0;

  for (let i = 0; i < samples.length && i < maxTrimSamples; i += windowSamples) {
    const rms = computeRMS(samples, i, windowSamples);
    const peak = computePeak(samples, i, windowSamples);
    
    // Use both RMS and peak for more reliable detection
    const hasSound = rms >= config.silenceThreshold || peak >= config.silenceThreshold * 3;
    
    if (hasSound) {
      if (consecutiveSilentSamples >= minSilenceSamples) {
        // Return position slightly before detected sound (safety margin)
        const safetyMargin = Math.floor(windowSamples * 2);
        return Math.max(0, i - safetyMargin);
      }
      return 0; // Sound found early, don't trim
    }
    consecutiveSilentSamples += windowSamples;
  }

  // Only trim if we found substantial silence
  if (consecutiveSilentSamples >= minSilenceSamples) {
    return Math.min(consecutiveSilentSamples, maxTrimSamples);
  }
  return 0;
}

/**
 * Find where speech ends (last audio above threshold)
 * 
 * CRITICAL: This function is designed to be CONSERVATIVE.
 * It's better to keep extra silence than to cut speech.
 */
function findSpeechEnd(
  samples: Float32Array,
  sampleRate: number,
  config: Required<TrimConfig>
): number {
  const windowSamples = Math.floor(sampleRate * config.windowSize);
  const minSilenceSamples = Math.floor(sampleRate * config.minSilenceDuration);
  const maxTrimSamples = Math.floor(sampleRate * config.maxTrailingTrim);
  const trailingPaddingSamples = Math.floor(sampleRate * config.trailingPadding);

  // Use LOWER threshold for end detection (catches quiet endings)
  const endThreshold = config.silenceThreshold * config.endThresholdMultiplier;

  let consecutiveSilentSamples = 0;
  let lastSpeechPosition = samples.length;
  let previousRMS = 0;
  let fadeOutDetected = false;

  // Scan backwards from end
  for (let i = samples.length - windowSamples; i >= 0; i -= windowSamples) {
    // Safety: don't trim more than maxTrailingTrim
    if (consecutiveSilentSamples > maxTrimSamples) {
      return samples.length; // Too much silence, don't trim
    }

    const rms = computeRMS(samples, i, windowSamples);
    const peak = computePeak(samples, i, windowSamples);

    // FADE-OUT DETECTION: If energy is decreasing but still audible
    if (config.detectFadeOut && previousRMS > 0) {
      const isDecreasing = rms < previousRMS * 0.85;
      const stillAudible = rms > endThreshold * 0.3 || peak > endThreshold;
      
      if (isDecreasing && stillAudible) {
        fadeOutDetected = true;
        // This is likely trailing speech, mark it
        lastSpeechPosition = i + windowSamples + trailingPaddingSamples;
        consecutiveSilentSamples = 0;
        previousRMS = rms;
        continue;
      }
    }

    // Check if this window has speech
    const hasSpeech = rms >= endThreshold || peak >= endThreshold * 2;

    if (hasSpeech) {
      if (consecutiveSilentSamples >= minSilenceSamples) {
        // Found speech after silence gap - this is the end point
        // Add trailing padding for Whisper
        const endWithPadding = i + windowSamples + trailingPaddingSamples;
        
        console.log(
          `[audioSilenceTrimmer] Speech end at ${(i / sampleRate).toFixed(2)}s, ` +
          `padding ${config.trailingPadding}s, fadeOut=${fadeOutDetected}`
        );
        
        return Math.min(samples.length, endWithPadding);
      }
      // Speech found, reset silence counter
      lastSpeechPosition = i + windowSamples;
      consecutiveSilentSamples = 0;
    } else {
      consecutiveSilentSamples += windowSamples;
    }

    previousRMS = rms;
  }

  // If fade-out was detected, use that position
  if (fadeOutDetected && lastSpeechPosition < samples.length) {
    return Math.min(samples.length, lastSpeechPosition + trailingPaddingSamples);
  }

  return samples.length; // Don't trim if uncertain
}

/**
 * Main function: Trim silence from audio blob
 * 
 * Returns new blob with silence removed, plus metrics
 */
export async function trimSilence(
  audioBlob: Blob,
  config: TrimConfig = {}
): Promise<{ blob: Blob; trimmedLeadingMs: number; trimmedTrailingMs: number; originalDurationMs: number }> {
  const cfg: Required<TrimConfig> = { ...DEFAULT_CONFIG, ...config };

  try {
    const arrayBuffer = await audioBlob.arrayBuffer();
    const audioContext = new AudioContext();
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

    // Convert to mono for analysis
    let samples: Float32Array;
    if (audioBuffer.numberOfChannels === 1) {
      samples = audioBuffer.getChannelData(0);
    } else {
      const left = audioBuffer.getChannelData(0);
      const right = audioBuffer.getChannelData(1);
      samples = new Float32Array(left.length);
      for (let i = 0; i < left.length; i++) {
        samples[i] = (left[i] + right[i]) / 2;
      }
    }

    const sampleRate = audioBuffer.sampleRate;
    const originalDurationMs = (samples.length / sampleRate) * 1000;

    // Find trim points
    const speechStart = findSpeechStart(samples, sampleRate, cfg);
    const speechEnd = cfg.trimTrailing
      ? findSpeechEnd(samples, sampleRate, cfg)
      : samples.length;

    // SAFETY: Ensure minimum duration
    const minSamples = Math.floor(sampleRate * cfg.minAudioDuration);
    const proposedLength = speechEnd - speechStart;

    if (proposedLength < minSamples) {
      console.log(
        `[audioSilenceTrimmer] Would trim to ${(proposedLength / sampleRate).toFixed(2)}s, ` +
        `below minimum ${cfg.minAudioDuration}s - skipping trim`
      );
      await audioContext.close();
      return { blob: audioBlob, trimmedLeadingMs: 0, trimmedTrailingMs: 0, originalDurationMs };
    }

    // No meaningful trim needed
    if (speechStart === 0 && speechEnd === samples.length) {
      await audioContext.close();
      return { blob: audioBlob, trimmedLeadingMs: 0, trimmedTrailingMs: 0, originalDurationMs };
    }

    const trimmedLeadingMs = Math.round((speechStart / sampleRate) * 1000);
    const trimmedTrailingMs = Math.max(0, Math.round(((samples.length - speechEnd) / sampleRate) * 1000));

    console.log(
      `[audioSilenceTrimmer] Trimming: ${trimmedLeadingMs}ms leading, ${trimmedTrailingMs}ms trailing ` +
      `(${originalDurationMs.toFixed(0)}ms → ${((speechEnd - speechStart) / sampleRate * 1000).toFixed(0)}ms)`
    );

    // Create trimmed buffer
    const trimmedLength = speechEnd - speechStart;
    const trimmedBuffer = audioContext.createBuffer(
      audioBuffer.numberOfChannels,
      trimmedLength,
      sampleRate
    );

    for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
      const original = audioBuffer.getChannelData(ch);
      const target = trimmedBuffer.getChannelData(ch);
      for (let i = 0; i < trimmedLength; i++) {
        target[i] = original[speechStart + i];
      }
    }

    const wavBlob = audioBufferToWav(trimmedBuffer);
    await audioContext.close();

    return { blob: wavBlob, trimmedLeadingMs, trimmedTrailingMs, originalDurationMs };
  } catch (err) {
    console.warn('[audioSilenceTrimmer] Trim failed, returning original:', err);
    return { blob: audioBlob, trimmedLeadingMs: 0, trimmedTrailingMs: 0, originalDurationMs: 0 };
  }
}

/**
 * Backwards-compatible helper
 */
export async function trimLeadingSilence(
  audioBlob: Blob,
  config: TrimConfig = {}
): Promise<{ blob: Blob; trimmedMs: number }> {
  const { blob, trimmedLeadingMs } = await trimSilence(audioBlob, {
    ...config,
    trimTrailing: false,
  });
  return { blob, trimmedMs: trimmedLeadingMs };
}

/**
 * Convert AudioBuffer to WAV Blob
 */
function audioBufferToWav(buffer: AudioBuffer): Blob {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataLength = buffer.length * blockAlign;
  const headerLength = 44;
  const totalLength = headerLength + dataLength;

  const arrayBuffer = new ArrayBuffer(totalLength);
  const view = new DataView(arrayBuffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  // WAV header
  writeString(0, 'RIFF');
  view.setUint32(4, totalLength - 8, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeString(36, 'data');
  view.setUint32(40, dataLength, true);

  const channels: Float32Array[] = [];
  for (let ch = 0; ch < numChannels; ch++) {
    channels.push(buffer.getChannelData(ch));
  }

  let offset = 44;
  for (let i = 0; i < buffer.length; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, channels[ch][i]));
      const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      view.setInt16(offset, intSample, true);
      offset += 2;
    }
  }

  return new Blob([arrayBuffer], { type: 'audio/wav' });
}
