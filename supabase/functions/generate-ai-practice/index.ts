import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { crypto } from "https://deno.land/std@0.168.0/crypto/mod.ts";
import { encode as base64Encode } from "https://deno.land/std@0.168.0/encoding/base64.ts";
import { 
  createPerformanceLogger,
  classifyGeminiErrorStatus
} from "../_shared/performanceLogger.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-gemini-api-key',
};

// ============================================================================
// CREDIT SYSTEM - Cost Map and Daily Limits
// ============================================================================
const COSTS = {
  // GENERATION
  'generate_speaking': 5,
  'generate_writing': 5,
  'generate_listening': 20,
  'generate_reading': 20,
  // EVALUATION
  'evaluate_speaking': 15,
  'evaluate_writing': 10,
  'evaluate_reading': 0,    // FREE
  'evaluate_listening': 0,  // FREE
  // CHAT
  'explain_answer': 2
};

const DAILY_CREDIT_LIMIT = 100;

// ============================================================================
// ATOMIC CREDIT FUNCTIONS - Uses DB functions to prevent race conditions
// ============================================================================

// Check and RESERVE credits atomically BEFORE calling AI
// This prevents the "rapid click attack" where parallel requests bypass limits
async function checkAndReserveCredits(
  serviceClient: any, 
  userId: string, 
  operationType: keyof typeof COSTS
): Promise<{ ok: boolean; error?: string; creditsUsed?: number; creditsRemaining?: number }> {
  const cost = COSTS[operationType] || 0;
  
  // Free operations always pass
  if (cost === 0) {
    return { ok: true, creditsUsed: 0, creditsRemaining: DAILY_CREDIT_LIMIT };
  }
  
  try {
    // Call atomic DB function that locks the row and reserves credits
    const { data, error } = await serviceClient.rpc('check_and_reserve_credits', {
      p_user_id: userId,
      p_cost: cost
    });
    
    if (error) {
      console.error('check_and_reserve_credits RPC error:', error);
      // Fail open - allow operation if RPC fails
      return { ok: true, creditsUsed: 0, creditsRemaining: DAILY_CREDIT_LIMIT };
    }
    
    console.log(`Credit check result for ${operationType} (cost ${cost}):`, data);
    
    if (!data.ok) {
      return {
        ok: false,
        error: data.error || `Daily credit limit reached. Add your own Gemini API key in Settings.`,
        creditsUsed: data.credits_used,
        creditsRemaining: data.credits_remaining
      };
    }
    
    return {
      ok: true,
      creditsUsed: data.credits_used,
      creditsRemaining: data.credits_remaining
    };
  } catch (err) {
    console.error('Error in atomic credit check:', err);
    // Fail open - allow operation
    return { ok: true, creditsUsed: 0, creditsRemaining: DAILY_CREDIT_LIMIT };
  }
}

// Refund credits if the AI operation fails AFTER we reserved them
async function refundCredits(
  serviceClient: any, 
  userId: string, 
  operationType: keyof typeof COSTS
): Promise<void> {
  const cost = COSTS[operationType] || 0;
  if (cost === 0) return;
  
  try {
    const { error } = await serviceClient.rpc('refund_credits', {
      p_user_id: userId,
      p_cost: cost
    });
    
    if (error) {
      console.error('refund_credits RPC error:', error);
    } else {
      console.log(`Refunded ${cost} credits for failed ${operationType}`);
    }
  } catch (err) {
    console.error('Failed to refund credits:', err);
  }
}

// Decrypt user's Gemini API key
async function decryptApiKey(encryptedValue: string, encryptionKey: string): Promise<string> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  
  const combined = Uint8Array.from(atob(encryptedValue), c => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const encryptedData = combined.slice(12);
  
  const keyData = encoder.encode(encryptionKey);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyData.slice(0, 32),
    { name: "AES-GCM" },
    false,
    ["decrypt"]
  );
  
  const decryptedData = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    cryptoKey,
    encryptedData
  );
  
  return decoder.decode(decryptedData);
}

// IELTS Topics for random selection
const IELTS_TOPICS = [
  'Climate change and environmental conservation',
  'The impact of technology on modern society',
  'Education systems around the world',
  'Health and wellness in the 21st century',
  'Urbanization and city planning',
  'Wildlife conservation and biodiversity',
  'The role of art and culture in society',
  'Space exploration and scientific discovery',
  'Global tourism and its effects',
  'Sustainable energy solutions',
  'Ancient civilizations and archaeology',
  'Marine ecosystems and ocean conservation',
  'The future of transportation',
  'Digital communication and social media',
  'Food security and agriculture',
];

// Listening scenario types
const LISTENING_SCENARIOS = [
  { type: 'conversation', description: 'a casual conversation between two people' },
  { type: 'lecture', description: 'a short educational lecture or presentation' },
  { type: 'interview', description: 'an interview about a specific topic' },
  { type: 'tour', description: 'a guided tour of a facility or location' },
  { type: 'phone_call', description: 'a phone conversation about booking or inquiry' },
];

// ============================================================================
// VOICE-FIRST GENDER SYNCHRONIZATION SYSTEM
// ============================================================================
// TTS Voice to Gender mapping for script synchronization
// CORRECTED: Based on actual Gemini TTS voice characteristics
// Reference: https://cloud.google.com/text-to-speech/docs/voices
const VOICE_GENDER_MAP: Record<string, 'male' | 'female'> = {
  // Gemini TTS voices - CORRECTED MAPPINGS
  // Female voices (softer, higher pitch)
  'Kore': 'female',       // Female voice
  'Aoede': 'female',      // Female voice
  'Puck': 'female',       // Female voice (mischievous, fairy-like)
  'Zephyr': 'female',     // Female voice
  'Leda': 'female',       // Female voice
  'Callirrhoe': 'female', // Female voice
  'Autonoe': 'female',    // Female voice
  'Despina': 'female',    // Female voice
  // Male voices (deeper, lower pitch)
  'Charon': 'male',       // Male voice (deep)
  'Fenrir': 'male',       // Male voice (strong)
  'Orus': 'male',         // Male voice
  'Iapetus': 'male',      // Male voice
  'Algenib': 'male',      // Male voice
  'Alnilam': 'male',      // Male voice
  // Edge TTS voices (common British/US)
  'en-GB-RyanNeural': 'male',
  'en-GB-SoniaNeural': 'female',
  'en-US-GuyNeural': 'male',
  'en-US-AriaNeural': 'female',
  'en-US-JennyNeural': 'female',
  'en-AU-WilliamNeural': 'male',
  'en-AU-NatashaNeural': 'female',
  'en-IN-PrabhatNeural': 'male',
  'en-IN-NeerjaNeural': 'female',
};

// Get gender from voice name (defaults to male for unknown voices)
function getVoiceGender(voiceName: string): 'male' | 'female' {
  return VOICE_GENDER_MAP[voiceName] || 'male';
}

// Get appropriate names based on gender
function getGenderAppropriateNames(gender: 'male' | 'female'): string[] {
  if (gender === 'male') {
    return ['Tom', 'David', 'John', 'Michael', 'James', 'Robert', 'William', 'Richard', 'Daniel', 'Mark'];
  }
  return ['Sarah', 'Emma', 'Lisa', 'Anna', 'Maria', 'Sophie', 'Rachel', 'Laura', 'Helen', 'Kate'];
}

// Build gender constraint for AI prompt
function buildGenderConstraint(primaryVoice: string, hasSecondSpeaker: boolean): string {
  const primaryGender = getVoiceGender(primaryVoice);
  const oppositeGender = primaryGender === 'male' ? 'female' : 'male';
  const primaryNames = getGenderAppropriateNames(primaryGender).slice(0, 5).join(', ');
  const secondaryNames = getGenderAppropriateNames(oppositeGender).slice(0, 5).join(', ');
  
  let constraint = `
CRITICAL - VOICE-GENDER SYNCHRONIZATION:
- The MAIN SPEAKER (Speaker1) for this audio is ${primaryGender.toUpperCase()}.
- You MUST assign Speaker1 a ${primaryGender} name (e.g., ${primaryNames}).
- You MUST NOT write self-identifying phrases that contradict this gender.
- DO NOT use phrases like "${primaryGender === 'male' ? "I am a mother" : "I am a father"}" or names of the wrong gender.`;

  if (hasSecondSpeaker) {
    constraint += `
- The SECOND SPEAKER (Speaker2) should be ${oppositeGender.toUpperCase()} for voice distinctiveness.
- Assign Speaker2 a ${oppositeGender} name (e.g., ${secondaryNames}).`;
  }
  
  return constraint;
}

// =============================================================================
// THE ARCHITECT - Test Generation Models (Split-Brain Architecture)
// =============================================================================
// Prioritize instruction-following models for complex JSON generation
// These models excel at adhering to strict formatting rules and producing valid JSON
const GEMINI_MODELS = [
  'gemini-2.5-flash',     // 1. Primary: Stable, reliable for complex JSON generation
];

// Store last error for better error messages
let lastGeminiError: string | null = null;
let lastTokensUsed: number = 0;
let isQuotaExceeded: boolean = false;

// DB-managed API key interface
interface ApiKeyRecord {
  id: string;
  provider: string;
  key_value: string;
  is_active: boolean;
  error_count: number;
}

// Fetch active Gemini keys from api_keys table with rotation support
async function getActiveGeminiKeys(supabaseServiceClient: any): Promise<ApiKeyRecord[]> {
  try {
    const { data, error } = await supabaseServiceClient
      .from('api_keys')
      .select('id, provider, key_value, is_active, error_count')
      .eq('provider', 'gemini')
      .eq('is_active', true)
      .order('error_count', { ascending: true }); // Prioritize keys with fewer errors
    
    if (error) {
      console.error('Failed to fetch API keys:', error);
      return [];
    }
    
    console.log(`Found ${data?.length || 0} active Gemini keys in api_keys table`);
    return data || [];
  } catch (err) {
    console.error('Error fetching API keys:', err);
    return [];
  }
}

// Increment error count for a failed key
async function incrementKeyErrorCount(supabaseServiceClient: any, keyId: string, deactivate: boolean = false): Promise<void> {
  try {
    const update: any = { 
      error_count: deactivate ? 999 : undefined,
      is_active: deactivate ? false : undefined,
    };
    
    // Use raw increment if not deactivating
    if (!deactivate) {
      const { data: currentKey } = await supabaseServiceClient
        .from('api_keys')
        .select('error_count')
        .eq('id', keyId)
        .single();
      
      if (currentKey) {
        await supabaseServiceClient
          .from('api_keys')
          .update({ 
            error_count: (currentKey.error_count || 0) + 1,
            updated_at: new Date().toISOString()
          })
          .eq('id', keyId);
      }
    } else {
      await supabaseServiceClient
        .from('api_keys')
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq('id', keyId);
    }
    
    console.log(`Updated key ${keyId}: ${deactivate ? 'deactivated' : 'incremented error count'}`);
  } catch (err) {
    console.error('Failed to update key error count:', err);
  }
}

// Reset error count on successful use
async function resetKeyErrorCount(supabaseServiceClient: any, keyId: string): Promise<void> {
  try {
    await supabaseServiceClient
      .from('api_keys')
      .update({ error_count: 0, updated_at: new Date().toISOString() })
      .eq('id', keyId);
  } catch (err) {
    console.error('Failed to reset key error count:', err);
  }
}

// Mark a model as quota exhausted for a specific key (for test generation)
// Maps actual model names to database column prefixes
const MODEL_TO_DB_COLUMN_MAP: Record<string, string> = {
  'gemini-exp-1206': 'gemini_exp_1206',
  'gemini-2.0-flash-exp': 'gemini_2_0_flash',
  'gemini-2.5-flash': 'gemini_2_5_flash',
  'gemini-2.0-flash': 'gemini_2_0_flash',
  'gemini-2.5-pro': 'gemini_2_5_pro',
  'gemini-3-pro-preview': 'gemini_3_pro',
};

async function markModelQuotaExhaustedForGeneration(
  supabaseServiceClient: any,
  keyId: string,
  modelName: string
): Promise<void> {
  try {
    const today = new Date().toISOString().split('T')[0];
    const columnPrefix = MODEL_TO_DB_COLUMN_MAP[modelName];
    
    if (!columnPrefix) {
      console.warn(`[markModelQuotaExhaustedForGeneration] Unknown model: ${modelName}, skipping quota tracking`);
      return;
    }
    
    const quotaField = `${columnPrefix}_exhausted`;
    const quotaDateField = `${columnPrefix}_exhausted_date`;
    
    const updateData: Record<string, any> = {
      [quotaField]: true,
      [quotaDateField]: today,
      updated_at: new Date().toISOString()
    };
    
    await supabaseServiceClient
      .from('api_keys')
      .update(updateData)
      .eq('id', keyId);
    
    console.log(`[markModelQuotaExhaustedForGeneration] Marked key ${keyId} as ${modelName} quota exhausted for ${today}`);
  } catch (err) {
    console.error(`[markModelQuotaExhaustedForGeneration] Failed to mark model quota exhausted:`, err);
  }
}

