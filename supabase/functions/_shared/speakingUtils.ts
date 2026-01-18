/**
 * Shared Speaking Evaluation Utilities
 * 
 * Consolidated utilities for speaking evaluation edge functions.
 * Reduces code duplication across: evaluate-speaking-submission, 
 * process-speaking-job, speaking-evaluate-job, speaking-upload-job
 */

import { crypto } from "https://deno.land/std@0.168.0/crypto/mod.ts";

// ============================================================================
// ENCRYPTION UTILITIES
// ============================================================================

/**
 * Decrypt a user's encrypted API key using AES-GCM
 */
export async function decryptKey(encrypted: string, appKey: string): Promise<string> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const keyData = encoder.encode(appKey).slice(0, 32);
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );
  const bytes = Uint8Array.from(atob(encrypted), c => c.charCodeAt(0));
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.slice(0, 12) },
    cryptoKey,
    bytes.slice(12)
  );
  return decoder.decode(decrypted);
}

// ============================================================================
// GOOGLE FILE API UTILITIES
// ============================================================================

/**
 * Upload audio to Google File API using direct HTTP (Deno-compatible)
 * Returns file URI for use in Gemini API calls
 */
export async function uploadToGoogleFileAPI(
  apiKey: string,
  audioBytes: Uint8Array,
  fileName: string,
  mimeType: string
): Promise<{ uri: string; mimeType: string }> {
  console.log(`[speakingUtils] Uploading ${fileName} to Google File API (${audioBytes.length} bytes)...`);
  
  const initiateUrl = `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`;
  
  const metadata = { file: { displayName: fileName } };
  
  const initiateResponse = await fetch(initiateUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(audioBytes.length),
      'X-Goog-Upload-Header-Content-Type': mimeType,
    },
    body: JSON.stringify(metadata),
  });
  
  if (!initiateResponse.ok) {
    const errorText = await initiateResponse.text();
    throw new Error(`Failed to initiate upload: ${initiateResponse.status} - ${errorText}`);
  }
  
  const uploadUrl = initiateResponse.headers.get('X-Goog-Upload-URL');
  if (!uploadUrl) {
    throw new Error('No upload URL returned from Google File API');
  }
  
  const uploadResponse = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Length': String(audioBytes.length),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
    },
    body: audioBytes.buffer as ArrayBuffer,
  });
  
  if (!uploadResponse.ok) {
    const errorText = await uploadResponse.text();
    throw new Error(`Failed to upload file: ${uploadResponse.status} - ${errorText}`);
  }
  
  const result = await uploadResponse.json();
  
  if (!result.file?.uri) {
    throw new Error('No file URI returned from Google File API');
  }
  
  console.log(`[speakingUtils] Uploaded ${fileName}: ${result.file.uri}`);
  
  return {
    uri: result.file.uri,
    mimeType: result.file.mimeType || mimeType,
  };
}

// ============================================================================
// JSON PARSING UTILITIES
// ============================================================================

/**
 * Parse JSON from Gemini response text, handling code blocks and malformed JSON
 */
export function parseJson(text: string): any {
  // Try direct parse first
  try { 
    return JSON.parse(text); 
  } catch {
    // Ignored
  }
  
  // Try extracting from code block
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (match) {
    try { 
      return JSON.parse(match[1].trim()); 
    } catch {
      // Ignored
    }
  }
  
  // Try extracting raw JSON object
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try { 
      return JSON.parse(objMatch[0]); 
    } catch {
      // Ignored
    }
  }
  
  return null;
}

// ============================================================================
// RETRY & BACKOFF UTILITIES
// ============================================================================

/**
 * Calculate exponential backoff delay with jitter
 */
export function exponentialBackoffWithJitter(
  attempt: number,
  baseDelayMs: number = 1000,
  maxDelayMs: number = 60000
): number {
  const exponentialDelay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
  const jitter = Math.random() * exponentialDelay * 0.5;
  return Math.round(exponentialDelay + jitter);
}

