/**
 * Groq Key Pool Manager
 * 
 * Manages Groq API keys for speaking evaluation with:
 * - ASH (Audio Seconds per Hour) tracking (free tier: 7,200s/hour)
 * - RPM management (free tier: 20 RPM for Whisper)
 * - Separate checkout for STT (Whisper) and LLM (Llama)
 * - Key rotation across multiple free accounts
 * 
 * Usage:
 *   const sttKey = await checkoutGroqKeyForSTT(supabase, jobId, estimatedSeconds);
 *   // ... call Whisper API ...
 *   await recordASHUsage(supabase, sttKey.keyId, actualSeconds);
 *   
 *   const llmKey = await checkoutGroqKeyForLLM(supabase, jobId);
 *   // ... call Llama API ...
 */

// ============================================================================
// TIMING CONFIGURATION (Groq Free Tier)
// ============================================================================

export const GROQ_TIMINGS = {
  // Delay between Whisper calls to stay under 20 RPM (3 seconds = max 20/min)
  INTER_SEGMENT_DELAY_MS: 3000,
  
  // ASH limit per hour (free tier)
  ASH_LIMIT_PER_HOUR: 7200,
  
  // RPM cooldown when rate limited (seconds)
  RPM_COOLDOWN_SEC: 60,
  
  // Daily quota cooldown (24 hours in minutes)
  DAILY_QUOTA_COOLDOWN_MIN: 1440,
};

// ============================================================================
// TYPES
// ============================================================================

export interface GroqKeyCheckoutResult {
  keyId: string;
  keyValue: string;
}

export interface GroqErrorClassification {
  type: 'rate_limit' | 'ash_limit' | 'daily_quota' | 'transient' | 'permanent';
  cooldownSeconds: number;
  shouldRetry: boolean;
  shouldSwitchKey: boolean;
  description: string;
}

// ============================================================================
// KEY CHECKOUT FUNCTIONS
// ============================================================================

/**
 * Checkout a Groq API key for Whisper STT.
 * Respects ASH limits and RPM cooldowns.
 */
export async function checkoutGroqKeyForSTT(
  supabaseService: any,
  jobId: string,
  estimatedAudioSeconds: number = 60
): Promise<GroqKeyCheckoutResult | null> {
  console.log(`[groqKeyPoolManager] Checking out Groq key for STT, job ${jobId?.slice(0, 8)}...`);
  
  const { data: keyRows, error } = await supabaseService.rpc('checkout_groq_key_for_stt', {
    p_job_id: jobId,
    p_estimated_audio_seconds: estimatedAudioSeconds,
  });
  
  if (error) {
    console.error(`[groqKeyPoolManager] checkout_groq_key_for_stt error:`, error.message);
    return null;
  }
  
  if (!keyRows || keyRows.length === 0) {
    console.warn(`[groqKeyPoolManager] No available Groq keys for STT (all exhausted, cooling down, or ASH limit reached)`);
    return null;
  }
  
  const key = keyRows[0];
  console.log(`[groqKeyPoolManager] Checked out Groq STT key ${key.out_key_id?.slice(0, 8)}...`);
  
  return {
    keyId: key.out_key_id,
    keyValue: key.out_key_value,
  };
}

/**
 * Checkout a Groq API key for Llama LLM.
 * Simpler checkout - just checks if not exhausted.
 */
export async function checkoutGroqKeyForLLM(
  supabaseService: any,
  jobId: string
): Promise<GroqKeyCheckoutResult | null> {
  console.log(`[groqKeyPoolManager] Checking out Groq key for LLM, job ${jobId?.slice(0, 8)}...`);
  
  const { data: keyRows, error } = await supabaseService.rpc('checkout_groq_key_for_llm', {
    p_job_id: jobId,
  });
  
  if (error) {
    console.error(`[groqKeyPoolManager] checkout_groq_key_for_llm error:`, error.message);
    return null;
  }
  
  if (!keyRows || keyRows.length === 0) {
    console.warn(`[groqKeyPoolManager] No available Groq keys for LLM (all exhausted)`);
    return null;
  }
  
  const key = keyRows[0];
  console.log(`[groqKeyPoolManager] Checked out Groq LLM key ${key.out_key_id?.slice(0, 8)}...`);
  
  return {
    keyId: key.out_key_id,
    keyValue: key.out_key_value,
  };
}

// ============================================================================
// USAGE TRACKING
// ============================================================================

/**
 * Record ASH usage after successful transcription.
 * Call this after each Whisper call completes.
 */
export async function recordASHUsage(
  supabaseService: any,
  keyId: string,
  audioSeconds: number
): Promise<void> {
  console.log(`[groqKeyPoolManager] Recording ${audioSeconds}s ASH usage for key ${keyId?.slice(0, 8)}...`);
  
  const { error } = await supabaseService.rpc('record_groq_ash_usage', {
    p_key_id: keyId,
    p_audio_seconds: Math.ceil(audioSeconds),
  });
  
  if (error) {
    console.error(`[groqKeyPoolManager] record_groq_ash_usage error:`, error.message);
  }
}

// ============================================================================
// RATE LIMIT HANDLING
// ============================================================================

/**
 * Mark a Groq key as RPM-limited (short cooldown).
 * Call this when you get a 429 error from Whisper.
 */