// Pre-flight validation: Check API key validity without consuming generation quota
// Uses a lightweight models/list call instead of a generation request
async function preflightApiCheck(apiKey: string, skipPreflight: boolean = false): Promise<{ ok: boolean; error?: string }> {
  // Allow skipping preflight when caller wants to proceed directly to main request
  if (skipPreflight) {
    console.log('Skipping pre-flight check (skipPreflight=true)');
    return { ok: true };
  }

  try {
    console.log('Running lightweight pre-flight API validation...');
    
    // Use models/list endpoint - this validates API key without consuming generation quota
    // This endpoint has much higher rate limits than generation endpoints
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=1`,
      {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      }
    );

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const errorStatus = errorData?.error?.status || '';
      const errorMessage = errorData?.error?.message || '';
      
      console.error('Pre-flight check failed:', response.status, errorStatus);
      
      // Only treat 403/401 as definitive API key issues
      // 429 on list endpoint is very rare but could happen with extremely high abuse
      if (response.status === 403 || response.status === 401 || errorStatus === 'PERMISSION_DENIED') {
        return {
          ok: false,
          error: 'API_KEY_INVALID: Your Gemini API key appears to be invalid or lacks permissions. Please verify your API key in settings.',
        };
      } else if (response.status === 429 || errorStatus === 'RESOURCE_EXHAUSTED') {
        // Don't block on rate limit during pre-flight - let the main request try
        // The actual generation endpoint has separate limits
        console.warn('Pre-flight list endpoint rate-limited, proceeding to main request anyway');
        return { ok: true };
      }
      
      // For other errors, proceed anyway and let main request handle it
      console.warn(`Pre-flight returned ${response.status}, proceeding to main request`);
      return { ok: true };
    }

    console.log('Pre-flight API check passed');
    return { ok: true };
  } catch (err) {
    console.error('Pre-flight check connection error:', err);
    // Connection errors should not block - let the main request try
    console.warn('Pre-flight connection failed, proceeding to main request anyway');
    return { ok: true };
  }
}

// Update quota tracking in the database
async function updateQuotaTracking(supabase: any, userId: string, tokensUsed: number): Promise<void> {
  if (!userId || tokensUsed <= 0) return;
  
  try {
    const today = new Date().toISOString().split('T')[0];
    
    // Check for existing record
    const { data: existingData } = await supabase
      .from('gemini_daily_usage')
      .select('id, tokens_used, requests_count')
      .eq('user_id', userId)
      .eq('usage_date', today)
      .maybeSingle();

    if (existingData) {
      // Update existing record
      await supabase
        .from('gemini_daily_usage')
        .update({
          tokens_used: existingData.tokens_used + tokensUsed,
          requests_count: existingData.requests_count + 1,
          last_updated_at: new Date().toISOString(),
        })
        .eq('id', existingData.id);
    } else {
      // Insert new record
      await supabase
        .from('gemini_daily_usage')
        .insert({
          user_id: userId,
          usage_date: today,
          tokens_used: tokensUsed,
          requests_count: 1,
        });
    }
    
    console.log(`Updated quota for user ${userId}: +${tokensUsed} tokens`);
  } catch (err) {
    console.error('Failed to update quota tracking:', err);
  }
}

// Helper function to wait with exponential backoff
async function waitWithBackoff(attempt: number, baseDelayMs: number = 1000): Promise<void> {
  const delay = Math.min(baseDelayMs * Math.pow(2, attempt), 30000); // Max 30 seconds
  console.log(`Waiting ${delay}ms before retry (attempt ${attempt + 1})...`);
  await new Promise(resolve => setTimeout(resolve, delay));
}

// Simple sleep utility to prevent rate limiting between API calls
async function sleep(ms: number): Promise<void> {
  console.log(`Rate limit cooldown: waiting ${ms}ms...`);
  await new Promise(resolve => setTimeout(resolve, ms));
}

// Enhanced callGemini with DB key rotation support and performance logging
// If dbKeys array is provided, will rotate through them on 429/403 errors
async function callGemini(
  apiKey: string, 
  prompt: string, 
  maxRetries: number = 2,
  options?: {
    dbKeys?: ApiKeyRecord[];
    serviceClient?: any;
    currentKeyIndex?: number;
  }
): Promise<string | null> {
  lastGeminiError = null;
  lastTokensUsed = 0;
  isQuotaExceeded = false;
  
  // Create performance logger for this task
  const perfLogger = createPerformanceLogger('generate');
  
  const dbKeys = options?.dbKeys || [];
  const serviceClient = options?.serviceClient;
  let currentKeyIndex = options?.currentKeyIndex || 0;
  let currentApiKey = apiKey;
  let currentKeyRecord: ApiKeyRecord | null = null;
  
  // If we have DB keys, use the first one
  if (dbKeys.length > 0 && currentKeyIndex < dbKeys.length) {
    currentKeyRecord = dbKeys[currentKeyIndex];
    currentApiKey = currentKeyRecord.key_value;
    console.log(`Using DB-managed key ${currentKeyIndex + 1}/${dbKeys.length}`);
  }
  
  for (const model of GEMINI_MODELS) {
    let retryCount = 0;
    const modelCallStart = Date.now();
    
    while (retryCount <= maxRetries) {
      try {
        console.log(`Trying Gemini model: ${model}${retryCount > 0 ? ` (retry ${retryCount})` : ''}`);
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${currentApiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: {
                  temperature: 0.7,
                  maxOutputTokens: 8192,
                  // Strongly encourages the model to return valid JSON (prevents "[A] ..." non-JSON output)
                  responseMimeType: 'application/json',
                },
              }),
          }
        );

        if (!response.ok) {
          const errorData = await response.json();
          console.error(`Gemini ${model} failed:`, JSON.stringify(errorData));
          
          // Parse error message for user-friendly display
          const errorMessage = errorData?.error?.message || '';
          const errorStatus = errorData?.error?.status || '';
          
          if (response.status === 429 || errorStatus === 'RESOURCE_EXHAUSTED') {
            // Check if this is a DAILY quota exhaustion (not just per-minute rate limit)
            const isDailyQuota = 
              errorMessage.toLowerCase().includes('check your plan') ||
              errorMessage.toLowerCase().includes('billing') ||
              errorMessage.toLowerCase().includes('daily') ||
              errorMessage.toLowerCase().includes('per day') ||
              (errorMessage.toLowerCase().includes('quota') && !errorMessage.toLowerCase().includes('per minute'));
            
            // Log quota exceeded
            const modelCallEnd = Date.now() - modelCallStart;
            await perfLogger.logQuotaExceeded(model, errorMessage.slice(0, 200), currentKeyRecord?.id);
            
            // Apply cooldown/exhaustion before switching keys
            if (serviceClient && currentKeyRecord) {
              if (isDailyQuota) {
                // Daily quota exhaustion - mark model exhausted for this key
                console.log(`Key ${currentKeyIndex + 1} DAILY QUOTA EXHAUSTED on ${model}, marking exhausted...`);
                await markModelQuotaExhaustedForGeneration(serviceClient, currentKeyRecord.id, model);
              } else {
                // Rate limit (429/TPM/RPM) - apply 45s cooldown
                console.log(`Key ${currentKeyIndex + 1} rate limited on ${model}, applying 45s cooldown...`);
                // Note: mark_key_rate_limited uses minutes, so 1 minute is the minimum
                // The actual cooldown logic handles 45s waits for single-key scenarios
                await serviceClient.rpc('mark_key_rate_limited', {
                  p_key_id: currentKeyRecord.id,
                  p_cooldown_minutes: 1, // ~45-60 seconds
                });
              }
            }
            
            // Key rotation: try next DB key if available
            if (dbKeys.length > 0 && currentKeyIndex < dbKeys.length - 1) {
              console.log(`Rotating to next key after ${isDailyQuota ? 'quota exhaustion' : 'rate limit'}...`);
              currentKeyIndex++;
              currentKeyRecord = dbKeys[currentKeyIndex];
              currentApiKey = currentKeyRecord.key_value;
              console.log(`Switched to DB key ${currentKeyIndex + 1}/${dbKeys.length}`);
              retryCount = 0; // Reset retry count for new key
              continue;
            }
            
            // SINGLE KEY SCENARIO or all keys exhausted:
            // If only one key available and rate limited (not daily exhausted), wait 45s and retry
            if (!isDailyQuota && (dbKeys.length <= 1) && retryCount < maxRetries) {
              console.log(`Single key scenario: rate limited, waiting 45s before retry...`);
              await sleep(45000); // Wait 45 seconds for rate limit to reset
              retryCount++;
              continue;
            }
            
            // Check if it's a rate limit that might recover with waiting (no DB keys case)
            if (retryCount < maxRetries && !isDailyQuota && dbKeys.length === 0) {
              console.log(`Rate limit hit on ${model}, will retry after backoff...`);
              await waitWithBackoff(retryCount);
              retryCount++;
              continue;
            }
            
            // All retries and keys exhausted - mark all keys as exhausted for this model
            if (isDailyQuota && serviceClient && dbKeys.length > 0) {
              for (const key of dbKeys) {
                await markModelQuotaExhaustedForGeneration(serviceClient, key.id, model);
              }
            }
            
            // All retries and keys exhausted
            isQuotaExceeded = true;
            lastGeminiError = isDailyQuota 
              ? 'QUOTA_EXCEEDED: All API keys have exhausted their daily quota. Please try again tomorrow or add your own Gemini API key in Settings.'
              : 'QUOTA_EXCEEDED: All API keys have reached their rate limit. Please wait a few minutes and try again.';
            break;
          } else if (response.status === 403 || errorStatus === 'PERMISSION_DENIED') {
            // Key is invalid - try next DB key
            const modelCallEnd = Date.now() - modelCallStart;
            await perfLogger.logError(model, 'Permission denied', modelCallEnd, currentKeyRecord?.id);
            
            if (dbKeys.length > 0 && currentKeyIndex < dbKeys.length - 1) {
              console.log(`Key ${currentKeyIndex + 1} permission denied, rotating to next key...`);
              
              // Deactivate this key
              if (serviceClient && currentKeyRecord) {
                await incrementKeyErrorCount(serviceClient, currentKeyRecord.id, true);
              }
              
              currentKeyIndex++;
              currentKeyRecord = dbKeys[currentKeyIndex];
              currentApiKey = currentKeyRecord.key_value;
              retryCount = 0;
              continue;
            }
            
            lastGeminiError = 'API access denied. Please verify your Gemini API key is valid and has the correct permissions.';
            break;
          } else if (response.status === 400) {
            const modelCallEnd = Date.now() - modelCallStart;
            await perfLogger.logError(model, 'Invalid request', modelCallEnd, currentKeyRecord?.id);
            lastGeminiError = 'Invalid request to AI. The generation request was rejected. Please try again with different settings.';
            break;
          } else if (response.status >= 500) {
            if (retryCount < maxRetries) {
              console.log(`Server error on ${model}, will retry after backoff...`);
              await waitWithBackoff(retryCount);
              retryCount++;
              continue;
            }
            const modelCallEnd = Date.now() - modelCallStart;
            await perfLogger.logError(model, `Server error ${response.status}: ${errorMessage.slice(0, 100)}`, modelCallEnd, currentKeyRecord?.id);
            lastGeminiError = `AI service error (${response.status}): ${errorMessage.slice(0, 100)}`;
          } else {
            lastGeminiError = `AI service error (${response.status}): ${errorMessage.slice(0, 100)}`;
          }
          break;
        }

        const data = await response.json();
        
        // Extract token usage from response metadata
        const usageMetadata = data.usageMetadata;
        if (usageMetadata) {
          const promptTokens = usageMetadata.promptTokenCount || 0;
          const candidateTokens = usageMetadata.candidatesTokenCount || 0;
          lastTokensUsed = promptTokens + candidateTokens;
          console.log(`Token usage - Prompt: ${promptTokens}, Output: ${candidateTokens}, Total: ${lastTokensUsed}`);
        }
        
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) {
          console.log(`Success with ${model}`);
          
          // Log successful performance
          const modelCallEnd = Date.now() - modelCallStart;
          await perfLogger.logSuccess(model, modelCallEnd, currentKeyRecord?.id);
          
          // Reset error count on success
          if (serviceClient && currentKeyRecord) {
            await resetKeyErrorCount(serviceClient, currentKeyRecord.id);
          }
          
          return text;
        } else {
          const finishReason = data.candidates?.[0]?.finishReason;
          const modelCallEnd = Date.now() - modelCallStart;
          if (finishReason === 'SAFETY') {
            await perfLogger.logError(model, 'Content filtered by safety settings', modelCallEnd, currentKeyRecord?.id);
            lastGeminiError = 'Content was filtered by safety settings. Please try a different topic.';
          } else {
            await perfLogger.logError(model, 'Empty response from AI', modelCallEnd, currentKeyRecord?.id);
            lastGeminiError = 'AI returned empty response. Please try again.';
          }
        }
        break;
      } catch (err) {
        console.error(`Error with ${model}:`, err);
        const modelCallEnd = Date.now() - modelCallStart;
        await perfLogger.logError(model, err instanceof Error ? err.message : 'Unknown error', modelCallEnd, currentKeyRecord?.id);
        
        if (retryCount < maxRetries) {
          console.log(`Connection error on ${model}, will retry after backoff...`);
          await waitWithBackoff(retryCount);
          retryCount++;
          continue;
        }
        
        lastGeminiError = `Connection error: Unable to reach AI service. Please check your internet connection and try again.`;
        break;
      }
    }
  }
  return null;
}

// Save test to test_presets bank
async function saveToTestBank(
  serviceClient: any, 
  module: string, 
  topic: string, 
  payload: any
): Promise<boolean> {
  try {
    const { error } = await serviceClient
      .from('test_presets')
      .insert({
        module,
        topic,
        payload,
        is_published: false, // Admin must manually publish
      });
    
    if (error) {
      console.error('Failed to save to test bank:', error);
      return false;
    }
    
    console.log(`Saved ${module} test to test_presets bank`);
    return true;
  } catch (err) {
    console.error('Error saving to test bank:', err);
    return false;
  }
}

function getLastGeminiError(): string {
  return lastGeminiError || 'Failed to generate content. Please try again.';
}

function getLastTokensUsed(): number {
  return lastTokensUsed;
}

function wasQuotaExceeded(): boolean {
  return isQuotaExceeded;
}

// Robust JSON extraction from Gemini response
// Handles: raw JSON, ```json...```, ```...```, and mixed content
function extractJsonFromResponse(text: string): string {
  if (!text || typeof text !== 'string') {
    throw new Error('Empty or invalid response from AI');
  }
  
  // Try to find JSON in markdown code blocks first
  // Match ```json ... ``` or ``` ... ```
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch && codeBlockMatch[1]) {
    const extracted = codeBlockMatch[1].trim();
    // Validate it looks like JSON
    if (extracted.startsWith('{') || extracted.startsWith('[')) {
      return extracted;
    }
  }
  
  // Try finding JSON object directly (starts with { and ends with })
  const jsonObjectMatch = text.match(/\{[\s\S]*\}/);
  if (jsonObjectMatch) {
    return jsonObjectMatch[0];
  }
  
  // Try finding JSON array directly
  const jsonArrayMatch = text.match(/\[[\s\S]*\]/);
  if (jsonArrayMatch) {
    return jsonArrayMatch[0];
  }
  
  // Last resort: try trimming and returning as-is
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return trimmed;
  }
  
  throw new Error('Could not extract valid JSON from AI response');
}

// ============================================================================
// SPEAKING PART 3 ENFORCEMENT (count + word-length)
// - Requirement: Part 3 must have exactly 4 questions
// - Requirement: Each Part 3 question must be 12-16 words
// ============================================================================

function countWordsForIelts(text: string): number {
  const words = text.match(/[A-Za-z0-9]+(?:'[A-Za-z0-9]+)?/g);
  return words ? words.length : 0;
}

function ensureQuestionMark(text: string): string {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return '';
  return trimmed.endsWith('?') ? trimmed : `${trimmed}?`;
}

function normalizeQuestionText(text: string): string {
  return ensureQuestionMark(
    String(text ?? '')
      .trim()
      .replace(/^[-•\d.\s]+/, '')
      .replace(/^"|"$/g, '')
  );
}

function padToMinWords(question: string, minWords: number, maxWords: number): string {
  let q = question.trim();
  if (!q) return q;

  const hasQ = q.endsWith('?');
  if (hasQ) q = q.slice(0, -1);

  const current = countWordsForIelts(q);
  if (current >= minWords) return ensureQuestionMark(q);

  const need = minWords - current;
  const fillers: Record<number, string> = {
    1: 'today',
    2: 'in general',
    3: 'in your country',
    4: 'in your country today',
    5: 'in your country these days',
    6: 'in your country in recent years',
    7: 'in your country over recent years',
    8: 'in your country over the past decade',
  };

  const filler = fillers[need] || 'in modern society today';
  const candidate = `${q} ${filler}`.trim();

  const tokens = candidate.match(/[A-Za-z0-9]+(?:'[A-Za-z0-9]+)?/g) || [];
  const clipped = tokens.slice(0, maxWords).join(' ');
  return ensureQuestionMark(clipped);
}

function enforceWordCountRange(question: string, minWords: number, maxWords: number): string {
  let q = normalizeQuestionText(question);
  if (!q) return q;

  let wc = countWordsForIelts(q);
  if (wc > maxWords) {
    const tokens = q.match(/[A-Za-z0-9]+(?:'[A-Za-z0-9]+)?/g) || [];
    q = ensureQuestionMark(tokens.slice(0, maxWords).join(' '));
    wc = countWordsForIelts(q);
  }

  if (wc < minWords) {
    q = padToMinWords(q, minWords, maxWords);
  }

  return q;
}

function enforceSpeakingPart3Parts(rawParts: any): any {
  if (!Array.isArray(rawParts)) return rawParts;

  const fallback = [
    'Why do you think people can have very different opinions about this topic today?',
    'How might this topic affect younger and older people differently in modern society?',
    'What are the main advantages and disadvantages of this topic for individuals in your country?',
    'How do you think this topic will change in your country over the next decade?',
    'To what extent should governments influence decisions related to this topic in modern life?',
  ];

  return rawParts.map((p: any) => {
    const partNumber = p?.part_number ?? p?.partNumber;
    if (partNumber !== 3) return p;

    const questionsArr = Array.isArray(p?.questions) ? p.questions : [];

    // Extract strings
    const cleanedStrings = questionsArr
      .map((q: any) => (typeof q?.question_text === 'string' ? q.question_text : typeof q === 'string' ? q : ''))
      .map((q: string) => enforceWordCountRange(q, 12, 16))
      .filter(Boolean);

    // De-dupe
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const q of cleanedStrings) {
      if (!seen.has(q)) {
        seen.add(q);
        unique.push(q);
      }
    }

    // Enforce max 4 (exactly 4 questions)
    const limited = unique.slice(0, 4);

    // Enforce min 4
    let idx = 0;
    while (limited.length < 4 && idx < fallback.length) {
      const candidate = enforceWordCountRange(fallback[idx], 12, 16);
      if (candidate && !seen.has(candidate)) {
        seen.add(candidate);
        limited.push(candidate);
      }
      idx++;
    }

    // Return with renumbered objects
    return {
      ...p,
      questions: limited.map((text, i) => ({
        question_number: i + 1,
        question_text: text,
      })),
    };
  });
}

// ============================================================================
// CHART DATA GENERATION - REMOVED
// ============================================================================
// Chart data is now generated inline with the writing task prompt using 
// Gemini's JSON mode (response_mime_type: "application/json").
// This combines the essay prompt and visual data in ONE API call to prevent
// truncation and rate limiting issues.
// Old functions removed: generateChartData, mergeTruncatedSvg, generateMapSvg,
// generateFlowchartSvg, generateWritingTask1Svg

async function uploadGeneratedImage(
  supabaseClient: any, 
  imageDataUrl: string, 
  testId: string,
  folder: string = 'ai-practice-images'
): Promise<string | null> {
  try {
    // Extract base64 data and mime type
    const matches = imageDataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!matches) {
      console.error('Invalid image data URL format');
      return null;
    }
    
    const [, extension, base64Data] = matches;
    const binaryData = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
    
    const fileName = `${folder}/${testId}-${Date.now()}.${extension}`;
    
    const { data, error } = await supabaseClient.storage
      .from('listening-images')
      .upload(fileName, binaryData, {
        contentType: `image/${extension}`,
        upsert: true,
      });
    
    if (error) {
      console.error('Failed to upload map image:', error);
      return null;
    }
    
    // Get public URL
    const { data: urlData } = supabaseClient.storage
      .from('listening-images')
      .getPublicUrl(fileName);
    
    console.log('Map image uploaded:', urlData.publicUrl);
    return urlData.publicUrl;
  } catch (err) {
    console.error('Map image upload error:', err);
    return null;
  }
}

// Speaker configuration interface
interface SpeakerVoiceConfig {
  gender: 'male' | 'female';
  accent: string;
  voiceName: string;
}

interface SpeakerConfigInput {
  speaker1: SpeakerVoiceConfig;
  speaker2?: SpeakerVoiceConfig;
  useTwoSpeakers: boolean;
}

// Store last TTS error for user-friendly messages
let lastTTSError: string | null = null;

function getLastTTSError(): string {
  return lastTTSError || 'Audio generation failed. Please try again.';
}

// Generate TTS audio using Gemini with retry logic, configurable voices, and DB key rotation
// NOTE: For dialogues, we stitch per-speaker segments to guarantee distinct voices.
async function generateAudio(
  apiKey: string,
  script: string,
  speakerConfig?: SpeakerConfigInput,
  maxRetries = 3,
  options?: {
    dbKeys?: ApiKeyRecord[];
    serviceClient?: any;
  }
): Promise<{ audioBase64: string; sampleRate: number } | null> {
  lastTTSError = null;

  // Voices from config (or sensible defaults with distinct genders for natural dialogue)
  // Use Charon (male) and Aoede (female) as defaults for clear voice distinction
  const speaker1Voice = speakerConfig?.speaker1?.voiceName || 'Charon';
  const speaker2Voice = speakerConfig?.speaker2?.voiceName || 'Aoede';

  // Default to 2 speakers unless explicitly disabled
  const requestedTwoSpeakers = speakerConfig?.useTwoSpeakers !== false;

  // DB key rotation support for TTS
  const dbKeys = options?.dbKeys || [];
  const serviceClient = options?.serviceClient;
  let currentKeyIndex = 0;
  let currentApiKey = apiKey;
  let currentKeyRecord: ApiKeyRecord | null = null;

  if (dbKeys.length > 0) {
    currentKeyRecord = dbKeys[0];
    currentApiKey = currentKeyRecord.key_value;
    console.log(`TTS using DB-managed key 1/${dbKeys.length}`);
  }

  const rotateKeyIfPossible = async (deactivate: boolean) => {
    if (dbKeys.length === 0) return false;
    if (currentKeyIndex >= dbKeys.length - 1) return false;

    if (serviceClient && currentKeyRecord) {
      await incrementKeyErrorCount(serviceClient, currentKeyRecord.id, deactivate);
    }

    currentKeyIndex++;
    currentKeyRecord = dbKeys[currentKeyIndex];
    currentApiKey = currentKeyRecord.key_value;
    console.log(`TTS switched to DB key ${currentKeyIndex + 1}/${dbKeys.length}`);
    return true;
  };

  const callGeminiTtsOnce = async (
    text: string,
    voiceName: string,
  ): Promise<Uint8Array | null> => {
    // Keep prompts tiny (cheaper + more reliable)
    const ttsPrompt = `Read this clearly for a listening test. Use natural pacing and brief pauses.\n\n${text}`;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      // FIX 2c: Smart retry text cleaning - progressively strip SSML on failures
      let textToUse = text;
      if (attempt === 2) {
        textToUse = text.replace(/<(?!break)[^>]+>/g, ''); // Keep only <break> tags
        console.log(`[TTS] Attempt ${attempt}: Stripped non-break SSML tags`);
      } else if (attempt >= 3) {
        textToUse = text.replace(/<[^>]*>/g, ''); // Strip ALL tags
        console.log(`[TTS] Attempt ${attempt}: Stripped ALL SSML tags`);
      }
      
      const ttsPromptClean = `Read this clearly for a listening test. Use natural pacing and brief pauses.\n\n${textToUse}`;
      
      try {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${currentApiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: ttsPromptClean }] }],
              generationConfig: {
                responseModalities: ["AUDIO"],
                speechConfig: {
                  voiceConfig: {
                    prebuiltVoiceConfig: { voiceName },
                  },
                },
              },
            }),
          }
        );

        if (!response.ok) {
          const errorText = await response.text();
          console.error(`TTS failed (attempt ${attempt}/${maxRetries}) voice=${voiceName}:`, errorText);

          // FIX 2: Handle 429 QUOTA EXCEEDED - Don't give up, wait and retry
          if (response.status === 429) {
            console.warn('Hit 429 Quota.');
            
            // Try to rotate keys first
            if (await rotateKeyIfPossible(false)) {
              console.log('Key rotated successfully. Retrying immediately.');
              attempt--; // Don't burn a retry on a successful swap
              continue;
            }
            
            // If rotation failed, DO NOT FAIL. Wait longer and retry with same key.
            console.warn('No more keys to rotate (or single key mode). Backing off and retrying...');
            await waitWithBackoff(attempt, 3000); // Wait 3-30 seconds for 429
            lastTTSError = 'Rate limit hit - retrying with backoff...';
            continue; // Force retry loop, don't return null
          } else if (response.status === 403) {
            if (await rotateKeyIfPossible(true)) {
              attempt--;
              continue;
            }
            lastTTSError = 'API access denied for audio generation. Please verify your Gemini API key has TTS permissions enabled.';
          } else if (response.status === 400) {
            // FIX 2b: Handle 400 BAD REQUEST (Bad SSML) - continue to retry with cleaner text
            console.warn(`TTS 400 Error (Bad SSML). Will retry with cleaner text...`);
            lastTTSError = 'Audio generation request rejected. Retrying with simpler text...';
            // Let the loop continue - the text cleaning logic happens at attempt 2+
            continue;
          } else {
            lastTTSError = `Audio generation failed with status ${response.status}. Please try again.`;
          }

          // Retry transient server errors
          if ((response.status === 500 || response.status === 503) && attempt < maxRetries) {
            const delay = Math.pow(2, attempt) * 1000;
            await new Promise((resolve) => setTimeout(resolve, delay));
            continue;
          }

          return null;
        }

        const data = await response.json();
        const audioData = data.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data as string | undefined;
        if (!audioData) {
          lastTTSError = 'Audio generation returned empty response. Please try again.';
          continue;
        }

        const pcmBytes = Uint8Array.from(atob(audioData), (c) => c.charCodeAt(0));
        return pcmBytes;
      } catch (err) {
        console.error(`TTS error (attempt ${attempt}/${maxRetries}) voice=${voiceName}:`, err);
        lastTTSError = `Connection error during audio generation: ${err instanceof Error ? err.message : 'Unknown error'}`;
        if (attempt < maxRetries) {
          const delay = Math.pow(2, attempt) * 1000;
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        return null;
      }
    }

    return null;
  };

  // --------------------------------------------------------------------------
  // Multi-speaker stitching (guarantees distinct voices even if the script uses
  // explicit names like "Tom:" / "Sarah:" instead of Speaker1/Speaker2).
  // --------------------------------------------------------------------------
  const speakerLineRegex = /^([^:]{1,40}):\s*(.+)$/;

  const rawLines = script
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const detectedSpeakerLabels = new Set<string>();
  for (const l of rawLines) {
    const m = l.match(speakerLineRegex);
    if (m) detectedSpeakerLabels.add(m[1].trim());
  }

  const shouldStitch = requestedTwoSpeakers && detectedSpeakerLabels.size >= 2;

  if (shouldStitch) {
    console.log(`[TTS] Stitching multi-speaker audio. speakers=${detectedSpeakerLabels.size}, lines=${rawLines.length}`);

    const normalizeLabel = (label: string) => label.toLowerCase().replace(/\s+/g, '');

    const fixedVoiceMap: Record<string, string> = {
      speaker1: speaker1Voice,
      speakerone: speaker1Voice,
      speaker2: speaker2Voice,
      speakertwo: speaker2Voice,
    };

    const femaleNameHints = new Set(getGenderAppropriateNames('female').map((n) => n.toLowerCase()));
    const maleNameHints = new Set(getGenderAppropriateNames('male').map((n) => n.toLowerCase()));

    const assignedVoicesByLabel = new Map<string, string>();
    let nextAlternateIndex = 0;
    const alternates = [speaker1Voice, speaker2Voice];

    const getVoiceForLabel = (labelRaw: string) => {
      const normalized = normalizeLabel(labelRaw);
      const fixed = fixedVoiceMap[normalized];
      if (fixed) return fixed;

      const existing = assignedVoicesByLabel.get(labelRaw);
      if (existing) return existing;

      // Heuristic: try name-gender hint, otherwise alternate
      const lower = labelRaw.toLowerCase();
      let chosen: string;
      if (femaleNameHints.has(lower)) chosen = speaker2Voice;
      else if (maleNameHints.has(lower)) chosen = speaker1Voice;
      else chosen = alternates[nextAlternateIndex++ % alternates.length];

      assignedVoicesByLabel.set(labelRaw, chosen);
      return chosen;
    };

    type Segment = { voiceName: string; text: string };
    const segments: Segment[] = [];

    const cleanText = (t: string) =>
      t
        .replace(/<break[^>]*\/>/gi, ' ... ')
        .replace(/<\/??[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    for (const l of rawLines) {
      const m = l.match(speakerLineRegex);
      const label = m ? m[1].trim() : 'Narrator';
      const content = cleanText(m ? m[2] : l);
      if (!content) continue;

      const voiceName = getVoiceForLabel(label);

      // Coalesce consecutive segments by same voice to reduce API calls
      const last = segments[segments.length - 1];
      if (last && last.voiceName === voiceName) {
        last.text = `${last.text} ${content}`;
      } else {
        segments.push({ voiceName, text: content });
      }
    }

    const pcmChunks: Uint8Array[] = [];
    let totalLen = 0;

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      console.log(`[TTS] segment ${i + 1}/${segments.length} voice=${seg.voiceName} chars=${seg.text.length}`);

      const pcm = await callGeminiTtsOnce(seg.text, seg.voiceName);
      if (!pcm) {
        console.error('[TTS] Failed segment:', i + 1);
        return null;
      }

      pcmChunks.push(pcm);
      totalLen += pcm.length;

      // Reset error count after success
      if (serviceClient && currentKeyRecord) {
        await resetKeyErrorCount(serviceClient, currentKeyRecord.id);
      }
    }

    const merged = new Uint8Array(totalLen);
    let offset = 0;
    for (const c of pcmChunks) {
      merged.set(c, offset);
      offset += c.length;
    }

    const audioBase64 = base64Encode(merged.buffer);
    return { audioBase64, sampleRate: 24000 };
  }

  // --------------------------------------------------------------------------
  // Default path: single request (monologue or scripts without speaker lines)
  // --------------------------------------------------------------------------
  const useTwoSpeakers = requestedTwoSpeakers;

  const ttsPrompt = useTwoSpeakers
    ? `Read the following conversation slowly and clearly, as if for a language listening test. 
Use a moderate speaking pace with natural pauses between sentences. 
Pause briefly (about 1-2 seconds) after each speaker finishes their turn.
The two speakers should have distinct, clear voices:

${script}`
    : `Read the following monologue slowly and clearly, as if for a language listening test. 
Use a moderate speaking pace with natural pauses between sentences.

${script}`;

  let speechConfig: any;
  if (useTwoSpeakers) {
    speechConfig = {
      multiSpeakerVoiceConfig: {
        speakerVoiceConfigs: [
          { speaker: "Speaker1", voiceConfig: { prebuiltVoiceConfig: { voiceName: speaker1Voice } } },
          { speaker: "Speaker2", voiceConfig: { prebuiltVoiceConfig: { voiceName: speaker2Voice } } },
        ],
      },
    };
  } else {
    speechConfig = {
      voiceConfig: {
        prebuiltVoiceConfig: { voiceName: speaker1Voice },
      },
    };
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(
        `Generating TTS audio (attempt ${attempt}/${maxRetries}) with voices: ${speaker1Voice}${useTwoSpeakers ? `, ${speaker2Voice}` : ' (monologue)'}...`
      );

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${currentApiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: ttsPrompt }] }],
            generationConfig: {
              responseModalities: ["AUDIO"],
              speechConfig,
            },
          }),
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`TTS failed (attempt ${attempt}):`, errorText);

        if (response.status === 429) {
          if (await rotateKeyIfPossible(false)) {
            attempt--;
            continue;
          }
          lastTTSError = 'All API keys have reached their rate limit for audio generation. Please wait a few minutes and try again.';
        } else if (response.status === 403) {
          if (await rotateKeyIfPossible(true)) {
            attempt--;
            continue;
          }
          lastTTSError = 'API access denied for audio generation. Please verify your Gemini API key has TTS permissions enabled.';
        } else if (response.status === 400) {
          lastTTSError = 'Audio generation request was rejected. Please try again.';
        } else {
          lastTTSError = `Audio generation failed with status ${response.status}. Please try again.`;
        }

        if ((response.status === 500 || response.status === 503) && attempt < maxRetries) {
          const delay = Math.pow(2, attempt) * 1000;
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        return null;
      }

      const data = await response.json();
      const audioData = data.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

      if (audioData) {
        console.log("TTS audio generated successfully");

        if (serviceClient && currentKeyRecord) {
          await resetKeyErrorCount(serviceClient, currentKeyRecord.id);
        }

        return { audioBase64: audioData, sampleRate: 24000 };
      }

      lastTTSError = 'Audio generation returned empty response. Please try again.';
    } catch (err) {
      console.error(`TTS error (attempt ${attempt}):`, err);
      lastTTSError = `Connection error during audio generation: ${err instanceof Error ? err.message : 'Unknown error'}`;

      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
    }
  }

  return null;
}

// Reading configuration interface
interface ReadingConfig {
  passagePreset?: string;
  paragraphCount?: number;
  wordCount?: number;
  useWordCountMode?: boolean;
}

// Listening configuration interface
// Gemini free tier limits: ~15 min audio/day, keep each request to max ~2 min (70% of capacity)
// ~150 words per minute of speech at normal pace
interface SpellingModeConfig {
  enabled: boolean;
  testScenario: 'phone_call' | 'hotel_booking' | 'job_inquiry';
  spellingDifficulty: 'low' | 'high';
  numberFormat: 'phone_number' | 'date' | 'postcode';
}

interface ListeningConfig {
  transcriptPreset?: string;
  durationSeconds?: number;
  wordCount?: number;
  useWordCountMode?: boolean;
  speakerConfig?: SpeakerConfigInput;
  spellingMode?: SpellingModeConfig;
  monologueMode?: boolean; // Single speaker mode like IELTS Part 4
}

// Reading question type prompts - generate structured data matching DB schema
function getReadingPrompt(
  questionType: string, 
  topic: string, 
  difficulty: string, 
  questionCount: number,
  readingConfig?: ReadingConfig
): string {
  const difficultyDesc = difficulty === 'easy' ? 'Band 5-5.5' : difficulty === 'medium' ? 'Band 6-6.5' : difficulty === 'hard' ? 'Band 7-7.5' : 'Band 8-9 (Expert level - extremely challenging, requires near-native comprehension, subtle inferences, and mastery of nuanced vocabulary)';
  
  // Determine passage specifications based on config
  let paragraphCount = readingConfig?.paragraphCount || 6;
  let wordCount = readingConfig?.wordCount || 750;
  
  // If using word count mode, estimate paragraphs (avg ~100-120 words per paragraph)
  if (readingConfig?.useWordCountMode && readingConfig.wordCount) {
    paragraphCount = Math.max(3, Math.min(10, Math.ceil(wordCount / 110)));
  } else if (!readingConfig?.useWordCountMode && readingConfig?.paragraphCount) {
    // If using paragraph mode, estimate word count
    wordCount = paragraphCount * 110;
  }

  // Generate paragraph labels
  const paragraphLabels = Array.from({ length: paragraphCount }, (_, i) => 
    String.fromCharCode(65 + i) // A, B, C, ...
  );
  const labelList = paragraphLabels.map(l => `[${l}]`).join(', ');
  
  const basePrompt = `Generate an IELTS Academic Reading test with the following specifications:

Topic: ${topic}
Difficulty: ${difficulty} (${difficultyDesc})

Requirements:
1. Create a reading passage with these specifications:
   - Total word count: approximately ${wordCount} words (strict: between ${wordCount - 50} and ${wordCount + 100} words)
   - Number of paragraphs: ${paragraphCount} paragraphs, labeled ${labelList}
   - Each paragraph should be 80-150 words (official IELTS standard)
   - Academic in tone and style
   - Well-structured with clear paragraph labels [A], [B], etc.
   - Contains specific information that can be tested
   - Appropriate for the ${difficulty} difficulty level

`;

  switch (questionType) {
    case 'TRUE_FALSE_NOT_GIVEN':
    case 'YES_NO_NOT_GIVEN':
      return basePrompt + `2. Create ${questionCount} ${questionType === 'YES_NO_NOT_GIVEN' ? 'Yes/No/Not Given' : 'True/False/Not Given'} questions based on the passage.

Return ONLY valid JSON in this exact format:
{
  "passage": {
    "title": "The title of the passage",
    "content": "The full passage text with paragraph labels like [A], [B], etc."
  },
  "instruction": "Do the following statements agree with the information given in the passage? Write ${questionType === 'YES_NO_NOT_GIVEN' ? 'YES, NO, or NOT GIVEN' : 'TRUE, FALSE, or NOT GIVEN'}.",
  "questions": [
    {
      "question_number": 1,
      "question_text": "Statement about the passage",
      "correct_answer": "${questionType === 'YES_NO_NOT_GIVEN' ? 'YES' : 'TRUE'}",
      "explanation": "Why this is the correct answer"
    }
  ]
}`;

    case 'MULTIPLE_CHOICE':
    case 'MULTIPLE_CHOICE_SINGLE':
      return basePrompt + `2. Create ${questionCount} multiple choice questions (single answer) based on the passage.

Return ONLY valid JSON in this exact format:
{
  "passage": {
    "title": "The title of the passage",
    "content": "The full passage text with paragraph labels like [A], [B], etc."
  },
  "instruction": "Choose the correct letter, A, B, C or D.",
  "questions": [
    {
      "question_number": 1,
      "question_text": "The question about the passage?",
      "options": ["A First option", "B Second option", "C Third option", "D Fourth option"],
      "correct_answer": "A",
      "explanation": "Why A is correct"
    }
  ]
}`;

    case 'MULTIPLE_CHOICE_MULTIPLE':
      // For MCQ Multiple, we create ONE question "set" where test-takers must pick 3 answers.
      // The question group spans 3 question numbers (Questions 1-3) with 6 options (A-F).
      // This is the standardized MCMA format for AI practice.

      return basePrompt + `2. Create ONE multiple choice question set where test-takers must select THREE correct answers from six options (A-F).

CRITICAL REQUIREMENTS:
- The question set spans Questions 1 to 3 (3 question numbers)
- Return EXACTLY 3 question objects with question_number 1, 2, and 3
- ALL 3 question objects must have IDENTICAL content (same question_text, same options, same correct_answer, same explanation)
- Generate exactly 6 options (A through F)
- The correct_answer must be a comma-separated list of 3 letters (e.g., "A,C,E" or "B,D,F")
- DO NOT always use the same letters - randomize which 3 options are correct

Return ONLY valid JSON in this exact format:
{
  "passage": {
    "title": "The title of the passage",
    "content": "The full passage text with paragraph labels like [A], [B], etc."
  },
  "instruction": "Questions 1-3. Choose THREE letters, A-F.",
  "max_answers": 3,
  "questions": [
    {
      "question_number": 1,
      "question_text": "Which THREE of the following statements are true according to the passage?",
      "options": ["A First option", "B Second option", "C Third option", "D Fourth option", "E Fifth option", "F Sixth option"],
      "correct_answer": "A,C,E",
      "explanation": "A is correct because... C is correct because... E is correct because...",
      "max_answers": 3
    },
    {
      "question_number": 2,
      "question_text": "Which THREE of the following statements are true according to the passage?",
      "options": ["A First option", "B Second option", "C Third option", "D Fourth option", "E Fifth option", "F Sixth option"],
      "correct_answer": "A,C,E",
      "explanation": "A is correct because... C is correct because... E is correct because...",
      "max_answers": 3
    },
    {
      "question_number": 3,
      "question_text": "Which THREE of the following statements are true according to the passage?",
      "options": ["A First option", "B Second option", "C Third option", "D Fourth option", "E Fifth option", "F Sixth option"],
      "correct_answer": "A,C,E",
      "explanation": "A is correct because... C is correct because... E is correct because...",
      "max_answers": 3
    }
  ]
}`;

    case 'MATCHING_HEADINGS':
      return basePrompt + `2. Create a matching headings question where test-takers match paragraphs to headings.
   - Provide MORE headings than paragraphs (at least 2-3 extra distractors)

Return ONLY valid JSON in this exact format:
{
  "passage": {
    "title": "The title of the passage",
    "content": "The full passage text with paragraph labels like [A], [B], [C], [D], [E]"
  },
  "instruction": "The passage has five paragraphs, A-E. Choose the correct heading for each paragraph from the list of headings below.",
  "headings": [
    {"id": "i", "text": "First heading option"},
    {"id": "ii", "text": "Second heading option"},
    {"id": "iii", "text": "Third heading option"},
    {"id": "iv", "text": "Fourth heading option"},
    {"id": "v", "text": "Fifth heading option"},
    {"id": "vi", "text": "Sixth heading (distractor)"},
    {"id": "vii", "text": "Seventh heading (distractor)"}
  ],
  "questions": [
    {"question_number": 1, "question_text": "Paragraph A", "correct_answer": "ii", "explanation": "Why ii matches A"},
    {"question_number": 2, "question_text": "Paragraph B", "correct_answer": "v", "explanation": "Why v matches B"},
    {"question_number": 3, "question_text": "Paragraph C", "correct_answer": "i", "explanation": "Why i matches C"},
    {"question_number": 4, "question_text": "Paragraph D", "correct_answer": "iv", "explanation": "Why iv matches D"},
    {"question_number": 5, "question_text": "Paragraph E", "correct_answer": "iii", "explanation": "Why iii matches E"}
  ]
}`;

    case 'MATCHING_INFORMATION':
      return basePrompt + `2. Create ${questionCount} matching information questions where test-takers match statements to paragraphs.
   - The passage has multiple paragraphs labeled A, B, C, D, E
   - Each question asks which paragraph contains specific information
   - Provide paragraph options with descriptions (not just letters)

Return ONLY valid JSON in this exact format:
{
  "passage": {
    "title": "The title of the passage",
    "content": "The full passage text with paragraph labels like [A], [B], [C], [D], [E]"
  },
  "instruction": "Which paragraph contains the following information? Write the correct letter, A-E.",
  "options": [
    {"letter": "A", "text": "Introduction and background"},
    {"letter": "B", "text": "Historical development"},
    {"letter": "C", "text": "Current applications"},
    {"letter": "D", "text": "Future implications"},
    {"letter": "E", "text": "Conclusion and summary"}
  ],
  "questions": [
    {
      "question_number": 1,
      "question_text": "A description of the early origins of the subject",
      "correct_answer": "B",
      "explanation": "This information is found in paragraph B where the historical development is discussed..."
    }
  ]
}`;

    case 'FILL_IN_BLANK':
    case 'SHORT_ANSWER':
      // Randomly select a display variation for fill-in-the-blank questions
      // Variations: standard, paragraph, bullets, headings, note_style
      const fillVariations = ['standard', 'paragraph', 'bullets', 'headings', 'note_style'];
      const selectedVariation = fillVariations[Math.floor(Math.random() * fillVariations.length)];
      
      // Randomly select word limit (1, 2, or 3 words)
      const wordLimitOptions = [1, 2, 3];
      const selectedWordLimit = wordLimitOptions[Math.floor(Math.random() * wordLimitOptions.length)];
      const wordLimitText = selectedWordLimit === 1 ? 'ONE WORD ONLY' : 
                            selectedWordLimit === 2 ? 'NO MORE THAN TWO WORDS' : 
                            'NO MORE THAN THREE WORDS';
      
      let variationInstructions = '';
      let variationFormat = '';
      
      if (selectedVariation === 'paragraph') {
        variationInstructions = `
   - Format the questions as a flowing paragraph with blanks numbered in parentheses
   - The paragraph should be a coherent summary of part of the passage`;
        variationFormat = `
  "display_options": {
    "display_as_paragraph": true,
    "paragraph_text": "The study found that (1) _____ was the primary factor, which led to (2) _____ in the region. Researchers concluded that (3) _____ would be necessary..."
  },`;
      } else if (selectedVariation === 'bullets') {
        variationInstructions = `
   - Format each question as a bullet point item`;
        variationFormat = `
  "display_options": {
    "show_bullets": true
  },`;
      } else if (selectedVariation === 'headings') {
        variationInstructions = `
   - Group questions under 2-3 thematic headings based on the passage content
   - Each question should have a "heading" field indicating which heading it belongs to`;
        variationFormat = `
  "display_options": {
    "show_headings": true,
    "group_title": "Summary of Key Points"
  },`;
      } else if (selectedVariation === 'note_style') {
        variationInstructions = `
   - Format as note-taking style with categories
   - Group questions into 2-3 note categories
   - Each category has a title and list of items with blanks`;
        variationFormat = `
  "display_options": {
    "note_style_enabled": true,
    "note_categories": [
      {
        "title": "Main Findings",
        "items": [
          {"text_before": "Primary cause:", "question_number": 1, "text_after": ""},
          {"text_before": "Effect on population:", "question_number": 2, "text_after": ""}
        ]
      }
    ]
  },`;
      } else {
        variationFormat = `
  "display_options": {},`;
      }
      
      return basePrompt + `2. Create ${questionCount} fill-in-the-blank/sentence completion questions.

CRITICAL WORD LIMIT RULE - STRICTLY ENFORCED:
- Maximum word limit: ${selectedWordLimit} word(s) per answer
- Every answer MUST be ${selectedWordLimit === 1 ? 'exactly 1 word' : selectedWordLimit === 2 ? '1 or 2 words (never 3+)' : '1, 2, or 3 words (never 4+)'}
- NEVER exceed the word limit - this violates IELTS standards
- If word limit is 3, vary lengths naturally: some 1-word, some 2-word, some 3-word answers
- If word limit is 2, use mix of 1-word and 2-word answers
- If word limit is 1, ALL answers must be exactly 1 word${variationInstructions}

Return ONLY valid JSON in this exact format:
{
  "passage": {
    "title": "The title of the passage",
    "content": "The full passage text with paragraph labels like [A], [B], etc."
  },
  "instruction": "Complete the sentences below. Choose ${wordLimitText} from the passage for each answer.",${variationFormat}
  "questions": [
    {
      "question_number": 1,
      "question_text": "According to the passage, the main cause of _____ is pollution.",
      "correct_answer": "${selectedWordLimit === 1 ? 'pollution' : selectedWordLimit === 2 ? 'climate change' : 'global climate change'}",
      "explanation": "Found in paragraph A: 'the main cause of climate change is pollution'"${selectedVariation === 'headings' ? ',\n      "heading": "Environmental Impact"' : ''}
    }
  ]
}`;

    case 'SENTENCE_COMPLETION':
      return basePrompt + `2. Create ${questionCount} sentence completion questions with a word bank.
   - Provide a list of words/phrases (options A-H) that test-takers must choose from
   - Each question is a sentence with a blank that must be completed using one of the given words
   - Provide more options than questions as distractors

Return ONLY valid JSON in this exact format:
{
  "passage": {
    "title": "The title of the passage",
    "content": "The full passage text with paragraph labels like [A], [B], etc."
  },
  "instruction": "Complete the sentences below. Choose the correct letter, A-H, from the list of words below.",
  "word_bank": [
    {"id": "A", "text": "technology"},
    {"id": "B", "text": "environment"},
    {"id": "C", "text": "research"},
    {"id": "D", "text": "education"},
    {"id": "E", "text": "climate"},
    {"id": "F", "text": "innovation"},
    {"id": "G", "text": "development"},
    {"id": "H", "text": "sustainability"}
  ],
  "questions": [
    {
      "question_number": 1,
      "question_text": "The main focus of the study was on _____.",
      "correct_answer": "A",
      "explanation": "The passage mentions technology as the main focus in paragraph B"
    },
    {
      "question_number": 2,
      "question_text": "Scientists emphasized the importance of _____ in modern society.",
      "correct_answer": "F",
      "explanation": "Innovation is discussed as crucial in paragraph C"
    }
  ]
}`;

    case 'TABLE_COMPLETION':
      return basePrompt + `2. Create a table completion task with ${questionCount} blanks to fill.

CRITICAL RULES - FOLLOW EXACTLY:
1. WORD LIMIT: Maximum TWO words per answer. STRICTLY ENFORCED.
   - Every answer MUST be 1 or 2 words maximum
   - NEVER use 3+ word answers - this violates IELTS standards
   - Vary the lengths naturally: mix of 1-word and 2-word answers
   - Example valid answers: "pollution" (1 word), "water supply" (2 words)
   - Example INVALID: "clean water supply" (3 words - NEVER DO THIS)
2. Tables MUST have EXACTLY 3 COLUMNS (no more, no less).
3. Use inline blanks with __ (double underscores) within cell content, NOT separate cells for blanks.
   - Example: "Clean air and water, pollination of crops, and __" where __ is the blank
4. DISTRIBUTE blanks across BOTH column 2 AND column 3. Do NOT put all blanks only in column 2.
   - Alternate between putting blanks in the 2nd column and the 3rd column
   - At least 1/3 of blanks MUST be in the 3rd column

Return ONLY valid JSON in this exact format:
{
  "passage": {
    "title": "The title of the passage",
    "content": "The full passage text with paragraph labels like [A], [B], etc."
  },
  "instruction": "Complete the table below. Choose NO MORE THAN TWO WORDS from the passage for each answer.",
  "table_data": [
    [{"content": "Category", "is_header": true}, {"content": "Details", "is_header": true}, {"content": "Impact", "is_header": true}],
    [{"content": "First item"}, {"content": "Description text and __", "has_question": true, "question_number": 1}, {"content": "Positive effect"}],
    [{"content": "Second item"}, {"content": "More text here"}, {"content": "Results in __", "has_question": true, "question_number": 2}],
    [{"content": "Third item"}, {"content": "Additional info about __", "has_question": true, "question_number": 3}, {"content": "Significant"}]
  ],
  "questions": [
    {"question_number": 1, "question_text": "Fill in blank 1", "correct_answer": "resources", "explanation": "Found in paragraph B"},
    {"question_number": 2, "question_text": "Fill in blank 2", "correct_answer": "water scarcity", "explanation": "Found in paragraph C"},
    {"question_number": 3, "question_text": "Fill in blank 3", "correct_answer": "deforestation", "explanation": "Found in paragraph D"}
  ]
}`;

    case 'FLOWCHART_COMPLETION':
      return basePrompt + `2. Create a flowchart completion task describing a process with ${questionCount} blanks.

CRITICAL INSTRUCTION RULES:
- The instruction displayed to the user MUST be exactly: "Choose NO MORE THAN THREE WORDS AND/OR A NUMBER from the passage for each answer."
- The answers you select from the text MUST respect this limit (max 3 words).
- Do not artificially limit it to 2 words if a 3-word answer is better.

Return ONLY valid JSON in this exact format:
{
  "passage": {
    "title": "The title of the passage",
    "content": "The full passage text describing a process with paragraph labels like [A], [B], etc."
  },
  "instruction": "Choose NO MORE THAN THREE WORDS AND/OR A NUMBER from the passage for each answer.",
  "flowchart_title": "Process of...",
  "flowchart_steps": [
    {"id": "step1", "label": "First step: gathering materials", "isBlank": false},
    {"id": "step2", "label": "", "isBlank": true, "questionNumber": 1},
    {"id": "step3", "label": "Third step: processing", "isBlank": false},
    {"id": "step4", "label": "", "isBlank": true, "questionNumber": 2},
    {"id": "step5", "label": "Final step: completion", "isBlank": false}
  ],
  "questions": [
    {"question_number": 1, "question_text": "Step 2", "correct_answer": "mixing ingredients", "explanation": "Found in paragraph B"},
    {"question_number": 2, "question_text": "Step 4", "correct_answer": "quality testing", "explanation": "Found in paragraph D"}
  ]
}`;

    case 'SUMMARY_COMPLETION':
    case 'SUMMARY_WORD_BANK':
      return basePrompt + `2. Create a summary completion task with a word bank.

Return ONLY valid JSON in this exact format:
{
  "passage": {
    "title": "The title of the passage",
    "content": "The full passage text with paragraph labels like [A], [B], etc."
  },
  "instruction": "Complete the summary using the list of words, A-H, below.",
  "summary_text": "The passage discusses how {{1}} affects modern society. Scientists have found that {{2}} plays a crucial role in this process. Furthermore, {{3}} has been identified as a key factor.",
  "word_bank": [
    {"id": "A", "text": "technology"},
    {"id": "B", "text": "environment"},
    {"id": "C", "text": "research"},
    {"id": "D", "text": "education"},
    {"id": "E", "text": "climate"},
    {"id": "F", "text": "innovation"}
  ],
  "questions": [
    {"question_number": 1, "question_text": "Gap 1", "correct_answer": "A", "explanation": "Technology is discussed as affecting society"},
    {"question_number": 2, "question_text": "Gap 2", "correct_answer": "C", "explanation": "Research is mentioned as crucial"},
    {"question_number": 3, "question_text": "Gap 3", "correct_answer": "E", "explanation": "Climate is identified as key factor"}
  ]
}`;

    case 'MATCHING_SENTENCE_ENDINGS':
      return basePrompt + `2. Create ${questionCount} matching sentence endings questions.
   - Provide more endings than questions as distractors

Return ONLY valid JSON in this exact format:
{
  "passage": {
    "title": "The title of the passage",
    "content": "The full passage text with paragraph labels like [A], [B], etc."
  },
  "instruction": "Complete each sentence with the correct ending, A-G, below.",
  "sentence_beginnings": [
    {"number": 1, "text": "Scientists discovered that"},
    {"number": 2, "text": "The research team found that"},
    {"number": 3, "text": "Experts believe that"}
  ],
  "sentence_endings": [
    {"id": "A", "text": "pollution has increased significantly."},
    {"id": "B", "text": "new methods are needed."},
    {"id": "C", "text": "the results were unexpected."},
    {"id": "D", "text": "further study is required."},
    {"id": "E", "text": "improvements can be made."}
  ],
  "questions": [
    {"question_number": 1, "question_text": "Scientists discovered that", "correct_answer": "C", "explanation": "The passage states..."},
    {"question_number": 2, "question_text": "The research team found that", "correct_answer": "A", "explanation": "Found in paragraph B..."}
  ]
}`;

    case 'MAP_LABELING':
      return basePrompt + `2. Create a map/diagram labeling task with ${questionCount} labels to identify.

OFFICIAL IELTS FORMAT - CRITICAL RULES:
- The MAP shows: (1) Letter circles A-H marking UNKNOWN locations, and (2) LABELED landmarks for navigation
- The PASSAGE describes where things are using DIRECTIONS and LANDMARKS (e.g., "opposite the main entrance", "north of the café")
- QUESTIONS show the PLACE NAME the test taker must locate (e.g., "Library", "Gift Shop")
- The correct_answer is the LETTER (A, B, C, etc.) where that place is located

MAP STRUCTURE:
- map_labels: Answer positions A-H with x,y coordinates (0-100 percentage). The "text" field stores what the letter represents (for answer checking) but this text is NOT shown on the map - only the letter circle appears!
- landmarks: Reference points with x,y coordinates that ARE labeled on the map (streets, known buildings like "Main Entrance", "Café", "Park")

PASSAGE STYLE:
- Describe locations using RELATIVE POSITIONS: "The gift shop is directly opposite the main entrance" or "Located to the north of the café"
- NEVER say "The gift shop is at position B" - test takers must figure this out!
- Use directional words: north, south, east, west, opposite, adjacent, between, corner of, next to, behind

CRITICAL: Answers must NOT be sequential! Randomize: Q1=D, Q2=A, Q3=F, Q4=B (NOT Q1=A, Q2=B, Q3=C)

Return ONLY valid JSON in this exact format:
{
  "passage": {
    "title": "The New Community Center",
    "content": "The new community center opened last month. The main entrance faces Oak Street. Immediately to the left of the entrance is the reception desk. The children's play area is located in the northeast corner, directly behind the café. The library occupies the western wing, opposite the sports hall. Meeting rooms can be found on the second floor, accessible via the staircase next to the reception."
  },
  "instruction": "Label the map below. Choose the correct letter, A-H.",
  "map_description": "A floor plan showing Oak Street at the bottom with main entrance. The building has various rooms arranged around a central corridor.",
  "map_labels": [
    {"id": "A", "text": "Reception", "x": 25, "y": 70},
    {"id": "B", "text": "Children's Play Area", "x": 75, "y": 20},
    {"id": "C", "text": "Library", "x": 15, "y": 40},
    {"id": "D", "text": "Sports Hall", "x": 75, "y": 40},
    {"id": "E", "text": "Meeting Rooms", "x": 50, "y": 15},
    {"id": "F", "text": "Storage", "x": 85, "y": 70},
    {"id": "G", "text": "Staff Room", "x": 15, "y": 20},
    {"id": "H", "text": "Toilets", "x": 85, "y": 15}
  ],
  "landmarks": [
    {"id": "L1", "text": "Oak Street", "x": 50, "y": 95},
    {"id": "L2", "text": "Main Entrance", "x": 50, "y": 85},
    {"id": "L3", "text": "Café", "x": 60, "y": 30},
    {"id": "L4", "text": "Staircase", "x": 35, "y": 70}
  ],
  "map_type": "floor_plan",
  "questions": [
    {"question_number": 1, "question_text": "Children's Play Area", "correct_answer": "B", "explanation": "Passage says it's in the northeast corner, behind the café"},
    {"question_number": 2, "question_text": "Library", "correct_answer": "C", "explanation": "Passage says it occupies the western wing, opposite the sports hall"},
    {"question_number": 3, "question_text": "Reception", "correct_answer": "A", "explanation": "Passage says it's immediately left of the main entrance"},
    {"question_number": 4, "question_text": "Sports Hall", "correct_answer": "D", "explanation": "Passage says the library is opposite it"}
  ]
}`;

    case 'NOTE_COMPLETION':
      return basePrompt + `2. Create a note completion task with ${questionCount} blanks.

Return ONLY valid JSON in this exact format:
{
  "passage": {
    "title": "The title of the passage",
    "content": "The full passage text with paragraph labels like [A], [B], etc."
  },
  "instruction": "Complete the notes below. Choose NO MORE THAN TWO WORDS from the passage for each answer.",
  "note_sections": [
    {
      "title": "Main Topic",
      "items": [
        {"text_before": "The primary cause is", "question_number": 1, "text_after": ""},
        {"text_before": "This leads to", "question_number": 2, "text_after": "in urban areas"}
      ]
    }
  ],
  "questions": [
    {"question_number": 1, "question_text": "Note 1", "correct_answer": "pollution", "explanation": "Found in paragraph A"},
    {"question_number": 2, "question_text": "Note 2", "correct_answer": "health problems", "explanation": "Found in paragraph B"}
  ]
}`;

    default:
      return basePrompt + `2. Create ${questionCount} fill-in-the-blank questions based on the passage.

Return ONLY valid JSON in this exact format:
{
  "passage": {
    "title": "The title of the passage",
    "content": "The full passage text with paragraph labels like [A], [B], etc."
  },
  "instruction": "Complete the sentences below using words from the passage.",
  "questions": [
    {
      "question_number": 1,
      "question_text": "Complete this sentence: _____",
      "correct_answer": "the answer",
      "explanation": "Why this is correct"
    }
  ]
}`;
  }
}

// Listening question type prompts
// TEMPORARY: 1 minute audio for testing (revert to 4/600 for production)
const LISTENING_AUDIO_LENGTH_MINUTES = 1; // TESTING: was 4
const LISTENING_QUESTION_COUNT = 7;
const LISTENING_WORD_COUNT = 150; // TESTING: was 600 (1 min * 150 words/min)

function getListeningPrompt(
  questionType: string, 
  topic: string, 
  difficulty: string, 
  questionCount: number, 
  scenario: any,
  listeningConfig?: ListeningConfig
): string {
  const difficultyDesc = difficulty === 'easy' ? 'Band 5-5.5' : difficulty === 'medium' ? 'Band 6-6.5' : difficulty === 'hard' ? 'Band 7-7.5' : 'Band 8-9 (Expert level - extremely challenging, requires near-native comprehension, subtle inferences, and mastery of nuanced vocabulary)';
  
  // HARDCODED per Architect spec: 4 minutes audio, 7 questions
  const targetWordCount = LISTENING_WORD_COUNT;
  const targetDurationSeconds = LISTENING_AUDIO_LENGTH_MINUTES * 60; // 240 seconds
  const effectiveQuestionCount = LISTENING_QUESTION_COUNT;
  
  const wordRange = `${targetWordCount - 50}-${targetWordCount + 50}`;

  // Determine if we use 1 or 2 speakers based on config
  const useTwoSpeakers = listeningConfig?.speakerConfig?.useTwoSpeakers !== false;

  // SSML pause instructions - Use natural, short pauses
  const ssmlInstructions = `
   CRITICAL AUDIO PACING - NATURAL PAUSES ONLY:
   - You MUST use SSML tags for pauses in the dialogue
   - Insert <break time='500ms'/> between sentences and speaker turns
   - Insert <break time='300ms'/> for natural pauses within speech
   - NEVER use pauses longer than 1 second - keep the audio flowing naturally
   - Example: "Speaker1: Welcome to the museum tour.<break time='500ms'/> Let me start by explaining the layout."
   - Avoid long silences - test takers can pause the audio if needed`;

  // FIX 1: Resolve genders dynamically from actual TTS voices to prevent name/voice mismatch
  const s1Voice = listeningConfig?.speakerConfig?.speaker1?.voiceName || 'Kore';
  const s2Voice = listeningConfig?.speakerConfig?.speaker2?.voiceName || 'Aoede';
  
  const s1Gender = (VOICE_GENDER_MAP[s1Voice] || 'male').toUpperCase();
  const s2Gender = (VOICE_GENDER_MAP[s2Voice] || (s1Gender === 'MALE' ? 'female' : 'male')).toUpperCase();
  
  const maleNames = 'Mark, David, John, Michael, James';
  const femaleNames = 'Sarah, Emma, Lisa, Rachel, Kate';

  // Build prompt for realistic character names with SSML instructions
  const characterInstructions = useTwoSpeakers
    ? `1. Create a dialogue script between two characters that is:
   - ${wordRange} words total (approximately ${targetDurationSeconds} seconds / ${LISTENING_AUDIO_LENGTH_MINUTES} minutes when spoken)
   
   CRITICAL GENDER & NAME RULES (VOICE-SYNCHRONIZED):
   - Speaker1 voice is ${s1Gender}. You MUST assign Speaker1 a ${s1Gender} name (e.g., ${s1Gender === 'MALE' ? maleNames : femaleNames}).
   - Speaker2 voice is ${s2Gender}. You MUST assign Speaker2 a ${s2Gender} name (e.g., ${s2Gender === 'MALE' ? maleNames : femaleNames}).
   - DO NOT use self-referential phrases that contradict these genders.
   - DO NOT assign a male name to a female voice or vice versa.
   
   - In the output JSON dialogue field, you MUST use "Speaker1:" and "Speaker2:" prefixes for TTS processing
   - ALSO include a "speaker_names" object in your JSON that maps Speaker1/Speaker2 to their real names
   - Contains specific details (names, numbers, dates, locations)
   ${ssmlInstructions}
   
   CRITICAL OUTPUT FORMAT:
   - dialogue: Use "Speaker1:" and "Speaker2:" prefixes (required for audio generation)
   - speaker_names: {"Speaker1": "${s1Gender === 'MALE' ? 'Mark' : 'Sarah'}", "Speaker2": "${s2Gender === 'MALE' ? 'David' : 'Emma'}"}`
    : `1. Create a monologue script by a single speaker that is:
   - ${wordRange} words total (approximately ${targetDurationSeconds} seconds / ${LISTENING_AUDIO_LENGTH_MINUTES} minutes when spoken)
   - Clear and informative, like a tour guide, lecturer, or announcer
   - Use "Speaker1:" prefix for all lines (required for TTS)
   - ALSO include a "speaker_names" object: {"Speaker1": "Appropriate Role/Title"}
   - Example: speaker_names: {"Speaker1": "Tour Guide"} or {"Speaker1": "${s1Gender === 'MALE' ? 'Professor Williams' : 'Dr. Thompson'}"}
   - Contains specific details (names, numbers, dates, locations)
   ${ssmlInstructions}`;

  const basePrompt = `Generate an IELTS Listening test section with the following specifications:

Topic: ${topic}
Scenario: ${scenario.description}
Difficulty: ${difficulty} (${difficultyDesc})
FIXED PARAMETERS: ${LISTENING_AUDIO_LENGTH_MINUTES} minutes audio, ${effectiveQuestionCount} questions

Requirements:
${characterInstructions}
`;

  // Handle FILL_IN_BLANK with optional Spelling Mode or Monologue Mode
  if (questionType === 'FILL_IN_BLANK') {
    const spellingMode = listeningConfig?.spellingMode;
    const isMonologue = listeningConfig?.monologueMode === true;
    
    // NATURAL GAP POSITIONING INSTRUCTION - randomizes blank positions
    const gapPositionInstruction = `
CRITICAL - NATURAL GAP/BLANK POSITIONING:
For fill-in-the-blank questions, you MUST randomize the position of the missing word (represented by _____):
- 30% of questions: Blank should be near the START of the sentence (e.g., "_____ is the main attraction.")
- 40% of questions: Blank should be in the MIDDLE of the sentence (e.g., "The event starts at _____ on Saturday.")
- 30% of questions: Blank should be at the END of the sentence (e.g., "Visitors should bring _____.")
- Ensure the sentence context makes the missing word deducible from the audio.
- NEVER put all blanks at the same position - vary them naturally across questions.`;
    
    // Monologue mode (IELTS Part 4 style)
    if (isMonologue) {
      return basePrompt + `2. Create ${effectiveQuestionCount} fill-in-the-blank questions in IELTS Part 4 monologue style.

CRITICAL RULES FOR MONOLOGUE MODE:
- This is a SINGLE SPEAKER monologue (like a lecture, tour guide, or presentation)
- Use "Speaker1:" prefix for ALL lines (required for TTS)
- Blanks should contain common nouns, dates, numbers, or descriptive phrases
${gapPositionInstruction}

Return ONLY valid JSON:
{
  "dialogue": "Speaker1: Welcome to today's lecture...<break time='500ms'/> Let me explain...",
  "speaker_names": {"Speaker1": "Professor Williams"},
  "instruction": "Complete the notes below. Write NO MORE THAN THREE WORDS AND/OR A NUMBER for each answer.",
  "questions": [
    {"question_number": 1, "question_text": "_____ was the primary building material used.", "correct_answer": "Limestone", "explanation": "Speaker mentions limestone (START gap)"},
    {"question_number": 2, "question_text": "The museum opens at _____ on weekdays.", "correct_answer": "9 AM", "explanation": "Speaker states opening time (MIDDLE gap)"},
    {"question_number": 3, "question_text": "Visitors should register at _____.", "correct_answer": "the front desk", "explanation": "Speaker mentions registration location (END gap)"}
  ]
}`;
    }
    
    // Standard Fill-in-Blank
    return basePrompt + `2. Create ${effectiveQuestionCount} fill-in-the-blank questions.
${gapPositionInstruction}

CRITICAL NEGATIVE CONSTRAINT: You are PROHIBITED from placing the blank at the very end of the sentence more than 30% of the time.

Return ONLY valid JSON:
{
  "dialogue": "Speaker1: Hello, welcome to the museum...<break time='500ms'/>\\nSpeaker2: Thank you...",
  "speaker_names": {"Speaker1": "Tour Guide", "Speaker2": "Visitor"},
  "instruction": "Complete the notes below. Write NO MORE THAN THREE WORDS AND/OR A NUMBER for each answer.",
  "questions": [
    {"question_number": 1, "question_text": "_____ is located on the second floor.", "correct_answer": "The gift shop", "explanation": "Speaker mentions gift shop location (START gap)"},
    {"question_number": 2, "question_text": "The tour lasts approximately _____.", "correct_answer": "45 minutes", "explanation": "Speaker mentions tour duration (MIDDLE gap)"},
    {"question_number": 3, "question_text": "Photography is not allowed in _____.", "correct_answer": "the main gallery", "explanation": "Speaker mentions photography restriction (END gap)"}
  ]
}`;
  }

  switch (questionType) {
    case 'MULTIPLE_CHOICE':
    case 'MULTIPLE_CHOICE_SINGLE':
      return basePrompt + `2. Create ${effectiveQuestionCount} multiple choice questions (single answer).

Return ONLY valid JSON:
{
  "dialogue": "Speaker1: Let me explain...<break time='500ms'/>\\nSpeaker2: I see...",
  "speaker_names": {"Speaker1": "Instructor", "Speaker2": "Student"},
  "instruction": "Choose the correct letter, A, B or C.",
  "questions": [
    {"question_number": 1, "question_text": "What is the main topic?", "options": ["A First option", "B Second option", "C Third option"], "correct_answer": "A", "explanation": "The speaker mentions..."}
  ]
}`;

    case 'MULTIPLE_CHOICE_MULTIPLE':
      // For MCQ Multiple, we create ONE question "set" where test-takers must pick 3 answers.
      // The question group spans 3 question numbers (Questions 1-3) with 6 options (A-F).
      // This mirrors the reading MCMA format exactly.
      return basePrompt + `2. Create ONE multiple choice question set where test-takers must select THREE correct answers from six options (A-F).

CRITICAL REQUIREMENTS:
- The question set spans Questions 1 to 3 (3 question numbers)
- Return EXACTLY 3 question objects with question_number 1, 2, and 3
- ALL 3 question objects must have IDENTICAL content (same question_text, same options, same correct_answer, same explanation)
- Generate exactly 6 options (A through F) with full descriptive text
- The correct_answer must be a comma-separated list of 3 letters (e.g., "A,C,E" or "B,D,F")
- DO NOT always use the same letters - randomize which 3 options are correct
- Each option must be in format "A Full description of option A" (letter followed by space then text)

Return ONLY valid JSON:
{
  "dialogue": "Speaker1: There are several key benefits to this approach...<break time='500ms'/> First, it improves efficiency...<break time='300ms'/> Additionally, it reduces costs...",
  "speaker_names": {"Speaker1": "Expert"},
  "instruction": "Questions 1-3. Choose THREE letters, A-F.",
  "max_answers": 3,
  "questions": [
    {"question_number": 1, "question_text": "Which THREE benefits are mentioned by the speaker?", "options": ["A Improved efficiency in operations", "B Better customer satisfaction", "C Reduced overall costs", "D Enhanced employee morale", "E Faster processing times", "F Greater market reach"], "correct_answer": "A,C,E", "explanation": "A is correct because efficiency is mentioned. C is correct because cost reduction is discussed. E is correct because faster processing is highlighted.", "max_answers": 3},
    {"question_number": 2, "question_text": "Which THREE benefits are mentioned by the speaker?", "options": ["A Improved efficiency in operations", "B Better customer satisfaction", "C Reduced overall costs", "D Enhanced employee morale", "E Faster processing times", "F Greater market reach"], "correct_answer": "A,C,E", "explanation": "A is correct because efficiency is mentioned. C is correct because cost reduction is discussed. E is correct because faster processing is highlighted.", "max_answers": 3},
    {"question_number": 3, "question_text": "Which THREE benefits are mentioned by the speaker?", "options": ["A Improved efficiency in operations", "B Better customer satisfaction", "C Reduced overall costs", "D Enhanced employee morale", "E Faster processing times", "F Greater market reach"], "correct_answer": "A,C,E", "explanation": "A is correct because efficiency is mentioned. C is correct because cost reduction is discussed. E is correct because faster processing is highlighted.", "max_answers": 3}
  ]
}`;
    case 'MATCHING_CORRECT_LETTER':
    case 'DRAG_AND_DROP_OPTIONS': {
      // UNIFIED PROMPT for both question types - they are functionally identical
      // Calculate number of distractor options (2-3 more than number of questions)
      const numDistractorsDND = Math.min(3, Math.max(2, Math.ceil(effectiveQuestionCount * 0.4)));
      const totalOptionsDND = effectiveQuestionCount + numDistractorsDND;
      const lastLetterDND = String.fromCharCode(64 + totalOptionsDND);
      
      return basePrompt + `2. Create ${effectiveQuestionCount} drag-and-drop questions with a word bank.

CRITICAL - DRAG & DROP FORMAT WITH DISTRACTORS:
This is a WORD BANK question type where test-takers drag options to fill blanks.
You MUST generate MORE options than questions - the extras are DISTRACTORS.

REQUIREMENTS:
1. Generate EXACTLY ${totalOptionsDND} options in the "drag_options" array (letters A-${lastLetterDND})
2. Only ${effectiveQuestionCount} are correct answers; ${numDistractorsDND} are PLAUSIBLE DISTRACTORS
3. DISTRACTORS must be thematically relevant but WRONG based on the dialogue
   - If answers are names, distractors should be other plausible names NOT mentioned
   - If answers are dates/times, distractors should be other dates/times NOT mentioned
   - If answers are places, distractors should be other plausible places NOT mentioned
4. Each question_text MUST contain a blank using underscores: ________
5. Each correct_answer MUST be a SINGLE LETTER (A, B, C, etc.)
6. Letter mapping: A = drag_options[0], B = drag_options[1], etc.

EXAMPLE: If dialogue mentions "October 12th" and "Central Park":
- drag_options: ["October 12th", "Central Park", "November 5th", "Riverside Park"]
- Question about date → correct_answer: "A"
- "November 5th" and "Riverside Park" are distractors (plausible but not mentioned)

Return ONLY valid JSON:
{
  "dialogue": "Speaker1: The wellness fair is on October 12th at Central Park Pavilion...<break time='500ms'/> Sarah Jenkins leads the yoga session at 10 AM...",
  "speaker_names": {"Speaker1": "Event Coordinator"},
  "instruction": "Complete the notes below by dragging the correct option to each blank.",
  "drag_options": ["October 12th", "Central Park", "Sarah Jenkins", "10 AM", "November 5th", "Riverside Park", "Michael Brown", "2 PM"],
  "questions": [
    {"question_number": 1, "question_text": "Event date: ________", "correct_answer": "A", "explanation": "Speaker mentions 'October 12th' as the date."},
    {"question_number": 2, "question_text": "Location: ________ Pavilion", "correct_answer": "B", "explanation": "Speaker says 'Central Park Pavilion'."},
    {"question_number": 3, "question_text": "Yoga instructor: ________", "correct_answer": "C", "explanation": "Sarah Jenkins leads the yoga session."},
    {"question_number": 4, "question_text": "Yoga session time: ________", "correct_answer": "D", "explanation": "Yoga is at 10 AM."}
  ]
}`;
    }

    case 'TABLE_COMPLETION':
      return basePrompt + `2. Create a table completion task with ${effectiveQuestionCount} blanks.

Return ONLY valid JSON:
{
  "dialogue": "Speaker1: Let me give you the schedule...<break time='500ms'/>",
  "speaker_names": {"Speaker1": "Coordinator"},
  "instruction": "Complete the table below.",
  "table_data": {
    "headers": ["Event", "Time", "Location"],
    "rows": [
      [{"text": "Opening ceremony"}, {"text": "9:00 AM"}, {"isBlank": true, "questionNumber": 1}],
      [{"text": "Workshop"}, {"isBlank": true, "questionNumber": 2}, {"text": "Room 101"}]
    ]
  },
  "questions": [
    {"question_number": 1, "question_text": "Location of opening ceremony", "correct_answer": "Main Hall", "explanation": "Speaker says Main Hall"}
  ]
}`;

    case 'FLOWCHART_COMPLETION':
      return basePrompt + `2. Create a flowchart completion task with ${effectiveQuestionCount} blanks.

Return ONLY valid JSON:
{
  "dialogue": "Speaker1: Let me explain the process...<break time='500ms'/>",
  "speaker_names": {"Speaker1": "HR Manager"},
  "instruction": "Complete the flow chart below.",
  "flowchart_title": "Application Process",
  "flowchart_steps": [
    {"id": "step1", "text": "Submit application", "hasBlank": false},
    {"id": "step2", "text": "Receive __1__", "hasBlank": true, "blankNumber": 1},
    {"id": "step3", "text": "Attend __2__", "hasBlank": true, "blankNumber": 2}
  ],
  "distractor_options": ["schedule", "discount"],
  "questions": [
    {"question_number": 1, "question_text": "Step 2", "correct_answer": "confirmation", "explanation": "System sends confirmation"}
  ]
}`;

    case 'MAP_LABELING':
      return basePrompt + `2. Create a map labeling task with ${effectiveQuestionCount} locations.

CRITICAL: Use directional language, NEVER say "at position B".
Include x,y coordinates (0-100 percentage) for each label and landmark for map rendering.

Return ONLY valid JSON:
{
  "dialogue": "Speaker1: Welcome to Historic Fairview. Let me show you around...<break time='500ms'/> The quilt shop is on the west side of Main Street, just past the welcome center.<break time='500ms'/> If you walk north along Main Street, you'll find the handicrafts museum on your right, directly across from the bank...",
  "speaker_names": {"Speaker1": "Tour Guide"},
  "instruction": "Label the map. Choose the correct letter, A-H.",
  "map_description": "A street map showing the intersection of Oak Street and Main Street. Buildings are arranged along both streets.",
  "map_type": "street_map",
  "map_labels": [
    {"id": "A", "text": "Art Gallery", "x": 20, "y": 25},
    {"id": "B", "text": "Bookshop", "x": 40, "y": 35},
    {"id": "C", "text": "Museum", "x": 70, "y": 25},
    {"id": "D", "text": "Quilt Shop", "x": 25, "y": 55},
    {"id": "E", "text": "School House", "x": 75, "y": 55},
    {"id": "F", "text": "Gift Shop", "x": 50, "y": 65},
    {"id": "G", "text": "Café", "x": 80, "y": 35},
    {"id": "H", "text": "Post Office", "x": 15, "y": 75}
  ],
  "landmarks": [
    {"id": "L1", "text": "Bank", "x": 55, "y": 25},
    {"id": "L2", "text": "Welcome Center", "x": 30, "y": 45},
    {"id": "L3", "text": "Oak Street", "x": 50, "y": 10},
    {"id": "L4", "text": "Main Street", "x": 10, "y": 50},
    {"id": "L5", "text": "Elm Street", "x": 50, "y": 90}
  ],
  "questions": [
    {"question_number": 1, "question_text": "Quilt Shop", "correct_answer": "D", "explanation": "Guide says it's on west side of Main Street, past welcome center"},
    {"question_number": 2, "question_text": "Museum", "correct_answer": "C", "explanation": "Guide says it's north on Main Street, across from the bank"},
    {"question_number": 3, "question_text": "School House", "correct_answer": "E", "explanation": "Guide says it's on the east side, south of the café"}
  ]
}`;

    case 'NOTE_COMPLETION':
      return basePrompt + `2. Create a note completion task with ${effectiveQuestionCount} blanks.

Return ONLY valid JSON:
{
  "dialogue": "Speaker1: Let me explain the key points...<break time='500ms'/>",
  "speaker_names": {"Speaker1": "Lecturer"},
  "instruction": "Complete the notes below.",
  "note_sections": [
    {
      "title": "Main Topic",
      "items": [
        {"text_before": "The primary focus is", "question_number": 1, "text_after": ""}
      ]
    }
  ],
  "questions": [
    {"question_number": 1, "question_text": "Note 1", "correct_answer": "research methods", "explanation": "Speaker mentions research methods"}
  ]
}`;

    // DRAG_AND_DROP_OPTIONS is handled above with MATCHING_CORRECT_LETTER (same prompt)


    default:
      return basePrompt + `2. Create ${effectiveQuestionCount} fill-in-the-blank questions.

Return ONLY valid JSON:
{
  "dialogue": "Speaker1: dialogue...<break time='500ms'/>\\nSpeaker2: response...",
  "speaker_names": {"Speaker1": "Host", "Speaker2": "Guest"},
  "instruction": "Complete the notes below.",
  "questions": [
    {"question_number": 1, "question_text": "The event takes place in _____.", "correct_answer": "the main garden", "explanation": "Speaker mentions the main garden"}
  ]
}`;
  }
}

// ============================================================================
// SERVE HANDLER
// ============================================================================

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    console.log("Starting generate-ai-practice function");
    
    // Auth
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: req.headers.get('Authorization')! } } }
    );

    const { data: { user } } = await supabaseClient.auth.getUser();
    if (!user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Service client for DB operations
    const serviceClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    // Parse request body first to check for userApiKey
    const body = await req.json();
    const { module, questionType, difficulty, topicPreference, questionCount, timeMinutes, readingConfig, listeningConfig, writingConfig, skipPreflight, save_to_bank, userApiKey } = body;

    // ============ HYBRID KEY PRIORITY SYSTEM ============
    // Priority 1: User-provided key (header or body) - NO fallback on failure
    // Priority 2: User's API key pool (user_api_keys table) - with rotation
    // Priority 3: System pool (DB api_keys table) - with rotation (admin keys fallback)
    
    const headerApiKey = req.headers.get('x-gemini-api-key');
    let geminiApiKey: string | null = null;
    let isUserProvidedKey = false;
    let dbApiKeys: ApiKeyRecord[] = [];
    let isUserKeyPool = false;
    
    // Priority 1: Check for user-provided key (header or body)
    if (headerApiKey) {
      console.log('Using user-provided API key from header (Priority 1)');
      geminiApiKey = headerApiKey;
      isUserProvidedKey = true;
    } else if (userApiKey) {
      console.log('Using user-provided API key from body (Priority 1)');
      geminiApiKey = userApiKey;
      isUserProvidedKey = true;
    }
    
    // Priority 2: Check user's API key pool (user_api_keys table)
    if (!isUserProvidedKey) {
      // Reset user quotas from previous days
      await serviceClient.rpc('reset_user_api_key_quotas');
      
      const today = new Date().toISOString().split('T')[0];
      const { data: userPoolKeys, error: userPoolError } = await serviceClient
        .from('user_api_keys')
        .select('*')
        .eq('user_id', user.id)
        .eq('provider', 'gemini')
        .eq('is_active', true)
        .or(`flash_quota_exhausted.is.null,flash_quota_exhausted.eq.false,flash_quota_exhausted_date.lt.${today}`);
      
      if (!userPoolError && userPoolKeys && userPoolKeys.length > 0) {
        dbApiKeys = userPoolKeys.map((k: any) => ({
          id: k.id,
          provider: k.provider,
          key_value: k.key_value,
          is_active: k.is_active,
          error_count: 0,
        }));
        geminiApiKey = dbApiKeys[0].key_value;
        isUserProvidedKey = true; // Skip credit check for users with their own keys
        isUserKeyPool = true;
        console.log(`Using user API key pool (Priority 2): ${dbApiKeys.length} active keys`);
      }
    }
    
    // Priority 3: System pool (admin api_keys table) - only if no user key
    if (!isUserProvidedKey && !isUserKeyPool) {
      dbApiKeys = await getActiveGeminiKeys(serviceClient);
      console.log(`No user key found. Using system pool: ${dbApiKeys.length} DB-managed keys (Priority 3)`);
      
      if (dbApiKeys.length > 0) {
        geminiApiKey = dbApiKeys[0].key_value;
      }
    }
    
    if (!geminiApiKey) {
      return new Response(JSON.stringify({ 
        error: 'No API key available. Please add your Gemini API key in Settings, or contact support if using system keys.' 
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`Key mode: ${isUserProvidedKey ? 'USER_KEY (no fallback)' : 'SYSTEM_POOL (rotation enabled)'}`);

    // ============ CREDIT SYSTEM CHECK ============
    // Step 1: If user has their own key (BYOK), skip all credit checks
    // Step 2-4: Check and enforce credit limits for system pool users
    const operationType = module === 'reading' ? 'generate_reading' 
                        : module === 'listening' ? 'generate_listening'
                        : module === 'writing' ? 'generate_writing'
                        : module === 'speaking' ? 'generate_speaking'
                        : 'generate_reading';
    
    if (!isUserProvidedKey) {
      const creditCheck = await checkAndReserveCredits(serviceClient, user.id, operationType as keyof typeof COSTS);
      
      if (!creditCheck.ok) {
        return new Response(JSON.stringify({ 
          error: creditCheck.error,
          errorType: 'CREDIT_LIMIT_EXCEEDED',
          creditsUsed: creditCheck.creditsUsed,
          creditsRemaining: creditCheck.creditsRemaining,
          dailyLimit: DAILY_CREDIT_LIMIT
        }), {
          status: 403,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      
      console.log(`Credits reserved: ${creditCheck.creditsUsed}/${DAILY_CREDIT_LIMIT} used, ${creditCheck.creditsRemaining} remaining after this operation`);
    } else {
      console.log('BYOK mode: Skipping credit check');
    }
    
    // Track if we need to refund on error (only if credits were reserved)
    const creditsReserved = !isUserProvidedKey;
    const currentOperationType = operationType as keyof typeof COSTS;
    
    const topic = topicPreference || IELTS_TOPICS[Math.floor(Math.random() * IELTS_TOPICS.length)];
    const testId = crypto.randomUUID();

    console.log(`Request received: ${module}/${questionType}/${difficulty}, topic: ${topic}`);

    // ============ PRESET LOOKUP - Check for published admin-generated tests first ============
    // This saves credits and returns instantly if a matching preset exists
    try {
      // First, get all preset IDs that this user has already completed (submitted with results)
      const { data: completedPresets } = await serviceClient
        .from('ai_practice_results')
        .select('test_id, ai_practice_tests!inner(preset_id)')
        .eq('user_id', user.id);
      
      const completedPresetIds = new Set(
        (completedPresets || [])
          .map((r: any) => r.ai_practice_tests?.preset_id)
          .filter(Boolean)
      );
      
      console.log(`User has completed ${completedPresetIds.size} preset tests`);
      
      let presetQuery = serviceClient
        .from('generated_test_audio')
        .select('*')
        .eq('module', module)
        .eq('is_published', true)
        .eq('status', 'ready');
      
      // Match difficulty
      if (difficulty) {
        presetQuery = presetQuery.eq('difficulty', difficulty);
      }
      
      // For listening/speaking, prefer tests with audio
      if (module === 'listening') {
        presetQuery = presetQuery.not('audio_url', 'is', null);
      }
      
      // Match question type if specified and not mixed
      if (questionType && questionType !== 'mixed' && questionType !== 'MIXED' && questionType !== 'FULL_TEST') {
        // Normalize question type aliases for matching
        // MULTIPLE_CHOICE and MULTIPLE_CHOICE_SINGLE are equivalent
        const normalizedType = questionType.toUpperCase();
        if (normalizedType === 'MULTIPLE_CHOICE') {
          // Match both MULTIPLE_CHOICE and MULTIPLE_CHOICE_SINGLE
          presetQuery = presetQuery.in('question_type', ['MULTIPLE_CHOICE', 'MULTIPLE_CHOICE_SINGLE']);
        } else if (normalizedType === 'MULTIPLE_CHOICE_SINGLE') {
          presetQuery = presetQuery.in('question_type', ['MULTIPLE_CHOICE', 'MULTIPLE_CHOICE_SINGLE']);
        } else {
          presetQuery = presetQuery.eq('question_type', normalizedType);
        }
      }
      
      // Optionally match topic (fuzzy - if topic preference provided)
      if (topicPreference) {
        presetQuery = presetQuery.ilike('topic', `%${topicPreference}%`);
      }
      
      // Limit to tests not used recently, order by least used
      presetQuery = presetQuery.order('times_used', { ascending: true }).limit(20);
      
      const { data: allPresets, error: presetError } = await presetQuery;
      
      // Filter out presets this user has already completed
      const presets = (allPresets || []).filter(p => !completedPresetIds.has(p.id));
      
      console.log(`Found ${allPresets?.length || 0} matching presets, ${presets.length} not yet completed by user`);
      
      if (!presetError && presets && presets.length > 0) {
        // Pick a random one from the pool to add variety
        const preset = presets[Math.floor(Math.random() * presets.length)];
        console.log(`Found preset test ${preset.id} for ${module}/${difficulty}/${questionType}`);
        
        // Update usage stats
        await serviceClient
          .from('generated_test_audio')
          .update({ 
            times_used: (preset.times_used || 0) + 1,
            last_used_at: new Date().toISOString()
          })
          .eq('id', preset.id);
        
        // Build response based on module type using content_payload
        const payload = preset.content_payload || {};
        
          if (module === 'listening') {
            // Listening preset response
            const normalizeType = (raw: unknown) => String(raw ?? '').trim().toUpperCase();

            const buildGroup = (g: any, fallbackType: string) => {
              const type = normalizeType(g?.question_type || fallbackType || questionType);
              const qsRaw: any[] = Array.isArray(g?.questions)
                ? g.questions
                : Array.isArray(payload.questions)
                  ? payload.questions
                  : [];

              // -----------------------------------------------------------------
              // Options normalization (critical for DRAG_AND_DROP_OPTIONS presets)
              // -----------------------------------------------------------------
              const parseArrayish = (raw: any): string[] => {
                if (!raw) return [];
                if (Array.isArray(raw)) return raw;
                if (typeof raw === 'object' && Array.isArray(raw.options)) return raw.options;
                if (typeof raw === 'string') {
                  try {
                    const parsed = JSON.parse(raw);
                    return parseArrayish(parsed);
                  } catch {
                    return [];
                  }
                }
                return [];
              };

              const norm = (s: string) => String(s ?? '').trim().toLowerCase();
              const isLetterId = (s: string) => /^[A-Z]$/.test(String(s ?? '').trim());
              const toLabel = (idx: number) => String.fromCharCode(65 + idx);

              // Start with whatever is stored on the group, then fall back to root payload.
              // NOTE: DRAG_AND_DROP_OPTIONS presets store options under `drag_options`.
              let groupOptions: any = g?.options ?? payload.options ?? payload.groupOptions ?? {};

              // Prefer drag_options for DRAG_AND_DROP_OPTIONS
              if (type === 'DRAG_AND_DROP_OPTIONS') {
                const candidate =
                  g?.options?.drag_options ??
                  g?.drag_options ??
                  payload.drag_options ??
                  payload.dragOptions ??
                  g?.options ??
                  payload.options ??
                  payload.groupOptions;

                let options = parseArrayish(candidate)
                  .filter((x: any): x is string => typeof x === 'string')
                  .map((s: string) => s.trim())
                  .filter(Boolean);

                // If options are missing, bootstrap from correct answers (text form)
                const rawCorrectTexts = (qsRaw || [])
                  .map((q: any) => String(q?.correct_answer ?? q?.correctAnswer ?? '').trim())
                  .filter((a: string) => a && !isLetterId(a));

                if (options.length === 0 && rawCorrectTexts.length > 0) {
                  options = Array.from(new Set(rawCorrectTexts));
                }

                // Ensure all text correct answers exist in options
                for (const ca of rawCorrectTexts) {
                  if (!options.some((o) => norm(o) === norm(ca))) options.push(ca);
                }

                // Ensure there are MORE options than questions (add distractors)
                const qCount = Math.max(0, qsRaw?.length || 0);
                const requiredTotal = Math.max(qCount + 2, qCount + 1); // must be > qCount

                // Generate SMART context-aware distractors based on answer types
                // Analyze what types of answers we have to generate matching distractors
                const answerTypes = {
                  hasNames: false,
                  hasDates: false,
                  hasTimes: false,
                  hasPlaces: false,
                  hasNumbers: false,
                };
                
                for (const ca of rawCorrectTexts) {
                  if (/\b(january|february|march|april|may|june|july|august|september|october|november|december|\d{1,2}(?:st|nd|rd|th)?)\b/i.test(ca)) {
                    answerTypes.hasDates = true;
                  }
                  if (/\b\d{1,2}(?::\d{2})?\s*(?:am|pm|AM|PM)\b/.test(ca) || /\b\d{1,2}\s*o'clock\b/i.test(ca)) {
                    answerTypes.hasTimes = true;
                  }
                  if (/\b(park|street|road|avenue|center|centre|hall|building|room|entrance|library|museum|cafe|restaurant|hotel|pavilion)\b/i.test(ca)) {
                    answerTypes.hasPlaces = true;
                  }
                  if (/^[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?$/.test(ca) && ca.length < 25) {
                    answerTypes.hasNames = true;
                  }
                  if (/^\d+$/.test(ca) || /^\$?\d+(?:,\d{3})*(?:\.\d{2})?$/.test(ca)) {
                    answerTypes.hasNumbers = true;
                  }
                }

                // Context-aware distractor pools - plausible but wrong
                const distractorPools = {
                  names: ['Michael Brown', 'Jennifer White', 'Robert Davis', 'Amanda Wilson', 'Thomas Clark'],
                  dates: ['March 15th', 'June 22nd', 'November 8th', 'August 3rd', 'February 14th'],
                  times: ['9 AM', '11 AM', '2 PM', '4 PM', '6:30 PM'],
                  places: ['Main Hall', 'Conference Room', 'Reception Area', 'West Wing', 'Garden Terrace'],
                  numbers: ['15', '250', '1500', '45', '120'],
                  generic: ['registration desk', 'information center', 'main office', 'front entrance', 'parking area'],
                };

                const pushIfGood = (t: string) => {
                  const s = t.trim();
                  if (!s) return;
                  if (options.some((o) => norm(o) === norm(s))) return;
                  options.push(s);
                };

                const addDistractors = (pool: string[]) => {
                  for (const d of pool) {
                    if (options.length >= requiredTotal) return;
                    pushIfGood(d);
                  }
                };

                // Add type-appropriate distractors
                if (answerTypes.hasNames) addDistractors(distractorPools.names);
                if (answerTypes.hasDates) addDistractors(distractorPools.dates);
                if (answerTypes.hasTimes) addDistractors(distractorPools.times);
                if (answerTypes.hasPlaces) addDistractors(distractorPools.places);
                if (answerTypes.hasNumbers) addDistractors(distractorPools.numbers);
                
                // Final fallback with generic but plausible options
                addDistractors(distractorPools.generic);

                // Normalize to ListeningQuestions expectations
                groupOptions = {
                  ...(typeof groupOptions === 'object' && !Array.isArray(groupOptions) ? groupOptions : {}),
                  type,
                  options,
                  option_format: (g?.options?.option_format || payload.option_format || 'A') as string,
                };
              } else if (
                Array.isArray(groupOptions) &&
                [
                  'MATCHING_CORRECT_LETTER',
                  'MAPS',
                  'MAP_LABELING',
                  'MULTIPLE_CHOICE_MULTIPLE',
                  'DRAG_AND_DROP_OPTIONS',
                  'FLOWCHART_COMPLETION',
                  'TABLE_COMPLETION',
                ].includes(type)
              ) {
                groupOptions = { type, options: groupOptions, option_format: 'A' };
              }

              // Ensure bulk/admin presets for TABLE_COMPLETION carry table_data into group options
              // The bulk-generate-tests prompt outputs table_data at the root level of the payload
              // or inside groupOptions.table_data - need to check both locations
              if (type === 'TABLE_COMPLETION') {
                const tableDataSource = g?.options?.table_data || payload.table_data || g?.table_data;
                if (tableDataSource) {
                  if (Array.isArray(groupOptions)) {
                    groupOptions = { options: groupOptions };
                  }
                  if (!groupOptions || typeof groupOptions !== 'object') {
                    groupOptions = {};
                  }
                  if (!groupOptions.table_data) {
                    groupOptions = { ...groupOptions, table_data: tableDataSource };
                  }
                }
              }

              let questions = qsRaw.map((q: any, idx: number) => {
                const qType = normalizeType(q?.question_type || type);
                return {
                  id: q?.id || crypto.randomUUID(),
                  question_number: q?.question_number ?? idx + (g?.start_question ?? 1),
                  question_type: qType,
                  question_text: q?.question_text ?? q?.text ?? '',
                  correct_answer: q?.correct_answer ?? q?.correctAnswer ?? '',
                  explanation: q?.explanation ?? '',
                  heading: q?.heading ?? null,
                  options: Array.isArray(q?.options)
                    ? q.options
                    : Array.isArray(q?.options?.options)
                      ? q.options.options
                      : null,
                  option_format: q?.option_format ?? groupOptions?.option_format ?? 'A',
                  table_data: q?.table_data ?? groupOptions?.table_data ?? null,
                };
              });

              // For drag-and-drop presets: convert text correct_answer -> letter ID (A, B, C...)
              if (type === 'DRAG_AND_DROP_OPTIONS') {
                const opts: string[] = Array.isArray(groupOptions?.options) ? groupOptions.options : [];
                const normOpts = opts.map(norm);

                questions = questions.map((q: any) => {
                  const caRaw = String(q.correct_answer ?? '').trim();
                  if (!caRaw) return q;
                  if (isLetterId(caRaw)) return q;

                  let idx = normOpts.indexOf(norm(caRaw));
                  if (idx === -1) {
                    // Ensure the correct answer is included as an option
                    opts.push(caRaw);
                    normOpts.push(norm(caRaw));
                    idx = opts.length - 1;
                    // keep groupOptions in sync
                    groupOptions = { ...groupOptions, options: opts };
                  }

                  return { ...q, correct_answer: toLabel(idx) };
                });
              }

              return {
                id: g?.id || crypto.randomUUID(),
                instruction: g?.instruction || payload.instruction || 'Complete the questions below.',
                question_type: type,
                start_question: g?.start_question ?? 1,
                end_question: g?.end_question ?? (g?.start_question ?? 1) + Math.max(0, questions.length - 1),
                options: groupOptions,
                questions,
              };
            };

            const topLevelType = normalizeType(preset.question_type || questionType);
            const groups = Array.isArray(payload.questionGroups) && payload.questionGroups.length > 0
              ? payload.questionGroups.map((g: any) => buildGroup(g, topLevelType))
              : [buildGroup({ questions: payload.questions, options: payload.options }, topLevelType)];

            // IMPORTANT: ai_practice_tests.id is a UUID, so preset runs must also use a UUID testId (not "preset-...")
            const presetRunTestId = crypto.randomUUID();
            
            const responsePayload = {
              testId: presetRunTestId,
              topic: preset.topic,
              transcript: preset.transcript || payload.dialogue || payload.transcript,
              speakerNames: payload.speaker_names || payload.speakerNames,
              audioUrl: preset.audio_url, // Pre-generated audio URL
              audioBase64: null, // Not needed - using URL
              audioFormat: 'wav',
              sampleRate: 24000,
              questionGroups: groups,
              isPreset: true,
              presetId: preset.id,
            };
          
          console.log(`Serving listening preset: ${preset.topic}`);
          return new Response(JSON.stringify(responsePayload), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        } else if (module === 'speaking') {
          // Speaking preset response - transform part1/part2/part3 structure to speakingParts array
          const speakingParts: any[] = [];
          
          // Helper to transform part data
          const transformPart = (partData: any, partNum: number) => {
            if (!partData) return null;
            
            // Questions could be array of strings or array of objects
            // CRITICAL FIX: Enforce Part 3 to have exactly 4 questions max (truncate legacy 5-question presets)
            let rawQuestions = Array.isArray(partData.questions) ? partData.questions : [];
            if (partNum === 3) {
              rawQuestions = rawQuestions.slice(0, 4); // Enforce max 4 questions for Part 3
            }
            
            const questions = rawQuestions.map((q: any, qIndex: number) => ({
                  id: crypto.randomUUID(),
                  question_number: qIndex + 1,
                  question_text: typeof q === 'string' ? q : (q.question_text || q),
                  sample_answer: typeof q === 'object' ? q.sample_answer : undefined,
                }));
            
            // Sample answers could be separate array (also enforce max 4 for Part 3)
            let sampleAnswers = Array.isArray(partData.sample_answers) ? partData.sample_answers : [];
            if (partNum === 3) {
              sampleAnswers = sampleAnswers.slice(0, 4);
            }
            if (sampleAnswers.length > 0) {
              sampleAnswers.forEach((answer: string, idx: number) => {
                if (questions[idx]) {
                  questions[idx].sample_answer = answer;
                }
              });
            }
            
            return {
              id: crypto.randomUUID(),
              part_number: partNum,
              instruction: partData.instruction || '',
              questions,
              cue_card_topic: partData.cue_card_topic,
              cue_card_content: partData.cue_card_content,
              preparation_time_seconds: partData.preparation_time_seconds || (partNum === 2 ? 60 : undefined),
              speaking_time_seconds: partData.speaking_time_seconds || (partNum === 2 ? 120 : undefined),
              time_limit_seconds: partData.time_limit_seconds || (partNum === 1 || partNum === 3 ? 300 : undefined),
            };
          };
          
          // Check for part1/part2/part3 structure
          if (payload.part1) {
            const part = transformPart(payload.part1, 1);
            if (part) speakingParts.push(part);
          }
          if (payload.part2) {
            const part = transformPart(payload.part2, 2);
            if (part) speakingParts.push(part);
          }
          if (payload.part3) {
            const part = transformPart(payload.part3, 3);
            if (part) speakingParts.push(part);
          }
          
          // Fallback to parts array or speakingParts if already in correct format
          if (speakingParts.length === 0 && payload.parts) {
            payload.parts.forEach((p: any, pIndex: number) => {
              const part = transformPart(p, p.part_number || pIndex + 1);
              if (part) speakingParts.push(part);
            });
          }
          if (speakingParts.length === 0 && payload.speakingParts) {
            speakingParts.push(...payload.speakingParts);
          }
          
          // IMPORTANT: ai_practice_tests.id is a UUID, so preset runs must also use a UUID testId (not "preset-...")
          const presetRunTestId = crypto.randomUUID();
          
          // CRITICAL FIX: Filter out extra Part 3 audio URLs (legacy presets may have part3_q5)
          let filteredAudioUrls = payload.audioUrls;
          if (filteredAudioUrls && typeof filteredAudioUrls === 'object') {
            const filtered: Record<string, string> = {};
            for (const [key, url] of Object.entries(filteredAudioUrls)) {
              // Exclude part3_q5, part3_q6, etc. - only allow part3_q1 through part3_q4
              const part3Match = key.match(/^part3_q(\d+)$/);
              if (part3Match) {
                const qNum = parseInt(part3Match[1], 10);
                if (qNum > 4) {
                  console.log(`Filtering out legacy Part 3 audio: ${key}`);
                  continue; // Skip part3_q5 and beyond
                }
              }
              filtered[key] = url as string;
            }
            filteredAudioUrls = filtered;
          }
          
          const responsePayload = {
            testId: presetRunTestId,
            topic: preset.topic,
            speakingParts,
            audioUrls: filteredAudioUrls, // Pre-generated TTS audio URLs (filtered to max 4 Part 3 questions)
            isPreset: true,
            presetId: preset.id,
          };
          
          console.log(`Serving speaking preset: ${preset.topic}, parts: ${speakingParts.length}`);
          return new Response(JSON.stringify(responsePayload), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        } else if (module === 'reading') {
          // Reading preset response
          const normalizeType = (raw: unknown) => String(raw ?? '').trim().toUpperCase();

          const normalizePassage = (raw: any) => {
            // Bulk/admin presets often store {title, content} without an id.
            // The test-taker renderer relies on passage.id to attach questions to the passage.
            const content =
              typeof raw === 'string'
                ? raw
                : typeof raw?.content === 'string'
                  ? raw.content
                  : typeof payload?.passageContent === 'string'
                    ? payload.passageContent
                    : '';

            const title =
              typeof raw === 'object' && typeof raw?.title === 'string'
                ? raw.title
                : typeof payload?.title === 'string'
                  ? payload.title
                  : preset.topic;

            const id = typeof raw === 'object' && typeof raw?.id === 'string' && raw.id.trim()
              ? raw.id
              : crypto.randomUUID();

            return {
              id,
              title,
              content,
              passage_number: 1,
            };
          };

          const buildGroup = (g: any, fallbackType: string) => {
            const type = normalizeType(g?.question_type || fallbackType || questionType);
            const qsRaw: any[] = Array.isArray(g?.questions)
              ? g.questions
              : Array.isArray(payload.questions)
                ? payload.questions
                : [];

            let groupOptions: any = g?.options ?? payload.options ?? {};

            // Ensure bulk/admin presets for MATCHING_HEADINGS carry headings into group options
            // so the reading renderer can display the heading bank.
            if (type === 'MATCHING_HEADINGS' && Array.isArray(payload.headings)) {
              if (Array.isArray(groupOptions)) {
                groupOptions = { options: groupOptions };
              }
              if (!groupOptions || typeof groupOptions !== 'object') {
                groupOptions = {};
              }
              if (!Array.isArray(groupOptions.headings)) {
                groupOptions = { ...groupOptions, headings: payload.headings };
              }
            }

            // Ensure bulk/admin presets for TABLE_COMPLETION carry table_data into group options
            // The bulk-generate-tests prompt outputs table_data at the root level of the payload.
            if (type === 'TABLE_COMPLETION' && Array.isArray(payload.table_data)) {
              if (Array.isArray(groupOptions)) {
                groupOptions = { options: groupOptions };
              }
              if (!groupOptions || typeof groupOptions !== 'object') {
                groupOptions = {};
              }
              if (!groupOptions.table_data) {
                groupOptions = { ...groupOptions, table_data: payload.table_data };
              }
            }

            // For MULTIPLE_CHOICE_MULTIPLE: Extract max_answers from first question and propagate to group options
            // This ensures the renderer shows correct "Select X answers" instruction
            if (type === 'MULTIPLE_CHOICE_MULTIPLE') {
              // Ensure groupOptions is an object
              if (Array.isArray(groupOptions)) {
                groupOptions = { options: groupOptions };
              }
              if (!groupOptions || typeof groupOptions !== 'object') {
                groupOptions = {};
              }
              
              // Get max_answers from first question, group options, or infer from question text
              const firstQ = qsRaw[0];
              const explicitMax = firstQ?.max_answers ?? g?.max_answers ?? groupOptions?.max_answers ?? payload?.max_answers;
              
              // Get options from first question or group
              const extractedOptions = firstQ?.options ?? g?.options ?? groupOptions?.options ?? payload?.options;
              
              // Normalize options to array
              let normalizedOptions: string[] = [];
              if (Array.isArray(extractedOptions)) {
                normalizedOptions = extractedOptions;
              } else if (extractedOptions?.options && Array.isArray(extractedOptions.options)) {
                normalizedOptions = extractedOptions.options;
              }
              
              // IMPORTANT: For MCMA, options MUST be set on groupOptions for the renderer
              if (normalizedOptions.length > 0) {
                groupOptions = { ...groupOptions, options: normalizedOptions };
              }
              
              if (explicitMax) {
                groupOptions = { ...groupOptions, max_answers: explicitMax };
              } else if (firstQ?.question_text) {
                // Infer from question text (e.g., "Which THREE statements...")
                const text = firstQ.question_text;
                const match = text.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten|\d+)\b\s+(?:statements|answers|options|letters?|of the following)\b/i)
                  || text.match(/\bwhich\s+(one|two|three|four|five|six|seven|eight|nine|ten|\d+)\b/i)
                  || text.match(/choose\s+(one|two|three|four|five|six|seven|eight|nine|ten|\d+)/i);
                if (match) {
                  const raw = match[1].toLowerCase();
                  const wordMap: Record<string, number> = {
                    one: 1, two: 2, three: 3, four: 4, five: 5,
                    six: 6, seven: 7, eight: 8, nine: 9, ten: 10
                  };
                  const inferred = wordMap[raw] ?? parseInt(raw, 10);
                  if (inferred > 0) {
                    groupOptions = { ...groupOptions, max_answers: inferred };
                  }
                }
              }
              
              // Default to 3 if still not set (standard MCMA is Choose THREE)
              if (!groupOptions.max_answers) {
                groupOptions = { ...groupOptions, max_answers: 3 };
              }

              // For MCMA, also copy options to each question for the renderer
              console.log(`[MCMA Preset] max_answers: ${groupOptions.max_answers}, options count: ${normalizedOptions.length}`);
            }

            // Summary completion (word bank) presets: normalize summary_text + word_bank into group options
            // so the test-taker renderer can show the paragraph + draggable word bank.
            if (type === 'SUMMARY_COMPLETION' || type === 'SUMMARY_WORD_BANK') {
              if (Array.isArray(groupOptions)) {
                groupOptions = { options: groupOptions };
              }
              if (!groupOptions || typeof groupOptions !== 'object') {
                groupOptions = {};
              }

              const summaryTextRaw =
                g?.summary_text ??
                g?.summaryText ??
                (g?.options && typeof g.options === 'object'
                  ? (g.options.summary_text ?? g.options.summaryText ?? g.options.content)
                  : undefined) ??
                payload?.summary_text ??
                payload?.summaryText ??
                payload?.content ??
                payload?.summary ??
                payload?.paragraph_text ??
                '';

              const wordBankRaw =
                g?.word_bank ??
                g?.wordBank ??
                (g?.options && typeof g.options === 'object'
                  ? (g.options.word_bank ?? g.options.wordBank)
                  : undefined) ??
                payload?.word_bank ??
                payload?.wordBank ??
                [];

              const normalizeWordBank = (raw: any): Array<{ id: string; text: string }> => {
                if (!Array.isArray(raw)) return [];

                // Only treat a leading A–H as a label when it's followed by a real separator.
                // This prevents corrupting normal words that start with A–H (e.g., "expression").
                const parseLabeled = (value: string) => {
                  const trimmed = value.trim();
                  return trimmed.match(/^([A-H])(?:[\,\)\.\:]\s*|\s+)(.+)$/i);
                };

                return raw
                  .map((item: any, idx: number) => {
                    if (typeof item === 'string') {
                      const trimmed = item.trim();
                      const m = parseLabeled(trimmed);
                      const id = (m?.[1] ?? String.fromCharCode(65 + idx)).toUpperCase();
                      const text = (m?.[2] ?? trimmed).trim();
                      return { id, text };
                    }

                    if (item && typeof item === 'object') {
                      const rawId = String(item.id ?? item.letter ?? '').trim();
                      const fallbackId = String.fromCharCode(65 + idx);
                      const idFromField = rawId || fallbackId;

                      const rawText = String(item.text ?? item.label ?? item.option ?? '').trim();
                      const m = parseLabeled(rawText);
                      const text = (m?.[2] ?? rawText).trim();

                      const idFromText = m?.[1] ? m[1].toUpperCase() : null;
                      const finalId = idFromText ?? (idFromField.length === 1 ? idFromField.toUpperCase() : idFromField);

                      return { id: finalId, text };
                    }

                    return null;
                  })
                  .filter(Boolean) as Array<{ id: string; text: string }>;
              };

              const normalizedBank = normalizeWordBank(wordBankRaw);

              if (String(summaryTextRaw || '').trim() && normalizedBank.length > 0) {
                groupOptions = {
                  ...groupOptions,
                  summary_text: String(summaryTextRaw || ''),
                  word_bank: normalizedBank,
                };
              }
            }

            const questions = qsRaw.map((q: any, idx: number) => {
              const qType = normalizeType(q?.question_type || type);
              
              // For MCMA: Ensure each question has the shared options from group
              let qOptions = Array.isArray(q?.options)
                ? q.options
                : Array.isArray(q?.options?.options)
                  ? q.options.options
                  : null;
              
              // For MCMA, inherit options from groupOptions if question doesn't have its own
              if (type === 'MULTIPLE_CHOICE_MULTIPLE' && !qOptions && groupOptions?.options) {
                qOptions = groupOptions.options;
              }
              
              return {
                id: q?.id || crypto.randomUUID(),
                question_number: q?.question_number ?? idx + (g?.start_question ?? 1),
                question_type: qType,
                question_text: q?.question_text ?? q?.text ?? '',
                correct_answer: q?.correct_answer ?? q?.correctAnswer ?? '',
                explanation: q?.explanation ?? '',
                options: qOptions,
                option_format: q?.option_format ?? groupOptions?.option_format ?? 'A',
                heading: q?.heading ?? null,
                table_data: q?.table_data ?? groupOptions?.table_data ?? null,
                max_answers: type === 'MULTIPLE_CHOICE_MULTIPLE' ? (q?.max_answers ?? groupOptions?.max_answers ?? 3) : undefined,
              };
            });

            return {
              id: g?.id || crypto.randomUUID(),
              instruction: g?.instruction || payload.instruction || 'Answer the questions below.',
              question_type: type,
              start_question: g?.start_question ?? 1,
              end_question: g?.end_question ?? (g?.start_question ?? 1) + Math.max(0, questions.length - 1),
              options: groupOptions,
              questions,
            };
          };

          const topLevelType = normalizeType(preset.question_type || questionType);
          const groups = Array.isArray(payload.questionGroups) && payload.questionGroups.length > 0
            ? payload.questionGroups.map((g: any) => buildGroup(g, topLevelType))
            : [buildGroup({ questions: payload.questions, options: payload.options }, topLevelType)];

          // IMPORTANT: ai_practice_tests.id is a UUID, so preset runs must also use a UUID testId (not "preset-...")
          const presetRunTestId = crypto.randomUUID();
          
          const responsePayload = {
            testId: presetRunTestId,
            topic: preset.topic,
            passage: normalizePassage(payload.passage),
            questionGroups: groups,
            isPreset: true,
            presetId: preset.id,
          };
          
          console.log(`Serving reading preset: ${preset.topic}`);
          return new Response(JSON.stringify(responsePayload), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        } else if (module === 'writing') {
          // Writing preset response
          // IMPORTANT: ai_practice_tests.id is a UUID, so preset runs must also use a UUID testId (not "preset-...")
          const presetRunTestId = crypto.randomUUID();
          
          const responsePayload = {
            testId: presetRunTestId,
            topic: preset.topic,
            writingTask: payload.writingTask || payload,
            isPreset: true,
            presetId: preset.id,
          };
          
          console.log(`Serving writing preset: ${preset.topic}`);
          return new Response(JSON.stringify(responsePayload), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      } else {
        console.log(`No preset found for ${module}/${difficulty}/${questionType}, proceeding with fresh generation`);
      }
    } catch (presetError) {
      console.error('Preset lookup failed, continuing with generation:', presetError);
      // Continue to normal generation
    }

    // ============ FRESH GENERATION (if no preset found) ============

    // Pre-flight validation
    const preflightResult = await preflightApiCheck(geminiApiKey, skipPreflight === true);
    if (!preflightResult.ok) {
      return new Response(JSON.stringify({ 
        error: preflightResult.error,
        errorType: 'API_ERROR',
        preflightFailed: true
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (module === 'reading') {
      const readingPrompt = getReadingPrompt(questionType, topic, difficulty, questionCount, readingConfig);
      const result = await callGemini(geminiApiKey, readingPrompt, 2, { dbKeys: dbApiKeys, serviceClient });
      
      let totalTokensUsed = getLastTokensUsed();
      
      if (!result) {
        // Refund credits on AI failure
        if (creditsReserved) {
          await refundCredits(serviceClient, user.id, currentOperationType);
        }
        if (wasQuotaExceeded()) {
          return new Response(JSON.stringify({ 
            error: getLastGeminiError(),
            errorType: 'QUOTA_EXCEEDED'
          }), {
            status: 429,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ error: getLastGeminiError() }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      
      await updateQuotaTracking(serviceClient, user.id, totalTokensUsed);

      let parsed;
      try {
        const jsonStr = extractJsonFromResponse(result);
        parsed = JSON.parse(jsonStr);
        
        // Validate required fields
        if (!parsed.passage || !parsed.passage.content) {
          throw new Error('Missing passage content in AI response');
        }
        if (!Array.isArray(parsed.questions) || parsed.questions.length === 0) {
          throw new Error('Missing or empty questions array in AI response');
        }
        // Validate each question has required fields
        for (const q of parsed.questions) {
          if (!q.correct_answer) {
            throw new Error(`Question ${q.question_number || '?'} missing correct_answer`);
          }
        }
      } catch (e) {
        console.error("Failed to parse/validate Gemini response:", e);
        // Refund credits on parse failure
        if (creditsReserved) {
          await refundCredits(serviceClient, user.id, currentOperationType);
        }
        return new Response(JSON.stringify({ 
          error: 'AI returned invalid content. Please try again.',
          errorType: 'PARSE_ERROR',
          details: e instanceof Error ? e.message : String(e)
        }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const groupId = crypto.randomUUID();
      const passageId = crypto.randomUUID();

      let groupOptions: any = undefined;
      if (questionType === 'MATCHING_HEADINGS' && parsed.headings) {
        groupOptions = { headings: parsed.headings };
      } else if (questionType === 'MATCHING_INFORMATION' && parsed.options) {
        groupOptions = { options: parsed.options };
      } else if (questionType === 'MULTIPLE_CHOICE_MULTIPLE' && parsed.questions?.[0]?.options) {
        // MCMA: Include options and max_answers in groupOptions for the renderer
        const mcmaOptions = parsed.questions[0].options;
        const mcmaMaxAnswers = parsed.max_answers ?? parsed.questions[0]?.max_answers ?? 3;
        groupOptions = { 
          options: mcmaOptions, 
          max_answers: mcmaMaxAnswers,
          option_format: 'A'
        };
      } else if (questionType.includes('MULTIPLE_CHOICE') && parsed.questions?.[0]?.options) {
        groupOptions = { options: parsed.questions[0].options };
      } else if ((questionType === 'SUMMARY_COMPLETION' || questionType === 'SUMMARY_WORD_BANK') && (parsed.summary_text || parsed.word_bank)) {
        // Summary completion needs summary_text and word_bank in options for renderer
        groupOptions = { 
          summary_text: parsed.summary_text || '',
          word_bank: parsed.word_bank || [],
        };
      } else if (questionType === 'MATCHING_SENTENCE_ENDINGS' && (parsed.sentence_endings || parsed.sentence_beginnings)) {
        // Matching sentence endings needs sentence_endings array for drag/drop
        groupOptions = { 
          sentence_beginnings: parsed.sentence_beginnings || [],
          sentence_endings: parsed.sentence_endings || [],
        };
      } else if (questionType === 'TABLE_COMPLETION' && parsed.table_data) {
        groupOptions = { table_data: parsed.table_data };
      } else if (questionType === 'FLOWCHART_COMPLETION' && (parsed.flowchart_title || parsed.flowchart_steps)) {
        groupOptions = { 
          flowchart_title: parsed.flowchart_title || '',
          flowchart_steps: parsed.flowchart_steps || [],
        };
      } else if (questionType === 'MAP_LABELING' && parsed.map_labels) {
        groupOptions = {
          map_description: parsed.map_description || '',
          map_type: parsed.map_type || 'floor_plan',
          map_labels: parsed.map_labels || [],
          landmarks: parsed.landmarks || [],
        };
      } else if (questionType === 'NOTE_COMPLETION' && parsed.note_sections) {
        groupOptions = { note_sections: parsed.note_sections };
      }

      const questions = (parsed.questions || []).map((q: any, i: number) => ({
        id: crypto.randomUUID(),
        question_number: q.question_number || i + 1,
        question_text: q.question_text,
        correct_answer: q.correct_answer,
        explanation: q.explanation,
        options: q.options || null,
        heading: q.heading || null,
        max_answers: questionType === 'MULTIPLE_CHOICE_MULTIPLE' ? (q.max_answers ?? 3) : undefined,
      }));

      // For MCMA, ensure we have exactly 3 questions and end_question is 3
      const endQuestion = questionType === 'MULTIPLE_CHOICE_MULTIPLE' ? 3 : questions.length;

      const responsePayload = {
        testId,
        topic,
        passage: {
          id: passageId,
          title: parsed.passage?.title || 'Reading Passage',
          content: parsed.passage?.content || '',
        },
        questionGroups: [{
          id: groupId,
          instruction: parsed.instruction || `Questions 1-${endQuestion}`,
          question_type: questionType,
          start_question: 1,
          end_question: endQuestion,
          options: groupOptions,
          questions,
        }],
      };

      // Save to test bank if requested
      if (save_to_bank) {
        await saveToTestBank(serviceClient, 'reading', topic, responsePayload);
      }

      // Credits already reserved atomically before AI call - no deduction needed

      return new Response(JSON.stringify(responsePayload), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });

    } else if (module === 'listening') {
      const scenario = LISTENING_SCENARIOS[Math.floor(Math.random() * LISTENING_SCENARIOS.length)];
      const listeningPrompt = getListeningPrompt(questionType, topic, difficulty, LISTENING_QUESTION_COUNT, scenario, listeningConfig);
      
      const result = await callGemini(geminiApiKey, listeningPrompt, 2, { dbKeys: dbApiKeys, serviceClient });
      let totalTokensUsed = getLastTokensUsed();
      
      if (!result) {
        // Refund credits on AI failure
        if (creditsReserved) {
          await refundCredits(serviceClient, user.id, currentOperationType);
        }
        if (wasQuotaExceeded()) {
          return new Response(JSON.stringify({ 
            error: getLastGeminiError(),
            errorType: 'QUOTA_EXCEEDED'
          }), {
            status: 429,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ error: getLastGeminiError() }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      let parsed;
      try {
        const jsonStr = extractJsonFromResponse(result);
        parsed = JSON.parse(jsonStr);
        
        // Validate required fields
        if (!parsed.dialogue || typeof parsed.dialogue !== 'string' || parsed.dialogue.trim().length < 50) {
          throw new Error('Missing or too short dialogue in AI response');
        }
        if (!Array.isArray(parsed.questions) || parsed.questions.length === 0) {
          throw new Error('Missing or empty questions array in AI response');
        }
        if (!parsed.instruction || typeof parsed.instruction !== 'string') {
          throw new Error('Missing instruction in AI response');
        }
        // Validate each question has required fields
        for (const q of parsed.questions) {
          if (!q.correct_answer) {
            throw new Error(`Question ${q.question_number || '?'} missing correct_answer`);
          }
        }
        
        // MCMA-specific validation: must have options with at least 5 choices
        if (questionType === 'MULTIPLE_CHOICE_MULTIPLE') {
          const firstQ = parsed.questions[0];
          if (!firstQ?.options || !Array.isArray(firstQ.options) || firstQ.options.length < 5) {
            throw new Error('MULTIPLE_CHOICE_MULTIPLE requires at least 5 options (A-E or A-F). AI returned invalid or missing options.');
          }
          // Ensure we have 3 questions for MCMA
          if (parsed.questions.length < 3) {
            throw new Error('MULTIPLE_CHOICE_MULTIPLE requires exactly 3 question objects. AI returned fewer.');
          }
        }
      } catch (e) {
        console.error("Failed to parse/validate listening response:", e);
        // Refund credits on parse failure
        if (creditsReserved) {
          await refundCredits(serviceClient, user.id, currentOperationType);
        }
        return new Response(JSON.stringify({ 
          error: 'AI returned invalid content. Please try again.',
          errorType: 'PARSE_ERROR',
          details: e instanceof Error ? e.message : String(e)
        }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Generate TTS audio
      const useTwoSpeakers = listeningConfig?.speakerConfig?.useTwoSpeakers !== false;
      const audio = await generateAudio(geminiApiKey, parsed.dialogue, listeningConfig?.speakerConfig, 3, { dbKeys: dbApiKeys, serviceClient });
      
      await updateQuotaTracking(serviceClient, user.id, totalTokensUsed);

      // === PROPER MONOLOGUE REGENERATION: If TTS failed, regenerate as true monologue ===
      let finalTranscript = parsed.dialogue;
      let speakerNames = parsed.speaker_names || {};
      
      if (!audio && parsed.dialogue && useTwoSpeakers) {
        console.log('[Monologue Regeneration] TTS failed for dialogue, regenerating as proper monologue...');
        try {
          // REGENERATE as a proper monologue - not just passive voice conversion
          const monologueRegenerationPrompt = `You need to create a COMPLETELY NEW IELTS Listening monologue script.

CONTEXT: The original dialogue about "${topic}" failed audio generation. 
You must create a natural, engaging MONOLOGUE that covers the SAME TOPIC and contains answers to these questions:

QUESTIONS TO ANSWER IN THE MONOLOGUE:
${parsed.questions.map((q: any) => `- Q${q.question_number}: Answer must be "${q.correct_answer}"`).join('\n')}

REQUIREMENTS:
1. Write as a SINGLE SPEAKER (narrator, tour guide, lecturer, or announcer)
2. Use "Speaker1:" prefix for ALL lines (required for TTS)
3. Make it sound NATURAL - like a real lecture, tour, or announcement
4. Include ALL the correct answers naturally woven into the speech
5. Keep it 150-200 words total
6. NO SSML tags - use plain text only
7. Include speaker_names object: {"Speaker1": "Narrator"} or similar

IMPORTANT: This is NOT a passive voice conversion. Create FRESH, NATURAL content.

Example good style:
"Speaker1: Welcome to today's session. I'm going to walk you through the key points. First, let me mention that our main office is located at Central Park Avenue. The opening hours are from 9 AM to 5 PM..."

Return ONLY valid JSON:
{
  "dialogue": "Speaker1: [Your complete monologue here...]",
  "speaker_names": {"Speaker1": "Narrator"}
}`;
          
          const monologueResult = await callGemini(geminiApiKey, monologueRegenerationPrompt, 2, { dbKeys: dbApiKeys, serviceClient });
          
          if (monologueResult) {
            try {
              const jsonStr = extractJsonFromResponse(monologueResult);
              const monologueParsed = JSON.parse(jsonStr);
              
              if (monologueParsed.dialogue && monologueParsed.dialogue.trim().length > 100) {
                console.log('[Monologue Regeneration] Successfully generated proper monologue');
                finalTranscript = monologueParsed.dialogue.trim();
                speakerNames = monologueParsed.speaker_names || { Speaker1: 'Narrator' };
              } else {
                throw new Error('Monologue too short');
              }
            } catch (parseErr) {
              // If JSON parse fails, try to use raw text
              const cleanText = monologueResult
                .replace(/<[^>]*>/g, '')
                .replace(/```json?\s*/gi, '')
                .replace(/```/g, '')
                .trim();
              
              if (cleanText.length > 100) {
                console.log('[Monologue Regeneration] Using cleaned raw text');
                finalTranscript = `Speaker1: ${cleanText.replace(/^Speaker1:\s*/i, '')}`;
                speakerNames = { Speaker1: 'Narrator' };
              }
            }
          }
          
          // Final fallback: clean up original dialogue for browser TTS
          if (finalTranscript === parsed.dialogue) {
            console.warn('[Monologue Regeneration] Falling back to cleaned original dialogue');
            finalTranscript = parsed.dialogue
              .replace(/(Speaker\s*\d+|[A-Z][a-z]+):\s*/g, '')
              .replace(/\(.*?\)/g, '')
              .replace(/<[^>]*>/g, '')
              .replace(/\s+/g, ' ')
              .trim();
            speakerNames = { Speaker1: 'Narrator' };
          }
        } catch (rescueErr) {
          console.error('[Monologue Regeneration] Failed, using cleaned original:', rescueErr);
          finalTranscript = parsed.dialogue
            .replace(/(Speaker\s*\d+|[A-Z][a-z]+):\s*/g, '')
            .replace(/\(.*?\)/g, '')
            .replace(/<[^>]*>/g, '')
            .replace(/\s+/g, ' ')
            .trim();
          speakerNames = { Speaker1: 'Narrator' };
        }
      }
      
      // Process transcript to replace Speaker1/Speaker2 with real names (for original dialogue case)
      let displayTranscript = finalTranscript;
      if (speakerNames.Speaker1) {
        displayTranscript = displayTranscript.replace(/Speaker1:/g, `${speakerNames.Speaker1}:`);
      }
      if (speakerNames.Speaker2) {
        displayTranscript = displayTranscript.replace(/Speaker2:/g, `${speakerNames.Speaker2}:`);
      }

      let groupOptions: any = undefined;
      if (questionType === 'MAP_LABELING') {
        groupOptions = {
          map_description: parsed.map_description,
          map_type: parsed.map_type || 'floor_plan',
          map_labels: parsed.map_labels, // Now includes x,y coordinates
          landmarks: parsed.landmarks || [],
        };
      } else if (questionType === 'TABLE_COMPLETION') {
        groupOptions = { table_data: parsed.table_data };
      } else if (questionType === 'FLOWCHART_COMPLETION') {
        groupOptions = { 
          flowchart_title: parsed.flowchart_title,
          flowchart_steps: parsed.flowchart_steps,
        };
      } else if (questionType === 'NOTE_COMPLETION' && parsed.note_sections) {
        groupOptions = { note_sections: parsed.note_sections };
      } else if (questionType === 'DRAG_AND_DROP_OPTIONS' || questionType === 'MATCHING_CORRECT_LETTER') {
        // UNIFIED handling for drag-and-drop question types
        // Robustly ensure drag-and-drop options always exist and are MORE than the number of questions.
        const isLetterId = (s: string) => /^[A-Z]$/.test((s ?? '').trim().toUpperCase());
        const norm = (s: string) => (s ?? '').trim().toLowerCase();
        const labelOf = (idx: number) => String.fromCharCode(65 + idx);

        const qList = Array.isArray(parsed.questions) ? parsed.questions : [];
        const qCount = qList.length;
        const numDistractors = Math.min(3, Math.max(2, Math.ceil(Math.max(1, qCount) * 0.4)));
        const requiredTotalOptions = Math.max(0, qCount + numDistractors);

        // Accept multiple possible keys from model output
        let options: string[] = [];
        if (Array.isArray(parsed.drag_options)) options = parsed.drag_options;
        else if (Array.isArray(parsed.options)) {
          // Handle both string[] and {letter, text}[] formats
          options = parsed.options.map((o: any) => 
            typeof o === 'string' ? o : (o?.text ?? o?.label ?? '')
          );
        }

        options = options
          .filter((x: any): x is string => typeof x === 'string')
          .map((s: string) => s.trim())
          .filter(Boolean);

        // If model forgot options, start from the question correct answers (text form)
        const correctRaw = qList
          .map((q: any) => String(q?.correct_answer ?? '').trim())
          .filter(Boolean);

        const correctTexts = correctRaw.filter((a: string) => !isLetterId(a));
        if (options.length === 0 && correctTexts.length) {
          options = Array.from(new Set(correctTexts));
        }

        // Ensure every text correct answer is present in options
        for (const ca of correctTexts) {
          if (!options.some((o: string) => norm(o) === norm(ca))) options.push(ca);
        }

        // Generate SMART context-aware distractors based on answer types
        // Analyze what types of answers we have to generate matching distractors
        const answerTypes = {
          hasNames: false,
          hasDates: false,
          hasTimes: false,
          hasPlaces: false,
          hasNumbers: false,
        };
        
        for (const ca of correctTexts) {
          if (/\b(january|february|march|april|may|june|july|august|september|october|november|december|\d{1,2}(?:st|nd|rd|th)?)\b/i.test(ca)) {
            answerTypes.hasDates = true;
          }
          if (/\b\d{1,2}(?::\d{2})?\s*(?:am|pm|AM|PM)\b/.test(ca) || /\b\d{1,2}\s*o'clock\b/i.test(ca)) {
            answerTypes.hasTimes = true;
          }
          if (/\b(park|street|road|avenue|center|centre|hall|building|room|entrance|library|museum|cafe|restaurant|hotel)\b/i.test(ca)) {
            answerTypes.hasPlaces = true;
          }
          if (/^[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?$/.test(ca) && ca.length < 25) {
            answerTypes.hasNames = true;
          }
          if (/^\d+$/.test(ca) || /^\$?\d+(?:,\d{3})*(?:\.\d{2})?$/.test(ca)) {
            answerTypes.hasNumbers = true;
          }
        }

        // Context-aware distractor pools
        const distractorPools = {
          names: ['Michael Brown', 'Jennifer White', 'Robert Davis', 'Amanda Wilson', 'Thomas Clark'],
          dates: ['March 15th', 'June 22nd', 'November 8th', 'August 3rd', 'February 14th'],
          times: ['9 AM', '11 AM', '2 PM', '4 PM', '6:30 PM'],
          places: ['Main Hall', 'Conference Room', 'Reception Area', 'West Wing', 'Garden Terrace'],
          numbers: ['15', '250', '1500', '45', '120'],
          generic: ['registration desk', 'information center', 'main office', 'front entrance', 'parking area'],
        };

        const addDistractor = (pool: string[]) => {
          for (const d of pool) {
            if (options.length >= requiredTotalOptions) return;
            if (!options.some((o: string) => norm(o) === norm(d))) {
              options.push(d);
            }
          }
        };

        // Add type-appropriate distractors
        if (answerTypes.hasNames) addDistractor(distractorPools.names);
        if (answerTypes.hasDates) addDistractor(distractorPools.dates);
        if (answerTypes.hasTimes) addDistractor(distractorPools.times);
        if (answerTypes.hasPlaces) addDistractor(distractorPools.places);
        if (answerTypes.hasNumbers) addDistractor(distractorPools.numbers);
        
        // Final fallback with generic but plausible options
        addDistractor(distractorPools.generic);

        const finalOptions = requiredTotalOptions ? options.slice(0, requiredTotalOptions) : options;
        parsed.drag_options = finalOptions;

        // Convert text correct answers -> letter ids based on option position
        if (Array.isArray(parsed.questions) && finalOptions.length) {
          parsed.questions = parsed.questions.map((q: any) => {
            const ca = String(q?.correct_answer ?? '').trim();
            if (!ca) return q;
            if (isLetterId(ca)) return { ...q, correct_answer: ca.toUpperCase() };
            const idx = finalOptions.findIndex((o: string) => norm(o) === norm(ca));
            return idx >= 0 ? { ...q, correct_answer: labelOf(idx) } : q;
          });
        }

        groupOptions = { options: finalOptions, option_format: 'A' };
      } else if (questionType === 'MULTIPLE_CHOICE_MULTIPLE' && parsed.questions?.[0]?.options) {

        // MCMA: Include options and max_answers in groupOptions for the renderer (matching reading MCMA format)
        const mcmaOptions = parsed.questions[0].options;
        const mcmaMaxAnswers = parsed.max_answers ?? parsed.questions[0]?.max_answers ?? 3;
        groupOptions = { 
          options: mcmaOptions, 
          max_answers: mcmaMaxAnswers,
          option_format: 'A'
        };
      } else if (questionType.includes('MULTIPLE_CHOICE') && parsed.questions?.[0]?.options) {
        groupOptions = { options: parsed.questions[0].options };
      }

      const groupId = crypto.randomUUID();
      const questions = (parsed.questions || []).map((q: any, i: number) => ({
        id: crypto.randomUUID(),
        question_number: q.question_number || i + 1,
        question_text: q.question_text,
        correct_answer: q.correct_answer,
        explanation: q.explanation,
        options: q.options || null,
        // Include max_answers for MCMA
        max_answers: questionType === 'MULTIPLE_CHOICE_MULTIPLE' ? (q.max_answers ?? parsed.max_answers ?? 3) : undefined,
      }));

      // For MCMA, ensure we have exactly 3 questions and end_question is 3
      const endQuestion = questionType === 'MULTIPLE_CHOICE_MULTIPLE' ? 3 : questions.length;

      const responsePayload = {
        testId,
        topic,
        transcript: displayTranscript,
        speakerNames,
        audioBase64: audio?.audioBase64 || null,
        audioFormat: audio ? 'pcm' : null,
        sampleRate: audio?.sampleRate || null,
        questionGroups: [{
          id: groupId,
          instruction: parsed.instruction || `Questions 1-${endQuestion}`,
          question_type: questionType,
          start_question: 1,
          end_question: endQuestion,
          options: groupOptions,
          questions,
        }],
      };

      // Save to test bank if requested
      if (save_to_bank) {
        await saveToTestBank(serviceClient, 'listening', topic, responsePayload);
      }

      // Credits already reserved atomically before AI call - no deduction needed

      return new Response(JSON.stringify(responsePayload), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });

    } else if (module === 'writing') {
      // Writing handler - preserved from original
      const writingConfig = body.writingConfig || {};
      const taskType = writingConfig.taskType || questionType;
      const task1VisualType = writingConfig.task1VisualType || 'RANDOM';
      const task2EssayType = writingConfig.task2EssayType || 'RANDOM';
      
      const isFullTest = taskType === 'FULL_TEST';
      const includeTask1 = isFullTest || taskType === 'TASK_1';
      const includeTask2 = isFullTest || taskType === 'TASK_2';
      
      let writingTotalTokensUsed = 0;

      async function generateSingleWritingTask(taskNum: 1 | 2, visualType: string, essayType: string): Promise<any> {
        const isTask1 = taskNum === 1;
        let writingPrompt: string;
        
        if (isTask1) {
          const visualTypeToUse = visualType === 'RANDOM'
            ? ['BAR_CHART', 'LINE_GRAPH', 'PIE_CHART', 'TABLE', 'MIXED_CHARTS', 'PROCESS_DIAGRAM', 'MAP'][Math.floor(Math.random() * 7)]
            : visualType;

          const instructionVerb = visualTypeToUse === 'MIXED_CHARTS' ? 'show' : 'shows';
          
          // Build type-specific visualData examples based on visual type
          let visualDataExample: string;
          let typeSpecificInstructions: string;
          
          switch (visualTypeToUse) {
            case 'MIXED_CHARTS':
              visualDataExample = `{
    "type": "MIXED_CHARTS",
    "title": "Overall Title for Both Charts",
    "charts": [
      {
        "type": "PIE_CHART",
        "title": "First Chart - Pie Chart",
        "data": [
          { "label": "Category A", "value": 35 },
          { "label": "Category B", "value": 25 },
          { "label": "Category C", "value": 22 },
          { "label": "Category D", "value": 18 }
        ]
      },
      {
        "type": "BAR_CHART",
        "title": "Second Chart - Bar Chart",
        "xAxisLabel": "Sectors",
        "yAxisLabel": "Change (%)",
        "data": [
          { "label": "Sector 1", "value": 24 },
          { "label": "Sector 2", "value": 36 },
          { "label": "Sector 3", "value": 18 },
          { "label": "Sector 4", "value": 52 },
          { "label": "Sector 5", "value": 10 }
        ]
      }
    ]
  }`;
              typeSpecificInstructions = `CRITICAL: You MUST create EXACTLY TWO separate charts inside the "charts" array. The "charts" array MUST contain 2 objects. Pick TWO DIFFERENT chart types from: BAR_CHART, LINE_GRAPH, PIE_CHART, TABLE. Each chart needs its own unique "title", "type", and data. For PIE_CHART values must sum to 100. Keep all labels under 15 characters. DO NOT return a single chart - return exactly 2 charts in the array.`;
              break;
            case 'PROCESS_DIAGRAM':
              visualDataExample = `{
    "type": "PROCESS_DIAGRAM",
    "title": "Process Title",
    "steps": [
      { "label": "Step 1: Raw materials collected", "description": "Optional detail" },
      { "label": "Step 2: Materials processed", "description": "Optional detail" },
      { "label": "Step 3: Quality check", "description": "Optional detail" },
      { "label": "Step 4: Final product", "description": "Optional detail" }
    ]
  }`;
              typeSpecificInstructions = `Create a process/cycle diagram with 4-8 steps. Each step must have a clear "label" field. The "description" field is optional but helpful.`;
              break;
            case 'MAP':
              visualDataExample = `{
    "type": "MAP",
    "title": "Town Centre Development",
    "subtitle": "Changes between 1990 and 2020",
    "mapData": {
      "before": {
        "year": "1990",
        "features": [
          { "label": "Town Hall", "type": "building", "position": "center" },
          { "label": "Main Street", "type": "road", "position": "north-south" },
          { "label": "Old Park", "type": "park", "position": "east" }
        ]
      },
      "after": {
        "year": "2020",
        "features": [
          { "label": "Town Hall", "type": "building", "position": "center" },
          { "label": "Main Street", "type": "road", "position": "north-south" },
          { "label": "Shopping Mall", "type": "building", "position": "east" },
          { "label": "New Car Park", "type": "other", "position": "south" }
        ]
      }
    }
  }`;
              typeSpecificInstructions = `Create a map comparison showing changes over time. Include "before" and "after" sections with features (buildings, roads, parks, water bodies). Use position words like "north", "south", "center", "east", "west", "north-east" etc.`;
              break;
            case 'TABLE':
              visualDataExample = `{
    "type": "TABLE",
    "title": "Table Title",
    "headers": ["Category", "2010", "2015", "2020"],
    "rows": [
      [{ "value": "Item A" }, { "value": 25 }, { "value": 30 }, { "value": 35 }],
      [{ "value": "Item B" }, { "value": 40 }, { "value": 38 }, { "value": 42 }],
      [{ "value": "Item C" }, { "value": 15 }, { "value": 20 }, { "value": 28 }]
    ]
  }`;
              typeSpecificInstructions = `Create a data table with 3-5 rows and 3-5 columns of numeric data showing trends or comparisons.`;
              break;
            case 'LINE_GRAPH':
              visualDataExample = `{
    "type": "LINE_GRAPH",
    "title": "Graph Title",
    "xAxisLabel": "Year",
    "yAxisLabel": "Percentage (%)",
    "series": [
      { "name": "Category A", "data": [{ "x": "2000", "y": 20 }, { "x": "2005", "y": 35 }, { "x": "2010", "y": 45 }] },
      { "name": "Category B", "data": [{ "x": "2000", "y": 40 }, { "x": "2005", "y": 38 }, { "x": "2010", "y": 50 }] }
    ]
  }`;
              typeSpecificInstructions = `Create a line graph with 2-4 series showing trends over 4-6 time points. Use percentages (0-100) or realistic numbers.`;
              break;
            case 'PIE_CHART':
              visualDataExample = `{
    "type": "PIE_CHART",
    "title": "Pie Chart Title",
    "data": [
      { "label": "Category A", "value": 35 },
      { "label": "Category B", "value": 25 },
      { "label": "Category C", "value": 20 },
      { "label": "Category D", "value": 15 },
      { "label": "Other", "value": 5 }
    ]
  }`;
              typeSpecificInstructions = `Create a pie chart with 4-6 segments. Values must add up to 100 (percentages).`;
              break;
            case 'BAR_CHART':
            default:
              visualDataExample = `{
    "type": "BAR_CHART",
    "title": "Chart Title",
    "xAxisLabel": "Categories",
    "yAxisLabel": "Percentage (%)",
    "data": [
      { "label": "Category A", "value": 45 },
      { "label": "Category B", "value": 32 },
      { "label": "Category C", "value": 28 },
      { "label": "Category D", "value": 55 }
    ]
  }`;
              typeSpecificInstructions = `Create a bar chart with 4-8 bars. Use percentages (0-100) or realistic whole numbers.`;
              break;
          }
            
          // Add uniqueness seed for variety
          const uniquenessSeed = crypto.randomUUID().slice(0, 8);
          const dataContexts = [
            'statistics from a government survey',
            'data from a university research study',
            'figures from an international organization',
            'information from a market research report',
            'data collected over the past decade',
            'comparative statistics across countries',
          ];
          const selectedContext = dataContexts[Math.floor(Math.random() * dataContexts.length)];
          
          writingPrompt = `You are a data analyst. Generate an IELTS Academic Writing Task 1 with BOTH the essay question AND the chart/diagram data.

UNIQUENESS ID: ${uniquenessSeed} (Generate COMPLETELY UNIQUE data and descriptions each time)
Topic: ${topic}
Difficulty: ${difficulty}
Visual Type: ${visualTypeToUse}
Data Context: ${selectedContext}

CRITICAL INSTRUCTIONS:
1. ${typeSpecificInstructions}
2. The instruction must start with "The ${visualTypeToUse.replace(/_/g, ' ').toLowerCase()} below ${instructionVerb}..."
3. Include: "Summarise the information by selecting and reporting the main features, and make comparisons where relevant."
4. End with: "Write at least 150 words."
5. Generate UNIQUE and REALISTIC data - not generic placeholder values.
6. Use VARIED category names and labels that fit the topic.

Return this EXACT JSON structure:
{
  "task_type": "task1",
  "instruction": "The ${visualTypeToUse.replace(/_/g, ' ').toLowerCase()} below ${instructionVerb} [specific description]. Summarise the information by selecting and reporting the main features, and make comparisons where relevant. Write at least 150 words.",
  "visual_type": "${visualTypeToUse}",
  "visualData": ${visualDataExample}
}

IMPORTANT: Use whole numbers. Keep all labels under 15 characters. Ensure visualData matches the exact structure shown above. Make the data INTERESTING and VARIED.`;
        } else {
          const essayTypeToUse = essayType === 'RANDOM'
            ? ['OPINION', 'DISCUSSION', 'PROBLEM_SOLUTION', 'ADVANTAGES_DISADVANTAGES', 'TWO_PART_QUESTION'][Math.floor(Math.random() * 5)]
            : essayType;
            
          const essayFormatGuide = {
            'OPINION': 'To what extent do you agree or disagree?',
            'DISCUSSION': 'Discuss both views and give your own opinion.',
            'PROBLEM_SOLUTION': 'What are the causes of this problem and what solutions can you suggest?',
            'ADVANTAGES_DISADVANTAGES': 'What are the advantages and disadvantages of this?',
            'TWO_PART_QUESTION': 'Include two related questions that the student must address.'
          };
          
          // Add uniqueness seed for Task 2
          const task2UniquenessSeed = crypto.randomUUID().slice(0, 8);
          const perspectiveAngles = [
            'Consider this from both individual and societal perspectives.',
            'Think about short-term and long-term implications.',
            'Examine this from economic, social, and environmental viewpoints.',
            'Consider how this affects different age groups or demographics.',
            'Explore both traditional and modern perspectives on this issue.',
            'Consider local, national, and global dimensions of this topic.',
          ];
          const selectedPerspective = perspectiveAngles[Math.floor(Math.random() * perspectiveAngles.length)];
          
          writingPrompt = `Generate an IELTS Academic Writing Task 2.

UNIQUENESS ID: ${task2UniquenessSeed} (Create a COMPLETELY UNIQUE prompt each time)
Topic: ${topic}
Difficulty: ${difficulty}
Essay Type: ${essayTypeToUse}
Perspective: ${selectedPerspective}

CRITICAL - GENERATE A UNIQUE PROMPT:
- Do NOT use generic, overused essay topics.
- Create a SPECIFIC and INTERESTING scenario or statement.
- The topic should be thought-provoking and relevant.
- Avoid clichéd phrases and common essay questions.

IMPORTANT: The instruction must follow official IELTS format exactly:
- Start with a statement or context about a topic
- Present the main question/argument
- End with the appropriate question format for ${essayTypeToUse}: "${essayFormatGuide[essayTypeToUse as keyof typeof essayFormatGuide] || ''}"
- Include: "Give reasons for your answer and include any relevant examples from your own knowledge or experience."
- End with: "Write at least 250 words."

Return this EXACT JSON structure:
{
  "task_type": "task2",
  "instruction": "[Context statement about the topic]. [Main argument or question]. ${essayFormatGuide[essayTypeToUse as keyof typeof essayFormatGuide] || ''} Give reasons for your answer and include any relevant examples from your own knowledge or experience. Write at least 250 words.",
  "essay_type": "${essayTypeToUse}"
}`;
        }

        // Use Gemini with JSON mode for stable, non-truncated output
        console.log(`Generating Task ${taskNum} with JSON mode...`);

        const safeParseJson = (raw: string): any => {
          // 1) Direct parse (best case)
          try {
            return JSON.parse(raw);
          } catch {
            // 2) Extract JSON from mixed content (code fences etc.)
            const extracted = extractJsonFromResponse(raw);
            return JSON.parse(extracted);
          }
        };

        const baseMaxOutputTokens = 2048;
        const maxAttempts = 3;
        let lastErr: unknown = null;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          const maxOutputTokens = attempt === 0 ? baseMaxOutputTokens : baseMaxOutputTokens * 2;

          // Retry loop for transient API errors (503, 429, etc.)
          let response: Response | null = null;
          const maxApiRetries = 3;
          for (let apiRetry = 0; apiRetry < maxApiRetries; apiRetry++) {
            response = await fetch(
              `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiApiKey}`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  contents: [{ parts: [{ text: writingPrompt }] }],
                  generationConfig: {
                    temperature: 0.2,
                    maxOutputTokens,
                    responseMimeType: 'application/json',
                  },
                }),
              }
            );

            // Retry on transient errors (503 overloaded, 429 rate limit, 500 server error)
            if (response.status === 503 || response.status === 429 || response.status === 500) {
              const retryDelay = Math.pow(2, apiRetry) * 1000 + Math.random() * 500;
              console.warn(`Task ${taskNum} API returned ${response.status}, retrying in ${Math.round(retryDelay)}ms (attempt ${apiRetry + 1}/${maxApiRetries})`);
              await new Promise(resolve => setTimeout(resolve, retryDelay));
              continue;
            }
            break;
          }

          if (!response || !response.ok) {
            const errorText = response ? await response.text() : 'No response';
            console.error(`Task ${taskNum} generation failed:`, response?.status, errorText);
            throw new Error(`Failed to generate Task ${taskNum}: ${response?.status || 'unknown'}`);
          }

          const data = await response.json();

          // Track token usage
          const usageMetadata = data.usageMetadata;
          if (usageMetadata) {
            const promptTokens = usageMetadata.promptTokenCount || 0;
            const candidateTokens = usageMetadata.candidatesTokenCount || 0;
            writingTotalTokensUsed += promptTokens + candidateTokens;
            console.log(`Task ${taskNum} tokens - Prompt: ${promptTokens}, Output: ${candidateTokens}`);
          }

          const finishReason = data.candidates?.[0]?.finishReason;

          const resultText = data.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!resultText) {
            lastErr = new Error(`Empty response for Task ${taskNum}`);
            console.error(lastErr);
            continue;
          }

          console.log(`Task ${taskNum} response length: ${resultText.length} chars (attempt ${attempt + 1}/${maxAttempts}, finishReason=${finishReason || 'unknown'})`);

          try {
            const parsed = safeParseJson(resultText);

            return {
              id: crypto.randomUUID(),
              task_type: isTask1 ? 'task1' : 'task2',
              instruction: parsed.instruction,
              image_description: parsed.visual_description || parsed.instruction, // Fallback
              chartData: parsed.visualData || null, // Direct from combined response
              visual_type: parsed.visual_type,
              essay_type: parsed.essay_type,
              word_limit_min: isTask1 ? 150 : 250,
              word_limit_max: isTask1 ? 200 : 350,
            };
          } catch (e) {
            lastErr = e;
            const preview = resultText?.substring(0, 500);
            console.error(`Failed to parse Task ${taskNum} JSON (attempt ${attempt + 1}/${maxAttempts}):`, e, preview);

            // If the model output looks truncated, retry with a larger token budget.
            // Otherwise, retry once more anyway (models sometimes self-correct on retry).
            const looksTruncated = !resultText.trim().endsWith('}') || finishReason === 'MAX_TOKENS';
            if (!looksTruncated && attempt >= 1) {
              break;
            }

            continue;
          }
        }

        console.error(`Failed to parse Task ${taskNum} after ${maxAttempts} attempts:`, lastErr);
        throw new Error(`Failed to parse Task ${taskNum} content`);
      }

      try {
        // Create service client for quota tracking
        const serviceClient = createClient(
          Deno.env.get('SUPABASE_URL') ?? '',
          Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
        );

        if (isFullTest) {
          // Generate both tasks sequentially - each task is now a single API call
          console.log('Generating full writing test - Task 1...');
          const task1Result = await generateSingleWritingTask(1, task1VisualType, task2EssayType);
          
          console.log('Generating Task 2...');
          const task2Result = await generateSingleWritingTask(2, task1VisualType, task2EssayType);
          
          // Update quota tracking
          if (writingTotalTokensUsed > 0) {
            await updateQuotaTracking(serviceClient, user.id, writingTotalTokensUsed);
          }

          // Credits already reserved atomically before AI call - no deduction needed
          
          return new Response(JSON.stringify({
            testId,
            topic,
            timeMinutes,
            writingTask: {
              id: crypto.randomUUID(),
              test_type: 'full_test',
              task1: task1Result,
              task2: task2Result,
              time_minutes: timeMinutes,
            },
          }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        } else {
          // Generate single task
          const taskResult = await generateSingleWritingTask(
            includeTask1 ? 1 : 2,
            task1VisualType,
            task2EssayType
          );
          
          // Update quota tracking
          if (writingTotalTokensUsed > 0) {
            await updateQuotaTracking(serviceClient, user.id, writingTotalTokensUsed);
          }

          // Credits already reserved atomically before AI call - no deduction needed
          
          return new Response(JSON.stringify({
            testId,
            topic,
            writingTask: taskResult,
          }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      } catch (err: any) {
        console.error('Writing generation error:', err);
        return new Response(JSON.stringify({ error: err.message || 'Failed to generate writing test' }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

    } else if (module === 'speaking') {
      // Speaking test generation with official IELTS examiner phrases
      const isFullTest = questionType === 'FULL_TEST';
      const includePart1 = isFullTest || questionType === 'PART_1';
      const includePart2 = isFullTest || questionType === 'PART_2';
      const includePart3 = isFullTest || questionType === 'PART_3';

      // Add uniqueness seed to ensure variety across generations
      const uniquenessSeed = crypto.randomUUID().slice(0, 8);
      const randomAngles = [
        'Focus on personal experiences and memories related to this topic.',
        'Explore the social and cultural aspects of this topic.',
        'Consider future trends and changes related to this topic.',
        'Examine the advantages and disadvantages of this topic.',
        'Discuss how this topic affects different generations.',
        'Think about regional or international perspectives on this topic.',
        'Consider technological influences on this topic.',
        'Explore environmental or sustainability aspects of this topic.',
      ];
      const selectedAngle = randomAngles[Math.floor(Math.random() * randomAngles.length)];
      
      const questionStyleVariants = [
        'Use varied question structures: some "What...", some "How...", some "Why...", some "Do you think..."',
        'Include both direct questions and hypothetical scenarios.',
        'Mix opinion-based questions with experience-based questions.',
        'Balance between simple recall questions and analytical questions.',
      ];
      const selectedStyle = questionStyleVariants[Math.floor(Math.random() * questionStyleVariants.length)];

      const speakingPrompt = `Generate an official IELTS Speaking test matching the EXACT style and difficulty of Cambridge IELTS test books.

UNIQUENESS ID: ${uniquenessSeed}
TOPIC: ${topic}
THEMATIC ANGLE: ${selectedAngle}
PARTS TO INCLUDE: ${[includePart1 && 'Part 1', includePart2 && 'Part 2', includePart3 && 'Part 3'].filter(Boolean).join(', ')}

CRITICAL REQUIREMENTS - CAMBRIDGE STANDARD:
1. QUESTION DIFFICULTY: Target Band 7-8 level - questions should be SIMPLE, NATURAL, and CONVERSATIONAL.
2. QUESTION LENGTH: Keep questions SHORT (under 15 words for Part 1, 12-16 words for Part 3).
3. AVOID overly complex, academic, or philosophical questions that would be Band 9+ level.
4. Questions should sound like natural speech from a real IELTS examiner, not written essays.
5. ${selectedStyle}
6. Each question explores a DIFFERENT aspect of the topic.
7. DO NOT use generic questions like "Do you like [topic]?" - use specific angles instead.

OFFICIAL IELTS SPEAKING FORMAT:

PART 1 (Introduction & Interview) - 4-5 minutes:
- Examiner intro: "Now, in this first part, I'd like to ask you some questions about yourself."
- Then: "Let's talk about [topic]..." followed by 4 SIMPLE, DIRECT questions
- Questions should be EASY TO UNDERSTAND and about everyday personal experiences
- Keep questions SHORT (8-15 words maximum)
- Examples of good Part 1 questions: "When did you last...?", "Where do you usually...?", "How often do you...?"
- Each answer: 20-30 seconds

PART 2 (Individual Long Turn) - 3-4 minutes:
- Examiner intro: "Now, I'm going to give you a topic and I'd like you to talk about it for one to two minutes."
- Cue card with "Describe..." followed by 3-4 bullet points under "You should say:"
- Keep bullet points CONCISE (5-8 words each)
- One follow-up rounding-off question

PART 3 (Two-way Discussion) - 4-5 minutes:
- Examiner intro: "We've been talking about [Part 2 topic] and I'd like to discuss some related questions."
- 4-5 discussion questions that are CLEAR and ACCESSIBLE (minimum 4, maximum 5)
- Questions should require opinion/analysis but NOT be overly philosophical
- STRICT WORD COUNT: Each Part 3 question MUST have EXACTLY 12-16 words (MINIMUM 12 words - count carefully!)
- Questions with fewer than 12 words will be REJECTED - extend them to meet the minimum
- Example good questions (12-16 words each):
  * "What do you think are the main benefits of learning a foreign language?" (14 words)
  * "How has technology changed the way people communicate with each other nowadays?" (12 words)
  * "Why do you think some people prefer to live in cities rather than rural areas?" (15 words)

Return ONLY valid JSON:
{
  "topic": "${topic}",
  "parts": [
    ${includePart1 ? `{
      "part_number": 1,
      "instruction": "Now, in this first part, I'd like to ask you some questions about yourself. Let's talk about ${topic.toLowerCase()}...",
      "questions": [
        { "question_number": 1, "question_text": "Short question 1?" },
        { "question_number": 2, "question_text": "Short question 2?" },
        { "question_number": 3, "question_text": "Short question 3?" },
        { "question_number": 4, "question_text": "Short question 4?" }
      ],
      "time_limit_seconds": 300
    }${includePart2 || includePart3 ? ',' : ''}` : ''}
    ${includePart2 ? `{
      "part_number": 2,
      "cue_card_topic": "Describe [specific thing related to ${topic.toLowerCase()}]",
      "cue_card_content": "You should say:\\n• bullet 1 (5-8 words)\\n• bullet 2 (5-8 words)\\n• bullet 3 (5-8 words)\\n• and explain why/how...",
      "questions": [
        { "question_number": 1, "question_text": "Short follow-up question?" }
      ],
      "preparation_time_seconds": 60,
      "speaking_time_seconds": 120
    }${includePart3 ? ',' : ''}` : ''}
    ${includePart3 ? `{
      "part_number": 3,
      "instruction": "We've been talking about [Part 2 topic] and I'd like to discuss some related questions.",
      "questions": [
        { "question_number": 1, "question_text": "Clear discussion question 1 (12-16 words)?" },
        { "question_number": 2, "question_text": "Opinion-based question 2 (12-16 words)?" },
        { "question_number": 3, "question_text": "Comparison question 3 (12-16 words)?" },
        { "question_number": 4, "question_text": "Future/change question 4 (12-16 words)?" }
      ],
      "time_limit_seconds": 300
    }` : ''}
  ]
}

Generate natural, conversational questions matching Cambridge IELTS Band 7-8 difficulty. Questions must be SHORT, CLEAR, and sound like real examiner speech.`;

      const result = await callGemini(geminiApiKey, speakingPrompt, 2, { dbKeys: dbApiKeys, serviceClient });
      
      // Track tokens used
      const totalTokensUsed = getLastTokensUsed();
      
      if (!result) {
        // If quota exceeded, return special error with status 429
        if (wasQuotaExceeded()) {
          return new Response(JSON.stringify({ 
            error: getLastGeminiError(),
            errorType: 'QUOTA_EXCEEDED',
            suggestion: 'Check your usage at aistudio.google.com or wait a few minutes before retrying.'
          }), {
            status: 429,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ error: getLastGeminiError() }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      
      // Update quota tracking (uses serviceClient from main handler scope)
      await updateQuotaTracking(serviceClient, user.id, totalTokensUsed);

      let parsed;
      try {
        const jsonStr = extractJsonFromResponse(result);
        parsed = JSON.parse(jsonStr);
      } catch (e) {
        console.error("Failed to parse Gemini response:", e, result?.substring(0, 500));
        return new Response(JSON.stringify({ error: 'Failed to parse generated content. Please try again.' }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Enforce Part 3 constraints (exactly 4 questions, 12-16 words each)
      try {
        if (parsed?.parts) {
          parsed.parts = enforceSpeakingPart3Parts(parsed.parts);
        }
      } catch (e) {
        console.warn('Part 3 constraints enforcement failed:', e);
      }

      // Process the parts with proper structure
      const speakingParts = (parsed.parts || []).map((p: any, pIndex: number) => {
        const partNumber = p.part_number || pIndex + 1;
        
        return {
          id: crypto.randomUUID(),
          part_number: partNumber,
          instruction: p.instruction || '',
          questions: (p.questions || []).map((q: any, qIndex: number) => ({
            id: crypto.randomUUID(),
            question_number: q.question_number || qIndex + 1,
            question_text: q.question_text || '',
            sample_answer: q.sample_answer,
          })),
          cue_card_topic: p.cue_card_topic,
          cue_card_content: p.cue_card_content,
          preparation_time_seconds: p.preparation_time_seconds || (partNumber === 2 ? 60 : undefined),
          speaking_time_seconds: p.speaking_time_seconds || (partNumber === 2 ? 120 : undefined),
          time_limit_seconds: p.time_limit_seconds || (partNumber === 1 || partNumber === 3 ? 300 : undefined),
        };
      });

      // Credits already reserved atomically before AI call - no deduction needed

      return new Response(JSON.stringify({
        testId,
        topic: parsed.topic || topic,
        speakingParts,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ error: 'Invalid module' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
    console.error('Edge Function error:', error.message, error.stack);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
