/**
 * Audio Silence Trimmer - Production Grade
 * 
 * CRITICAL FIXES FOR TAIL-CLIPPING:
 * 1. Asymmetric thresholds (lower for end detection - handles decrescendo)
 * 2. 350ms trailing padding (Whisper needs silence runway)
 * 3. Energy slope detection (catches gradual fade-outs)
 * 4. Minimum audio preservation (never trim below 1 second)
 */

export interface TrimConfig {
  /** RMS threshold for START detection (0-1). Default 0.01 */
  silenceThreshold?: number;
  /** Multiplier for END detection threshold (lower = more sensitive). Default 0.6 */
  endThresholdMultiplier?: number;
  /** Analysis window size in seconds. Default 0.05 (50ms) */
  windowSize?: number;
  /** Minimum duration of silence before trimming (seconds). Default 0.2 */
  minSilenceDuration?: number;
  /** Trim trailing silence. Default false */
  trimTrailing?: boolean;
  /** Maximum leading silence to trim (seconds). Default 3 */
  maxLeadingTrim?: number;
  /** Maximum trailing silence to trim (seconds). Default 8 */
  maxTrailingTrim?: number;
  /** CRITICAL: Trailing padding to ALWAYS preserve (seconds). Default 0.35 */
  trailingPadding?: number;
  /** Minimum audio duration to keep (seconds). Default 1.0 */
  minAudioDuration?: number;
}

const DEFAULT_CONFIG: Required<TrimConfig> = {
  silenceThreshold: 0.01,
  endThresholdMultiplier: 0.6,  // 40% more sensitive for end detection
  windowSize: 0.05,
  minSilenceDuration: 0.2,
  trimTrailing: false,
  maxLeadingTrim: 3,
  maxTrailingTrim: 8,
  trailingPadding: 0.35,        // 350ms - critical for Whisper
  minAudioDuration: 1.0,        // Never trim below 1 second
};

/**
 * Computes RMS of a slice of samples.
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
 * Finds the first sample index where audio exceeds the silence threshold.
 * Uses standard threshold for start detection.
 */
function findSpeechStart(
  samples: Float32Array,
  sampleRate: number,
  config: Required<TrimConfig>
): number {
  const windowSamples = Math.floor(sampleRate * config.windowSize);
  const maxTrimSamples = Math.floor(sampleRate * config.maxLeadingTrim);
  const minSilenceSamples = Math.floor(sampleRate * config.minSilenceDuration);

  let silentSamples = 0;

  for (let i = 0; i < samples.length && i < maxTrimSamples; i += windowSamples) {
    const rms = computeRMS(samples, i, windowSamples);
    if (rms >= config.silenceThreshold) {
      if (silentSamples >= minSilenceSamples) {
        // Return slightly before to not clip speech onset
        return Math.max(0, i - Math.floor(windowSamples / 2));
      }
      return 0;
    }
    silentSamples += windowSamples;
  }

  if (silentSamples >= minSilenceSamples) {
    return Math.min(silentSamples, maxTrimSamples);
  }
  return 0;
}

/**
 * Finds the last sample index where audio exceeds the silence threshold.
 * 
 * CRITICAL IMPROVEMENTS:
 * 1. Uses LOWER threshold (endThresholdMultiplier) to catch quiet endings
 * 2. Adds 350ms trailing padding after detected end
 * 3. Uses energy slope detection to avoid cutting during gradual fade
 */