/**
 * Extract retry-after seconds from Gemini error message
 */
export function extractRetryAfterSeconds(err: any): number | undefined {
  const msg = String(err?.message || err || '');
  
  // Match: retryDelay":"56s"
  const m1 = msg.match(/retryDelay"\s*:\s*"(\d+)s"/i);
  if (m1) return Math.max(0, Number(m1[1]));
  
  // Match: retry in 56.7s
  const m2 = msg.match(/retry\s+in\s+([0-9.]+)s/i);
  if (m2) return Math.max(0, Math.ceil(Number(m2[1])));
  
  return undefined;
}

/**
 * Sleep utility
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// BAND SCORE CALCULATION UTILITIES
// ============================================================================

/**
 * IELTS band rounding rules:
 * - Round to nearest 0.5
 * - If fractional part is .25 or above, round up to .5
 * - If fractional part is .75 or above, round up to next whole band
 */
export function roundIELTSBand(rawAverage: number): number {
  if (!Number.isFinite(rawAverage)) return 0;
  
  const avg = Math.max(0, Math.min(9, rawAverage));
  const floor = Math.floor(avg);
  const fraction = avg - floor;
  
  if (fraction < 0.25) return floor;
  if (fraction < 0.75) return floor + 0.5;
  return floor + 1;
}

/**
 * Calculate overall band score from criteria scores using IELTS rounding
 * This should match frontend computeSpeakingOverallBandFromCriteria
 */
export function calculateBandFromCriteria(criteria: any): number {
  const criteriaKeys = ['fluency_coherence', 'lexical_resource', 'grammatical_range', 'pronunciation'];
  let total = 0;
  let count = 0;

  for (const key of criteriaKeys) {
    const criterion = criteria?.[key];
    const band = criterion?.band ?? criterion?.score;
    if (typeof band === 'number' && band >= 0 && band <= 9) {
      total += band;
      count++;
    }
  }

  if (count === 0) return 0;
  
  const avg = total / count;
  // Use proper IELTS rounding
  return roundIELTSBand(avg);
}

/**
 * Compute weighted overall band from part-level scores
 * Uses official IELTS-style weighting:
 * - Part 1: 25% (warmup, familiar topics)
 * - Part 2: 40% (core demonstration, long turn)
 * - Part 3: 35% (abstract discussion, deeper assessment)
 */
export function computeWeightedPartBand(partScores: {
  part1?: number;
  part2?: number;
  part3?: number;
}): number | null {
  const WEIGHTS = { part1: 0.25, part2: 0.40, part3: 0.35 };
  
  let weightedTotal = 0;
  let totalWeight = 0;

  if (typeof partScores.part1 === 'number' && partScores.part1 >= 0 && partScores.part1 <= 9) {
    weightedTotal += partScores.part1 * WEIGHTS.part1;
    totalWeight += WEIGHTS.part1;
  }
  if (typeof partScores.part2 === 'number' && partScores.part2 >= 0 && partScores.part2 <= 9) {
    weightedTotal += partScores.part2 * WEIGHTS.part2;
    totalWeight += WEIGHTS.part2;
  }
  if (typeof partScores.part3 === 'number' && partScores.part3 >= 0 && partScores.part3 <= 9) {
    weightedTotal += partScores.part3 * WEIGHTS.part3;
    totalWeight += WEIGHTS.part3;
  }

  // Only use weighted calculation if we have enough data (at least 50% weight)
  if (totalWeight < 0.5) return null;

  const rawBand = weightedTotal / totalWeight;
  // Use proper IELTS rounding
  return roundIELTSBand(rawBand);
}

// ============================================================================
// VALIDATION UTILITIES
// ============================================================================

/**
 * Validate that evaluation result has required fields and completeness
 */
export function validateEvaluationResult(
  result: any,
  expectedQuestionCount: number
): { valid: boolean; issues: string[] } {
  const issues: string[] = [];

  if (!result || typeof result !== 'object') {
    return { valid: false, issues: ['Response is not a valid object'] };
  }

  // Check overall_band exists and is reasonable
  const overallBand = result.overall_band ?? result.overallBand;
  if (typeof overallBand !== 'number' || overallBand < 1 || overallBand > 9) {
    issues.push(`Invalid overall_band: ${overallBand}`);
  }

  // Check criteria scores - handle both formats
  const criteria = result.criteria || {};
  const criteriaKeys = ['fluency_coherence', 'lexical_resource', 'grammatical_range', 'pronunciation'];

  for (const key of criteriaKeys) {
    const criterion = criteria[key] || result[key];
    const band = criterion?.band ?? criterion?.score;

    if (typeof band !== 'number' || band < 0 || band > 9) {
      issues.push(`Missing or invalid band for ${key}: ${band}`);
    }

    // Ensure we have feedback, not just "no audio input"
    const feedback = criterion?.feedback || '';
    if (typeof feedback === 'string' && feedback.toLowerCase().includes('no audio input')) {
      issues.push(`${key} says "no audio input" - audio wasn't processed correctly`);
    }
  }

  // Check modelAnswers count
  const modelAnswers = result.modelAnswers || result.model_answers || [];
  if (!Array.isArray(modelAnswers) || modelAnswers.length < expectedQuestionCount) {
    issues.push(`Expected ${expectedQuestionCount} modelAnswers, got ${modelAnswers.length}`);
  }

  // Check transcripts exist
  const transcriptsByQuestion = result.transcripts_by_question;
  if (!transcriptsByQuestion || typeof transcriptsByQuestion !== 'object') {
    issues.push('Missing transcripts_by_question');
  } else {
    let transcriptCount = 0;
    for (const partEntries of Object.values(transcriptsByQuestion)) {
      if (Array.isArray(partEntries)) {
        transcriptCount += partEntries.length;
      }
    }
    if (transcriptCount < expectedQuestionCount) {
      issues.push(`Expected ${expectedQuestionCount} transcripts, got ${transcriptCount}`);
    }
  }

  // Check that criteria bands are not all zero (indicates failed processing)
  let allZero = true;
  for (const key of criteriaKeys) {
    const criterion = criteria[key] || result[key];
    const band = criterion?.band ?? criterion?.score ?? 0;
    if (band > 0) allZero = false;
  }
  if (allZero && (result.overall_band ?? result.overallBand) > 0) {
    issues.push('All criteria bands are 0 but overall_band is non-zero - inconsistent');
  }

  return { valid: issues.length === 0, issues };
}

/**
 * Normalize Gemini response to consistent format
 */
export function normalizeGeminiResponse(result: any): any {
  if (!result) return result;

  // If criteria is missing but individual criteria are at root level, restructure
  if (!result.criteria && (result.fluency_coherence || result.lexical_resource)) {
    const criteriaKeys = ['fluency_coherence', 'lexical_resource', 'grammatical_range', 'pronunciation'];
    result.criteria = {};

    for (const key of criteriaKeys) {
      if (result[key]) {
        // Normalize score -> band
        if (result[key].score !== undefined && result[key].band === undefined) {
          result[key].band = result[key].score;
        }
        result.criteria[key] = result[key];
      }
    }
  }

  // Normalize overall band naming
  if (result.overallBand !== undefined && result.overall_band === undefined) {
    result.overall_band = result.overallBand;
  }

  // Normalize model answers array name
  if (result.model_answers && !result.modelAnswers) {
    result.modelAnswers = result.model_answers;
  }

  return result;
}

// ============================================================================
// CORS HEADERS
// ============================================================================

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-gemini-api-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// ============================================================================
// QUOTA ERROR CLASS
// ============================================================================

export class QuotaError extends Error {
  permanent: boolean;
  retryAfterSeconds?: number;

  constructor(message: string, opts: { permanent: boolean; retryAfterSeconds?: number }) {
    super(message);
    this.name = 'QuotaError';
    this.permanent = opts.permanent;
    this.retryAfterSeconds = opts.retryAfterSeconds;
  }
}
