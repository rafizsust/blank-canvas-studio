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
 * @param skipUserKey - If true, skip user's own key and go straight to admin pool.
 *                      Use this when user key has been marked exhausted.
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
    skipUserKey?: boolean;  // NEW: skip user key if it's exhausted
  }
): Promise<KeyCheckoutResult | null> {
  const lockDuration = options?.lockDurationSec ?? TIMINGS.KEY_LOCK_DURATION_SEC;
  const modelName = options?.modelName ?? 'gemini-2.5-flash';
  const skipUserKey = options?.skipUserKey ?? false;
  
  console.log(`[keyPoolManager] Checking out key for job ${jobId?.slice(0, 8)}... part ${partNumber}${skipUserKey ? ' (skipping user key)' : ''}`);
  
  // PRIORITY 1: Try user's own key first (no locking needed)
  // Skip if explicitly told to (e.g., user key is exhausted)
  let userKeyChecked = false;
  if (appEncryptionKey && !skipUserKey) {
    const userKeyResult = await tryGetUserKey(supabaseService, userId, appEncryptionKey, modelName);
    if (userKeyResult.key) {
      console.log(`[keyPoolManager] Using user's own API key`);
      return { keyId: 'user', keyValue: userKeyResult.key, isUserKey: true };
    }
    userKeyChecked = true;
    // Only log "exhausted" if user actually HAS a key that is exhausted
    // If userKeyResult.exhausted is true, user has a key but it's exhausted for this model
    // If userKeyResult.noKey is true, user has no key configured at all
    if (userKeyResult.exhausted) {
      console.log(`[keyPoolManager] User's key is exhausted for ${modelName}, falling back to admin pool`);
    } else if (userKeyResult.noKey) {
      console.log(`[keyPoolManager] User has no API key configured, using admin pool`);
    }
  }
  
  // PRIORITY 2: Checkout from admin key pool with atomic locking
  // First, check if user has credits (if they don't have their own key)
  if (userKeyChecked) {
    const { data: creditStatus } = await supabaseService.rpc('get_credit_status', {
      p_user_id: userId,
    });
    
    if (creditStatus && !creditStatus.is_admin) {
      const creditsRemaining = creditStatus.credits_remaining ?? 0;
      if (creditsRemaining <= 0) {
        console.warn(`[keyPoolManager] User has no credits remaining (${creditStatus.credits_used}/100 used) and no personal API key`);
        // Still allow checkout from admin pool but log the warning
        // The actual credit check/reservation happens elsewhere
      }
    }
  }
  
  // Use v2 RPC to bypass any stale PostgREST schema cache and avoid ambiguous column issues
  const { data: keyRows, error } = await supabaseService.rpc('checkout_key_for_part_v2', {
    p_job_id: jobId,
    p_part_number: partNumber,
    p_lock_duration_seconds: lockDuration,
    p_model_name: modelName,
  });

  if (error) {
    // Log as much PostgREST detail as possible to make DB issues actionable
    console.error(`[keyPoolManager] checkout_key_for_part_v2 error:`, {
      message: error.message,
      details: (error as any).details,
      hint: (error as any).hint,
      code: (error as any).code,
    });
    return null;
  }

  if (!keyRows || keyRows.length === 0) {
    console.warn(`[keyPoolManager] No available API keys in admin pool for part ${partNumber} (none configured, all cooling down, or daily quota exhausted)`);
    return null;
  }
  
  const key = keyRows[0];
  // Handle both old column names (key_id) and new OUT parameter names (out_key_id)
  const keyId = key.out_key_id || key.key_id;
  const keyValue = key.out_key_value || key.key_value;
  const isUserKey = key.out_is_user_key ?? key.is_user_key ?? false;
  
  console.log(`[keyPoolManager] Checked out admin key ${keyId?.slice(0, 8)}... for part ${partNumber}`);
  
  return {
    keyId,
    keyValue,
    isUserKey,
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
 * IMPORTANT: Check daily quota FIRST because the error message often contains
 * both "429" and "quota exceeded". We want to classify these as daily_quota,
 * not rate_limit, because they need different handling (24h cooldown vs 5min).
 * 
 * @returns Classification with recommended action
 */
export function classifyError(error: any): ErrorClassification {
  const msg = String(error?.message || error || '').toLowerCase();
  const status = error?.status || error?.error?.status || '';
  
  // ========================================
  // DAILY QUOTA EXHAUSTION (CHECK FIRST!)
  // ========================================
  // These indicate the key's daily limit is exceeded.
  // The message often includes "429" AND "quota exceeded" - we want to catch
  // "quota exceeded" first because it requires 24h cooldown, not 5min.
  // Action: Mark key exhausted for the day, switch key
  if (
    msg.includes('exceeded your current quota') ||  // Google's exact message
    msg.includes('quota exceeded') ||
    msg.includes('resource_exhausted') ||
    msg.includes('resource exhausted') ||
    msg.includes('daily') ||
    msg.includes('per day') ||
    msg.includes('day limit') ||
    msg.includes('24 hours') ||
    msg.includes('check your plan') ||
    msg.includes('billing') ||
    msg.includes('limit: 0')
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
  // RATE LIMIT ERRORS (429, TPM, RPM)
  // ========================================
  // These are per-minute/per-request limits, NOT daily quotas.
  // Only reaches here if it's NOT a quota exhaustion error.
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
 * Mark a USER's key as having exhausted its quota for a model.
 * This uses the user_secrets table to track exhaustion state.
 */
export async function markUserKeyQuotaExhausted(
  supabaseService: any,
  userId: string,
  modelName: string
): Promise<void> {
  const today = new Date().toISOString().split('T')[0];
  const secretName = `GEMINI_API_KEY_EXHAUSTED_${modelName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`;
  
  console.log(`[keyPoolManager] Marking user ${userId.slice(0, 8)}...'s key as exhausted for ${modelName}`);
  
  try {
    // Upsert an exhaustion marker for this user/model
    await supabaseService
      .from('user_secrets')
      .upsert({
        user_id: userId,
        secret_name: secretName,
        encrypted_value: today, // Just store the date, not encrypted
        updated_at: new Date().toISOString(),
      }, {
        onConflict: 'user_id,secret_name',
      });
  } catch (e) {
    console.warn(`[keyPoolManager] Failed to mark user key exhausted:`, e);
  }
}

/**
 * Check if user's key is exhausted for a model today.
 */
async function isUserKeyExhausted(
  supabaseService: any,
  userId: string,
  modelName: string
): Promise<boolean> {
  const today = new Date().toISOString().split('T')[0];
  const secretName = `GEMINI_API_KEY_EXHAUSTED_${modelName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`;
  
  try {
    const { data } = await supabaseService
      .from('user_secrets')
      .select('encrypted_value')
      .eq('user_id', userId)
      .eq('secret_name', secretName)
      .maybeSingle();
    
    if (data?.encrypted_value === today) {
      return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}

interface UserKeyResult {
  key: string | null;
  exhausted: boolean;
  noKey: boolean;  // true if user has no API key configured at all
}

/**
 * Try to get user's own API key.
 * Also checks if the key is exhausted for the given model today.
 */
async function tryGetUserKey(
  supabaseService: any,
  userId: string,
  appEncryptionKey: string,
  modelName?: string
): Promise<UserKeyResult> {
  try {
    // First fetch the user's API key secret
    const { data: userSecret } = await supabaseService
      .from('user_secrets')
      .select('encrypted_value')
      .eq('user_id', userId)
      .eq('secret_name', 'GEMINI_API_KEY')
      .maybeSingle();
    
    // If user has no API key configured at all
    if (!userSecret?.encrypted_value) {
      return { key: null, exhausted: false, noKey: true };
    }
    
    // User has a key - now check if it's exhausted for this model today
    if (modelName) {
      const exhausted = await isUserKeyExhausted(supabaseService, userId, modelName);
      if (exhausted) {
        return { key: null, exhausted: true, noKey: false };
      }
    }
    
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
    return { key: decoder.decode(decrypted), exhausted: false, noKey: false };
  } catch (e) {
    console.warn(`[keyPoolManager] Failed to get user key:`, e);
    return { key: null, exhausted: false, noKey: true };
  }
}
