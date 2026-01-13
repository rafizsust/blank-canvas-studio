import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { GoogleGenerativeAI } from "https://esm.sh/@google/generative-ai@0.21.0";
import { GoogleAIFileManager } from "https://esm.sh/@google/generative-ai@0.21.0/server";
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
 * Uses Google File API for audio uploads to avoid base64 token bloat.
 * Audio files are uploaded to Google's servers, then URIs are passed to Gemini.
 * 
 * Key Features:
 * - Google File API for audio (avoids 429 quota issues from base64)
 * - Immediate key rotation on quota errors
 * - Works with ai_practice_tests table
 * - Returns full evaluation result synchronously
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-gemini-api-key',
};

// Model priority: Use exp model for better limits, then fall back
const GEMINI_MODELS = [
  'gemini-2.0-flash-exp',
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

// Upload audio to Google File API and return file URI
async function uploadToGoogleFileAPI(
  fileManager: GoogleAIFileManager,
  audioBytes: Uint8Array,
  fileName: string,
  mimeType: string
): Promise<{ uri: string; mimeType: string }> {
  // Write to temp file (required by File API)
  const tempPath = `/tmp/${fileName}`;
  await Deno.writeFile(tempPath, audioBytes);
  
  try {
    console.log(`[evaluate-speaking-submission] Uploading ${fileName} to Google File API...`);
    
    const uploadResult = await fileManager.uploadFile(tempPath, {
      mimeType,
      displayName: fileName,
    });
    
    console.log(`[evaluate-speaking-submission] Uploaded ${fileName}: ${uploadResult.file.uri}`);
    
    return {
      uri: uploadResult.file.uri,
      mimeType: uploadResult.file.mimeType,
    };
  } finally {
    // Clean up temp file
    try {
      await Deno.remove(tempPath);
    } catch {
      // Ignore cleanup errors
    }
  }
}

// Build evaluation prompt with expert examiner analysis
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
  
  const includedParts = [...new Set(orderedSegments.map(s => s.partNumber))].sort();
  const partsDescription = includedParts.length === 1 
    ? `Part ${includedParts[0]} only` 
    : `Parts ${includedParts.join(', ')}`;

  const numQ = orderedSegments.length;

  return `You are a SENIOR IELTS Speaking examiner. Return ONLY valid JSON, no markdown.

CONTEXT: Topic: ${topic || 'General'}, Difficulty: ${difficulty || 'Medium'}, Parts: ${partsDescription}, Questions: ${numQ}
${fluencyFlag ? '⚠️ Part 2 under 80s - penalize Fluency & Coherence.' : ''}

MANDATORY REQUIREMENTS:
1. Listen to ALL ${numQ} audio files and transcribe EACH one fully
2. Provide band scores (use "band" key, not "score") for ALL 4 criteria
3. Create modelAnswers array with EXACTLY ${numQ} entries - one for each audio
4. Include transcripts_by_question with ALL ${numQ} question transcripts
5. All band scores must be between 1.0 and 9.0 (not zero!)

SCORING:
- Short responses (1-10 words) = Band 4.0-4.5 max
- Overall band = weighted average (Part2 x2.0, Part3 x1.5, Part1 x1.0)

MODEL ANSWERS: estimatedBand = candidate's level, targetBand = next whole band up
Example: estimatedBand 5.5 → targetBand 6 → provide Band 6 model answer

EXACT JSON SCHEMA (follow precisely):
{
  "overall_band": 6.0,
  "criteria": {
    "fluency_coherence": {"band": 6.0, "feedback": "2-3 sentence assessment", "strengths": ["strength1", "strength2"], "weaknesses": ["weakness1"], "suggestions": ["tip1", "tip2"]},
    "lexical_resource": {"band": 6.0, "feedback": "...", "strengths": [...], "weaknesses": [...], "suggestions": [...]},
    "grammatical_range": {"band": 5.5, "feedback": "...", "strengths": [...], "weaknesses": [...], "suggestions": [...]},
    "pronunciation": {"band": 6.0, "feedback": "...", "strengths": [...], "weaknesses": [...], "suggestions": [...]}
  },
  "summary": "2-4 sentence overall performance summary",
  "lexical_upgrades": [{"original": "good", "upgraded": "beneficial", "context": "example sentence"}],
  "part_analysis": [{"part_number": 1, "performance_notes": "analysis...", "key_moments": ["..."], "areas_for_improvement": ["..."]}],
  "improvement_priorities": ["Priority 1: ...", "Priority 2: ..."],
  "strengths_to_maintain": ["Strength 1: ...", "Strength 2: ..."],
  "transcripts_by_part": {"1": "Full concatenated transcript for Part 1..."},
  "transcripts_by_question": {
    "1": [
      {"segment_key": "part1-q...", "question_number": 1, "question_text": "...", "transcript": "Full answer transcript..."},
      {"segment_key": "part1-q...", "question_number": 2, "question_text": "...", "transcript": "..."}
    ]
  },
  "modelAnswers": [
    {
      "segment_key": "part1-q...",
      "partNumber": 1,
      "questionNumber": 1,
      "question": "Question text",
      "candidateResponse": "Full transcript of candidate's answer",
      "estimatedBand": 5.5,
      "targetBand": 6,
      "modelAnswer": "A comprehensive Band 6 model answer (80-120 words)...",
      "whyItWorks": ["Uses topic-specific vocabulary", "Clear organization"],
      "keyImprovements": ["Add more examples", "Vary vocabulary"]
    }
  ]
}

INPUT DATA:
questions_json: ${questionJson}
segment_map_json (${numQ} segments to evaluate): ${segmentJson}

CRITICAL: You MUST return exactly ${numQ} entries in modelAnswers array. Listen carefully to each audio file.`;
}

