import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { crypto } from "https://deno.land/std@0.168.0/crypto/mod.ts";
import { uploadToR2 } from "../_shared/r2Client.ts";
import { 
  getActiveGeminiKeysForModel, 
  markKeyQuotaExhausted
} from "../_shared/apiKeyQuotaUtils.ts";
import { 
  createPerformanceLogger,
  classifyGeminiErrorStatus
} from "../_shared/performanceLogger.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Model priority: gemini-2.5-flash as primary, gemini-2.0-flash as fallback
const GEMINI_MODELS_FALLBACK_ORDER = [
  'gemini-2.5-flash',
  'gemini-2.0-flash',
];

// Exponential backoff configuration
const RETRY_CONFIG = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 8000,
  backoffMultiplier: 2,
  retryableStatuses: [429, 503, 504],
};

// DB-managed API key interface
interface ApiKeyRecord {
  id: string;
  provider: string;
  key_value: string;
  is_active: boolean;
  error_count: number;
}

// Error classification for specific user messages
interface GeminiErrorInfo {
  code: string;
  userMessage: string;
  isQuota: boolean;
  isRateLimit: boolean;
  isInvalidKey: boolean;
}

function classifyGeminiError(status: number, errorText: string): GeminiErrorInfo {
  const lower = errorText.toLowerCase();
  
  if (status === 429 || lower.includes('quota') || lower.includes('resource_exhausted')) {
    return {
      code: 'QUOTA_EXCEEDED',
      userMessage: 'Gemini API quota exceeded. Please wait a few minutes or check your Google AI Studio billing.',
      isQuota: true,
      isRateLimit: false,
      isInvalidKey: false,
    };
  }
  
  if (lower.includes('rate limit') || lower.includes('too many requests')) {
    return {
      code: 'RATE_LIMITED',
      userMessage: 'Too many requests to Gemini API. Please wait 30 seconds and try again.',
      isQuota: false,
      isRateLimit: true,
      isInvalidKey: false,
    };
  }
  
  if (status === 400 && (lower.includes('api_key') || lower.includes('api key'))) {
    return {
      code: 'INVALID_API_KEY',
      userMessage: 'Invalid Gemini API key. Please update your API key in Settings.',
      isQuota: false,
      isRateLimit: false,
      isInvalidKey: true,
    };
  }
  
  if (status === 403) {
    return {
      code: 'PERMISSION_DENIED',
      userMessage: 'Gemini API access denied. Your API key may not have permissions for this model.',
      isQuota: false,
      isRateLimit: false,
      isInvalidKey: false,
    };
  }
  
  if (status === 503) {
    return {
      code: 'SERVICE_UNAVAILABLE',
      userMessage: 'Gemini API is temporarily unavailable. Please try again in a few minutes.',
      isQuota: false,
      isRateLimit: false,
      isInvalidKey: false,
    };
  }
  
  return {
    code: 'GEMINI_ERROR',
    userMessage: 'Gemini API error. Please try again.',
    isQuota: false,
    isRateLimit: false,
    isInvalidKey: false,
  };
}

// Fetch active Gemini keys from api_keys table with rotation support AND quota filtering
async function getActiveGeminiKeys(supabaseServiceClient: any): Promise<ApiKeyRecord[]> {
  // Use the shared utility that filters out quota-exhausted keys for 'flash_2_5' model type
  return await getActiveGeminiKeysForModel(supabaseServiceClient, 'flash_2_5');
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
    console.error('[evaluate-ai-speaking-part] Failed to update key error count:', err);
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
    console.error('[evaluate-ai-speaking-part] Failed to reset key error count:', err);
  }
}

interface PartEvaluationRequest {
  testId: string;
  partNumber: 1 | 2 | 3;
  audioData: Record<string, string>;
  durations?: Record<string, number>;
  questions: Array<{
    id: string;
    question_number: number;
    question_text: string;
  }>;
  cueCardTopic?: string;
  cueCardContent?: string;
  instruction?: string;
  topic?: string;
  difficulty?: string;
}