export async function markGroqKeyRPMLimited(
  supabaseService: any,
  keyId: string,
  cooldownSeconds: number = GROQ_TIMINGS.RPM_COOLDOWN_SEC
): Promise<void> {
  console.log(`[groqKeyPoolManager] Marking key ${keyId?.slice(0, 8)}... as RPM-limited for ${cooldownSeconds}s`);
  
  const { error } = await supabaseService.rpc('mark_groq_key_rpm_limited', {
    p_key_id: keyId,
    p_cooldown_seconds: cooldownSeconds,
  });
  
  if (error) {
    console.error(`[groqKeyPoolManager] mark_groq_key_rpm_limited error:`, error.message);
  }
}

/**
 * Mark a Groq key as exhausted for a specific model.
 * Call this when you get a quota exhaustion error.
 */
export async function markGroqKeyExhausted(
  supabaseService: any,
  keyId: string,
  model: 'whisper_v3_turbo' | 'whisper_v3' | 'llama_70b'
): Promise<void> {
  console.log(`[groqKeyPoolManager] Marking key ${keyId?.slice(0, 8)}... as exhausted for ${model}`);
  
  const { error } = await supabaseService.rpc('mark_groq_key_exhausted', {
    p_key_id: keyId,
    p_model: model,
  });
  
  if (error) {
    console.error(`[groqKeyPoolManager] mark_groq_key_exhausted error:`, error.message);
  }
}

// ============================================================================
// ERROR CLASSIFICATION
// ============================================================================

/**
 * Classify Groq API errors to determine appropriate response.
 */
export function classifyGroqError(error: any, response?: Response): GroqErrorClassification {
  const msg = String(error?.message || error || '').toLowerCase();
  const status = response?.status || error?.status || 0;
  
  // Check for ASH limit (audio_seconds_per_hour)
  if (msg.includes('audio_seconds') || msg.includes('ash') || msg.includes('audio seconds per hour')) {
    return {
      type: 'ash_limit',
      cooldownSeconds: 3600, // 1 hour
      shouldRetry: false,
      shouldSwitchKey: true,
      description: 'ASH limit reached for this key. Switching to another key.',
    };
  }
  
  // Check for daily quota exhaustion
  if (
    msg.includes('exceeded your current quota') ||
    msg.includes('quota exceeded') ||
    msg.includes('resource_exhausted') ||
    msg.includes('daily') ||
    msg.includes('per day')
  ) {
    return {
      type: 'daily_quota',
      cooldownSeconds: GROQ_TIMINGS.DAILY_QUOTA_COOLDOWN_MIN * 60,
      shouldRetry: false,
      shouldSwitchKey: true,
      description: 'Daily quota exhausted. Key marked for 24h cooldown.',
    };
  }
  
  // Check for rate limit (RPM/TPM)
  if (
    status === 429 ||
    msg.includes('429') ||
    msg.includes('too many requests') ||
    msg.includes('rate limit') ||
    msg.includes('rate_limit') ||
    msg.includes('rpm') ||
    msg.includes('requests per minute')
  ) {
    return {
      type: 'rate_limit',
      cooldownSeconds: GROQ_TIMINGS.RPM_COOLDOWN_SEC,
      shouldRetry: false,
      shouldSwitchKey: true,
      description: 'RPM limit hit. Switching to different key.',
    };
  }
  
  // Transient errors
  if (
    msg.includes('timeout') ||
    msg.includes('network') ||
    msg.includes('connection') ||
    msg.includes('503') ||
    msg.includes('service unavailable') ||
    msg.includes('temporarily') ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  ) {
    return {
      type: 'transient',
      cooldownSeconds: 0,
      shouldRetry: true,
      shouldSwitchKey: false,
      description: 'Transient error. Will retry with same key.',
    };
  }
  
  // Permanent/unknown
  return {
    type: 'permanent',
    cooldownSeconds: 0,
    shouldRetry: false,
    shouldSwitchKey: false,
    description: 'Permanent or unknown error. Check logs.',
  };
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Sleep utility for inter-segment delays.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Inter-segment delay to respect Whisper RPM limit.
 * Call this between consecutive Whisper API calls.
 */
export async function interSegmentDelay(): Promise<void> {
  console.log(`[groqKeyPoolManager] Inter-segment delay: ${GROQ_TIMINGS.INTER_SEGMENT_DELAY_MS}ms`);
  await sleep(GROQ_TIMINGS.INTER_SEGMENT_DELAY_MS);
}

/**
 * Get the current provider settings.
 */
export async function getSpeakingEvaluationProvider(
  supabaseService: any
): Promise<{
  provider: 'gemini' | 'groq';
  groqSttModel: string;
  groqLlmModel: string;
  geminiModel: string;
  autoFallbackEnabled: boolean;
} | null> {
  const { data, error } = await supabaseService.rpc('get_speaking_evaluation_provider');
  
  if (error || !data || data.length === 0) {
    console.warn(`[groqKeyPoolManager] Could not get provider settings, defaulting to gemini`);
    return null;
  }
  
  const settings = data[0];
  return {
    provider: settings.provider as 'gemini' | 'groq',
    groqSttModel: settings.groq_stt_model,
    groqLlmModel: settings.groq_llm_model,
    geminiModel: settings.gemini_model,
    autoFallbackEnabled: settings.auto_fallback_enabled,
  };
}