function findSpeechEnd(
  samples: Float32Array,
  sampleRate: number,
  config: Required<TrimConfig>
): number {
  const windowSamples = Math.floor(sampleRate * config.windowSize);
  const minSilenceSamples = Math.floor(sampleRate * config.minSilenceDuration);
  const maxTrailingTrimSamples = Math.floor(sampleRate * config.maxTrailingTrim);

  // CRITICAL: Calculate trailing padding in samples (350ms default)
  const trailingPaddingSamples = Math.floor(sampleRate * config.trailingPadding);

  // CRITICAL: Use LOWER threshold for end detection (catches quiet endings)
  const endThreshold = config.silenceThreshold * config.endThresholdMultiplier;

  let silentSamples = 0;
  let previousRMS = 0;

  for (let i = samples.length - windowSamples; i >= 0; i -= windowSamples) {
    if (silentSamples > maxTrailingTrimSamples) {
      return samples.length;
    }

    const rms = computeRMS(samples, i, windowSamples);

    // ENERGY SLOPE DETECTION: If energy is dropping but still above very low threshold,
    // this might be trailing speech (decrescendo) - don't cut here
    const isDecrescendo = previousRMS > 0 && rms > 0 &&
                          rms < previousRMS * 0.8 && // Energy dropping
                          rms > endThreshold * 0.3;   // But still audible

    if (rms >= endThreshold || isDecrescendo) {
      if (silentSamples >= minSilenceSamples) {
        // CRITICAL: Add trailing padding after detected speech end
        const endWithPadding = i + windowSamples + trailingPaddingSamples;
        console.log(`[audioSilenceTrimmer] Speech end detected at ${(i / sampleRate).toFixed(2)}s, adding ${config.trailingPadding}s padding`);
        return Math.min(samples.length, endWithPadding);
      }
      return samples.length;
    }

    previousRMS = rms;
    silentSamples += windowSamples;
  }

  return samples.length;
}

/**
 * Trim silence from the start (and optionally end) of an audio Blob.
 * Returns a new Blob with silence removed, preserving critical trailing audio.
 */
export async function trimSilence(
  audioBlob: Blob,
  config: TrimConfig = {}
): Promise<{ blob: Blob; trimmedLeadingMs: number; trimmedTrailingMs: number }> {
  const cfg: Required<TrimConfig> = { ...DEFAULT_CONFIG, ...config };

  try {
    const arrayBuffer = await audioBlob.arrayBuffer();
    const audioContext = new AudioContext();
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

    // Get mono samples
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

    const speechStart = findSpeechStart(samples, sampleRate, cfg);
    const speechEnd = cfg.trimTrailing
      ? findSpeechEnd(samples, sampleRate, cfg)
      : samples.length;

    // SAFETY CHECK: Ensure we don't trim below minimum duration
    const minSamples = Math.floor(sampleRate * cfg.minAudioDuration);
    const trimmedSamples = speechEnd - speechStart;

    if (trimmedSamples < minSamples) {
      console.log(`[audioSilenceTrimmer] Would trim to ${(trimmedSamples / sampleRate).toFixed(2)}s, below minimum ${cfg.minAudioDuration}s - skipping trim`);
      await audioContext.close();
      return { blob: audioBlob, trimmedLeadingMs: 0, trimmedTrailingMs: 0 };
    }

    // No meaningful trim needed
    if (speechStart === 0 && speechEnd === samples.length) {
      await audioContext.close();
      return { blob: audioBlob, trimmedLeadingMs: 0, trimmedTrailingMs: 0 };
    }

    const trimmedLeadingMs = Math.round((speechStart / sampleRate) * 1000);
    const trimmedTrailingMs = Math.max(0, Math.round(((samples.length - speechEnd) / sampleRate) * 1000));

    console.log(
      `[audioSilenceTrimmer] Trimming: ${trimmedLeadingMs}ms leading, ${trimmedTrailingMs}ms trailing ` +
      `(${originalDurationMs.toFixed(0)}ms → ${((speechEnd - speechStart) / sampleRate * 1000).toFixed(0)}ms)`
    );

    // Create new AudioBuffer with trimmed audio
    const trimmedBuffer = audioContext.createBuffer(
      audioBuffer.numberOfChannels,
      trimmedSamples,
      sampleRate
    );

    for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
      const original = audioBuffer.getChannelData(ch);
      const target = trimmedBuffer.getChannelData(ch);
      for (let i = 0; i < trimmedSamples; i++) {
        target[i] = original[speechStart + i];
      }
    }

    const wavBlob = audioBufferToWav(trimmedBuffer);
    await audioContext.close();

    return { blob: wavBlob, trimmedLeadingMs, trimmedTrailingMs };
  } catch (err) {
    console.warn('[audioSilenceTrimmer] Failed to trim silence:', err);
    return { blob: audioBlob, trimmedLeadingMs: 0, trimmedTrailingMs: 0 };
  }
}

/**
 * Backwards-compatible helper: trims leading silence only.
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
 * Convert an AudioBuffer to a WAV Blob.
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
