/**
 * Key Pool Manager for Per-Part Key Rotation
 * 
 * Provides intelligent API key management with:
 * - Per-part key locking for speaking evaluations
 * - Rate limit cooling (5-10 min based on consecutive 429s)
 * - Daily quota exhaustion tracking
 * - No-retry policy for 429 errors (switch key instead)
 * 
 * Usage:
 *   const key = await checkoutKeyForPart(supabase, userId, jobId, 1);
 *   // ... use key.keyValue for AI call ...
 *   await releaseKeyWithCooldown(supabase, jobId, 1, 45);
 */

// ============================================================================
// TIMING CONFIGURATION
// ============================================================================

export const TIMINGS = {
  // How long to lock a key for a single part evaluation (seconds)
  KEY_LOCK_DURATION_SEC: 120,
  
  // Mandatory cooldown after releasing a key (seconds)
  KEY_COOLDOWN_SEC: 45,
  
  // Delay between processing parts (seconds) - helps RPM reset
  INTER_PART_DELAY_SEC: 30,
  
  // Cooldown when 429/TPM/RPM hit (minutes) - first occurrence
  RATE_LIMIT_COOLDOWN_MIN: 5,
  
  // Escalated cooldown after 3+ consecutive 429s (minutes)
  RATE_LIMIT_ESCALATION_MIN: 10,
  
  // Cooldown for daily quota exhaustion (minutes) - 24 hours
  DAILY_QUOTA_COOLDOWN_MIN: 1440,
};

// ============================================================================
// TYPES
// ============================================================================

export interface KeyCheckoutResult {
  keyId: string;
  keyValue: string;
  isUserKey: boolean;
}

export interface ErrorClassification {
  type: 'rate_limit' | 'daily_quota' | 'transient' | 'permanent';
  cooldownMinutes: number;
  shouldRetry: boolean;
  shouldSwitchKey: boolean;
  description: string;
}

// ============================================================================
// KEY CHECKOUT / RELEASE FUNCTIONS
// ============================================================================

/**
 * Checkout an API key for a specific speaking part.
 * Uses atomic database function to prevent race conditions.
 * 
 * @returns KeyCheckoutResult if a key is available, null otherwise
 */
export async function checkoutKeyForPart(
  supabaseService: any,
  userId: string,
  jobId: string,
  partNumber: 1 | 2 | 3,
  appEncryptionKey?: string,
  options?: { 
    lockDurationSec?: number; 
    modelName?: string;
  }
): Promise<KeyCheckoutResult | null> {
  const lockDuration = options?.lockDurationSec ?? TIMINGS.KEY_LOCK_DURATION_SEC;
  const modelName = options?.modelName ?? 'gemini-2.5-flash';
  
  console.log(`[keyPoolManager] Checking out key for job ${jobId?.slice(0, 8)}... part ${partNumber}`);
  
  // PRIORITY 1: Try user's own key first (no locking needed)
  if (appEncryptionKey) {
    const userKey = await tryGetUserKey(supabaseService, userId, appEncryptionKey);
    if (userKey) {
      console.log(`[keyPoolManager] Using user's own API key`);
      return { keyId: 'user', keyValue: userKey, isUserKey: true };
    }
  }
  
  // PRIORITY 2: Checkout from admin key pool with atomic locking
  const { data: keyRows, error } = await supabaseService.rpc('checkout_key_for_part', {
    p_job_id: jobId,
    p_part_number: partNumber,
    p_lock_duration_seconds: lockDuration,
    p_model_name: modelName,
  });
  
  if (error) {
    console.error(`[keyPoolManager] checkout_key_for_part error:`, error.message);
    return null;
  }
  
  if (!keyRows || keyRows.length === 0) {
    console.warn(`[keyPoolManager] No available API keys for part ${partNumber}`);
    return null;
  }
  
  const key = keyRows[0];
  console.log(`[keyPoolManager] Checked out key ${key.key_id?.slice(0, 8)}... for part ${partNumber}`);
  
  return {
    keyId: key.key_id,
    keyValue: key.key_value,
    isUserKey: key.is_user_key || false,
  };
}

