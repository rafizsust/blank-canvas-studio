import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { crypto } from "https://deno.land/std@0.168.0/crypto/mod.ts";
import { uploadToR2 } from "../_shared/r2Client.ts";
import { 
  getActiveGeminiKeysForModel, 
  markKeyQuotaExhausted, 
  isQuotaExhaustedError,
  type QuotaModelType
} from "../_shared/apiKeyQuotaUtils.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function stableHashHex(input: string): string {
  // djb2 (32-bit)
  let h = 5381;
  for (let i = 0; i < input.length; i++) h = ((h << 5) + h + input.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0');
}

function stableSpeakingQuestionId(partNumber: 1 | 2 | 3, idx: number, text: string): string {
  return `p${partNumber}-q${idx + 1}-${stableHashHex(text)}`;
}

// Model priority: Gemini 2.0 Flash first (stable, high RPM), 2.5 Flash second, 1.5 Pro fallback
const GEMINI_MODELS_FALLBACK_ORDER = [
  'gemini-2.0-flash',       // Primary: Stable, high RPM
  'gemini-2.5-flash',       // Secondary: Newer stable
  'gemini-1.5-pro',         // Fallback: More capable but slower
];

// Exponential backoff configuration
// NOTE: We only retry transient transport errors. We DO NOT retry 429 quota/rate-limit responses,
// because retrying the same key/model is pointless and wastes time.
const RETRY_CONFIG = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 8000,
  backoffMultiplier: 2,
  retryableStatuses: [503, 504], // Service Unavailable, Gateway Timeout
};

// DB-managed API key interface
interface ApiKeyRecord {
  id: string;
  provider: string;
  key_value: string;
  is_active: boolean;
  error_count: number;
  flash_quota_exhausted?: boolean;
  flash_quota_exhausted_date?: string;
}

// Fetch active Gemini keys from api_keys table with rotation support AND quota filtering
async function getActiveGeminiKeys(supabaseServiceClient: any): Promise<ApiKeyRecord[]> {
  // Use the shared utility that filters out quota-exhausted keys for 'flash' model type
  return await getActiveGeminiKeysForModel(supabaseServiceClient, 'flash');
}

// Increment error count for a failed key
async function incrementKeyErrorCount(supabaseServiceClient: any, keyId: string, deactivate: boolean = false): Promise<void> {
  try {
    if (deactivate) {
      await supabaseServiceClient
        .from('api_keys')
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq('id', keyId);
    } else {
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
    }
  } catch (err) {
    console.error('[evaluate-ai-speaking] Failed to update key error count:', err);
  }
}

// Mark key as quota exhausted for flash model
async function markKeyQuotaExhaustedForFlash(supabaseServiceClient: any, keyId: string): Promise<void> {
  await markKeyQuotaExhausted(supabaseServiceClient, keyId, 'flash');
  console.log(`[evaluate-ai-speaking] Marked key ${keyId} as flash quota exhausted`);
}

// Reset error count on successful use
async function resetKeyErrorCount(supabaseServiceClient: any, keyId: string): Promise<void> {
  try {
    await supabaseServiceClient
      .from('api_keys')
      .update({ error_count: 0, updated_at: new Date().toISOString() })
      .eq('id', keyId);
  } catch (err) {
    console.error('[evaluate-ai-speaking] Failed to reset key error count:', err);
  }
}

// Error classification for specific user messages
interface GeminiErrorInfo {
  code: string;
  userMessage: string;
  isQuota: boolean;
  isRateLimit: boolean;
  isInvalidKey: boolean;
  isModelNotFound: boolean;  // NEW: 404 model not found - don't mark key exhausted
  isRetryable: boolean;      // NEW: Should retry with backoff
}

function classifyGeminiError(status: number, errorText: string): GeminiErrorInfo {
  const lower = errorText.toLowerCase();
  
  // 404 Model Not Found - DO NOT mark key as exhausted, just try next model
  if (status === 404 || lower.includes('not found') || lower.includes('not_found')) {
    return {
      code: 'MODEL_NOT_FOUND',
      userMessage: 'Model not available. Trying alternative model...',
      isQuota: false,
      isRateLimit: false,
      isInvalidKey: false,
      isModelNotFound: true,
      isRetryable: false, // Don't retry same model, move to next
    };
  }
  
  // 429 is typically either quota exhaustion or rate limiting.
  // IMPORTANT: do NOT retry the same key/model on 429 — rotate keys/models instead.
  if (status === 429 || lower.includes('quota') || lower.includes('resource_exhausted')) {
    return {
      code: 'QUOTA_EXCEEDED',
      userMessage:
        'Gemini API quota/rate limit exceeded for this key. We\'ll switch keys automatically; please retry in a bit if it persists.',
      isQuota: true,
      isRateLimit: true,
      isInvalidKey: false,
      isModelNotFound: false,
      isRetryable: false,
    };
  }
  
  if (lower.includes('rate limit') || lower.includes('too many requests')) {
    return {
      code: 'RATE_LIMITED',
      userMessage: 'Too many requests to Gemini API. Please wait 30 seconds and try again.',
      isQuota: false,
      isRateLimit: true,
      isInvalidKey: false,
      isModelNotFound: false,
      isRetryable: true, // Retry with backoff
    };
  }
  
  if (status === 400 && (lower.includes('api_key') || lower.includes('api key'))) {
    return {
      code: 'INVALID_API_KEY',
      userMessage: 'Invalid Gemini API key. Please update your API key in Settings.',
      isQuota: false,
      isRateLimit: false,
      isInvalidKey: true,
      isModelNotFound: false,
      isRetryable: false,
    };
  }
  
  if (status === 403) {
    return {
      code: 'PERMISSION_DENIED',
      userMessage: 'Gemini API access denied. Your API key may not have permissions for this model.',
      isQuota: false,
      isRateLimit: false,
      isInvalidKey: false,
      isModelNotFound: false,
      isRetryable: false,
    };
  }
  
  if (status === 503 || status === 504) {
    return {
      code: 'SERVICE_UNAVAILABLE',
      userMessage: 'Gemini API is temporarily unavailable. Please try again in a few minutes.',
      isQuota: false,
      isRateLimit: false,
      isInvalidKey: false,
      isModelNotFound: false,
      isRetryable: true, // Retry with backoff
    };
  }
  
  return {
    code: 'UNKNOWN_ERROR',
    userMessage: 'An unexpected error occurred with Gemini API. Please try again.',
    isQuota: false,
    isRateLimit: false,
    isInvalidKey: false,
    isModelNotFound: false,
    isRetryable: false,
  };
}

// Exponential backoff sleep helper
async function sleepWithBackoff(attempt: number): Promise<void> {
  const delay = Math.min(
    RETRY_CONFIG.initialDelayMs * Math.pow(RETRY_CONFIG.backoffMultiplier, attempt),
    RETRY_CONFIG.maxDelayMs
  );
  const jitter = delay * 0.2 * Math.random(); // Add 20% jitter
  console.log(`[evaluate-ai-speaking] Retry attempt ${attempt + 1}, waiting ${Math.round(delay + jitter)}ms`);
  await new Promise(resolve => setTimeout(resolve, delay + jitter));
}

interface EvaluationRequest {
  testId: string;
  audioData: Record<string, string>; // dataURL or base64
  durations?: Record<string, number>; // seconds
  topic?: string;
  difficulty?: string;
  part2SpeakingDuration?: number;
  fluencyFlag?: boolean;
}

