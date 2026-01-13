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
  
  // Determine which parts are included
  const includedParts = [...new Set(orderedSegments.map(s => s.partNumber))].sort();
  const partsDescription = includedParts.length === 1 
    ? `Part ${includedParts[0]} only` 
    : `Parts ${includedParts.join(', ')}`;

  return [
    `You are a SENIOR IELTS Speaking examiner with 15+ years experience, evaluating according to 2025 official band descriptors.`,
    `Your role: Provide COMPREHENSIVE, DETAILED evaluation for EVERY recorded question like an expert mentor.`,
    ``,
    `TEST CONTEXT:`,
    `- Topic: ${topic || 'General'}`,
    `- Difficulty: ${difficulty || 'Medium'}`,
    `- Parts included: ${partsDescription} (ONLY evaluate these parts - do not include other parts!)`,
    `- Total questions to evaluate: ${orderedSegments.length}`,
    fluencyFlag
      ? `- ⚠️ Part 2 speaking was under 80 seconds; this MUST be reflected in Fluency & Coherence scoring.`
      : null,
    ``,
    `═══════════════════════════════════════════════════════════════════`,
    `CRITICAL REQUIREMENTS - YOU MUST FOLLOW ALL:`,
    `═══════════════════════════════════════════════════════════════════`,
    ``,
    `1. COMPLETE COVERAGE (MANDATORY):`,
    `   - You MUST provide evaluation for EVERY question in segment_map_json (${orderedSegments.length} questions total)`,
    `   - transcripts_by_question MUST have entries for ALL ${orderedSegments.length} questions`,
    `   - modelAnswers array MUST have exactly ${orderedSegments.length} entries (one per question)`,
    `   - If audio is unclear, transcribe what you can hear and mark unclear parts as "(inaudible)"`,
    ``,
    `2. ACCURATE PART LABELING:`,
    `   - ONLY include parts that exist in segment_map_json: ${includedParts.join(', ')}`,
    `   - Do NOT add Part 2 or Part 3 if they are not in the segments`,
    `   - Each modelAnswer must have correct partNumber matching the segment`,
    ``,
    `3. MODEL ANSWER TARGETING (MENTORSHIP APPROACH):`,
    `   For EACH question individually:`,
    `   - Assess the specific response quality and assign estimatedBand (can be 4.0, 4.5, 5.0, 5.5, 6.0, etc.)`,
    `   - Set targetBand = ONE band higher than estimatedBand (rounded up to nearest whole number)`,
    `   - Provide a model answer at EXACTLY that target level`,
    `   Examples:`,
    `     • estimatedBand 4.5 → targetBand 6, provide Band 6 model answer`,
    `     • estimatedBand 5.0 → targetBand 6, provide Band 6 model answer`,
    `     • estimatedBand 5.5 → targetBand 6, provide Band 6 model answer`,
    `     • estimatedBand 6.0 → targetBand 7, provide Band 7 model answer`,
    `     • estimatedBand 6.5 → targetBand 7, provide Band 7 model answer`,
    `     • estimatedBand 7.0 → targetBand 8, provide Band 8 model answer`,
    `     • estimatedBand 8.0+ → targetBand 9, provide Band 9 model answer`,
    ``,
    `4. EXPERT EXAMINER ANALYSIS (HOLISTIC VIEW):`,
    `   Analyze patterns ACROSS all responses:`,
    `   - Repeated vocabulary/phrases used across questions (e.g., always saying "I think", "very good")`,
    `   - Filler word patterns (um, uh, like, you know)`,
    `   - Grammar errors that repeat (subject-verb agreement, tense consistency)`,
    `   - Pronunciation patterns (specific sounds, word stress, intonation)`,
    `   - Response length and depth patterns`,
    `   - Coherence and logical flow across the test`,
    ``,
    `5. SCORING ACCURACY:`,
    `   - Short responses (1-10 words) = Band 4.0-4.5 maximum`,
    `   - Off-topic or minimal content = severe band penalty`,
    `   - overall_band = weighted average: Part 2 weight 2.0, Part 3 weight 1.5, Part 1 weight 1.0`,
    `   - Criteria bands should be consistent with overall_band (±1.0 max)`,
    ``,
    `═══════════════════════════════════════════════════════════════════`,
    `OUTPUT SCHEMA (Return STRICT JSON only, no markdown):`,
    `═══════════════════════════════════════════════════════════════════`,
    `{`,
    `  "overall_band": 6.5,`,
    `  "criteria": {`,
    `    "fluency_coherence": {`,
    `      "band": 6.5,`,
    `      "feedback": "Detailed 2-3 sentence assessment...",`,
    `      "strengths": ["Specific strength 1", "Specific strength 2", "...at least 2-3"],`,
    `      "weaknesses": ["Specific weakness 1", "Specific weakness 2", "...at least 2-3"],`,
    `      "suggestions": ["Actionable tip 1", "Actionable tip 2", "...at least 2-3"]`,
    `    },`,
    `    "lexical_resource": {`,
    `      "band": 6.5,`,
    `      "feedback": "Detailed assessment...",`,
    `      "strengths": ["..."],`,
    `      "weaknesses": ["..."],`,
    `      "suggestions": ["..."]`,
    `    },`,
    `    "grammatical_range": {`,
    `      "band": 6.5,`,
    `      "feedback": "Detailed assessment...",`,
    `      "strengths": ["..."],`,
    `      "weaknesses": ["..."],`,
    `      "suggestions": ["..."]`,
    `    },`,
    `    "pronunciation": {`,
    `      "band": 6.5,`,
    `      "feedback": "Detailed assessment...",`,
    `      "strengths": ["..."],`,
    `      "weaknesses": ["..."],`,
    `      "suggestions": ["..."]`,
    `    }`,
    `  },`,
    `  "summary": "2-4 sentence expert summary of overall performance, noting key patterns observed across all responses",`,
    `  "lexical_upgrades": [`,
    `    {"original": "good", "upgraded": "beneficial/advantageous", "context": "This is good for health → This is highly beneficial for one's well-being"},`,
    `    {"original": "...", "upgraded": "...", "context": "..."},`,
    `    "...provide 5-10 vocabulary upgrades from candidate's actual speech"`,
    `  ],`,
    `  "part_analysis": [`,
    `    {`,
    `      "part_number": 1,`,
    `      "performance_notes": "Detailed analysis of how candidate performed in this part...",`,
    `      "key_moments": ["Positive moment 1", "Positive moment 2"],`,
    `      "areas_for_improvement": ["Specific improvement 1", "Specific improvement 2"]`,
    `    }`,
    `  ],`,
    `  "improvement_priorities": [`,
    `    "Priority 1: Most impactful improvement with specific example",`,
    `    "Priority 2: Second most impactful...",`,
    `    "Priority 3: ...",`,
    `    "Priority 4: ...",`,
    `    "Priority 5: ..."`,
    `  ],`,
    `  "strengths_to_maintain": [`,
    `    "Strength 1: What candidate does well with example",`,
    `    "Strength 2: ...",`,
    `    "Strength 3: ..."`,
    `  ],`,
    `  "transcripts_by_part": {`,
    `    "1": "Full concatenated transcript for Part 1...",`,
    `    "2": "Full transcript for Part 2 if included...",`,
    `    "3": "Full transcript for Part 3 if included..."`,
    `  },`,
    `  "transcripts_by_question": {`,
    `    "1": [`,
    `      {"segment_key": "part1-q...", "question_number": 1, "question_text": "...", "transcript": "Full transcript of candidate's answer..."},`,
    `      {"segment_key": "part1-q...", "question_number": 2, "question_text": "...", "transcript": "..."},`,
    `      "...ONE ENTRY FOR EACH QUESTION IN PART 1"`,
    `    ],`,
    `    "2": ["...if Part 2 was included"],`,
    `    "3": ["...if Part 3 was included"]`,
    `  },`,
    `  "modelAnswers": [`,
    `    {`,
    `      "segment_key": "part1-q...",`,
    `      "partNumber": 1,`,
    `      "questionNumber": 1,`,
    `      "question": "What is your daily routine?",`,
    `      "candidateResponse": "Full transcript of what candidate said...",`,
    `      "estimatedBand": 5.5,`,
    `      "targetBand": 6,`,
    `      "modelAnswer": "A comprehensive Band 6 model answer (80-120 words) demonstrating the target level...",`,
    `      "whyItWorks": [`,
    `        "Uses topic-specific vocabulary appropriately",`,
    `        "Demonstrates clear organization with discourse markers",`,
    `        "Shows some complexity in sentence structure",`,
    `        "...3-5 specific features that make this a Band 6 answer"`,
    `      ],`,
    `      "keyImprovements": [`,
    `        "Add more specific examples from personal experience",`,
    `        "Use more varied vocabulary instead of repeating 'good' and 'nice'",`,
    `        "Include discourse markers like 'furthermore', 'in addition'",`,
    `        "...2-4 specific, actionable improvements"`,
    `      ]`,
    `    },`,
    `    "...MUST HAVE ${orderedSegments.length} ENTRIES - ONE FOR EACH RECORDED QUESTION"`,
    `  ]`,
    `}`,
    ``,
    `═══════════════════════════════════════════════════════════════════`,
    `INPUT DATA:`,
    `═══════════════════════════════════════════════════════════════════`,
    `questions_json: ${questionJson}`,
    ``,
    `segment_map_json (THE SOURCE OF TRUTH - ${orderedSegments.length} segments to evaluate): ${segmentJson}`,
    ``,
    `REMINDER: Your modelAnswers array MUST have exactly ${orderedSegments.length} entries. Do not skip any questions!`,
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