/**
 * Release a key lock with mandatory cooldown period.
 * Call this after successful evaluation to prevent immediate reuse.
 */
export async function releaseKeyWithCooldown(
  supabaseService: any,
  jobId: string,
  partNumber: 1 | 2 | 3,
  cooldownSeconds?: number
): Promise<void> {
  const cooldown = cooldownSeconds ?? TIMINGS.KEY_COOLDOWN_SEC;
  
  console.log(`[keyPoolManager] Releasing key for job ${jobId?.slice(0, 8)}... part ${partNumber} with ${cooldown}s cooldown`);
  
  const { error } = await supabaseService.rpc('release_key_with_cooldown', {
    p_job_id: jobId,
    p_part_number: partNumber,
    p_cooldown_seconds: cooldown,
  });
  
  if (error) {
    console.error(`[keyPoolManager] release_key_with_cooldown error:`, error.message);
  }
}

/**
 * Mark a key as rate-limited (5-10 min cooldown).
 * Call this when you get a 429/TPM/RPM error.
 * The key will NOT be retried - switch to a different key.
 */
export async function markKeyRateLimited(
  supabaseService: any,
  keyId: string,
  cooldownMinutes?: number
): Promise<void> {
  if (keyId === 'user') {
    console.log(`[keyPoolManager] User key rate-limited, cannot mark in pool`);
    return;
  }
  
  const cooldown = cooldownMinutes ?? TIMINGS.RATE_LIMIT_COOLDOWN_MIN;
  
  console.log(`[keyPoolManager] Marking key ${keyId?.slice(0, 8)}... as rate-limited for ${cooldown} min`);
  
  const { error } = await supabaseService.rpc('mark_key_rate_limited', {
    p_key_id: keyId,
    p_cooldown_minutes: cooldown,
  });
  
  if (error) {
    console.error(`[keyPoolManager] mark_key_rate_limited error:`, error.message);
  }
}

/**
 * Reset rate limit counter after a successful call.
 * This helps keys recover from transient issues.
 */
export async function resetKeyRateLimit(
  supabaseService: any,
  keyId: string
): Promise<void> {
  if (keyId === 'user') return;
  
  const { error } = await supabaseService.rpc('reset_key_rate_limit', {
    p_key_id: keyId,
  });
  
  if (error) {
    console.warn(`[keyPoolManager] reset_key_rate_limit error:`, error.message);
  }
}

// ============================================================================
// ERROR CLASSIFICATION
// ============================================================================

/**
 * Classify an error to determine the appropriate response.
 * 
 * @returns Classification with recommended action
 */
