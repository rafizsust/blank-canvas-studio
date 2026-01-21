/**
 * Audio Silence Trimmer
 *
 * Trims leading (and optionally trailing) silence from an audio Blob using
 * RMS (root-mean-square) analysis on the decoded PCM data.
 *
 * Use case: Before uploading speaking recordings, we trim breath / silence
 * at the start to prevent Whisper from hallucinating filler text like
 * "IELTS speaking test interview".
 */

/** Configuration for silence trimming */
export interface TrimConfig {
  /** RMS threshold below which audio is considered silence (0-1). Default 0.01 */
  silenceThreshold?: number;
  /** Analysis window size in seconds. Default 0.05 (50ms) */
  windowSize?: number;
  /** Minimum duration (seconds) of silence to trim. Default 0.2 */
  minSilenceDuration?: number;
  /** Trim trailing silence as well. Default false */
  trimTrailing?: boolean;
  /** Maximum leading silence to trim (seconds). Default 3 */
  maxLeadingTrim?: number;
  /** Maximum trailing silence to trim (seconds). Default 8 */
  maxTrailingTrim?: number;
}

const DEFAULT_CONFIG: Required<TrimConfig> = {
  silenceThreshold: 0.01,
  windowSize: 0.05,
  minSilenceDuration: 0.2,
  trimTrailing: false,
  maxLeadingTrim: 3,
  maxTrailingTrim: 8,
};

/**
 * Computes RMS of a slice of samples.
 */
function computeRMS(samples: Float32Array, start: number, length: number): number {
  let sumSquares = 0;
  const end = Math.min(start + length, samples.length);
  for (let i = start; i < end; i++) {
    sumSquares += samples[i] * samples[i];
  }
  return Math.sqrt(sumSquares / (end - start));
}

/**
 * Finds the first sample index where audio exceeds the silence threshold.
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
      // Speech detected - only trim if we had enough silence first
      if (silentSamples >= minSilenceSamples) {
        // Return slightly before to not clip speech onset
        return Math.max(0, i - Math.floor(windowSamples / 2));
      }
      return 0; // Not enough silence, don't trim
    }
    silentSamples += windowSamples;
  }

  // All silence up to maxTrimSamples; trim all of it
  if (silentSamples >= minSilenceSamples) {
    return Math.min(silentSamples, maxTrimSamples);
  }
  return 0;
}

/**
 * Finds the last sample index where audio exceeds the silence threshold.
 */
function findSpeechEnd(
  samples: Float32Array,
  sampleRate: number,
  config: Required<TrimConfig>
): number {
  const windowSamples = Math.floor(sampleRate * config.windowSize);
  const minSilenceSamples = Math.floor(sampleRate * config.minSilenceDuration);
  const maxTrailingTrimSamples = Math.floor(sampleRate * config.maxTrailingTrim);

  let silentSamples = 0;
  let lastSpeechIdx = samples.length;

  for (let i = samples.length - windowSamples; i >= 0; i -= windowSamples) {
    // Don't scan beyond our max trailing trim budget.
    // If we haven't found speech within this range, keep original end.
    if (silentSamples > maxTrailingTrimSamples) {
      return samples.length;
    }

    const rms = computeRMS(samples, i, windowSamples);
    if (rms >= config.silenceThreshold) {
      if (silentSamples >= minSilenceSamples) {
        return Math.min(samples.length, i + windowSamples + Math.floor(windowSamples / 2));
      }
      return samples.length;
    }
    silentSamples += windowSamples;
    lastSpeechIdx = i;
  }

  return lastSpeechIdx;
}

/**
 * Trim silence from the start (and optionally end) of an audio Blob.
 * Returns a new Blob with silence removed.
 * Falls back to original blob if trimming fails or no silence detected.
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

    // Get mono samples (mix down if stereo)
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
    const speechStart = findSpeechStart(samples, sampleRate, cfg);
    const speechEnd = cfg.trimTrailing
      ? findSpeechEnd(samples, sampleRate, cfg)
      : samples.length;

    // No meaningful trim needed
    if (speechStart === 0 && speechEnd === samples.length) {
      await audioContext.close();
      return { blob: audioBlob, trimmedLeadingMs: 0, trimmedTrailingMs: 0 };
    }

    const trimmedSamples = speechEnd - speechStart;
    if (trimmedSamples < sampleRate * 0.5) {
      // Less than 0.5s of audio would remain; skip trim
      await audioContext.close();
      return { blob: audioBlob, trimmedLeadingMs: 0, trimmedTrailingMs: 0 };
    }

    const trimmedLeadingMs = Math.round((speechStart / sampleRate) * 1000);
    const trimmedTrailingMs = Math.max(
      0,
      Math.round(((samples.length - speechEnd) / sampleRate) * 1000)
    );
    console.log(
      `[audioSilenceTrimmer] Trimming ${trimmedLeadingMs}ms leading silence and ${trimmedTrailingMs}ms trailing silence (${speechStart}-${speechEnd} of ${samples.length} samples at ${sampleRate}Hz)`
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

    // Encode back to WAV (simpler than re-encoding to WebM)
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

  // Helper to write string
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
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // Audio format (PCM)
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeString(36, 'data');
  view.setUint32(40, dataLength, true);

  // Interleave samples and write as 16-bit PCM
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