function parseJson(text: string): any {
  try { return JSON.parse(text); } catch {}
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (match) try { return JSON.parse(match[1].trim()); } catch {}
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch) try { return JSON.parse(objMatch[0]); } catch {}
  return null;
}

// Validate that response has required fields and completeness
function validateEvaluationResult(result: any, expectedQuestionCount: number): { valid: boolean; issues: string[] } {
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
    // Check in criteria wrapper first, then at root level
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
    // Count total transcript entries
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

// Normalize Gemini response to consistent format
function normalizeGeminiResponse(result: any): any {
  if (!result) return result;

  // If criteria is missing but individual criteria are at root level, restructure
  if (!result.criteria && (result.fluency_coherence || result.lexical_resource)) {
    const criteriaKeys = ['fluency_coherence', 'lexical_resource', 'grammatical_range', 'pronunciation'];
    result.criteria = {};
    
    for (const key of criteriaKeys) {
      if (result[key]) {
        // Normalize score -> band
        const criterion = { ...result[key] };
        if (criterion.score !== undefined && criterion.band === undefined) {
          criterion.band = criterion.score;
        }
        result.criteria[key] = criterion;
      }
    }
  }

  // Ensure overall_band is set
  if (result.overallBand !== undefined && result.overall_band === undefined) {
    result.overall_band = result.overallBand;
  }

  return result;
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

    // ============ DOWNLOAD FILES FROM R2 ============
    const audioFiles: { key: string; bytes: Uint8Array; mimeType: string }[] = [];
    
    try {
      for (const [audioKey, r2Path] of Object.entries(filePaths as Record<string, string>)) {
        console.log(`[evaluate-speaking-submission] Downloading from R2: ${r2Path}`);
        const result = await getFromR2(r2Path);
        if (!result.success || !result.bytes) {
          throw new Error(`Failed to download audio from R2: ${result.error}`);
        }
        
        const ext = r2Path.split('.').pop()?.toLowerCase() || 'webm';
        const mimeType = ext === 'mp3' ? 'audio/mpeg' : 'audio/webm';
        
        audioFiles.push({ key: audioKey, bytes: result.bytes, mimeType });
        console.log(`[evaluate-speaking-submission] Downloaded: ${r2Path} (${result.bytes.length} bytes)`);
      }
      console.log(`[evaluate-speaking-submission] Downloaded ${audioFiles.length} audio files from R2`);
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
        // Initialize File Manager and GenAI with this key
        const fileManager = new GoogleAIFileManager(candidateKey.key);
        const genAI = new GoogleGenerativeAI(candidateKey.key);

        // ============ UPLOAD FILES TO GOOGLE FILE API ============
        const fileUris: Array<{ fileData: { mimeType: string; fileUri: string } }> = [];
        
        console.log(`[evaluate-speaking-submission] Uploading ${audioFiles.length} files to Google File API...`);
        
        for (const audioFile of audioFiles) {
          try {
            const uploadResult = await uploadToGoogleFileAPI(
              fileManager,
              audioFile.bytes,
              `${audioFile.key}.webm`,
              audioFile.mimeType
            );
            
            fileUris.push({
              fileData: {
                mimeType: uploadResult.mimeType,
                fileUri: uploadResult.uri,
              }
            });
          } catch (uploadError: any) {
            console.error(`[evaluate-speaking-submission] Failed to upload ${audioFile.key}:`, uploadError?.message);
            throw uploadError;
          }
        }
        
        console.log(`[evaluate-speaking-submission] Successfully uploaded ${fileUris.length} files to Google File API`);

        // Try each model in priority order
        for (const modelName of GEMINI_MODELS) {
          if (evaluationResult) break;

          console.log(`[evaluate-speaking-submission] Attempting evaluation with model: ${modelName}`);
          
          const model = genAI.getGenerativeModel({ 
            model: modelName,
            generationConfig: {
              temperature: 0.3,
              maxOutputTokens: 65000, // Higher limit for complete responses
            },
          });

          // Build content with file URIs (NOT base64)
          const contentParts: any[] = [
            ...fileUris, // File URIs first
            { text: prompt } // Then the prompt
          ];

          // Track quota/rate-limit errors per-model so we can fall back to the next model
          // before burning through the entire key pool.
          let lastQuotaError: QuotaError | null = null;

          // Retry ONCE on temporary rate limit (RetryInfo) instead of burning through all keys
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              const result = await model.generateContent({
                contents: [{ role: 'user', parts: contentParts }],
              });

              const responseText = result.response?.text();
              if (responseText) {
                const parsed = parseJson(responseText);
                if (parsed) {
                  // Normalize the response structure
                  const normalized = normalizeGeminiResponse(parsed);
                  
                  // Validate completeness
                  const validation = validateEvaluationResult(normalized, audioFiles.length);
                  
                  if (validation.valid) {
                    evaluationResult = normalized;
                    usedModel = modelName;
                    usedKey = candidateKey;
                    console.log(`[evaluate-speaking-submission] Success with ${modelName}`);
                    break;
                  } else {
                    // Log validation issues but still accept if we have basic data
                    console.warn(`[evaluate-speaking-submission] Validation issues: ${validation.issues.join(', ')}`);
                    
                    // Accept if we at least have overall_band and some criteria
                    const overallBand = normalized.overall_band ?? normalized.overallBand;
                    const hasSomeCriteria = normalized.criteria && Object.keys(normalized.criteria).length > 0;
                    
                    if (typeof overallBand === 'number' && overallBand > 0 && hasSomeCriteria) {
                      console.log(`[evaluate-speaking-submission] Accepting partial result with issues`);
                      evaluationResult = normalized;
                      usedModel = modelName;
                      usedKey = candidateKey;
                      break;
                    }
                    
                    // Otherwise log and try next
                    console.warn(`[evaluate-speaking-submission] Response too incomplete, trying next model...`);
                  }
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