serve(async (req) => {
  const startTime = Date.now();
  console.log(`[evaluate-ai-speaking-part] Request received at ${new Date().toISOString()}`);
  
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
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

    // Create service client for API key pool access
    const supabaseServiceClient = createClient(supabaseUrl, supabaseServiceKey);

    // Get user
    const { data: { user }, error: authError } = await supabaseClient.auth.getUser();
    if (authError || !user) {
      console.error('[evaluate-ai-speaking-part] Auth error:', authError?.message);
      return new Response(JSON.stringify({ error: 'Unauthorized', code: 'UNAUTHORIZED' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    console.log(`[evaluate-ai-speaking-part] User authenticated: ${user.id}`);

    if (!appEncryptionKey) {
      console.error('[evaluate-ai-speaking-part] app_encryption_key not set');
      return new Response(JSON.stringify({
        error: 'Server configuration error: encryption key not set.',
        code: 'SERVER_CONFIG_ERROR'
      }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Try to get user's own Gemini API key first
    let geminiApiKey: string | null = null;
    let userApiKey: string | null = null;
    let usingUserKey = false;
    let poolKeys: ApiKeyRecord[] = [];
    let currentPoolKeyIndex = 0;
    let currentPoolKeyId: string | null = null;

    // Always load pool keys - we'll need them as fallback
    poolKeys = await getActiveGeminiKeys(supabaseServiceClient);
    console.log(`[evaluate-ai-speaking-part] Found ${poolKeys.length} active pool keys`);

    const { data: userSecret } = await supabaseClient
      .from('user_secrets')
      .select('encrypted_value')
      .eq('user_id', user.id)
      .eq('secret_name', 'GEMINI_API_KEY')
      .single();

    if (userSecret?.encrypted_value) {
      try {
        // Decrypt user's API key
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
        console.log('[evaluate-ai-speaking-part] User API key found, will try it first');
      } catch (decryptErr) {
        console.error('[evaluate-ai-speaking-part] Failed to decrypt user key:', decryptErr);
      }
    }

    // If no user key, try pool keys
    if (!geminiApiKey && poolKeys.length > 0) {
      geminiApiKey = poolKeys[0].key_value;
      currentPoolKeyId = poolKeys[0].id;
      console.log('[evaluate-ai-speaking-part] Using pool key (rotation enabled)');
    }

    if (!geminiApiKey) {
      console.error('[evaluate-ai-speaking-part] No Gemini API key available');
      return new Response(JSON.stringify({
        error: 'Gemini API key not found. Please set it in Settings.',
        code: 'API_KEY_NOT_FOUND'
      }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Parse request body
    const body: PartEvaluationRequest = await req.json();
    const { testId, partNumber, audioData, durations, questions, cueCardTopic, cueCardContent, instruction, topic, difficulty } = body;

    if (!testId || !partNumber || !audioData || typeof audioData !== 'object') {
      console.error('[evaluate-ai-speaking-part] Bad request: missing required fields');
      return new Response(JSON.stringify({ error: 'Missing required fields', code: 'BAD_REQUEST' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const audioKeys = Object.keys(audioData);
    console.log(`[evaluate-ai-speaking-part] Test: ${testId}, Part: ${partNumber}, User: ${user.id}`);
    console.log(`[evaluate-ai-speaking-part] Audio segments: ${audioKeys.length}`);

    // Upload audio to R2 and get URLs
    const audioUrls: Record<string, string> = {};
    
     for (const key of audioKeys) {
       try {
         const value = audioData[key];
         const { mimeType, base64 } = parseDataUrl(value);
         const duration = durations?.[key];

         // Skip truly empty payloads only (small answers can still be valid speech)
         if (!base64 || base64.length < 100) {
           console.log(
             `[evaluate-ai-speaking-part][audio] skip (too small) key=${key} mime=${mimeType} b64Len=${base64?.length ?? 0} dur=${typeof duration === 'number' ? duration.toFixed(2) : 'n/a'} head=${describeBase64(base64)}`,
           );
           continue;
         }

         console.log(
           `[evaluate-ai-speaking-part][audio] recv key=${key} mime=${mimeType} b64Len=${base64.length} dur=${typeof duration === 'number' ? duration.toFixed(2) : 'n/a'} head=${describeBase64(base64)}`,
         );

         const audioBytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
         console.log(
           `[evaluate-ai-speaking-part][audio] bytes key=${key} bytesLen=${audioBytes.length} container=${detectAudioContainer(audioBytes)} first16=${bytesToHex(audioBytes.slice(0, 16))}`,
         );

         const ext = mimeType === 'audio/mpeg' ? 'mp3' : 'webm';
         const r2Key = `speaking-audios/ai-speaking/${user.id}/${testId}/${key}.${ext}`;

         const result = await uploadToR2(r2Key, audioBytes, mimeType);
         if (result.success && result.url) {
           audioUrls[key] = result.url;
           console.log(`[evaluate-ai-speaking-part] Uploaded audio to R2: ${r2Key}`);
         } else {
           console.warn(`[evaluate-ai-speaking-part] Upload failed for ${key}:`, result.error);
         }
       } catch (err) {
         console.error(`Failed to upload audio for ${key}:`, err);
       }
     }

    // Build Gemini prompt for this single part
    const contents = buildPartEvaluationContents({
      partNumber,
      audioData,
      questions,
      cueCardTopic,
      cueCardContent,
      instruction,
      topic,
      difficulty,
    });

    // Call Gemini API with rotation support
    let evaluationRaw: any = null;
    let usedModel: string | null = null;
    let lastError: GeminiErrorInfo = {
      code: 'UNKNOWN_ERROR',
      userMessage: 'Failed to evaluate speaking part. Please try again.',
      isQuota: false,
      isRateLimit: false,
      isInvalidKey: false,
    };
    const GEMINI_TIMEOUT_MS = 90_000;
    
    // Create performance logger for this task
    const perfLogger = createPerformanceLogger('evaluate_speaking');

    console.log(`[evaluate-ai-speaking-part] Starting Gemini API call for Part ${partNumber}`);

    let userKeyFailed = false;

    // Function to attempt Gemini with models
    async function tryGeminiWithKey(apiKey: string, keyId: string | null): Promise<boolean> {
      for (const modelName of GEMINI_MODELS_FALLBACK_ORDER) {
        console.log(`[evaluate-ai-speaking-part] Attempting model: ${modelName}`);
        const modelCallStart = Date.now();
        const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(apiKey)}`;

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
                maxOutputTokens: 6000,
                responseMimeType: 'application/json',
              },
            }),
          });
          
          clearTimeout(timeoutId);
          console.log(`[evaluate-ai-speaking-part] Gemini ${modelName} response status: ${geminiResponse.status}`);

          if (!geminiResponse.ok) {
            const errorText = await geminiResponse.text();
            console.error(`[evaluate-ai-speaking-part] Gemini ${modelName} error:`, errorText.slice(0, 300));
            
            const errorInfo = classifyGeminiError(geminiResponse.status, errorText);
            lastError = errorInfo;

            // Handle pool key errors
            if (keyId) {
              if (errorInfo.isInvalidKey) {
                const modelCallEnd = Date.now() - modelCallStart;
                await perfLogger.logError(modelName, errorText.slice(0, 200), modelCallEnd, keyId);
                await incrementKeyErrorCount(supabaseServiceClient, keyId, true);
                return false; // Try next pool key
              } else if (errorInfo.isQuota || errorInfo.isRateLimit) {
                const modelCallEnd = Date.now() - modelCallStart;
                await perfLogger.logQuotaExceeded(modelName, errorText.slice(0, 200), keyId);
                // Mark this key as quota exhausted for flash_2_5 model - prevents reuse today
                await markKeyQuotaExhausted(supabaseServiceClient, keyId, 'flash_2_5');
                await incrementKeyErrorCount(supabaseServiceClient, keyId);
                console.log(`[evaluate-ai-speaking-part] Key ${keyId} marked as quota exhausted`);
                return false; // Try next pool key
              }
            }

            // For user key quota/rate limit, signal to fallback to pool
            if (usingUserKey && (errorInfo.isQuota || errorInfo.isRateLimit)) {
              console.log('[evaluate-ai-speaking-part] User key quota/rate limited, will try pool keys');
              userKeyFailed = true;
              return false;
            }

            // For invalid user key, fail with specific message
            if (usingUserKey && errorInfo.isInvalidKey) {
              return false; // Will return specific error after
            }

            continue; // Try next model
          }

          const data = await geminiResponse.json();
          const responseText = data?.candidates?.[0]?.content?.parts
            ?.map((p: any) => p?.text)
            .filter(Boolean)
            .join('\n');

          if (!responseText) {
            console.error(`[evaluate-ai-speaking-part] No response text from ${modelName}`);
            continue;
          }

          evaluationRaw = parseJsonFromResponse(responseText);
          if (evaluationRaw) {
            usedModel = modelName;
            const modelCallEnd = Date.now() - modelCallStart;
            
            // Log successful performance
            await perfLogger.logSuccess(modelName, modelCallEnd, keyId ?? undefined);
            
            console.log(`[evaluate-ai-speaking-part] Successfully evaluated Part ${partNumber} with model: ${modelName}`);
            
            // Reset error count on success for pool keys
            if (keyId) {
              await resetKeyErrorCount(supabaseServiceClient, keyId);
            }
            return true;
          }
        } catch (err: any) {
          const modelCallEnd = Date.now() - modelCallStart;
          if (err.name === 'AbortError') {
            console.error(`[evaluate-ai-speaking-part] Timeout with model ${modelName}`);
            await perfLogger.logError(modelName, 'Request timed out', modelCallEnd, keyId ?? undefined);
          } else {
            console.error(`[evaluate-ai-speaking-part] Error with model ${modelName}:`, err.message);
            await perfLogger.logError(modelName, err.message ?? 'Unknown error', modelCallEnd, keyId ?? undefined);
          }
          continue;
        }
      }
      return false;
    }

    // Try with user's key first
    let success = false;
    if (usingUserKey && userApiKey) {
      success = await tryGeminiWithKey(userApiKey, null);
    }

    // If user key failed due to quota, fallback to pool keys
    if (!success && userKeyFailed && poolKeys.length > 0) {
      console.log('[evaluate-ai-speaking-part] Falling back to admin pool keys');
      usingUserKey = false;
      currentPoolKeyIndex = 0;
      currentPoolKeyId = poolKeys[0].id;
      geminiApiKey = poolKeys[0].key_value;
      success = await tryGeminiWithKey(geminiApiKey, currentPoolKeyId);
    }

    // If not using user key (or initial pool key failed), try rotating pool keys
    if (!success && !usingUserKey && poolKeys.length > 0) {
      for (let i = (userKeyFailed ? 1 : 0); i < Math.min(poolKeys.length, 3) && !success; i++) {
        currentPoolKeyIndex = i;
        currentPoolKeyId = poolKeys[i].id;
        geminiApiKey = poolKeys[i].key_value;
        console.log(`[evaluate-ai-speaking-part] Trying pool key ${i + 1}/${poolKeys.length}`);
        success = await tryGeminiWithKey(geminiApiKey, currentPoolKeyId);
      }
    }

    if (!evaluationRaw) {
      console.error('[evaluate-ai-speaking-part] All models/keys failed to evaluate');
      const errorMessage = lastError.userMessage;
      const errorCode = lastError.code;
      return new Response(JSON.stringify({ error: errorMessage, code: errorCode }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Retry transcripts that came back as "No speech detected" even though we have audio.
    const transcriptsInitial = (evaluationRaw.transcripts || {}) as Record<string, string>;
    const transcriptsRefined = await retryTranscriptionForNoSpeechPart({
      transcriptsMap: transcriptsInitial,
      audioData,
      durations,
      apiKey: geminiApiKey,
      preferredModel: usedModel ?? undefined,
    });

    // Build the partial result
    const partResult = {
      partNumber,
      audioUrls,
      transcripts: transcriptsRefined,
      criteriaScores: {
        fluencyCoherence: evaluationRaw.fluencyCoherence || { score: 0, feedback: '' },
        lexicalResource: evaluationRaw.lexicalResource || { score: 0, feedback: '' },
        grammaticalRange: evaluationRaw.grammaticalRange || { score: 0, feedback: '' },
        pronunciation: evaluationRaw.pronunciation || { score: 0, feedback: '' },
      },
      partAnalysis: {
        strengths: evaluationRaw.strengths || [],
        improvements: evaluationRaw.improvements || [],
        feedback: evaluationRaw.partFeedback || '',
      },
      modelAnswers: normalizeModelAnswers(evaluationRaw.modelAnswers || []),
      usedModel,
    };

    const elapsed = Date.now() - startTime;
    console.log(`[evaluate-ai-speaking-part] Part ${partNumber} completed in ${elapsed}ms`);

    return new Response(JSON.stringify({
      success: true,
      partResult,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: unknown) {
    const elapsed = Date.now() - startTime;
    console.error(`[evaluate-ai-speaking-part] Error after ${elapsed}ms:`, error);
    const errorMessage = error instanceof Error ? error.message : 'Evaluation failed';
    return new Response(JSON.stringify({ error: errorMessage, code: 'EVALUATION_ERROR' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

// Normalize model answers to ensure ALL band levels exist
function normalizeModelAnswers(rawModelAnswers: any[]): any[] {
  if (!Array.isArray(rawModelAnswers)) return [];
  
  return rawModelAnswers.map((ma: any) => {
    const candidateResponse = ma.candidateResponse ?? ma.candidate_response ?? '';
    const ensureArray = (val: any) => (Array.isArray(val) ? val : []);
    
    return {
      ...ma,
      questionNumber: ma.questionNumber ?? ma.question_number ?? 1,
      question: ma.question ?? '',
      candidateResponse,
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
}

function parseDataUrl(value: string): { mimeType: string; base64: string } {
  if (!value) return { mimeType: 'audio/webm', base64: '' };

  if (value.startsWith('data:')) {
    const commaIdx = value.indexOf(',');
    const header = commaIdx >= 0 ? value.slice(5, commaIdx) : value.slice(5);
    const base64 = commaIdx >= 0 ? value.slice(commaIdx + 1) : '';

    const semiIdx = header.indexOf(';');
    const mimeType = (semiIdx >= 0 ? header.slice(0, semiIdx) : header).trim() || 'audio/webm';

    return { mimeType, base64 };
  }

  return { mimeType: 'audio/webm', base64: value };
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function detectAudioContainer(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return 'mp3(id3)';
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return 'mp3(frame-sync)';
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'webm/ebml';

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
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
    return JSON.parse(responseText);
  } catch (err) {
    console.error('Error parsing evaluation response:', err);
    return null;
  }
}

function buildPartEvaluationContents(input: {
  partNumber: 1 | 2 | 3;
  audioData: Record<string, string>;
  questions: Array<{ id: string; question_number: number; question_text: string }>;
  cueCardTopic?: string;
  cueCardContent?: string;
  instruction?: string;
  topic?: string;
  difficulty?: string;
}): Array<{ parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> }> {
  const { partNumber, audioData, questions, cueCardTopic, cueCardContent, instruction, topic, difficulty } = input;

  const contents: Array<{ parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> }> = [];

  // System prompt for single part evaluation
  contents.push({
    parts: [{
      text: `You are an expert IELTS Speaking examiner (2025 standard). You will evaluate Part ${partNumber} of a speaking test.

${topic ? `TEST TOPIC: ${topic}` : ''}
${difficulty ? `DIFFICULTY: ${difficulty}` : ''}

Listen to the audio for each question and:
1. Transcribe the candidate's speech accurately (INCLUDING very short utterances)
2. Evaluate based on IELTS criteria
3. Provide specific feedback for this part
4. Generate a model answer for EVERY question

TRANSCRIPTION RULES:
- Transcribe even 1–2 word answers (e.g., "Yes", "No", "Let me think").
- Only write "No speech detected" if the audio is essentially silent (no discernible spoken words).
- If unclear, write your best guess and append " [unclear]".

CRITICAL SCORING GUIDELINES (USE CONSISTENTLY - SAME SCALE AS FULL TEST):
Score each criterion INDEPENDENTLY. Use the same scoring standard as a full test evaluation:
- Band 9: Native-level performance
- Band 7: Good user with occasional inaccuracies  
- Band 5: Modest user with noticeable limitations
- Band 3: Limited user with frequent errors

IMPORTANT: Do NOT inflate scores just because this is a single part. Apply the EXACT same standards as a full test.
Use half-band scores (5.5, 6.5, 7.5) when appropriate.

MODEL ANSWERS REQUIREMENT:
You MUST provide FOUR model answers for EVERY question in this part at Band 6, 7, 8, and 9 levels:
- candidateResponse: What the candidate actually said
- modelAnswerBand6: A Band 6 response showing competent but limited language use
- modelAnswerBand7: A solid Band 7 response that is good but has minor limitations
- modelAnswerBand8: An exemplary Band 8 response with sophisticated language
- modelAnswerBand9: A near-native Band 9 response with exceptional fluency and precision
- whyBand6Works: Array of reasons why this Band 6 answer is effective at that level
- whyBand7Works: Array of reasons why this Band 7 answer is effective at that level
- whyBand8Works: Array of reasons why this Band 8 answer is effective at that level
- whyBand9Works: Array of reasons why this Band 9 answer is effective at that level

MANDATORY WORD COUNT REQUIREMENTS FOR MODEL ANSWERS (STRICT - REGARDLESS OF CANDIDATE RESPONSE LENGTH):
- Part 1 model answers: 60-85 words per question (natural, conversational with personal examples)
- Part 2 model answers: 260-340 words (comprehensive long turn covering all cue card points with detail)
- Part 3 model answers: 130-170 words per question (in-depth discussion with reasoning and examples)
These word counts are MINIMUM STANDARDS. Even if the candidate gave a very short or no response, YOUR model answers MUST meet these lengths.
Model answers should demonstrate ideal IELTS response structure, vocabulary, and fluency for each band level.

Respond with JSON in this exact format:
{
  "fluencyCoherence": { "score": number, "feedback": string },
  "lexicalResource": { "score": number, "feedback": string },
  "grammaticalRange": { "score": number, "feedback": string },
  "pronunciation": { "score": number, "feedback": string },
  "strengths": string[],
  "improvements": string[],
  "partFeedback": string,
  "modelAnswers": [{"questionNumber": number, "question": string, "candidateResponse": string, "modelAnswerBand6": string, "modelAnswerBand7": string, "modelAnswerBand8": string, "modelAnswerBand9": string, "whyBand6Works": string[], "whyBand7Works": string[], "whyBand8Works": string[], "whyBand9Works": string[]}],
  "transcripts": { "part${partNumber}-q<id>": string }
}

CRITICAL MANDATORY REQUIREMENTS FOR MODEL ANSWERS:
1. The "modelAnswers" array MUST contain an entry for EVERY question in this part - NO EXCEPTIONS.
2. Each entry MUST include ALL FOUR band levels: modelAnswerBand6, modelAnswerBand7, modelAnswerBand8, modelAnswerBand9.
3. Each entry MUST include ALL FOUR whyBandXWorks arrays: whyBand6Works, whyBand7Works, whyBand8Works, whyBand9Works.
4. NEVER skip or omit any band level - all four are MANDATORY for every question.
5. If any band level is missing, the response will be REJECTED and must be regenerated.
6. Each whyBandXWorks array should have 2-4 specific reasons.`,
    }],
  });

  // Part context
  contents.push({
    parts: [{
      text: `\n=== PART ${partNumber} ===\n${instruction ? `Instruction: ${instruction}\n` : ''}`,
    }],
  });

  // Part 2 cue card
  if (partNumber === 2) {
    if (cueCardTopic) {
      contents.push({ parts: [{ text: `Cue Card Topic: ${cueCardTopic}\n` }] });
    }
    if (cueCardContent) {
      contents.push({ parts: [{ text: `Cue Card Content:\n${cueCardContent}\n` }] });
    }
  }

  // Questions and audio
  for (const q of questions) {
    const audioKey = `part${partNumber}-q${q.id}`;
    contents.push({
      parts: [{ text: `\nQuestion ${q.question_number}: ${q.question_text}\nAudio key: ${audioKey}\n` }],
    });

     const rawAudio = audioData[audioKey];
     const hasKey = Object.prototype.hasOwnProperty.call(audioData, audioKey);
     const rawType = rawAudio === null ? 'null' : typeof rawAudio;
     const rawHead = typeof rawAudio === 'string' ? rawAudio.slice(0, 40).replace(/\s/g, '') : 'n/a';
     const { mimeType, base64 } = parseDataUrl(rawAudio || '');

     console.log(
       `[evaluate-ai-speaking-part][gemini-input] key=${audioKey} hasKey=${hasKey} rawType=${rawType} rawHead=${rawHead} hasAudio=${Boolean(rawAudio)} mime=${mimeType} b64Len=${base64?.length ?? 0} head=${describeBase64(base64)}`,
     );

     // Small clips are common in Part 1/3; accept them.
     if (base64 && base64.length > 100) {
       const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
       console.log(
         `[evaluate-ai-speaking-part][gemini-inline] key=${audioKey} mime=${mimeType} b64Len=${base64.length} bytesLen=${bytes.length} container=${detectAudioContainer(bytes)} first16=${bytesToHex(bytes.slice(0, 16))}`,
       );

       contents.push({ parts: [{ inlineData: { mimeType, data: base64 } }] });
       contents.push({
         parts: [{
           text: `Transcribe and evaluate this audio for key "${audioKey}".`,
         }],
       });
     } else {
       console.log(
         `[evaluate-ai-speaking-part][gemini-inline] key=${audioKey} NOT_SENT reason=${!hasKey ? 'missing_key' : 'empty_or_too_small'} mime=${mimeType} b64Len=${base64?.length ?? 0}`,
       );

       contents.push({
         parts: [{
           text: `No usable audio for ${audioKey}. Set transcripts["${audioKey}"] = "No speech detected".`,
         }],
       });
     }
  }

  contents.push({
    parts: [{
      text: `\nReturn ONLY a single valid JSON object. Do not add markdown.`,
    }],
  });

  return contents;
}

async function retryTranscriptionForNoSpeechPart(input: {
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
    // Only retry for clips that should contain something (avoid noisy 0.2s taps).
    return typeof dur !== 'number' || dur >= 0.7;
  });

  if (keysToRetry.length === 0) return transcriptsMap;

  // Keep payload bounded.
  const limitedKeys = keysToRetry.slice(0, 8);
  console.log(`[evaluate-ai-speaking-part][retry-stt] Retrying transcripts for ${limitedKeys.length}/${keysToRetry.length} keys`);

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
        console.error(`[evaluate-ai-speaking-part][retry-stt] Gemini ${modelName} failed:`, errText.slice(0, 300));
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
        console.log(`[evaluate-ai-speaking-part][retry-stt] Updated ${replaced}/${limitedKeys.length} transcripts using ${modelName}`);
        break;
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        console.error(`[evaluate-ai-speaking-part][retry-stt] Timeout on model ${modelName}`);
      } else {
        console.error(`[evaluate-ai-speaking-part][retry-stt] Error on model ${modelName}:`, err?.message ?? err);
      }
    }
  }

  return transcriptsMap;
}

