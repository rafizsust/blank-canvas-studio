import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { GoogleGenerativeAI } from "https://esm.sh/@google/generative-ai@0.21.0";
import { 
  getActiveGeminiKeysForModel, 
  markKeyQuotaExhausted,
  isQuotaExhaustedError
} from "../_shared/apiKeyQuotaUtils.ts";
import { getFromR2 } from "../_shared/r2Client.ts";
import { crypto } from "https://deno.land/std@0.168.0/crypto/mod.ts";


/**
 * SYNC Speaking Evaluation Edge Function for AI Practice Tests
 * 
 * This function uses inline base64 audio data for Gemini evaluation.
 * It waits for the complete evaluation and returns results directly.
 * 
 * Key Features:
 * - Uses inline data (no File API) for Deno compatibility
 * - Immediate key rotation on quota errors (no wasteful retries)
 * - Works with ai_practice_tests table (not speaking_submissions)
 * - Returns full evaluation result synchronously
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-gemini-api-key',
};

// Model priority: 2.5 Flash only (2.0-flash deprecated, 1.5-pro removed from API)
const GEMINI_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.0-flash',
];

// Custom error class for quota exhaustion / rate limiting
class QuotaError extends Error {
  permanent: boolean;
  retryAfterSeconds?: number;

  constructor(message: string, opts: { permanent: boolean; retryAfterSeconds?: number }) {
    super(message);
    this.name = 'QuotaError';
    this.permanent = opts.permanent;
    this.retryAfterSeconds = opts.retryAfterSeconds;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractRetryAfterSeconds(err: any): number | undefined {
  const msg = String(err?.message || err || '');

  // Gemini sometimes includes: retryDelay":"56s" OR "Please retry in 56.7s"
  const m1 = msg.match(/retryDelay"\s*:\s*"(\d+)s"/i);
  if (m1) return Math.max(0, Number(m1[1]));

  const m2 = msg.match(/retry\s+in\s+([0-9.]+)s/i);
  if (m2) return Math.max(0, Math.ceil(Number(m2[1])));

  return undefined;
}

function isPermanentQuotaExhausted(err: any): boolean {
  const msg = String(err?.message || err || '').toLowerCase();

  // Signals that waiting won't help (billing/quota disabled or hard daily cap)
  if (msg.includes('check your plan') || msg.includes('billing')) return true;
  if (msg.includes('limit: 0')) return true;
  if (msg.includes('per day') && !msg.includes('retry')) return true;

  return false;
}

// Convert Uint8Array to base64 string
function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// Download audio from R2 and return as base64 data
async function downloadAudioFromR2(filePath: string): Promise<{ base64Data: string; mimeType: string }> {
  console.log(`[evaluate-speaking-submission] Downloading from R2: ${filePath}`);
  
  const result = await getFromR2(filePath);
  if (!result.success || !result.bytes) {
    throw new Error(`Failed to download audio from R2: ${result.error}`);
  }
  
  const ext = filePath.split('.').pop()?.toLowerCase() || 'webm';
  const mimeType = ext === 'mp3' ? 'audio/mpeg' : 'audio/webm';
  
  // Convert Uint8Array to base64 string for inline data
  const base64Data = uint8ArrayToBase64(result.bytes);
  
  console.log(`[evaluate-speaking-submission] Downloaded: ${filePath} (${result.bytes.length} bytes)`);
  return { base64Data, mimeType };
}

// Decrypt user API key
async function decryptKey(encrypted: string, appKey: string): Promise<string> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const keyData = encoder.encode(appKey).slice(0, 32);
  const cryptoKey = await crypto.subtle.importKey('raw', keyData, { name: 'AES-GCM' }, false, ['decrypt']);
  const bytes = Uint8Array.from(atob(encrypted), c => c.charCodeAt(0));
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, cryptoKey, bytes.slice(12));
  return decoder.decode(decrypted);
}

// Build evaluation prompt with mentor-style model answers
function buildPrompt(
  payload: any,
  topic: string | undefined,
  difficulty: string | undefined,
  fluencyFlag: boolean | undefined,
  orderedSegments: Array<{ segmentKey: string; partNumber: 1 | 2 | 3; questionNumber: number; questionText: string }>,
): string {
  const parts = Array.isArray(payload?.speakingParts) ? payload.speakingParts : [];
  const questions = parts
    .flatMap((p: any) =>
      (Array.isArray(p?.questions)
        ? p.questions.map((q: any) => ({
            id: String(q?.id || ''),
            part_number: Number(p?.part_number),
            question_number: Number(q?.question_number),
            question_text: String(q?.question_text || ''),
          }))
        : []),
    )
    .filter((q: any) => q.part_number === 1 || q.part_number === 2 || q.part_number === 3);

  const questionJson = JSON.stringify(questions);
  const segmentJson = JSON.stringify(orderedSegments);

  return [
    `You are a strict, professional IELTS Speaking examiner and mentor (2025 criteria).`,
    `Your job: produce COMPLETE evaluation for EVERY recorded question, acting like a real mentor who shows the NEXT ACHIEVABLE LEVEL.`,
    `Topic: ${topic || 'General'}. Difficulty: ${difficulty || 'Medium'}.`,
    fluencyFlag
      ? `Important: Part 2 speaking was under 80 seconds; reflect this in Fluency & Coherence feedback.`
      : null,
    ``,
    `CRITICAL OUTPUT RULES:`,
    `- Return STRICT JSON ONLY (no markdown, no backticks).`,
    `- You MUST include transcripts + model answers for ALL questions listed in segment_map_json.`,
    `- If speech is unclear, use "(inaudible)" for missing words but still return an entry.`,
    `- Keep answers realistic and aligned to band descriptors.`,
    ``,
    `MODEL ANSWER STRATEGY (IMPORTANT):`,
    `For EACH question, you will assess what band the candidate achieved for THAT SPECIFIC response.`,
    `Then provide ONE model answer that is exactly ONE band higher - the NEXT achievable level.`,
    `- If candidate achieved Band 4-5 on a question → provide a Band 6 model answer`,
    `- If candidate achieved Band 5-6 on a question → provide a Band 7 model answer`,
    `- If candidate achieved Band 6-7 on a question → provide a Band 8 model answer`,
    `- If candidate achieved Band 8+ on a question → provide a Band 9 model answer`,
    `This is how a real mentor helps students improve - by showing them the next step, not overwhelming them with all levels.`,
    ``,
    `SCORING CONSISTENCY (CRITICAL):`,
    `- You MUST evaluate every answer; do NOT award an overall band based on the best answer only.`,
    `- If an answer is extremely short (e.g., "test", 1–3 words) treat it as a near non-response and penalize band for that question.`,
    `- Set modelAnswers[].estimatedBand for EVERY segment and ensure it reflects the actual response quality.`,
    `- Compute overall_band as a weighted average of estimatedBand across all segments (Part 2 weight 2.0, Part 3 weight 1.5, Part 1 weight 1.0), then round to nearest 0.5.`,
    `- overall_band should be consistent with criteria bands (no big mismatch).`,
    ``,
    `Return this exact schema and key names:`,
    `{`,
    `  "overall_band": 6.5,`,
    `  "criteria": {`,
    `    "fluency_coherence": { "band": 6.5, "feedback": "...", "strengths": ["..."], "weaknesses": ["..."], "suggestions": ["..."] },`,
    `    "lexical_resource": { "band": 6.5, "feedback": "...", "strengths": ["..."], "weaknesses": ["..."], "suggestions": ["..."] },`,
    `    "grammatical_range": { "band": 6.5, "feedback": "...", "strengths": ["..."], "weaknesses": ["..."], "suggestions": ["..."] },`,
    `    "pronunciation": { "band": 6.5, "feedback": "...", "strengths": ["..."], "weaknesses": ["..."], "suggestions": ["..."] }`,
    `  },`,
    `  "summary": "1-3 sentences overall summary",`,
    `  "improvements": ["Top 5 actionable improvements"],`,
    `  "transcripts_by_part": { "1": "...", "2": "...", "3": "..." },`,
    `  "transcripts_by_question": {`,
    `    "1": [{"segment_key":"part1-q...","question_number":1,"question_text":"...","transcript":"..."}],`,
    `    "2": [{"segment_key":"part2-q...","question_number":5,"question_text":"...","transcript":"..."}],`,
    `    "3": [{"segment_key":"part3-q...","question_number":9,"question_text":"...","transcript":"..."}]`,
    `  },`,
    `  "modelAnswers": [{`,
    `    "segment_key": "part1-q...",`,
    `    "partNumber": 1,`,
    `    "questionNumber": 1,`,
    `    "question": "...",`,
    `    "candidateResponse": "(copy from transcript)",`,
    `    "estimatedBand": 6.0,`,
    `    "targetBand": 7,`,
    `    "modelAnswer": "A Band 7 level answer showing the next achievable level...",`,
    `    "whyItWorks": ["Specific feature 1 that makes this a Band 7 answer", "Feature 2", "..."],`,
    `    "keyImprovements": ["What the candidate should focus on to reach this level"]`,
    `  }]`,
    `}`,
    ``,
    `You will receive (JSON):`,
    `- questions_json: all questions in the test`,
    `- segment_map_json: the recorded segments you MUST cover (this is the source of truth for completeness)`,
    ``,
    `questions_json: ${questionJson}`,
    `segment_map_json: ${segmentJson}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function parseJson(text: string): any {
  try { return JSON.parse(text); } catch {}
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (match) try { return JSON.parse(match[1].trim()); } catch {}
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch) try { return JSON.parse(objMatch[0]); } catch {}
  return null;
}

function calculateBand(result: any): number {
  const c = result.criteria;
  if (!c) return 6.0;
  const scores = [
    c.fluency_coherence?.band,
    c.lexical_resource?.band,
    c.grammatical_range?.band,
    c.pronunciation?.band,
  ].filter(s => typeof s === 'number');

  if (scores.length === 0) return 6.0;

  const avg = scores.reduce((a: number, b: number) => a + b, 0) / scores.length;
  return Math.round(avg * 2) / 2; // Round to nearest 0.5
}

function computeOverallBandFromQuestionBands(result: any): number | null {
  const modelAnswers = Array.isArray(result?.modelAnswers) ? result.modelAnswers : [];
  const bands = modelAnswers
    .map((a: any) => ({
      part: Number(a?.partNumber),
      band: typeof a?.estimatedBand === 'number' ? a.estimatedBand : Number(a?.estimatedBand),
    }))
    .filter((x: any) => (x.part === 1 || x.part === 2 || x.part === 3) && Number.isFinite(x.band));

  if (!bands.length) return null;

  const weightForPart = (p: number) => (p === 2 ? 2.0 : p === 3 ? 1.5 : 1.0);
  const weighted = bands.reduce(
    (acc: { sum: number; w: number }, x: any) => {
      const w = weightForPart(x.part);
      return { sum: acc.sum + x.band * w, w: acc.w + w };
    },
    { sum: 0, w: 0 },
  );

  if (weighted.w <= 0) return null;

  const avg = weighted.sum / weighted.w;
  const rounded = Math.round(avg * 2) / 2;
  const clamped = Math.min(9, Math.max(1, rounded));
  return clamped;
}

serve(async (req) => {
  console.log(`[evaluate-speaking-submission] Request at ${new Date().toISOString()}`);
  
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const appEncryptionKey = Deno.env.get('app_encryption_key')!;
    const r2PublicUrl = Deno.env.get('R2_PUBLIC_URL') || '';

    const supabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: req.headers.get('Authorization')! } },
    });

    const supabaseService = createClient(supabaseUrl, supabaseServiceKey);

    const { data: { user } } = await supabaseClient.auth.getUser();

    if (!user) {
      return new Response(JSON.stringify({ error: 'Unauthorized', code: 'UNAUTHORIZED' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { testId, filePaths, durations, topic, difficulty, fluencyFlag } = await req.json();

    if (!testId || !filePaths || Object.keys(filePaths).length === 0) {
      console.error('[evaluate-speaking-submission] Missing testId or filePaths');
      return new Response(JSON.stringify({ error: 'Missing testId or filePaths', code: 'BAD_REQUEST' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`[evaluate-speaking-submission] Received ${Object.keys(filePaths).length} files for test ${testId}`);

    // Fetch test payload from ai_practice_tests
    const { data: testRow, error: testError } = await supabaseService
      .from('ai_practice_tests')
      .select('payload, topic, difficulty, preset_id')
      .eq('id', testId)
      .eq('user_id', user.id)
      .maybeSingle();

    if (testError || !testRow) {
      return new Response(JSON.stringify({ error: 'Test not found or unauthorized', code: 'TEST_NOT_FOUND' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    let payload = testRow.payload as any || {};

    // Fetch preset content if needed
    if (testRow.preset_id && (!payload.speakingParts && !payload.part1)) {
      const { data: presetData } = await supabaseService
        .from('generated_test_audio')
        .select('content_payload')
        .eq('id', testRow.preset_id)
        .maybeSingle();
      
      if (presetData?.content_payload) {
        payload = presetData.content_payload;
      }
    }

    // Build segment metadata for completeness checking
    const parts = Array.isArray(payload?.speakingParts) ? payload.speakingParts : [];
    const questionById = new Map<string, { partNumber: 1 | 2 | 3; questionNumber: number; questionText: string }>();
    for (const p of parts) {
      const partNumber = Number(p?.part_number) as 1 | 2 | 3;
      if (partNumber !== 1 && partNumber !== 2 && partNumber !== 3) continue;
      const qs = Array.isArray(p?.questions) ? p.questions : [];
      for (const q of qs) {
        const id = String(q?.id || '');
        if (!id) continue;
        questionById.set(id, {
          partNumber,
          questionNumber: Number(q?.question_number),
          questionText: String(q?.question_text || ''),
        });
      }
    }

    const segmentMetaByKey = new Map<
      string,
      { segmentKey: string; partNumber: 1 | 2 | 3; questionNumber: number; questionText: string }
    >();

    for (const segmentKey of Object.keys(filePaths as Record<string, string>)) {
      const m = String(segmentKey).match(/^part([123])\-q(.+)$/);
      if (!m) continue;
      const partNumber = Number(m[1]) as 1 | 2 | 3;
      const questionId = m[2];
      const q = questionById.get(questionId);
      if (!q) continue;
      segmentMetaByKey.set(segmentKey, {
        segmentKey,
        partNumber,
        questionNumber: q.questionNumber,
        questionText: q.questionText,
      });
    }

    const orderedSegments = Array.from(segmentMetaByKey.values()).sort((a, b) => {
      if (a.partNumber !== b.partNumber) return a.partNumber - b.partNumber;
      return a.questionNumber - b.questionNumber;
    });

    // ============ BUILD API KEY QUEUE (Atomic Session Logic) ============
    interface KeyCandidate {
      key: string;
      keyId: string | null;
      isUserProvided: boolean;
    }

    const keyQueue: KeyCandidate[] = [];

    // 1. Check for user-provided key (header or user_secrets)
    const headerApiKey = req.headers.get('x-gemini-api-key');
    if (headerApiKey) {
      keyQueue.push({ key: headerApiKey, keyId: null, isUserProvided: true });
    } else {
      const { data: userSecret } = await supabaseClient
        .from('user_secrets')
        .select('encrypted_value')
        .eq('user_id', user.id)
        .eq('secret_name', 'GEMINI_API_KEY')
        .single();

      if (userSecret?.encrypted_value && appEncryptionKey) {
        try {
          const userKey = await decryptKey(userSecret.encrypted_value, appEncryptionKey);
          keyQueue.push({ key: userKey, keyId: null, isUserProvided: true });
        } catch (e) {
          console.warn('[evaluate-speaking-submission] Failed to decrypt user API key:', e);
        }
      }
    }

    // 2. Add admin keys from database
    const dbApiKeys = await getActiveGeminiKeysForModel(supabaseService, 'flash');
    for (const dbKey of dbApiKeys) {
      keyQueue.push({ key: dbKey.key_value, keyId: dbKey.id, isUserProvided: false });
    }

    if (keyQueue.length === 0) {
      return new Response(JSON.stringify({ error: 'No API key available. Please add your Gemini API key in Settings.', code: 'API_KEY_NOT_FOUND' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`[evaluate-speaking-submission] Key queue: ${keyQueue.length} keys (${keyQueue.filter(k => k.isUserProvided).length} user, ${keyQueue.filter(k => !k.isUserProvided).length} admin)`);

    // ============ DOWNLOAD FILES FROM R2 AS BASE64 ============
    const audioFiles: { key: string; base64Data: string; mimeType: string }[] = [];
    
    try {
      for (const [audioKey, r2Path] of Object.entries(filePaths as Record<string, string>)) {
        const { base64Data, mimeType } = await downloadAudioFromR2(r2Path);
        audioFiles.push({ key: audioKey, base64Data, mimeType });
      }
      console.log(`[evaluate-speaking-submission] Downloaded ${audioFiles.length} audio files as base64`);
    } catch (downloadError) {
      console.error('[evaluate-speaking-submission] Failed to download audio files:', downloadError);
      return new Response(JSON.stringify({ error: 'Failed to download audio files', code: 'R2_DOWNLOAD_ERROR' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Build the evaluation prompt
    const prompt = buildPrompt(
      payload,
      topic || testRow.topic,
      difficulty || testRow.difficulty,
      fluencyFlag,
      orderedSegments,
    );

    // ============ EVALUATION LOOP WITH KEY ROTATION ============
    let evaluationResult: any = null;
    let usedModel: string | null = null;
    let usedKey: KeyCandidate | null = null;

    // If we ONLY hit temporary rate limits, return a 429 with Retry-After (do not mark keys exhausted)
    let bestRetryAfterSeconds: number | null = null;
    let sawTemporaryRateLimit = false;

    for (const candidateKey of keyQueue) {
      if (evaluationResult) break;
      
      console.log(`[evaluate-speaking-submission] Trying key ${candidateKey.isUserProvided ? '(user)' : `(admin: ${candidateKey.keyId})`}`);

      try {
        // Generate content using inline base64 data (Deno-compatible)
        const genAI = new GoogleGenerativeAI(candidateKey.key);

        // Try each model in priority order
        for (const modelName of GEMINI_MODELS) {
          if (evaluationResult) break;

          console.log(`[evaluate-speaking-submission] Attempting evaluation with model: ${modelName}`);
          const model = genAI.getGenerativeModel({ model: modelName });

          // Build content with inline base64 audio data (built once per model)
          const contentParts: any[] = [];
          for (const audioFile of audioFiles) {
            contentParts.push({
              inlineData: {
                mimeType: audioFile.mimeType,
                data: audioFile.base64Data,
              },
            });
          }
          contentParts.push({ text: prompt });

          // Track quota/rate-limit errors per-model so we can fall back to the next model
          // before burning through the entire key pool.
          let lastQuotaError: QuotaError | null = null;

          // Retry ONCE on temporary rate limit (RetryInfo) instead of burning through all keys
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              const result = await model.generateContent({
                contents: [{ role: 'user', parts: contentParts }],
                generationConfig: {
                  temperature: 0.3,
                  maxOutputTokens: 8000,
                },
              });

              const responseText = result.response?.text();
              if (responseText) {
                const parsed = parseJson(responseText);
                if (parsed) {
                  evaluationResult = parsed;
                  usedModel = modelName;
                  usedKey = candidateKey;
                  console.log(`[evaluate-speaking-submission] Success with ${modelName}`);
                  break;
                }
              }

              // If we didn't get parseable JSON, try next model (no key switching here)
              break;
            } catch (modelError: any) {
              const msg = String(modelError?.message || modelError);
              console.warn(`[evaluate-speaking-submission] Model ${modelName} failed (attempt ${attempt + 1}/2):`, msg);

              const isQuotaLike =
                isQuotaExhaustedError(modelError) || modelError?.status === 429 || modelError?.status === 403;

              if (!isQuotaLike) {
                // Non-quota error -> try next model/key
                break;
              }

              const retryAfter = extractRetryAfterSeconds(modelError);
              const permanent = isPermanentQuotaExhausted(modelError) || retryAfter === undefined;

              // Temporary rate limit: wait once and retry SAME model.
              if (!permanent && retryAfter && retryAfter > 0 && attempt === 0) {
                sawTemporaryRateLimit = true;
                bestRetryAfterSeconds =
                  bestRetryAfterSeconds === null ? retryAfter : Math.min(bestRetryAfterSeconds, retryAfter);
                console.warn(
                  `[evaluate-speaking-submission] Temporary rate limit. Waiting ${retryAfter}s then retrying same key/model...`,
                );
                await sleep((retryAfter + 1) * 1000);
                continue;
              }

              // IMPORTANT BUGFIX:
              // Quota/billing issues can be MODEL-SPECIFIC (e.g., Gemini 2.x not enabled) while
              // Gemini 1.5 still works for the SAME API key. So we record the quota error and
              // fall through to the NEXT model instead of switching keys immediately.
              lastQuotaError = new QuotaError(`Gemini quota/rate limit: ${msg}`, {
                permanent,
                retryAfterSeconds: retryAfter,
              });
              break; // break attempt loop -> next model
            }
          }

          if (evaluationResult) break;

          // If this model only failed due to quota/rate limit, try the next model.
          if (lastQuotaError) {
            const isLastModel = GEMINI_MODELS[GEMINI_MODELS.length - 1] === modelName;
            if (isLastModel) throw lastQuotaError;
            continue;
          }
        }

      } catch (error: any) {
        if (error instanceof QuotaError) {
          const keyLabel = usedKey?.isUserProvided
            ? '(user)'
            : candidateKey.isUserProvided
              ? '(user)'
              : `(admin: ${candidateKey.keyId})`;

          if (error.permanent) {
            console.warn(`[evaluate-speaking-submission] Permanent quota/billing issue for ${keyLabel}. Switching key...`);
            if (!candidateKey.isUserProvided && candidateKey.keyId) {
              await markKeyQuotaExhausted(supabaseService, candidateKey.keyId, 'flash');
            }
            continue;
          }

          // Temporary rate-limit: do NOT mark exhausted. We'll either have already waited and retried,
          // or we rotate without persisting exhaustion.
          sawTemporaryRateLimit = true;
          if (typeof error.retryAfterSeconds === 'number' && error.retryAfterSeconds > 0) {
            bestRetryAfterSeconds =
              bestRetryAfterSeconds === null
                ? error.retryAfterSeconds
                : Math.min(bestRetryAfterSeconds, error.retryAfterSeconds);
          }

          console.warn(`[evaluate-speaking-submission] Temporary rate limit for ${keyLabel}. Trying next key...`);
          continue;
        }

        // Log and continue to next key
        console.error('[evaluate-speaking-submission] Error during evaluation:', error?.message || error);
        continue;
      }
    }

    if (!evaluationResult || !usedModel || !usedKey) {
      if (sawTemporaryRateLimit) {
        const retryAfter = bestRetryAfterSeconds ?? 60;
        return new Response(
          JSON.stringify({
            error: `Gemini is rate-limiting requests right now. Please retry in ~${retryAfter}s.`,
            code: 'RATE_LIMITED',
            retryAfterSeconds: retryAfter,
          }),
          {
            status: 429,
            headers: {
              ...corsHeaders,
              'Content-Type': 'application/json',
              'Retry-After': String(retryAfter),
            },
          },
        );
      }

      return new Response(
        JSON.stringify({
          error: 'All API keys are exhausted or misconfigured. Please add a working Gemini API key in Settings (paid/billed project) and try again.',
          code: 'ALL_KEYS_EXHAUSTED',
        }),
        {
          status: 503,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      );
    }

    console.log(`[evaluate-speaking-submission] Successfully received response from model: ${usedModel}`);

    // Calculate band score
    const derivedFromQuestions = computeOverallBandFromQuestionBands(evaluationResult);
    const derivedFromCriteria = calculateBand(evaluationResult);
    const overallBand =
      typeof evaluationResult?.overall_band === 'number'
        ? evaluationResult.overall_band
        : derivedFromQuestions ?? derivedFromCriteria;

    // Keep the payload internally consistent for the frontend.
    evaluationResult.overall_band = overallBand;

    // Build public audio URLs
    const publicBase = r2PublicUrl.replace(/\/$/, '');
    const audioUrls: Record<string, string> = {};
    if (publicBase) {
      for (const [k, r2Key] of Object.entries(filePaths as Record<string, string>)) {
        audioUrls[k] = `${publicBase}/${String(r2Key).replace(/^\//, '')}`;
      }
    }

    // Extract transcripts
    const transcriptsByPart = evaluationResult?.transcripts_by_part || {};
    const transcriptsByQuestion = evaluationResult?.transcripts_by_question || {};

    // Save to ai_practice_results
    const { data: resultRow, error: saveError } = await supabaseService
      .from('ai_practice_results')
      .insert({
        test_id: testId,
        user_id: user.id,
        module: 'speaking',
        score: Math.round(overallBand * 10),
        band_score: overallBand,
        total_questions: audioFiles.length,
        time_spent_seconds: durations
          ? Math.round(Object.values(durations as Record<string, number>).reduce((a, b) => a + b, 0))
          : 60,
        question_results: evaluationResult,
        answers: {
          audio_urls: audioUrls,
          transcripts_by_part: transcriptsByPart,
          transcripts_by_question: transcriptsByQuestion,
          file_paths: filePaths,
        },
        completed_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (saveError) {
      console.error('[evaluate-speaking-submission] Save error:', saveError);
      // Continue anyway - we have the result
    }

    console.log(`[evaluate-speaking-submission] Evaluation complete, band: ${overallBand}, result_id: ${resultRow?.id}`);

    return new Response(JSON.stringify({ 
      success: true,
      overallBand,
      evaluationReport: evaluationResult,
      resultId: resultRow?.id,
      audioUrls,
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
    console.error('[evaluate-speaking-submission] Error:', error.message);
    
    return new Response(JSON.stringify({ 
      error: error.message || 'An unexpected error occurred during evaluation.',
      code: 'UNKNOWN_ERROR' 
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