type SpeakingQuestion = {
  id: string;
  question_number: number;
  question_text: string;
};

type SpeakingPart = {
  id: string;
  part_number: 1 | 2 | 3;
  instruction?: string;
  cue_card_topic?: string;
  cue_card_content?: string;
  questions: SpeakingQuestion[];
};

type GeneratedTestPayload = {
  id: string;
  module: string;
  topic?: string;
  difficulty?: string;
  speakingParts?: SpeakingPart[];
};

// Declare EdgeRuntime for background processing
declare const EdgeRuntime: { waitUntil?: (promise: Promise<void>) => void } | undefined;

serve(async (req) => {
  const startTime = Date.now();
  console.log(`[evaluate-ai-speaking] Request received at ${new Date().toISOString()}`);
  
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const appEncryptionKey = Deno.env.get('app_encryption_key');

    // Create client with user's auth
    const supabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: {
        headers: { Authorization: req.headers.get('Authorization')! },
      },
    });

    // Get user
    const { data: { user }, error: authError } = await supabaseClient.auth.getUser();
    if (authError || !user) {
      console.error('[evaluate-ai-speaking] Auth error:', authError?.message);
      return new Response(JSON.stringify({ error: 'Unauthorized', code: 'UNAUTHORIZED' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    console.log(`[evaluate-ai-speaking] User authenticated: ${user.id}`);

    if (!appEncryptionKey) {
      console.error('[evaluate-ai-speaking] app_encryption_key not set');
      return new Response(JSON.stringify({
        error: 'Server configuration error: encryption key not set.',
        code: 'SERVER_CONFIG_ERROR'
      }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Service client for DB operations (needed before body parsing for key pool access)
    const supabaseService = createClient(supabaseUrl, supabaseServiceKey);

    // Try to get user's Gemini API key first
    const { data: userSecret, error: secretError } = await supabaseClient
      .from('user_secrets')
      .select('encrypted_value')
      .eq('user_id', user.id)
      .eq('secret_name', 'GEMINI_API_KEY')
      .single();

    let geminiApiKey: string | null = null;
    let userApiKey: string | null = null;
    let usingUserKey = false;
    let activePoolKeys: ApiKeyRecord[] = [];
    let currentPoolKeyIndex = 0;

    // Always load pool keys - we'll need them as fallback
    activePoolKeys = await getActiveGeminiKeys(supabaseService);
    console.log(`[evaluate-ai-speaking] Found ${activePoolKeys.length} active pool keys`);

    if (userSecret && !secretError) {
      // Decrypt user's API key
      try {
        const encoder = new TextEncoder();
        const decoder = new TextDecoder();
        const keyData = encoder.encode(appEncryptionKey);
        const cryptoKey = await crypto.subtle.importKey(
          "raw",
          keyData.slice(0, 32),
          { name: "AES-GCM" },
          false,
          ["decrypt"],
        );

        const encryptedBytes = Uint8Array.from(atob(userSecret.encrypted_value), (c) => c.charCodeAt(0));
        const iv = encryptedBytes.slice(0, 12);
        const ciphertext = encryptedBytes.slice(12);

        const decryptedData = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv },
          cryptoKey,
          ciphertext,
        );

        userApiKey = decoder.decode(decryptedData);
        geminiApiKey = userApiKey;
        usingUserKey = true;
        console.log('[evaluate-ai-speaking] User API key found, will try it first');
      } catch (decryptErr) {
        console.error('[evaluate-ai-speaking] Failed to decrypt user key:', decryptErr);
      }
    }

    // If no user key, use pool keys
    if (!geminiApiKey && activePoolKeys.length > 0) {
      currentPoolKeyIndex = Math.floor(Math.random() * activePoolKeys.length);
      geminiApiKey = activePoolKeys[currentPoolKeyIndex].key_value;
      console.log(`[evaluate-ai-speaking] Using system key pool`);
    }

    if (!geminiApiKey) {
      console.error('[evaluate-ai-speaking] No API key available (user or system pool)');
      return new Response(JSON.stringify({
        error: 'Gemini API key not found. Please set your API key in Settings.',
        code: 'API_KEY_NOT_FOUND'
      }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Parse request body
    const body: EvaluationRequest = await req.json();
    const { testId, audioData, durations, topic, difficulty, part2SpeakingDuration, fluencyFlag } = body;

    if (!testId || !audioData || typeof audioData !== 'object') {
      console.error('[evaluate-ai-speaking] Bad request: missing testId or audioData');
      return new Response(JSON.stringify({ error: 'Missing testId or audioData', code: 'BAD_REQUEST' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const audioKeys = Object.keys(audioData);
    const totalPayloadSize = JSON.stringify(audioData).length;
    console.log(`[evaluate-ai-speaking] Test: ${testId}, User: ${user.id}`);
    console.log(`[evaluate-ai-speaking] Audio segments: ${audioKeys.length}, Payload size: ${(totalPayloadSize / 1024 / 1024).toFixed(2)}MB`);
    console.log(`[evaluate-ai-speaking] Audio keys: ${audioKeys.join(', ')}`);

    // Load AI practice test payload (for question context)
    const { data: testRow, error: testError } = await supabaseClient
      .from('ai_practice_tests')
      .select('payload, topic, difficulty, module, preset_id, is_preset')
      .eq('id', testId)
      .eq('user_id', user.id)
      .maybeSingle();

    if (testError || !testRow) {
      return new Response(JSON.stringify({ error: 'AI practice test not found', code: 'TEST_NOT_FOUND' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    let payload = (testRow.payload ?? {}) as any;
    
    // For preset tests with empty payload, fetch content from generated_test_audio
    const payloadKeys = Object.keys(payload);
    const isEmptyPayload = !payload || payloadKeys.length === 0 || !payload.speakingParts;
    console.log(`[evaluate-ai-speaking] Payload check: preset_id=${testRow.preset_id}, payloadKeys=${payloadKeys.length}, isEmptyPayload=${isEmptyPayload}, hasSpeakingParts=${!!payload.speakingParts}`);
    
    if (testRow.preset_id && isEmptyPayload) {
      console.log(`[evaluate-ai-speaking] Fetching preset content from generated_test_audio: ${testRow.preset_id}`);
      
      const { data: presetData, error: presetError } = await supabaseService
        .from('generated_test_audio')
        .select('content_payload')
        .eq('id', testRow.preset_id)
        .maybeSingle();
        
      if (presetData && !presetError) {
        payload = presetData.content_payload ?? {};
        const presetKeys = Object.keys(payload);
        console.log(`[evaluate-ai-speaking] Loaded preset content, keys: ${presetKeys.join(', ')}`);
        
        // Additional debug: check if part1/part2/part3 or speakingParts exist
        console.log(`[evaluate-ai-speaking] Preset has: part1=${!!payload.part1}, part2=${!!payload.part2}, part3=${!!payload.part3}, speakingParts=${!!payload.speakingParts}`);
      } else {
        console.error('[evaluate-ai-speaking] Failed to load preset content:', presetError);
      }
    } else if (!testRow.preset_id && isEmptyPayload) {
      console.error('[evaluate-ai-speaking] Non-preset test has empty payload');
    }
    
    // Extract question IDs from the audioData keys sent by the client.
    // Client uses format: part1-q{UUID}, part2-q{UUID}, part3-q{UUID}
    // We need to use these exact IDs when building the Gemini prompt.
    const audioKeysByPart: Record<number, string[]> = { 1: [], 2: [], 3: [] };
    for (const key of audioKeys) {
      const match = key.match(/^part(\d)-q(.+)$/);
      if (match) {
        const partNum = parseInt(match[1], 10);
        if (partNum >= 1 && partNum <= 3) {
          audioKeysByPart[partNum].push(match[2]); // Extract question ID
        }
      }
    }
    console.log(`[evaluate-ai-speaking] Audio keys by part: part1=${audioKeysByPart[1].length}, part2=${audioKeysByPart[2].length}, part3=${audioKeysByPart[3].length}`);

    // Transform part1/part2/part3 format to speakingParts array if needed
    // Preset speaking tests use {part1: {questions: string[], instruction}, part2: {...}, part3: {...}}
    let speakingParts: SpeakingPart[] = [];
    
    if (payload.speakingParts) {
      // Already in correct format - but we should update IDs to match client audio keys if needed
      speakingParts = payload.speakingParts.slice().sort((a: SpeakingPart, b: SpeakingPart) => a.part_number - b.part_number);
      
      // For each part, if the client sent audio keys with different IDs, update the question IDs to match
      for (const part of speakingParts) {
        const clientIds = audioKeysByPart[part.part_number];
        if (clientIds.length > 0 && part.questions?.length) {
          for (let i = 0; i < Math.min(clientIds.length, part.questions.length); i++) {
            console.log(`[evaluate-ai-speaking] Mapping part${part.part_number} q${i+1}: server id=${part.questions[i].id} -> client id=${clientIds[i]}`);
            part.questions[i].id = clientIds[i];
          }
        }
      }
    } else {
      // Transform from part1/part2/part3 format
      for (const partKey of ['part1', 'part2', 'part3']) {
        const rawPart = payload[partKey];
        if (!rawPart) continue;
        
        const partNumber = parseInt(partKey.slice(4)) as 1 | 2 | 3;
        const clientIds = audioKeysByPart[partNumber];
        
        let questions: SpeakingQuestion[] = Array.isArray(rawPart.questions)
          ? rawPart.questions.map((q: any, idx: number) => {
              const questionText = typeof q === 'string' ? q : (q?.question_text ?? '');
              // Use client-provided ID if available, otherwise use the ID from payload or generate one
              const questionId = clientIds[idx] ?? (typeof q === 'string' ? crypto.randomUUID() : (q?.id ?? crypto.randomUUID()));
              
              console.log(`[evaluate-ai-speaking] Part ${partNumber} Q${idx + 1}: using id=${questionId}, clientHasId=${!!clientIds[idx]}`);
              
              return {
                id: questionId,
                question_number: idx + 1,
                question_text: questionText,
              };
            }).filter((q: SpeakingQuestion) => q.question_text)
          : [];
        
        // CRITICAL FIX: Handle Part 2 cue_card format - create a question from cue_card if no questions exist
        // This matches the client-side logic in aiPractice.ts
        if (questions.length === 0 && partNumber === 2) {
          const cueCardText = String(rawPart.cue_card ?? rawPart.cue_card_topic ?? rawPart.cueCardTopic ?? '').trim();
          if (cueCardText || clientIds.length > 0) {
            // Use client-provided ID if available (this ensures audio key matching)
            const questionId = clientIds[0] ?? stableSpeakingQuestionId(2, 0, cueCardText);
            console.log(`[evaluate-ai-speaking] Part 2: Creating question from cue_card, id=${questionId}, clientHasId=${!!clientIds[0]}`);
            questions = [{
              id: questionId,
              question_number: 1,
              question_text: cueCardText || 'Describe the topic on the cue card.',
            }];
          }
        }
        
        if (questions.length > 0 || partNumber === 2) {
          speakingParts.push({
            id: crypto.randomUUID(),
            part_number: partNumber,
            instruction: rawPart.instruction ?? '',
            questions,
            cue_card_topic: rawPart.cue_card_topic ?? rawPart.cueCardTopic,
            cue_card_content: rawPart.cue_card_content ?? rawPart.cueCardContent,
          });
        }
      }
      
      console.log(`[evaluate-ai-speaking] Transformed preset to ${speakingParts.length} speaking parts`);
    }

    if (!speakingParts.length) {
      console.error('[evaluate-ai-speaking] No speaking parts found after transformation. Payload keys:', Object.keys(payload));
      return new Response(JSON.stringify({ error: 'Speaking parts not found in test payload', code: 'INVALID_TEST' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // supabaseService already created above for key pool access

    // Upload each segment to R2 and produce public URLs
    const audioUrls: Record<string, string> = {};
    
     for (const key of audioKeys) {
       try {
         const value = audioData[key];
         const { mimeType, base64 } = parseDataUrl(value);
         const duration = durations?.[key];

         // Skip truly empty payloads only (small answers can still be valid speech)
         if (!base64 || base64.length < 100) {
           console.log(
             `[evaluate-ai-speaking][audio] skip (too small) key=${key} mime=${mimeType} b64Len=${base64?.length ?? 0} dur=${typeof duration === 'number' ? duration.toFixed(2) : 'n/a'} head=${describeBase64(base64)}`,
           );
           continue;
         }

         console.log(
           `[evaluate-ai-speaking][audio] recv key=${key} mime=${mimeType} b64Len=${base64.length} dur=${typeof duration === 'number' ? duration.toFixed(2) : 'n/a'} head=${describeBase64(base64)}`,
         );

         const audioBytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
         console.log(
           `[evaluate-ai-speaking][audio] bytes key=${key} bytesLen=${audioBytes.length} container=${detectAudioContainer(audioBytes)} first16=${bytesToHex(audioBytes.slice(0, 16))}`,
         );

         const ext = mimeType === 'audio/mpeg' ? 'mp3' : 'webm';
         const r2Key = `speaking-audios/ai-speaking/${user.id}/${testId}/${key}.${ext}`;

         const result = await uploadToR2(r2Key, audioBytes, mimeType);
         if (result.success && result.url) {
           audioUrls[key] = result.url;
           console.log(`[evaluate-ai-speaking] Uploaded audio to R2: ${r2Key}`);
         } else {
           console.warn(`[evaluate-ai-speaking] Upload failed for ${key}:`, result.error);
         }
       } catch (err) {
         console.error(`Failed to upload audio for ${key}:`, err);
       }
     }

    // Build Gemini multi-modal prompt similar to admin evaluation (audio inline + transcripts)
    const contents = buildGeminiContents({
      speakingParts,
      audioData,
      topic: topic ?? testRow.topic ?? payload.topic,
      difficulty: difficulty ?? testRow.difficulty ?? payload.difficulty,
      part2SpeakingDuration,
      fluencyFlag,
    });

    // Call Gemini API with fallback models, key rotation, and timeout
    let evaluationRaw: any = null;
    let usedModel: string | null = null;
    let lastError: GeminiErrorInfo | null = null;
    const GEMINI_TIMEOUT_MS = 120_000; // 2 minutes timeout for large audio payloads

    console.log(`[evaluate-ai-speaking] Starting Gemini API call, timeout: ${GEMINI_TIMEOUT_MS}ms, using ${usingUserKey ? 'user key' : 'pool key'}`);

    // Function to call Gemini with a specific API key (with retry and model fallback)
    async function callGemini(apiKey: string, poolKeyId?: string): Promise<{ success: boolean; shouldFallbackToPool?: boolean }> {
      for (const modelName of GEMINI_MODELS_FALLBACK_ORDER) {
        console.log(`[evaluate-ai-speaking] Attempting model: ${modelName}`);
        const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(apiKey)}`;

        // Retry loop with exponential backoff for retryable errors
        for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
          try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
            
            const geminiResponse = await fetch(GEMINI_API_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              signal: controller.signal,
              body: JSON.stringify({
                contents,
                generationConfig: {
                  temperature: 0.3,
                  maxOutputTokens: 12000,
                  responseMimeType: 'application/json',
                },
              }),
            });
            
            clearTimeout(timeoutId);
            console.log(`[evaluate-ai-speaking] Gemini ${modelName} response status: ${geminiResponse.status}`);

            if (!geminiResponse.ok) {
              const errorText = await geminiResponse.text();
              console.error(`[evaluate-ai-speaking] Gemini ${modelName} error (${geminiResponse.status}):`, errorText.slice(0, 500));
              
              lastError = classifyGeminiError(geminiResponse.status, errorText);
              
              // MODEL NOT FOUND (404): Just try next model, don't mark key exhausted
              if (lastError.isModelNotFound) {
                console.log(`[evaluate-ai-speaking] Model ${modelName} not found, trying next model...`);
                break; // Break retry loop, try next model
              }
              
              // RETRYABLE ERRORS (429, 503, 504): Retry with backoff before marking key exhausted
              if (lastError.isRetryable && attempt < RETRY_CONFIG.maxRetries) {
                await sleepWithBackoff(attempt);
                continue; // Retry same model
              }
              
              // If using pool key and got quota/rate limit error after retries, MARK AS QUOTA EXHAUSTED
              if (poolKeyId && (lastError.isQuota || lastError.isRateLimit)) {
                await markKeyQuotaExhaustedForFlash(supabaseService, poolKeyId);
                await incrementKeyErrorCount(supabaseService, poolKeyId, false);
                console.log(`[evaluate-ai-speaking] Key ${poolKeyId} marked as quota exhausted after ${attempt + 1} attempts, will try next key`);
                return { success: false }; // Signal to try next pool key
              }
              
              // If invalid key in pool, deactivate it
              if (poolKeyId && lastError.isInvalidKey) {
                await incrementKeyErrorCount(supabaseService, poolKeyId, true);
                return { success: false }; // Try next pool key
              }

              // For user key quota/rate limit, signal to fallback to pool
              if (usingUserKey && (lastError.isQuota || lastError.isRateLimit)) {
                console.log('[evaluate-ai-speaking] User key quota/rate limited, will try pool keys');
                return { success: false, shouldFallbackToPool: true };
              }

              // For invalid user key, fail with specific message
              if (usingUserKey && lastError.isInvalidKey) {
                throw new Error(lastError.userMessage);
              }

              break; // Try next model
            }

            const data = await geminiResponse.json();
            const responseText = data?.candidates?.[0]?.content?.parts
              ?.map((p: any) => p?.text)
              .filter(Boolean)
              .join('\n');

            if (!responseText) {
              console.error(`[evaluate-ai-speaking] No response text from ${modelName}`);
              break; // Try next model
            }

            evaluationRaw = parseJsonFromResponse(responseText);
            if (evaluationRaw) {
              usedModel = modelName;
              // Reset error count on success for pool keys
              if (poolKeyId) {
                await resetKeyErrorCount(supabaseService, poolKeyId);
              }
              console.log(`[evaluate-ai-speaking] Successfully evaluated with model: ${modelName}`);
              return { success: true };
            }
            break; // No valid JSON, try next model
          } catch (err: any) {
            if (err.name === 'AbortError') {
              console.error(`[evaluate-ai-speaking] Timeout with model ${modelName} (attempt ${attempt + 1})`);
              lastError = { code: 'TIMEOUT', userMessage: 'Request timed out. Please try again.', isQuota: false, isRateLimit: false, isInvalidKey: false, isModelNotFound: false, isRetryable: true };
              
              // Retry timeout with backoff
              if (attempt < RETRY_CONFIG.maxRetries) {
                await sleepWithBackoff(attempt);
                continue;
              }
            } else if (err.message) {
              // Propagate specific error messages
              throw err;
            } else {
              console.error(`[evaluate-ai-speaking] Error with model ${modelName}:`, err);
            }
            break; // Try next model
          }
        }
      }
      return { success: false };
    }

    // Try with user's API key first
    let result = await callGemini(geminiApiKey, usingUserKey ? undefined : activePoolKeys[currentPoolKeyIndex]?.id);

    // If user key failed due to quota/rate limit, fallback to pool keys
    if (!result.success && result.shouldFallbackToPool && activePoolKeys.length > 0) {
      console.log('[evaluate-ai-speaking] Falling back to admin pool keys after user key quota exceeded');
      usingUserKey = false;
      currentPoolKeyIndex = Math.floor(Math.random() * activePoolKeys.length);
      geminiApiKey = activePoolKeys[currentPoolKeyIndex].key_value;
      result = await callGemini(geminiApiKey, activePoolKeys[currentPoolKeyIndex].id);
    }

    // If failed and using pool keys, try rotating through other keys
    if (!result.success && !usingUserKey && activePoolKeys.length > 1) {
      for (let i = 1; i < activePoolKeys.length && !result.success; i++) {
        const nextIndex = (currentPoolKeyIndex + i) % activePoolKeys.length;
        console.log(`[evaluate-ai-speaking] Rotating to pool key ${i + 1}/${activePoolKeys.length}`);
        geminiApiKey = activePoolKeys[nextIndex].key_value;
        result = await callGemini(geminiApiKey, activePoolKeys[nextIndex].id);
      }
    }

    if (!evaluationRaw) {
      console.error('[evaluate-ai-speaking] All models/keys failed to evaluate');
      const errorMessage = (lastError as GeminiErrorInfo | null)?.userMessage || 'Failed to evaluate speaking test. Please try again.';
      const errorCode = (lastError as GeminiErrorInfo | null)?.code || 'EVALUATION_ERROR';
      const isQuotaOrRate = (lastError as GeminiErrorInfo | null)?.isQuota || (lastError as GeminiErrorInfo | null)?.isRateLimit;
      
      return new Response(JSON.stringify({ 
        error: errorMessage, 
        code: errorCode,
        userMessage: errorMessage 
      }), {
        status: isQuotaOrRate ? 429 : 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Normalize evaluation into the frontend-friendly structure
    const evaluation = normalizeEvaluationResponse(evaluationRaw);

    // Extract transcripts (question-by-question) from model output
    const transcriptsMap = extractTranscriptsMap(evaluationRaw);

    // Retry transcription for clips that came back as "No speech detected" despite having audio.
    // This addresses occasional false negatives on very short / low-volume utterances.
    const transcriptsMapRefined = await retryTranscriptionForNoSpeech({
      transcriptsMap,
      audioData,
      durations,
      apiKey: geminiApiKey,
      preferredModel: usedModel ?? undefined,
    });

    // Build transcripts_by_question and transcripts_by_part in deterministic order
    const transcriptsByQuestion: Record<number, Array<{ question_number: number; question_text: string; transcript: string }>> = {
      1: [],
      2: [],
      3: [],
    };

    const transcriptsByPart: Record<number, string> = { 1: '', 2: '', 3: '' };

    for (const part of speakingParts) {
      const lines: string[] = [];

       for (const q of part.questions ?? []) {
         const audioKey = `part${part.part_number}-q${q.id}`;
         const transcript = String(transcriptsMapRefined[audioKey] ?? transcriptsMap[audioKey] ?? '').trim();
        transcriptsByQuestion[part.part_number].push({
          question_number: q.question_number,
          question_text: q.question_text,
          transcript,
        });
        if (transcript) lines.push(`Q${q.question_number}: ${transcript}`);
      }

      transcriptsByPart[part.part_number] = lines.join('\n');
    }

    // Derive timeSpent
    const timeSpentSeconds = durations
      ? Math.round(Object.values(durations).reduce((acc, s) => acc + (Number(s) || 0), 0))
      : Math.round((part2SpeakingDuration ?? 0) + 60);

    const overallBand = Number(evaluation.overall_band ?? evaluation.overallBand ?? 0);

    // Save to database using service client
    const { error: insertError } = await supabaseService
      .from('ai_practice_results')
      .insert({
        user_id: user.id,
        test_id: testId,
        module: 'speaking',
        answers: {
          audio_urls: audioUrls,
          transcripts_by_part: transcriptsByPart,
          transcripts_by_question: transcriptsByQuestion,
        },
        score: Math.round(((overallBand || 0) / 9) * 100),
        total_questions: audioKeys.length,
        band_score: overallBand,
        time_spent_seconds: timeSpentSeconds,
        question_results: evaluation,
        completed_at: new Date().toISOString(),
      });

    if (insertError) {
      console.error('[evaluate-ai-speaking] Failed to save result:', insertError);
      // Don't fail the request, still return evaluation
    } else {
      console.log('[evaluate-ai-speaking] Result saved successfully');
    }

    const elapsed = Date.now() - startTime;
    console.log(`[evaluate-ai-speaking] Completed in ${elapsed}ms, overall band: ${overallBand}`);

    return new Response(JSON.stringify({
      success: true,
      evaluation,
      usedModel,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: unknown) {
    const elapsed = Date.now() - startTime;
    console.error(`[evaluate-ai-speaking] Error after ${elapsed}ms:`, error);
    const errorMessage = error instanceof Error ? error.message : 'Evaluation failed';
    return new Response(JSON.stringify({ error: errorMessage, code: 'EVALUATION_ERROR' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

function parseDataUrl(value: string): { mimeType: string; base64: string } {
  if (!value) return { mimeType: 'audio/webm', base64: '' };

  // data:[mime];base64,[payload]
  if (value.startsWith('data:')) {
    const commaIdx = value.indexOf(',');
    const header = commaIdx >= 0 ? value.slice(5, commaIdx) : value.slice(5);
    const base64 = commaIdx >= 0 ? value.slice(commaIdx + 1) : '';

    const semiIdx = header.indexOf(';');
    const mimeType = (semiIdx >= 0 ? header.slice(0, semiIdx) : header).trim() || 'audio/webm';

    return { mimeType, base64 };
  }

  // Raw base64 (legacy)
  return { mimeType: 'audio/webm', base64: value };
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function detectAudioContainer(bytes: Uint8Array): string {
  // MP3 often starts with "ID3" or 0xFFFB/0xFFF3 sync
  if (bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return 'mp3(id3)';
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return 'mp3(frame-sync)';

  // WebM/Matroska is EBML header: 1A 45 DF A3
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'webm/ebml';

  // WAV: "RIFF" .... "WAVE"
  if (bytes.length >= 12) {
    const riff = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    const wave = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    if (riff === 'RIFF' && wave === 'WAVE') return 'wav';
  }

  return 'unknown';
}

function describeBase64(base64?: string): string {
  if (!base64) return 'empty';
  const head = base64.slice(0, 32);
  const tail = base64.slice(-16);
  return `${head}...${tail}`;
}

function parseJsonFromResponse(responseText: string): any {
  try {
    // First try: direct parse
    return JSON.parse(responseText);
  } catch {
    // Second try: extract JSON object from markdown or other text
    try {
      // Remove markdown code blocks if present
      let cleaned = responseText.replace(/```json\s*/gi, '').replace(/```\s*/gi, '');
      
      // Try to find JSON object
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        let jsonStr = jsonMatch[0];
        
        // Fix common JSON issues:
        // 1. Remove trailing commas before } or ]
        jsonStr = jsonStr.replace(/,(\s*[}\]])/g, '$1');
        
        // 2. Fix unescaped quotes in strings (basic heuristic)
        // This is tricky, so we try parsing first without this fix
        try {
          return JSON.parse(jsonStr);
        } catch {
          // Try more aggressive cleaning
          // Remove any control characters that might cause issues
          jsonStr = jsonStr.replace(/[\x00-\x1F\x7F]/g, (char) => {
            if (char === '\n' || char === '\r' || char === '\t') return char;
            return '';
          });
          
          return JSON.parse(jsonStr);
        }
      }
      
      return JSON.parse(cleaned);
    } catch (err) {
      console.error('Error parsing evaluation response:', err);
      console.error('Response text preview:', responseText.slice(0, 500));
      return null;
    }
  }
}

function extractTranscriptsMap(raw: any): Record<string, string> {
  // Support a few shapes:
  // 1) { transcripts: { "part1-q...": "..." } }
  // 2) { evaluation_report: { transcripts: { ... } } }
  // 3) { evaluationReport: { transcripts: { ... } } }
  const direct = raw?.transcripts;
  const nested = raw?.evaluation_report?.transcripts ?? raw?.evaluationReport?.transcripts;

  const map = (direct && typeof direct === 'object')
    ? direct
    : (nested && typeof nested === 'object')
      ? nested
      : null;

  return map ? (map as Record<string, string>) : {};
}

function buildGeminiContents(input: {
  speakingParts: SpeakingPart[];
  audioData: Record<string, string>;
  topic?: string;
  difficulty?: string;
  part2SpeakingDuration?: number;
  fluencyFlag?: boolean;
}): Array<{ parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> }> {
  const { speakingParts, audioData, topic, difficulty, part2SpeakingDuration, fluencyFlag } = input;

  const contents: Array<{ parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> }> = [];

  contents.push({
    parts: [{
      text: getEvaluationSystemPrompt(topic, difficulty, part2SpeakingDuration, fluencyFlag),
    }],
  });

  for (const part of speakingParts) {
    contents.push({
      parts: [{
        text: `\nPART ${part.part_number}\n${part.instruction ? `Instruction: ${part.instruction}\n` : ''}`,
      }],
    });

    if (part.part_number === 2) {
      if (part.cue_card_topic) {
        contents.push({ parts: [{ text: `Cue Card Topic: ${part.cue_card_topic}\n` }] });
      }
      if (part.cue_card_content) {
        contents.push({ parts: [{ text: `Cue Card Content:\n${part.cue_card_content}\n` }] });
      }
    }

    for (const q of part.questions ?? []) {
      const audioKey = `part${part.part_number}-q${q.id}`;
      contents.push({
        parts: [{ text: `\nQuestion ${q.question_number}: ${q.question_text}\nAudio key: ${audioKey}\n` }],
      });

       const rawAudio = audioData[audioKey];
       const hasKey = Object.prototype.hasOwnProperty.call(audioData, audioKey);
       const rawType = rawAudio === null ? 'null' : typeof rawAudio;
       const rawHead = typeof rawAudio === 'string' ? rawAudio.slice(0, 40).replace(/\s/g, '') : 'n/a';
       const { mimeType, base64 } = parseDataUrl(rawAudio || '');

       console.log(
         `[evaluate-ai-speaking][gemini-input] key=${audioKey} hasKey=${hasKey} rawType=${rawType} rawHead=${rawHead} hasAudio=${Boolean(rawAudio)} mime=${mimeType} b64Len=${base64?.length ?? 0} head=${describeBase64(base64)}`,
       );

       // Small clips are common in Part 1/3; accept them.
       if (base64 && base64.length > 100) {
         const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
         console.log(
           `[evaluate-ai-speaking][gemini-inline] key=${audioKey} mime=${mimeType} b64Len=${base64.length} bytesLen=${bytes.length} container=${detectAudioContainer(bytes)} first16=${bytesToHex(bytes.slice(0, 16))}`,
         );

         contents.push({ parts: [{ inlineData: { mimeType, data: base64 } }] });
         contents.push({
           parts: [{
              text: `Transcribe the candidate's speech for this audio and store it in the JSON field "transcripts" under the key "${audioKey}". Even if the response is 1–2 words (e.g., "Let me think"), transcribe it. Only write "No speech detected" if the audio is essentially silent (no discernible spoken words).`,
           }],
         });
       } else {
         console.log(
           `[evaluate-ai-speaking][gemini-inline] key=${audioKey} NOT_SENT reason=${!hasKey ? 'missing_key' : 'empty_or_too_small'} mime=${mimeType} b64Len=${base64?.length ?? 0}`,
         );

         contents.push({
           parts: [{
             text: `No usable audio was provided for ${audioKey}. Set transcripts["${audioKey}"] = "No speech detected".`,
           }],
         });
       }
    }
  }

  contents.push({
    parts: [{
      text: `\nReturn ONLY a single valid JSON object matching the requested schema. Do not add markdown.`,
    }],
  });

  return contents;
}

function getEvaluationSystemPrompt(
  topic?: string,
  difficulty?: string,
  part2SpeakingDuration?: number,
  fluencyFlag?: boolean,
): string {
  return `You are an OFFICIAL IELTS Speaking examiner following the Cambridge/British Council 2025 assessment standards. You will be given:
- The test context (topic/difficulty)
- The exact questions
- Audio recordings for each question

You MUST base the score on what you hear in the audio.
If there is no speech in the audio, score that criterion as 0.

${topic ? `TEST TOPIC: ${topic}\n` : ''}${difficulty ? `DIFFICULTY: ${difficulty}\n` : ''}${typeof part2SpeakingDuration === 'number' ? `PART 2 SPEAKING DURATION: ${Math.floor(part2SpeakingDuration)} seconds\n` : ''}${fluencyFlag ? `FLUENCY FLAG: Part 2 was below 80 seconds\n` : ''}

=== CRITICAL: PER-QUESTION EVALUATION REQUIREMENT ===
You MUST evaluate EVERY question individually. The final band score is the WEIGHTED AVERAGE of all individual question performances.

**SCORING METHODOLOGY:**
1. For EACH audio recording, assess the response quality:
   - NO SPEECH or unintelligible: Score 0 for that question
   - MINIMAL (1-3 words like "yes", "ok", "next", "I don't know"): Score 2.0 for that question
   - SHORT (4-10 words, single sentence): Score 3.5-4.5 for that question  
   - ADEQUATE (2-4 sentences, some development): Score 5.0-6.0 for that question
   - GOOD (well-developed, coherent): Score 6.5-7.5 for that question
   - EXCELLENT (fully developed, sophisticated): Score 8.0-9.0 for that question

2. Calculate the FINAL band for each criterion by averaging ALL question scores:
   - Sum individual question scores and divide by total number of questions
   - Example: If 9 questions with scores [7,7,2,2,2,2,6,2,2] = average 3.5, NOT 7

3. The overall band = arithmetic mean of all four criteria averages, rounded to nearest 0.5

**MANDATORY PENALTY RULES:**
- If >50% of responses are minimal (1-3 words): Maximum overall band = 4.0
- If >30% of responses are minimal: Maximum overall band = 5.0  
- If Part 2 response is under 60 seconds: Reduce fluency score by 1.0 band
- One-word answers like "yes", "no", "next", "ok" = Score 2.0 maximum for that question

=== OFFICIAL IELTS SPEAKING BAND DESCRIPTORS (2025) ===
You MUST apply these EXACT criteria from the official IELTS Speaking Band Descriptors. Score STRICTLY - do not inflate scores.

FLUENCY AND COHERENCE:
Band 9: Speaks fluently with only very occasional repetition or self-correction; any hesitation is content-related rather than to find words or grammar; speaks coherently with full appropriate cohesive features; develops topics fully and appropriately
Band 8: Speaks fluently with only occasional repetition or self-correction; hesitation is usually content-related; develops topics coherently and appropriately
Band 7: Speaks at length without noticeable effort or loss of coherence; may demonstrate language-related hesitation or some repetition/self-correction; uses a range of connectives and discourse markers with some flexibility
Band 6: Is willing to speak at length though may lose coherence at times due to occasional repetition/self-correction or hesitation; uses a range of connectives and discourse markers but not always appropriately
Band 5: Usually maintains flow of speech but uses repetition, self-correction and/or slow speech to keep going; may over-use certain connectives and discourse markers; produces simple speech fluently but more complex communication causes fluency problems
Band 4: Cannot respond without noticeable pauses and may speak slowly, with frequent repetition and self-correction; links basic sentences but with repetitious use of simple connectives; some breakdowns in coherence
Band 3: Speaks with long pauses; has limited ability to link simple sentences; gives only simple responses and is frequently unable to convey basic message
Band 2: Pauses lengthily before most words; little communication possible
Band 1: No communication possible; no rateable language
Band 0: No speech detected

LEXICAL RESOURCE:
Band 9: Uses vocabulary with full flexibility and precision in all topics; uses idiomatic language naturally and accurately
Band 8: Uses a wide vocabulary resource readily and flexibly to convey precise meaning; uses less common and idiomatic vocabulary skillfully, with occasional inaccuracies; uses paraphrase effectively as required
Band 7: Uses vocabulary resource flexibly to discuss a variety of topics; uses some less common and idiomatic vocabulary and shows some awareness of style and collocation, with some inappropriate choices; uses paraphrase effectively
Band 6: Has a wide enough vocabulary to discuss topics at length and make meaning clear in spite of inappropriacies; generally paraphrases successfully
Band 5: Manages to talk about familiar and unfamiliar topics but uses vocabulary with limited flexibility; attempts to use paraphrase but with mixed success
Band 4: Is able to talk about familiar topics but can only convey basic meaning on unfamiliar topics; makes frequent errors in word choice; rarely attempts paraphrase
Band 3: Uses simple vocabulary to convey personal information; has insufficient vocabulary for less familiar topics
Band 2: Only produces isolated words or memorized utterances
Band 1: No communication possible; no rateable language
Band 0: No speech detected

GRAMMATICAL RANGE AND ACCURACY:
Band 9: Uses a full range of structures naturally and appropriately; produces consistently accurate structures apart from 'slips' characteristic of native speaker speech
Band 8: Uses a wide range of structures flexibly; produces a majority of error-free sentences with only very occasional inappropriacies or basic/non-systematic errors
Band 7: Uses a range of complex structures with some flexibility; frequently produces error-free sentences, though some grammatical mistakes persist
Band 6: Uses a mix of simple and complex structures, but with limited flexibility; may make frequent mistakes with complex structures though these rarely cause comprehension problems
Band 5: Produces basic sentence forms with reasonable accuracy; uses a limited range of more complex structures, but these usually contain errors and may cause some comprehension problems
Band 4: Produces basic sentence forms and some correct simple sentences but subordinate structures are rare; errors are frequent and may lead to misunderstanding
Band 3: Attempts basic sentence forms but with limited success, or relies on apparently memorized utterances; makes numerous errors except in memorized expressions
Band 2: Cannot produce basic sentence forms
Band 1: No communication possible; no rateable language
Band 0: No speech detected

PRONUNCIATION:
Band 9: Uses the full range of pronunciation features with precision and subtlety; sustains flexible use of features throughout; is effortless to understand
Band 8: Uses a wide range of pronunciation features; sustains flexible use of features, with only occasional lapses; is easy to understand throughout; L1 accent has minimal effect on intelligibility
Band 7: Shows all the positive features of Band 6 and some, but not all, of the positive features of Band 8
Band 6: Uses a range of pronunciation features with mixed control; shows some effective use of features but this is not sustained; can generally be understood throughout, though mispronunciation of individual words or sounds reduces clarity at times
Band 5: Shows all the positive features of Band 4 and some, but not all, of the positive features of Band 6
Band 4: Uses a limited range of pronunciation features; attempts to control features but lapses are frequent; mispronunciations are frequent and cause some difficulty for the listener
Band 3: Shows some of the features of Band 2 and some, but not all, of the positive features of Band 4
Band 2: Speech is often unintelligible
Band 1: No communication possible; no rateable language
Band 0: No speech detected

=== STRICT SCORING RULES ===
1. NO SPEECH = Band 0 for all criteria. If audio is silent or has no discernible speech, score 0.
2. MINIMAL SPEECH (only 1-3 words per question) = Score 2.0 for that specific question.
3. SHORT RESPONSES (one sentence answers) = Maximum Band 4.5 for that specific question.
4. Score each criterion by AVERAGING scores across ALL questions - not just the best ones.
5. The overall band = arithmetic mean of all four criteria averages, rounded to nearest 0.5.
6. DO NOT inflate scores. If most responses are minimal, the overall band MUST be low (3-4).
7. Apply the SAME standard whether evaluating a single part or the full test.
8. IMPORTANT: A candidate who answers only 2 out of 9 questions properly CANNOT score above Band 4.

=== MODEL ANSWERS (COMPACT) ===
For each question, provide FOUR short model answers at Band 6, 7, 8, and 9 levels.
To avoid truncated JSON responses, keep answers concise:
- Part 1 model answers: 25–45 words
- Part 2 model answers: 90–140 words
- Part 3 model answers: 60–90 words

For each band level also include whyBandXWorks (1–2 specific reasons).
Model answers must be natural and realistic IELTS responses (no bullet lists inside the model answer text).

Respond with JSON in this exact format (IMPORTANT: output ONLY valid JSON, no markdown, no trailing commas):
{
  "overallBand": number,
  "questionScores": [
    {"audioKey": "part1-q<id>", "score": number, "wordCount": number, "responseType": "none|minimal|short|adequate|good|excellent"}
  ],
  "minimalResponseCount": number,
  "totalQuestionCount": number,
  "fluencyCoherence": { "score": number, "feedback": string, "examples": ["example1"] },
  "lexicalResource": { "score": number, "feedback": string, "examples": ["example1"], "lexicalUpgrades": [{"original": "word", "upgraded": "better_word", "context": "sentence"}] },
  "grammaticalRange": { "score": number, "feedback": string, "examples": ["example1"] },
  "pronunciation": { "score": number, "feedback": string },
  "partAnalysis": [
    {"partNumber": 1, "strengths": ["strength1"], "improvements": ["improvement1"]},
    {"partNumber": 2, "strengths": ["strength1"], "improvements": ["improvement1"]},
    {"partNumber": 3, "strengths": ["strength1"], "improvements": ["improvement1"]}
  ],
  "modelAnswers": [
    {"partNumber": 1, "questionNumber": 1, "question": "question text", "candidateResponse": "what they said", "questionBandScore": 5.0, "modelAnswerBand6": "model", "modelAnswerBand7": "model", "modelAnswerBand8": "model", "modelAnswerBand9": "model", "whyBand6Works": ["reason"], "whyBand7Works": ["reason"], "whyBand8Works": ["reason"], "whyBand9Works": ["reason"]}
  ],
  "summary": "overall summary",
  "keyStrengths": ["strength1"],
  "priorityImprovements": ["improvement1"],
  "transcripts": { "part1-q<id>": "transcript text" }
}

CRITICAL JSON REQUIREMENTS:
1. Output ONLY valid JSON - no markdown code blocks, no comments, no trailing commas.
2. The "questionScores" array MUST contain an entry for EVERY audio recording with the individual band score.
3. "minimalResponseCount" = count of responses with 1-3 words only.
4. Each modelAnswer MUST include "questionBandScore" showing the score for that specific question.
5. Keep all arrays and strings concise to avoid JSON truncation.
6. Double-check JSON syntax before outputting.`;
}

function normalizeEvaluationResponse(data: any): any {
  const ensureArray = (val: any) => (Array.isArray(val) ? val : []);

  // Extract question scores for per-question evaluation
  const questionScores = ensureArray(data.questionScores ?? data.question_scores ?? []);
  const minimalResponseCount = data.minimalResponseCount ?? data.minimal_response_count ?? 0;
  const totalQuestionCount = data.totalQuestionCount ?? data.total_question_count ?? questionScores.length;

  // Calculate the overall band based on question scores if provided
  let overallBand = data.overallBand ?? data.overall_band ?? 0;
  
  // VALIDATION: If we have question scores, verify the overall band makes sense
  if (questionScores.length > 0) {
    const avgQuestionScore = questionScores.reduce((sum: number, qs: any) => sum + (qs.score ?? 0), 0) / questionScores.length;
    
    // Apply penalty caps based on minimal response count
    let maxAllowedBand = 9.0;
    const minimalRatio = minimalResponseCount / Math.max(totalQuestionCount, 1);
    
    if (minimalRatio > 0.5) {
      maxAllowedBand = 4.0; // More than 50% minimal responses
      console.log(`[evaluate-ai-speaking] Capping band to ${maxAllowedBand} due to ${(minimalRatio * 100).toFixed(0)}% minimal responses`);
    } else if (minimalRatio > 0.3) {
      maxAllowedBand = 5.0; // More than 30% minimal responses
      console.log(`[evaluate-ai-speaking] Capping band to ${maxAllowedBand} due to ${(minimalRatio * 100).toFixed(0)}% minimal responses`);
    }
    
    // Cap the overall band if it exceeds the maximum allowed
    if (overallBand > maxAllowedBand) {
      console.log(`[evaluate-ai-speaking] Reducing overall band from ${overallBand} to ${maxAllowedBand} due to minimal responses`);
      overallBand = maxAllowedBand;
    }
    
    // Sanity check: overall band shouldn't be more than 1.5 above average question score
    if (overallBand > avgQuestionScore + 1.5) {
      const adjustedBand = Math.round((avgQuestionScore + 1.0) * 2) / 2; // Round to nearest 0.5
      console.log(`[evaluate-ai-speaking] Adjusting overall band from ${overallBand} to ${adjustedBand} (avg question score: ${avgQuestionScore.toFixed(1)})`);
      overallBand = Math.min(overallBand, adjustedBand);
    }
  }

  const normalizeCriterion = (camelKey: string, snakeKey: string) => {
    const val = data[camelKey] ?? data[snakeKey] ?? { score: 0, feedback: '' };
    return {
      score: val.score ?? 0,
      feedback: val.feedback ?? '',
      examples: ensureArray(val.examples),
    };
  };

  const lexicalResource = data.lexicalResource ?? data.lexical_resource ?? {};
  const lexicalUpgrades = ensureArray(
    lexicalResource.lexicalUpgrades ?? lexicalResource.lexical_upgrades ?? data.lexical_upgrades ?? [],
  );

  const partAnalysisRaw = ensureArray(data.partAnalysis ?? data.part_analysis ?? []);
  const partAnalysis = partAnalysisRaw.map((p: any) => ({
    part_number: p.partNumber ?? p.part_number ?? 0,
    strengths: ensureArray(p.strengths),
    improvements: ensureArray(p.improvements),
  }));

  // Normalize model answers to ensure ALL band levels exist
  const rawModelAnswers = ensureArray(data.modelAnswers ?? data.model_answers ?? []);
  const normalizedModelAnswers = rawModelAnswers.map((ma: any) => {
    const candidateResponse = ma.candidateResponse ?? ma.candidate_response ?? '';
    return {
      ...ma,
      partNumber: ma.partNumber ?? ma.part_number ?? 1,
      questionNumber: ma.questionNumber ?? ma.question_number ?? 1,
      question: ma.question ?? '',
      candidateResponse,
      questionBandScore: ma.questionBandScore ?? ma.question_band_score ?? 0,
      // Ensure all four band levels exist with fallback content
      modelAnswerBand6: ma.modelAnswerBand6 ?? ma.model_answer_band6 ?? (candidateResponse || 'Model answer at Band 6 level.'),
      modelAnswerBand7: ma.modelAnswerBand7 ?? ma.model_answer_band7 ?? (candidateResponse || 'Model answer at Band 7 level.'),
      modelAnswerBand8: ma.modelAnswerBand8 ?? ma.model_answer_band8 ?? (candidateResponse || 'Model answer at Band 8 level.'),
      modelAnswerBand9: ma.modelAnswerBand9 ?? ma.model_answer_band9 ?? (candidateResponse || 'Model answer at Band 9 level.'),
      // Ensure all whyBandXWorks arrays exist
      whyBand6Works: ensureArray(ma.whyBand6Works ?? ma.why_band6_works ?? ['Demonstrates competent language use']),
      whyBand7Works: ensureArray(ma.whyBand7Works ?? ma.why_band7_works ?? ['Shows good language control with minor limitations']),
      whyBand8Works: ensureArray(ma.whyBand8Works ?? ma.why_band8_works ?? ['Exhibits sophisticated vocabulary and grammar']),
      whyBand9Works: ensureArray(ma.whyBand9Works ?? ma.why_band9_works ?? ['Demonstrates near-native fluency and precision']),
    };
  });

  return {
    overall_band: overallBand,
    overallBand: overallBand,
    questionScores,
    minimalResponseCount,
    totalQuestionCount,
    fluency_coherence: normalizeCriterion('fluencyCoherence', 'fluency_coherence'),
    lexical_resource: {
      ...normalizeCriterion('lexicalResource', 'lexical_resource'),
      lexicalUpgrades: lexicalUpgrades,
    },
    grammatical_range: normalizeCriterion('grammaticalRange', 'grammatical_range'),
    pronunciation: {
      score: (data.pronunciation ?? {}).score ?? 0,
      feedback: (data.pronunciation ?? {}).feedback ?? '',
    },
    lexical_upgrades: lexicalUpgrades,
    part_analysis: partAnalysis,
    improvement_priorities: ensureArray(data.priorityImprovements ?? data.improvement_priorities ?? []),
    strengths_to_maintain: ensureArray(data.keyStrengths ?? data.strengths_to_maintain ?? []),
    examiner_notes: data.summary ?? data.examiner_notes ?? '',
    modelAnswers: normalizedModelAnswers,
  };
}

async function retryTranscriptionForNoSpeech(input: {
  transcriptsMap: Record<string, string>;
  audioData: Record<string, string>;
  durations?: Record<string, number>;
  apiKey: string;
  preferredModel?: string;
}): Promise<Record<string, string>> {
  const { transcriptsMap, audioData, durations, apiKey, preferredModel } = input;

  const keysToRetry = Object.keys(transcriptsMap).filter((k) => {
    const t = String(transcriptsMap[k] ?? '').trim().toLowerCase();
    if (t !== 'no speech detected' && t !== '') return false;

    const raw = audioData[k];
    if (!raw) return false;

    const { base64 } = parseDataUrl(raw);
    if (!base64 || base64.length < 100) return false;

    const dur = durations?.[k];
    // LOWERED THRESHOLD: Retry for clips >= 0.3s (was 0.7s). Part 2 may have short initial responses.
    return typeof dur !== 'number' || dur >= 0.3;
  });

  if (keysToRetry.length === 0) return transcriptsMap;

  // Keep payload bounded.
  const limitedKeys = keysToRetry.slice(0, 8);
  console.log(`[evaluate-ai-speaking][retry-stt] Retrying transcripts for ${limitedKeys.length}/${keysToRetry.length} keys`);

  const contents: Array<{ parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> }> = [];
  contents.push({
    parts: [{
      text: `You are a speech-to-text engine. Transcribe the audio clips exactly.

Rules:
- Transcribe even very short utterances (1–2 words).
- Do NOT output "No speech detected" unless the clip is essentially silent (no discernible spoken words).
- If the speech is unclear, output your best guess and append " [unclear]".

Return ONLY valid JSON:
{ "transcripts": { "<audioKey>": "<transcript>" } }`,
    }],
  });

  for (const key of limitedKeys) {
    const raw = audioData[key] || '';
    const { mimeType, base64 } = parseDataUrl(raw);
    const dur = durations?.[key];

    contents.push({ parts: [{ text: `Audio key: ${key}${typeof dur === 'number' ? ` (duration ~${dur.toFixed(2)}s)` : ''}` }] });
    contents.push({ parts: [{ inlineData: { mimeType, data: base64 } }] });
  }

  const modelsToTry = [preferredModel, ...GEMINI_MODELS_FALLBACK_ORDER].filter(Boolean) as string[];
  const timeoutMs = 45_000;

  for (const modelName of modelsToTry) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(apiKey)}`;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          contents,
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 2000,
            responseMimeType: 'application/json',
          },
        }),
      });

      clearTimeout(timeoutId);

      if (!res.ok) {
        const errText = await res.text();
        console.error(`[evaluate-ai-speaking][retry-stt] Gemini ${modelName} failed:`, errText.slice(0, 300));
        continue;
      }

      const data = await res.json();
      const responseText = data?.candidates?.[0]?.content?.parts
        ?.map((p: any) => p?.text)
        .filter(Boolean)
        .join('\n');

      if (!responseText) continue;
      const parsed = parseJsonFromResponse(responseText);
      const newMap = parsed?.transcripts;

      if (newMap && typeof newMap === 'object') {
        let replaced = 0;
        for (const key of limitedKeys) {
          const candidate = String(newMap[key] ?? '').trim();
          if (candidate) {
            transcriptsMap[key] = candidate;
            replaced++;
          }
        }
        console.log(`[evaluate-ai-speaking][retry-stt] Updated ${replaced}/${limitedKeys.length} transcripts using ${modelName}`);
        break;
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        console.error(`[evaluate-ai-speaking][retry-stt] Timeout on model ${modelName}`);
      } else {
        console.error(`[evaluate-ai-speaking][retry-stt] Error on model ${modelName}:`, err?.message ?? err);
      }
    }
  }

  return transcriptsMap;
}