export function classifyError(error: any): ErrorClassification {
  const msg = String(error?.message || error || '').toLowerCase();
  const status = error?.status || error?.error?.status || '';
  
  // ========================================
  // RATE LIMIT ERRORS (429, TPM, RPM)
  // ========================================
  // These are per-minute/per-request limits, NOT daily quotas.
  // Action: Switch key immediately, NO retry with same key
  if (
    msg.includes('429') ||
    msg.includes('too many requests') ||
    msg.includes('too many') ||
    msg.includes('rpm') ||
    msg.includes('tpm') ||
    msg.includes('requests per minute') ||
    msg.includes('tokens per minute') ||
    msg.includes('rate limit') ||
    msg.includes('rate_limit') ||
    (status === 429)
  ) {
    return {
      type: 'rate_limit',
      cooldownMinutes: TIMINGS.RATE_LIMIT_COOLDOWN_MIN,
      shouldRetry: false,  // NO retry with same key!
      shouldSwitchKey: true,
      description: 'Rate limit hit (RPM/TPM). Switching to different key.',
    };
  }
  
  // ========================================
  // DAILY QUOTA EXHAUSTION
  // ========================================
  // These indicate the key's daily limit is exceeded.
  // Action: Mark key exhausted for the day, switch key
  if (
    msg.includes('daily') ||
    msg.includes('per day') ||
    msg.includes('day limit') ||
    msg.includes('24 hours') ||
    msg.includes('check your plan') ||
    msg.includes('billing') ||
    msg.includes('limit: 0') ||
    (msg.includes('quota') && msg.includes('exceeded'))
  ) {
    return {
      type: 'daily_quota',
      cooldownMinutes: TIMINGS.DAILY_QUOTA_COOLDOWN_MIN,
      shouldRetry: false,
      shouldSwitchKey: true,
      description: 'Daily quota exhausted. Key marked for 24h cooldown.',
    };
  }
  
  // ========================================
  // TRANSIENT ERRORS
  // ========================================
  // Network issues, timeouts, server overload - can retry with same key
  if (
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('network') ||
    msg.includes('connection') ||
    msg.includes('econnreset') ||
    msg.includes('socket hang up') ||
    msg.includes('fetch failed') ||
    msg.includes('503') ||
    msg.includes('service unavailable') ||
    msg.includes('overloaded') ||
    msg.includes('temporarily unavailable') ||
    msg.includes('try again') ||
    msg.includes('internal server error') ||
    msg.includes('500') ||
    msg.includes('502') ||
    msg.includes('504') ||
    (status === 500) ||
    (status === 502) ||
    (status === 503) ||
    (status === 504)
  ) {
    return {
      type: 'transient',
      cooldownMinutes: 0,
      shouldRetry: true,  // Can retry with same key
      shouldSwitchKey: false,
      description: 'Transient server/network error. Will retry.',
    };
  }
  
  // ========================================
  // PERMANENT / UNKNOWN ERRORS
  // ========================================
  return {
    type: 'permanent',
    cooldownMinutes: 0,
    shouldRetry: false,
    shouldSwitchKey: false,
    description: 'Permanent or unknown error. Check logs.',
  };
}

/**
 * Quick check: Is this a rate limit error (429/TPM/RPM)?
 */
export function isRateLimitError(error: any): boolean {
  return classifyError(error).type === 'rate_limit';
}

/**
 * Quick check: Is this a daily quota exhaustion error?
 */
export function isDailyLimitError(error: any): boolean {
  return classifyError(error).type === 'daily_quota';
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Sleep utility for inter-part delays
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Inter-part delay with logging
 */
export async function interPartDelay(partNumber: number): Promise<void> {
  console.log(`[keyPoolManager] Inter-part delay: ${TIMINGS.INTER_PART_DELAY_SEC}s after part ${partNumber}`);
  await sleep(TIMINGS.INTER_PART_DELAY_SEC * 1000);
}

/**
 * Try to get user's own API key
 */
async function tryGetUserKey(
  supabaseService: any,
  userId: string,
  appEncryptionKey: string
): Promise<string | null> {
  try {
    const { data: userSecret } = await supabaseService
      .from('user_secrets')
      .select('encrypted_value')
      .eq('user_id', userId)
      .eq('secret_name', 'GEMINI_API_KEY')
      .maybeSingle();
    
    if (!userSecret?.encrypted_value) return null;
    
    // Decrypt using AES-GCM
    const { crypto } = await import("https://deno.land/std@0.168.0/crypto/mod.ts");
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const keyData = encoder.encode(appEncryptionKey).slice(0, 32);
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'AES-GCM' },
      false,
      ['decrypt']
    );
    const bytes = Uint8Array.from(atob(userSecret.encrypted_value), c => c.charCodeAt(0));
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, 12) },
      cryptoKey,
      bytes.slice(12)
    );
    return decoder.decode(decrypted);
  } catch (e) {
    console.warn(`[keyPoolManager] Failed to get user key:`, e);
    return null;
  }
}
