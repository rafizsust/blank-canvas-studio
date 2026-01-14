import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { 
  getActiveGeminiKeysForModels,
  markModelQuotaExhausted,
  isDailyQuotaExhaustedError,
  getTodayDate,
  ALL_MODEL_QUOTA_COLUMNS
} from "../_shared/apiKeyQuotaUtils.ts";
import { 
  createPerformanceLogger,
  classifyGeminiErrorStatus
} from "../_shared/performanceLogger.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// UNIFIED EXAMINER VOICE: Use a single clearly-male voice for all speaking tests site-wide
// Root cause fix: Gemini's "Kore" voice is not reliably perceived as male; unify on "Charon".
const UNIFIED_EXAMINER_VOICE = "Charon"; // Unified male examiner voice

// Available TTS voices with accents (used for listening tests which need variety)
const TTS_VOICES = {
  US: ["Kore", "Charon", "Fenrir"],
  GB: ["Kore", "Aoede", "Puck"],
  AU: ["Kore", "Aoede", "Fenrir"],
  IN: ["Kore", "Charon", "Puck"],
};

const ALL_ACCENTS = Object.keys(TTS_VOICES) as Array<keyof typeof TTS_VOICES>;

// ============================================================================
// VOICE-FIRST GENDER SYNCHRONIZATION SYSTEM (for listening multi-speaker)
// ============================================================================
const VOICE_GENDER_MAP: Record<string, 'male' | 'female'> = {
  'Kore': 'male',
  'Charon': 'male',
  'Fenrir': 'male',
  // Puck is a female voice in Gemini TTS (keep this in sync with other functions)
  'Puck': 'female',
  'Aoede': 'female',
};

function getVoiceGender(voiceName: string): 'male' | 'female' {
  return VOICE_GENDER_MAP[voiceName] || 'male';
}

function getGenderAppropriateNames(gender: 'male' | 'female'): string[] {
  if (gender === 'male') {
    return ['Tom', 'David', 'John', 'Michael', 'James', 'Robert', 'William', 'Richard', 'Daniel', 'Mark'];
  }
  return ['Sarah', 'Emma', 'Lisa', 'Anna', 'Maria', 'Sophie', 'Rachel', 'Laura', 'Helen', 'Kate'];
}

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

function getRandomVoice(preferredAccent?: string): { voiceName: string; accent: string } {
  let accent: keyof typeof TTS_VOICES;
  
  if (preferredAccent && preferredAccent !== "random" && preferredAccent !== "mixed" && TTS_VOICES[preferredAccent as keyof typeof TTS_VOICES]) {
    accent = preferredAccent as keyof typeof TTS_VOICES;
  } else {
    accent = ALL_ACCENTS[Math.floor(Math.random() * ALL_ACCENTS.length)];
  }
  
  const voices = TTS_VOICES[accent];
  const voiceName = voices[Math.floor(Math.random() * voices.length)];
  return { voiceName, accent };
}

function pickSecondaryVoice(primaryVoice: string, accent: string): string {
  const voices = TTS_VOICES[accent as keyof typeof TTS_VOICES] ?? TTS_VOICES.US;
  const primaryGender = getVoiceGender(primaryVoice);

  const candidates = voices.filter(v => v !== primaryVoice);
  const oppositeGenderCandidates = candidates.filter(v => getVoiceGender(v) !== primaryGender);

  const pool = oppositeGenderCandidates.length > 0 ? oppositeGenderCandidates : candidates;
  return pool[Math.floor(Math.random() * pool.length)] ?? primaryVoice;
}

// API Key management for round-robin Gemini API calls with quota tracking
// TTS Model used for audio generation
const TTS_MODEL = 'gemini-2.5-flash-preview-tts';

interface ApiKeyRecord {
  id: string;
  provider: string;
  key_value: string;
  is_active: boolean;
  error_count: number;
  // Dynamic quota fields
  [key: string]: any;
}

// Separate caches for TTS and Flash models
let ttsKeyCache: ApiKeyRecord[] = [];
let flashKeyCache: ApiKeyRecord[] = [];
let ttsKeyIndex = 0;
let flashKeyIndex = 0;

// List of models we use for content generation (non-TTS)
const CONTENT_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash'];

async function getActiveGeminiKeysForTTS(supabaseServiceClient: any): Promise<ApiKeyRecord[]> {
  return getActiveGeminiKeysForModels(supabaseServiceClient, [TTS_MODEL]);
}

async function getActiveGeminiKeysForContent(supabaseServiceClient: any): Promise<ApiKeyRecord[]> {
  return getActiveGeminiKeysForModels(supabaseServiceClient, CONTENT_MODELS);
}

// Legacy function for backward compatibility
async function getActiveGeminiKeys(supabaseServiceClient: any): Promise<ApiKeyRecord[]> {
  return getActiveGeminiKeysForContent(supabaseServiceClient);
}

async function markTTSQuotaExhausted(supabaseServiceClient: any, keyId: string): Promise<void> {
  await markModelQuotaExhausted(supabaseServiceClient, keyId, TTS_MODEL);
  // Remove this key from the TTS cache
  ttsKeyCache = ttsKeyCache.filter(k => k.id !== keyId);
  console.log(`Removed key ${keyId} from TTS cache, ${ttsKeyCache.length} keys remaining`);
}

async function markContentQuotaExhausted(supabaseServiceClient: any, keyId: string, modelName: string): Promise<void> {
  await markModelQuotaExhausted(supabaseServiceClient, keyId, modelName);
  // Remove this key from the flash cache
  flashKeyCache = flashKeyCache.filter(k => k.id !== keyId);
  console.log(`Removed key ${keyId} from flash cache for ${modelName}, ${flashKeyCache.length} keys remaining`);
}

// Check if error is a quota error (broad check for rate limiting/transient)
function isQuotaExhaustedError(errorStatus: string | number, errorMessage: string): boolean {
  return (
    errorStatus === 'RESOURCE_EXHAUSTED' ||
    errorStatus === 429 ||
    errorMessage.toLowerCase().includes('quota') ||
    errorMessage.toLowerCase().includes('rate limit') ||
    errorMessage.toLowerCase().includes('resource exhausted') ||
    errorMessage.toLowerCase().includes('too many requests')
  );
}

// Check if error is a PERMANENT daily quota exhaustion (use before marking model exhausted)
function isPermanentQuotaError(errorMessage: string): boolean {
  const msg = errorMessage.toLowerCase();
  return (
    msg.includes('check your plan') ||
    msg.includes('billing') ||
    msg.includes('limit: 0') ||
    (msg.includes('per day') && !msg.includes('retry')) ||
    msg.includes('daily quota') ||
    msg.includes('daily limit')
  );
}

async function incrementKeyErrorCount(supabaseServiceClient: any, keyId: string, deactivate: boolean = false): Promise<void> {
  try {
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

function getNextTTSApiKey(): ApiKeyRecord | null {
  if (ttsKeyCache.length === 0) return null;
  const key = ttsKeyCache[ttsKeyIndex % ttsKeyCache.length];
  ttsKeyIndex = (ttsKeyIndex + 1) % ttsKeyCache.length;
  return key;
}

function getNextFlashApiKey(): ApiKeyRecord | null {
  if (flashKeyCache.length === 0) return null;
  const key = flashKeyCache[flashKeyIndex % flashKeyCache.length];
  flashKeyIndex = (flashKeyIndex + 1) % flashKeyCache.length;
  return key;
}

// Legacy function for backward compatibility
let apiKeyCache: ApiKeyRecord[] = [];
let currentKeyIndex = 0;

function getNextApiKey(): ApiKeyRecord | null {
  if (flashKeyCache.length > 0) {
    return getNextFlashApiKey();
  }
  // Fallback to legacy cache
  if (apiKeyCache.length === 0) return null;
  const key = apiKeyCache[currentKeyIndex % apiKeyCache.length];
  currentKeyIndex = (currentKeyIndex + 1) % apiKeyCache.length;
  return key;
}

// Retry helper with exponential backoff
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelayMs: number = 1000
): Promise<T> {
  let lastError: Error | null = null;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.log(`Attempt ${attempt + 1} failed:`, lastError.message);
      
      if (attempt < maxRetries - 1) {
        const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 500;
        console.log(`Retrying in ${Math.round(delay)}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  throw lastError || new Error("All retries failed");
}

async function fetchWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ============================================================================
// SPEAKING PART 3 ENFORCEMENT (count + word-length)
// - Requirement: Part 3 must have 4-5 questions
// - Requirement: Each Part 3 question must be 12-16 words
// ============================================================================

function countWordsForIelts(text: string): number {
  const words = text.match(/[A-Za-z0-9]+(?:'[A-Za-z0-9]+)?/g);
  return words ? words.length : 0;
}

function ensureQuestionMark(text: string): string {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return "";
  return trimmed.endsWith("?") ? trimmed : `${trimmed}?`;
}

function normalizeQuestionText(text: string): string {
  return ensureQuestionMark(
    String(text ?? "")
      .trim()
      .replace(/^[-•\d.\s]+/, "")
      .replace(/^"|"$/g, "")
  );
}

function padToMinWords(question: string, minWords: number, maxWords: number): string {
  let q = question.trim();
  if (!q) return q;

  // Remove trailing '?' to append safely
  const hasQ = q.endsWith("?");
  if (hasQ) q = q.slice(0, -1);

  const current = countWordsForIelts(q);
  if (current >= minWords) return ensureQuestionMark(q);

  const need = minWords - current;
  const fillers: Record<number, string> = {
    1: "today",
    2: "in general",
    3: "in your country",
    4: "in your country today",
    5: "in your country these days",
    6: "in your country in recent years",
    7: "in your country over recent years",
    8: "in your country over the past decade",
  };

  const filler = fillers[need] || "in modern society today";
  const candidate = `${q} ${filler}`.trim();

  // Ensure we don't accidentally exceed maxWords
  const tokens = candidate.match(/[A-Za-z0-9]+(?:'[A-Za-z0-9]+)?/g) || [];
  const clipped = tokens.slice(0, maxWords).join(" ");
  return ensureQuestionMark(clipped);
}

function enforceWordCountRange(question: string, minWords: number, maxWords: number): string {
  let q = normalizeQuestionText(question);
  if (!q) return q;

  let wc = countWordsForIelts(q);
  if (wc > maxWords) {
    const tokens = q.match(/[A-Za-z0-9]+(?:'[A-Za-z0-9]+)?/g) || [];
    q = ensureQuestionMark(tokens.slice(0, maxWords).join(" "));
    wc = countWordsForIelts(q);
  }

  if (wc < minWords) {
    q = padToMinWords(q, minWords, maxWords);
  }

  return q;
}

function normalizePart3Questions(
  raw: unknown,
  opts: { minQuestions: number; maxQuestions: number; minWords: number; maxWords: number }
): string[] {
  const fallback = [
    "Why do you think people can have very different opinions about this topic today?",
    "How might this topic affect younger and older people differently in modern society?",
    "What are the main advantages and disadvantages of this topic for individuals in your country?",
    "How do you think this topic will change in your country over the next decade?",
    "To what extent should governments influence decisions related to this topic in modern life?",
  ];

  const arr = Array.isArray(raw) ? raw : [];

  const cleaned = arr
    .filter((q) => typeof q === "string")
    .map((q) => enforceWordCountRange(q, opts.minWords, opts.maxWords))
    .filter(Boolean);

  // De-dupe while preserving order
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const q of cleaned) {
    if (!seen.has(q)) {
      seen.add(q);
      unique.push(q);
    }
  }

  // Max 5 questions
  const limited = unique.slice(0, opts.maxQuestions);

  // Ensure minimum 4 by appending safe fallbacks
  let idx = 0;
  while (limited.length < opts.minQuestions && idx < fallback.length) {
    const candidate = enforceWordCountRange(fallback[idx], opts.minWords, opts.maxWords);
    if (candidate && !seen.has(candidate)) {
      seen.add(candidate);
      limited.push(candidate);
    }
    idx++;
  }

  return limited;
}

function normalizeSampleAnswers(raw: unknown, desiredCount: number): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const answers = raw
    .filter((a) => typeof a === "string")
    .map((a) => String(a).trim())
    .filter(Boolean);

  const defaultAnswer =
    "I think it depends on the situation, but overall there can be both benefits and drawbacks. For example, people may gain in one way, yet face challenges in another. In my view, the best approach is to balance these factors carefully.";

  if (answers.length === 0) answers.push(defaultAnswer);

  while (answers.length < desiredCount) {
    answers.push(answers[answers.length - 1] || defaultAnswer);
  }

  return answers.slice(0, desiredCount);
}

function enforceSpeakingPart3Constraints(content: any): void {
  if (!content || typeof content !== "object") return;
  const part3 = content.part3;
  if (!part3 || typeof part3 !== "object") return;

  const normalizedQuestions = normalizePart3Questions(part3.questions, {
    minQuestions: 4,
    maxQuestions: 5,
    minWords: 12,
    maxWords: 16,
  });

  part3.questions = normalizedQuestions;

  const normalizedAnswers = normalizeSampleAnswers(part3.sample_answers, normalizedQuestions.length);
  if (normalizedAnswers) {
    part3.sample_answers = normalizedAnswers;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Invalid token" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Admin check
    const { data: adminCheck } = await supabase
      .from("admin_users")
      .select("id")
      .eq("user_id", user.id)
      .single();

    if (!adminCheck) {
      return new Response(JSON.stringify({ error: "Admin access required" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const { module, topic, difficulty, quantity, questionType, monologue, writingConfig } = body;

    // Validation
    if (!module || !topic || !difficulty || !quantity) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!["listening", "speaking", "reading", "writing"].includes(module)) {
      return new Response(JSON.stringify({ error: "Invalid module" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!["easy", "medium", "hard"].includes(difficulty)) {
      return new Response(JSON.stringify({ error: "Invalid difficulty" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (quantity < 1 || quantity > 50) {
      return new Response(JSON.stringify({ error: "Quantity must be 1-50" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Create job record
    const { data: job, error: jobError } = await supabase
      .from("bulk_generation_jobs")
      .insert({
        admin_user_id: user.id,
        module,
        topic,
        difficulty,
        quantity,
        question_type: questionType || "mixed",
        monologue: monologue || false,
        status: "pending",
      })
      .select()
      .single();

    if (jobError) {
      console.error("Failed to create job:", jobError);
      return new Response(JSON.stringify({ error: "Failed to create job" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[Job ${job.id}] Created job for ${quantity} ${module} tests`);

    // Start background processing using EdgeRuntime.waitUntil
    const processingPromise = processGenerationJob(
      supabase,
      job.id,
      module,
      topic,
      difficulty,
      quantity,
      questionType || "mixed",
      monologue || false,
      writingConfig
    );
    
    // Use EdgeRuntime.waitUntil if available for background processing
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
      EdgeRuntime.waitUntil(processingPromise);
    } else {
      // Fallback: don't await, let it run in background
      processingPromise.catch(console.error);
    }

    return new Response(
      JSON.stringify({
        success: true,
        jobId: job.id,
        message: `Started generating ${quantity} ${module} tests for topic "${topic}"`,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("bulk-generate-tests error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

// Main processing function
async function processGenerationJob(
  supabase: any,
  jobId: string,
  module: string,
  topic: string,
  difficulty: string,
  quantity: number,
  questionType: string,
  monologue: boolean,
  writingConfig?: any
) {
  console.log(`[Job ${jobId}] Starting generation of ${quantity} ${module} tests (type: ${questionType}, monologue: ${monologue})`);

  await supabase
    .from("bulk_generation_jobs")
    .update({
      status: "processing",
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", jobId);

  let successCount = 0;
  let failureCount = 0;
  const errorLog: Array<{ index: number; error: string }> = [];
  let cancelled = false;

  // If mixed question type, rotate through available types
  const questionTypes = getQuestionTypesForModule(module, questionType);

  for (let i = 0; i < quantity; i++) {
    // Allow admin to cancel the job
    const { data: jobRow } = await supabase
      .from("bulk_generation_jobs")
      .select("status")
      .eq("id", jobId)
      .single();

    if (jobRow?.status === "cancelled") {
      cancelled = true;
      console.log(`[Job ${jobId}] Cancelled by admin. Stopping at ${i}/${quantity}.`);
      break;
    }

    try {
      console.log(`[Job ${jobId}] Processing test ${i + 1}/${quantity}`);

      // For SPEAKING tests: Always use unified examiner voice for consistency
      // For LISTENING tests: Use random voice with gender variety (dialogues need multiple speakers)
      const { voiceName: randomVoice, accent } = getRandomVoice();
      const voiceName = module === "speaking" ? UNIFIED_EXAMINER_VOICE : randomVoice;
      
      let currentQuestionType = questionTypes[i % questionTypes.length];

      // WRITING TASK 1: enforce the selected visual type so presets can be filtered correctly
      // (If this stays as TASK_1, the preset picker can't distinguish BAR vs PIE vs TABLE, etc.)
      if (module === "writing" && currentQuestionType === "TASK_1") {
        const desired = writingConfig?.task1VisualType;
        const allowed = [
          "BAR_CHART",
          "LINE_GRAPH",
          "PIE_CHART",
          "TABLE",
          "MIXED_CHARTS",
          "MAP",
          "PROCESS_DIAGRAM",
        ];

        if (desired && desired !== "RANDOM" && allowed.includes(desired)) {
          currentQuestionType = desired;
        }
      }

      // Generate content using the same prompts as generate-ai-practice
      // Pass voiceName for gender synchronization (listening/speaking modules)
      let content = await withRetry(
        () => generateContent(module, topic, difficulty, currentQuestionType, monologue, voiceName, writingConfig),
        3,
        2000
      );

      if (!content) {
        throw new Error("Content generation failed - empty response");
      }

      // SPEAKING: Enforce Part 3 constraints (4-5 questions, 12-16 words each)
      if (module === "speaking") {
        enforceSpeakingPart3Constraints(content);
      }

      // WRITING TASK 1: if we're generating Task 1 with RANDOM visual type, infer the actual visual type
      // from the AI response so we can store + filter presets correctly.
      if (module === "writing" && currentQuestionType === "TASK_1") {
        const inferred = content?.visual_type || content?.visualType || content?.visualData?.type;
        const allowedVisualTypes = [
          "BAR_CHART",
          "LINE_GRAPH",
          "PIE_CHART",
          "TABLE",
          "MIXED_CHARTS",
          "PROCESS_DIAGRAM",
          "MAP",
        ];

        if (typeof inferred === "string" && allowedVisualTypes.includes(inferred)) {
          currentQuestionType = inferred;
        }
      }

      let audioUrl: string | null = null;
      let testRowId: string | null = null;

      // LISTENING: Generate audio with MONOLOGUE RESCUE on failure
      if (module === "listening") {
        const scriptText = content.dialogue || content.script || "";
        const hasSecondSpeaker = !monologue && /Speaker2\s*:/i.test(scriptText) && /Speaker1\s*:/i.test(scriptText);

        // Persist speaker voice mapping in the JSON payload (so admin preview can show both voices)
        if (hasSecondSpeaker) {
          const speaker2Voice = pickSecondaryVoice(voiceName, accent);
          content.tts_speaker_voices = { Speaker1: voiceName, Speaker2: speaker2Voice };
        } else {
          content.tts_speaker_voices = { Speaker1: voiceName };
        }
        
        if (scriptText.trim()) {
          try {
            audioUrl = await withRetry(
              () => generateAndUploadAudio(
                supabase,
                scriptText,
                voiceName,
                hasSecondSpeaker ? content.tts_speaker_voices?.Speaker2 : undefined,
                monologue,
                jobId,
                i
              ),
              3,
              3000
            );
          } catch (audioError) {
            console.error(`[Job ${jobId}] Listening audio failed for test ${i + 1}:`, audioError);
            
            // === MONOLOGUE RESCUE: Convert dialogue to monologue for browser TTS fallback ===
            if (!monologue && scriptText.includes('Speaker')) {
              console.log(`[Job ${jobId}] Attempting monologue rescue for test ${i + 1}...`);
              try {
                const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
                if (LOVABLE_API_KEY) {
                  const monologuePrompt = `Rewrite the following dialogue as a detailed monologue or narration. 
Remove all speaker labels (e.g., "Speaker1:", "Speaker2:", names followed by colons). 
Convert the conversation into a flowing narrative that a single narrator would read aloud.
Keep ALL factual information, numbers, dates, names, and details that would be needed to answer test questions.
Return ONLY the raw monologue text, no JSON wrapper.

DIALOGUE TO CONVERT:
${scriptText}`;
                  
                  const rescueResponse = await fetchWithTimeout(
                    "https://ai.gateway.lovable.dev/v1/chat/completions",
                    {
                      method: "POST",
                      headers: {
                        Authorization: `Bearer ${LOVABLE_API_KEY}`,
                        "Content-Type": "application/json",
                      },
                      body: JSON.stringify({
                        model: "google/gemini-2.5-flash",
                        messages: [
                          { role: "user", content: monologuePrompt },
                        ],
                      }),
                    },
                    60_000
                  );
                  
                  if (rescueResponse.ok) {
                    const rescueData = await rescueResponse.json();
                    const rescuedMonologue = rescueData.choices?.[0]?.message?.content;
                    
                    if (rescuedMonologue && rescuedMonologue.trim().length > 50) {
                      console.log(`[Job ${jobId}] Monologue rescue successful for test ${i + 1}`);
                      content.dialogue = rescuedMonologue.trim();
                      content.script = rescuedMonologue.trim();
                      content.speaker_names = { Speaker1: 'Narrator' };
                      content.monologue_rescued = true;
                      // Continue without throwing - test will be saved with browser TTS fallback
                    } else {
                      throw new Error('Monologue rescue returned empty result');
                    }
                  } else {
                    throw new Error('Monologue rescue API call failed');
                  }
                } else {
                  throw new Error('LOVABLE_API_KEY not available for rescue');
                }
              } catch (rescueError) {
                console.error(`[Job ${jobId}] Monologue rescue failed for test ${i + 1}:`, rescueError);
                throw new Error(`Audio generation failed and monologue rescue failed: ${audioError instanceof Error ? audioError.message : "Unknown"}`);
              }
            } else {
              // Already a monologue or no dialogue - cannot rescue
              throw new Error(`Audio generation failed: ${audioError instanceof Error ? audioError.message : "Unknown"}`);
            }
          }
        }
      }

      // SPEAKING: Insert the test row early so the UI can display progress even if
      // audio generation is slow / hits worker limits, then update payload once audio is ready.
      if (module === "speaking") {
        const initialPayload = {
          ...content,
          audioUrls: null,
          audioFormat: "wav",
        };

        const initialTestData: any = {
          job_id: jobId,
          module,
          topic,
          difficulty,
          question_type: currentQuestionType,
          content_payload: initialPayload,
          audio_url: null,
          transcript: null,
          status: "content_only",
          is_published: false,
          voice_id: voiceName,
          accent,
        };

        const { data: inserted, error: insertErr } = await supabase
          .from("generated_test_audio")
          .insert(initialTestData)
          .select("id")
          .single();

        if (insertErr || !inserted?.id) {
          throw new Error(`Database insert failed: ${insertErr?.message || "Unknown"}`);
        }

        testRowId = inserted.id;

        try {
          const speakingAudioUrls = await withRetry(
            () => generateSpeakingAudio(supabase, content, voiceName, jobId, i, currentQuestionType),
            2,
            2000
          );

          if (speakingAudioUrls) {
            content.audioUrls = speakingAudioUrls;
          }
        } catch (audioError) {
          console.warn(`[Job ${jobId}] Speaking audio generation failed, will use browser TTS fallback:`, audioError);
          content.audioUrls = null;
          content.useBrowserTTS = true;
        }
      }

      // Transform content for writing module to match expected format
      // The frontend expects { writingTask: { id, task_type, instruction, chartData, visual_type, ... } }
      let contentPayload = content;
      if (module === "writing") {
        // Transform the AI response to match the user generator's format
        const isTask1 = currentQuestionType === "TASK_1" || 
          ['BAR_CHART', 'LINE_GRAPH', 'PIE_CHART', 'TABLE', 'MIXED_CHARTS', 'PROCESS_DIAGRAM', 'MAP'].includes(currentQuestionType);
        
        const enforcedVisualType = isTask1 ? currentQuestionType : null;
        const chartData = isTask1 && content.visualData
          ? { ...content.visualData, type: enforcedVisualType }
          : null;

        const writingTask = {
          id: crypto.randomUUID(),
          task_type: isTask1 ? 'task1' : 'task2',
          instruction: content.instruction,
          // For Task 1: chartData must match the exact user-generator schema and type must be enforced
          chartData,
          visual_type: enforcedVisualType,
          // For Task 2: essay_type
          essay_type: content.essay_type || null,
          word_limit_min: isTask1 ? 150 : 250,
          word_limit_max: isTask1 ? 200 : 350,
        };
        
        contentPayload = { writingTask };
        console.log(`[Job ${jobId}] Writing task formatted: type=${writingTask.task_type}, visual_type=${writingTask.visual_type}`);
      }

      // Save to generated_test_audio table
      // - For speaking we already inserted a row (status=processing); here we update it.
      // - For other modules we insert normally.
      const testData: any = {
        job_id: jobId,
        module,
        topic,
        difficulty,
        question_type: currentQuestionType,
        content_payload: contentPayload,
        audio_url: audioUrl,
        transcript: content.dialogue || content.script || null,
        status: module === "listening" && !audioUrl && !content.monologue_rescued ? "audio_failed" : "ready",
        is_published: false,
      };

      // Only add voice configuration for audio-based modules
      if (module === "listening" || module === "speaking") {
        testData.voice_id = voiceName;
        testData.accent = accent;
      }

      let upsertError: any = null;

      if (testRowId) {
        const { error } = await supabase
          .from("generated_test_audio")
          .update({
            ...testData,
            status: "ready",
          })
          .eq("id", testRowId);
        upsertError = error;
      } else {
        const { error } = await supabase
          .from("generated_test_audio")
          .insert(testData);
        upsertError = error;
      }

      if (upsertError) {
        throw new Error(`Database save failed: ${upsertError.message}`);
      }

      successCount++;
      console.log(`[Job ${jobId}] Successfully created test ${i + 1}`);

       await supabase
         .from("bulk_generation_jobs")
         .update({
           success_count: successCount,
           failure_count: failureCount,
           updated_at: new Date().toISOString(),
         })
         .eq("id", jobId);

    } catch (error) {
      failureCount++;
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      errorLog.push({ index: i, error: errorMessage });
      console.error(`[Job ${jobId}] Failed test ${i + 1}:`, errorMessage);

       await supabase
         .from("bulk_generation_jobs")
         .update({
           success_count: successCount,
           failure_count: failureCount,
           error_log: errorLog,
           updated_at: new Date().toISOString(),
         })
         .eq("id", jobId);
    }

    // Delay between generations to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  await supabase
    .from("bulk_generation_jobs")
    .update({
      status: cancelled ? "cancelled" : failureCount === quantity ? "failed" : "completed",
      success_count: successCount,
      failure_count: failureCount,
      error_log: errorLog,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", jobId);

  console.log(`[Job ${jobId}] Completed: ${successCount} success, ${failureCount} failed`);
}

// Get question types for rotation
function getQuestionTypesForModule(module: string, selectedType: string): string[] {
  if (selectedType !== "mixed") {
    return [selectedType];
  }

  switch (module) {
    case "reading":
      return [
        "TRUE_FALSE_NOT_GIVEN",
        "MULTIPLE_CHOICE_SINGLE",
        "MULTIPLE_CHOICE_MULTIPLE",
        "MATCHING_HEADINGS",
        "SENTENCE_COMPLETION",
        "SUMMARY_WORD_BANK",
        "SHORT_ANSWER",
        "TABLE_COMPLETION",
      ];
    case "listening":
      return [
        "FILL_IN_BLANK",
        "MULTIPLE_CHOICE_SINGLE",
        "MULTIPLE_CHOICE_MULTIPLE",
        "TABLE_COMPLETION",
        "NOTE_COMPLETION",
        "MATCHING_CORRECT_LETTER",
      ];
    case "writing":
      return ["TASK_1", "TASK_2"];
    case "speaking":
      return ["FULL_TEST"];
    default:
      return ["mixed"];
  }
}

// Generate content using Lovable AI Gateway with performance logging
async function generateContent(
  module: string,
  topic: string,
  difficulty: string,
  questionType: string,
  monologue: boolean,
  voiceName?: string,
  writingConfig?: any
): Promise<any> {
  const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
  
  if (!LOVABLE_API_KEY) {
    throw new Error("LOVABLE_API_KEY not configured");
  }

  const prompt = getPromptForModule(module, topic, difficulty, questionType, monologue, voiceName, writingConfig);
  
  // Create performance logger for this task
  const perfLogger = createPerformanceLogger('generate');
  const modelName = "google/gemini-2.5-flash";
  const callStart = Date.now();

  try {
    const response = await fetchWithTimeout(
      "https://ai.gateway.lovable.dev/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${LOVABLE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: modelName,
          messages: [
            {
              role: "system",
              content:
                "You are an expert IELTS test creator. Generate high-quality, authentic exam content. Always respond with valid JSON only, no markdown code blocks.",
            },
            { role: "user", content: prompt },
          ],
        }),
      },
      90_000
    );

    if (!response.ok) {
      const errorText = await response.text();
      const callEnd = Date.now() - callStart;
      
      // Log appropriate error type
      const isQuota = response.status === 429 || 
                      errorText.toLowerCase().includes('quota') ||
                      errorText.toLowerCase().includes('resource_exhausted');
      
      if (isQuota) {
        await perfLogger.logQuotaExceeded(modelName, errorText.slice(0, 200));
      } else {
        await perfLogger.logError(modelName, `HTTP ${response.status}: ${errorText.slice(0, 100)}`, callEnd);
      }
      
      throw new Error(`AI generation failed: ${response.status} - ${errorText.slice(0, 200)}`);
    }

    const data = await response.json();
    const contentText = data.choices?.[0]?.message?.content;

    if (!contentText) {
      const callEnd = Date.now() - callStart;
      await perfLogger.logError(modelName, 'Empty AI response', callEnd);
      throw new Error("Empty AI response");
    }

    // Parse JSON from response
    let jsonContent = contentText;
    if (contentText.includes("```json")) {
      jsonContent = contentText.replace(/```json\n?/g, "").replace(/```\n?/g, "");
    } else if (contentText.includes("```")) {
      jsonContent = contentText.replace(/```\n?/g, "");
    }

    try {
      const result = JSON.parse(jsonContent.trim());
      
      // Log success
      const callEnd = Date.now() - callStart;
      await perfLogger.logSuccess(modelName, callEnd);
      
      return result;
    } catch (parseError) {
      const callEnd = Date.now() - callStart;
      await perfLogger.logError(modelName, 'JSON parse failed', callEnd);
      console.error("JSON parse error:", parseError, "Content:", jsonContent.slice(0, 500));
      throw new Error("Failed to parse AI response as JSON");
    }
  } catch (err) {
    // If error wasn't already logged, log it now
    if (err instanceof Error && !err.message.includes('AI generation failed') && !err.message.includes('Empty AI response') && !err.message.includes('Failed to parse')) {
      const callEnd = Date.now() - callStart;
      await perfLogger.logError(modelName, err.message, callEnd);
    }
    throw err;
  }
}

// Get prompt based on module and question type
function getPromptForModule(
  module: string,
  topic: string,
  difficulty: string,
  questionType: string,
  monologue: boolean,
  voiceName?: string,
  writingConfig?: any
): string {
  const difficultyDesc = difficulty === "easy" ? "Band 5.5-6.5" : difficulty === "medium" ? "Band 7-8" : "Band 8.5-9";
  // MCMA uses 3 questions (user selects 3 answers), all other types use 7
  const questionCount = questionType === "MULTIPLE_CHOICE_MULTIPLE" ? 3 : 7;
  const paragraphCount = 4; // Fixed per requirements

  switch (module) {
    case "reading":
      return getReadingPrompt(topic, difficultyDesc, questionType, questionCount, paragraphCount);
    case "listening":
      return getListeningPrompt(topic, difficultyDesc, questionType, questionCount, monologue, voiceName);
    case "writing":
      return getWritingPrompt(topic, difficultyDesc, questionType, writingConfig);
    case "speaking":
      return getSpeakingPrompt(topic, difficultyDesc, questionType);
    default:
      throw new Error(`Unknown module: ${module}`);
  }
}

function getReadingPrompt(topic: string, difficulty: string, questionType: string, questionCount: number, paragraphCount: number): string {
  const paragraphLabels = Array.from({ length: paragraphCount }, (_, i) => 
    String.fromCharCode(65 + i)
  ).map(l => `[${l}]`).join(", ");

  const basePrompt = `Generate an IELTS Academic Reading test with:
Topic: ${topic}
Difficulty: ${difficulty}

Create a reading passage with:
- ${paragraphCount} paragraphs labeled ${paragraphLabels}
- Each paragraph 80-150 words
- Academic tone, well-structured
- Contains specific testable information

`;

  switch (questionType) {
    case "TRUE_FALSE_NOT_GIVEN":
    case "YES_NO_NOT_GIVEN":
      return basePrompt + `Create ${questionCount} ${questionType === "YES_NO_NOT_GIVEN" ? "Yes/No/Not Given" : "True/False/Not Given"} questions.

Return ONLY valid JSON:
{
  "passage": {"title": "Title", "content": "Full passage with [A], [B], etc."},
  "instruction": "Do the following statements agree with the information given?",
  "questions": [
    {"question_number": 1, "question_text": "Statement", "correct_answer": "${questionType === "YES_NO_NOT_GIVEN" ? "YES" : "TRUE"}", "explanation": "Why"}
  ]
}`;

    case "MULTIPLE_CHOICE_SINGLE":
      return basePrompt + `Create ${questionCount} multiple choice questions (single answer).

Return ONLY valid JSON:
{
  "passage": {"title": "Title", "content": "Full passage"},
  "instruction": "Choose the correct letter, A, B, C or D.",
  "questions": [
    {"question_number": 1, "question_text": "Question?", "options": ["A Option", "B Option", "C Option", "D Option"], "correct_answer": "A", "explanation": "Why"}
  ]
}`;

    case "MULTIPLE_CHOICE_MULTIPLE":
      // For MCMA: Generate 1 question set spanning question numbers 1-3
      // User selects 3 correct answers from 6 options (A-F)
      return basePrompt + `Create a multiple choice question set where the test-taker must choose THREE correct answers from six options (A-F).

CRITICAL REQUIREMENTS:
- This question set spans Questions 1 to 3 (3 question numbers)
- Generate exactly 6 options (A through F)
- Generate exactly 3 correct answer letters (e.g., "A,C,E")
- Return exactly 3 question objects with question_number 1, 2, and 3
- ALL 3 question objects must have IDENTICAL content (same question_text, same options, same correct_answer)
- The correct_answer is a comma-separated list of 3 letters (e.g., "A,C,E")
- DO NOT always use A,C,E - randomize which 3 options are correct

Return ONLY valid JSON:
{
  "passage": {"title": "Title", "content": "Full passage with paragraph labels [A], [B], etc."},
  "instruction": "Questions 1-3. Choose THREE letters, A-F.",
  "max_answers": 3,
  "questions": [
    {
      "question_number": 1,
      "question_text": "Which THREE of the following statements are true according to the passage?",
      "options": ["A First statement", "B Second statement", "C Third statement", "D Fourth statement", "E Fifth statement", "F Sixth statement"],
      "correct_answer": "A,C,E",
      "max_answers": 3,
      "explanation": "A is correct because..., C is correct because..., E is correct because..."
    },
    {
      "question_number": 2,
      "question_text": "Which THREE of the following statements are true according to the passage?",
      "options": ["A First statement", "B Second statement", "C Third statement", "D Fourth statement", "E Fifth statement", "F Sixth statement"],
      "correct_answer": "A,C,E",
      "max_answers": 3,
      "explanation": "A is correct because..., C is correct because..., E is correct because..."
    },
    {
      "question_number": 3,
      "question_text": "Which THREE of the following statements are true according to the passage?",
      "options": ["A First statement", "B Second statement", "C Third statement", "D Fourth statement", "E Fifth statement", "F Sixth statement"],
      "correct_answer": "A,C,E",
      "max_answers": 3,
      "explanation": "A is correct because..., C is correct because..., E is correct because..."
    }
  ]
}`;

    case "MATCHING_HEADINGS":
      return basePrompt + `Create a matching headings task with ${questionCount} paragraphs needing headings.

Return ONLY valid JSON:
{
  "passage": {"title": "Title", "content": "Full passage with [A], [B], etc."},
  "instruction": "Choose the correct heading for each paragraph.",
  "headings": ["i Heading 1", "ii Heading 2", "iii Heading 3", "iv Heading 4", "v Heading 5", "vi Heading 6", "vii Heading 7", "viii Extra heading"],
  "questions": [
    {"question_number": 1, "question_text": "Paragraph A", "correct_answer": "ii", "explanation": "Why"}
  ]
}`;

    case "SENTENCE_COMPLETION":
      return basePrompt + `Create ${questionCount} sentence completion questions.

Return ONLY valid JSON:
{
  "passage": {"title": "Title", "content": "Full passage"},
  "instruction": "Complete the sentences. Write NO MORE THAN THREE WORDS.",
  "questions": [
    {"question_number": 1, "question_text": "The main advantage is _____.", "correct_answer": "increased efficiency", "explanation": "Why"}
  ]
}`;

    case "SUMMARY_COMPLETION":
    case "SUMMARY_WORD_BANK":
      return basePrompt + `Create a summary completion task with a word bank.
The summary_text should have gaps marked with {{1}}, {{2}}, {{3}} etc.
Create 4-6 questions where each correct_answer is a letter (A-H) from the word_bank.

Return ONLY valid JSON:
{
  "passage": {"title": "Title", "content": "Full passage with paragraph labels [A], [B], etc."},
  "instruction": "Complete the summary using the list of words, A-H, below.",
  "summary_text": "The passage discusses how {{1}} affects modern society. Scientists have found that {{2}} plays a crucial role. Furthermore, {{3}} has been identified as key, while {{4}} remains a concern.",
  "word_bank": [
    {"id": "A", "text": "technology"},
    {"id": "B", "text": "environment"},
    {"id": "C", "text": "research"},
    {"id": "D", "text": "education"},
    {"id": "E", "text": "climate"},
    {"id": "F", "text": "innovation"},
    {"id": "G", "text": "development"},
    {"id": "H", "text": "resources"}
  ],
  "questions": [
    {"question_number": 1, "question_text": "Gap 1", "correct_answer": "A", "explanation": "Technology is discussed as affecting society"},
    {"question_number": 2, "question_text": "Gap 2", "correct_answer": "C", "explanation": "Research is mentioned as crucial"},
    {"question_number": 3, "question_text": "Gap 3", "correct_answer": "E", "explanation": "Climate is identified as key factor"},
    {"question_number": 4, "question_text": "Gap 4", "correct_answer": "B", "explanation": "Environment remains a concern"}
  ]
}`;

    case "TABLE_COMPLETION":
      return basePrompt + `Create a table completion task with ${questionCount} blanks to fill.

CRITICAL RULES - FOLLOW EXACTLY:
1. WORD LIMIT: Maximum THREE words per answer. STRICTLY ENFORCED.
   - Every answer MUST be 1, 2, or 3 words maximum
   - NEVER use 4+ word answers - this violates IELTS standards
   - Vary the lengths naturally: mix of 1-word, 2-word, and 3-word answers
   - Example valid answers: "pollution" (1 word), "water supply" (2 words), "clean water supply" (3 words)
   - Example INVALID: "the clean water supply" (4 words - NEVER DO THIS)
2. Tables MUST have EXACTLY 3 COLUMNS (no more, no less).
3. Use inline blanks with __ (double underscores) within cell content, NOT separate cells for blanks.
   - Example: "Clean air and water, pollination of crops, and __" where __ is the blank
4. DISTRIBUTE blanks across BOTH column 2 AND column 3. Do NOT put all blanks only in column 2.
   - Alternate between putting blanks in the 2nd column and the 3rd column
   - At least 1/3 of blanks MUST be in the 3rd column

Return ONLY valid JSON in this exact format:
{
  "passage": {"title": "Title", "content": "Full passage with paragraph labels [A], [B], etc."},
  "instruction": "Complete the table below. Choose NO MORE THAN THREE WORDS from the passage for each answer.",
  "table_data": [
    [{"content": "Category", "is_header": true}, {"content": "Details", "is_header": true}, {"content": "Impact/Challenge", "is_header": true}],
    [{"content": "First item"}, {"content": "Description text and __", "has_question": true, "question_number": 1}, {"content": "Positive effect"}],
    [{"content": "Second item"}, {"content": "More text here"}, {"content": "Results in __", "has_question": true, "question_number": 2}],
    [{"content": "Third item"}, {"content": "Additional info about __", "has_question": true, "question_number": 3}, {"content": "Significant"}],
    [{"content": "Fourth item"}, {"content": "Details here"}, {"content": "Has __", "has_question": true, "question_number": 4}],
    [{"content": "Fifth item"}, {"content": "Uses __ method", "has_question": true, "question_number": 5}, {"content": "Effective"}]
  ],
  "questions": [
    {"question_number": 1, "question_text": "Fill in blank 1", "correct_answer": "resources", "explanation": "Found in paragraph B"},
    {"question_number": 2, "question_text": "Fill in blank 2", "correct_answer": "water scarcity", "explanation": "Found in paragraph C"},
    {"question_number": 3, "question_text": "Fill in blank 3", "correct_answer": "deforestation", "explanation": "Found in paragraph D"},
    {"question_number": 4, "question_text": "Fill in blank 4", "correct_answer": "limitations", "explanation": "Found in paragraph E"},
    {"question_number": 5, "question_text": "Fill in blank 5", "correct_answer": "solar", "explanation": "Found in paragraph A"}
  ]
}`;

    case "SHORT_ANSWER":
      return basePrompt + `Create ${questionCount} short answer questions.

Return ONLY valid JSON:
{
  "passage": {"title": "Title", "content": "Full passage"},
  "instruction": "Answer the questions. Write NO MORE THAN THREE WORDS.",
  "questions": [
    {"question_number": 1, "question_text": "What was the main finding?", "correct_answer": "carbon emissions", "explanation": "Why"}
  ]
}`;

    default:
      return basePrompt + `Create ${questionCount} True/False/Not Given questions.

Return ONLY valid JSON:
{
  "passage": {"title": "Title", "content": "Full passage"},
  "instruction": "Do the following statements agree with the information given?",
  "questions": [
    {"question_number": 1, "question_text": "Statement", "correct_answer": "TRUE", "explanation": "Why"}
  ]
}`;
  }
}

function getListeningPrompt(topic: string, difficulty: string, questionType: string, questionCount: number, monologue: boolean, voiceName?: string): string {
  // TEMPORARY: 1 minute audio for testing (revert to 300-500 words / 4 minutes for production)
  
  // Build gender constraint if voice is provided
  const genderConstraint = voiceName ? buildGenderConstraint(voiceName, !monologue) : '';
  
  const speakerInstructions = monologue
    ? `Create a monologue (single speaker) script that is:
- 100-150 words (approximately 1 minute when spoken)
- Use "Speaker1:" prefix for all lines
- Include speaker_names: {"Speaker1": "Role/Name"}`
    : `Create a dialogue between two people that is:
- 100-150 words (approximately 1 minute when spoken)
- Use "Speaker1:" and "Speaker2:" prefixes
- Include speaker_names: {"Speaker1": "Name", "Speaker2": "Name"}`;

  // NATURAL GAP POSITIONING INSTRUCTION
  const gapPositionInstruction = `
CRITICAL - NATURAL GAP/BLANK POSITIONING:
For fill-in-the-blank questions, you MUST randomize the position of the missing word (represented by _____):
- 30% of questions: Blank should be near the START of the sentence (e.g., "_____ is the main attraction.")
- 40% of questions: Blank should be in the MIDDLE of the sentence (e.g., "The event starts at _____ on Saturday.")
- 30% of questions: Blank should be at the END of the sentence (e.g., "Visitors should bring _____.")
- Ensure the sentence context makes the missing word deducible from the audio.
- NEVER put all blanks at the same position - vary them naturally across questions.`;

  const basePrompt = `Generate an IELTS Listening test section:
Topic: ${topic}
Difficulty: ${difficulty}
${genderConstraint}

${speakerInstructions}
- Natural conversation with realistic names/roles
- Contains specific details (names, numbers, dates, locations)
- Use natural, short pauses: <break time='500ms'/> between sentences. NEVER use pauses longer than 1 second.

`;

  switch (questionType) {
    case "FILL_IN_BLANK":
      return basePrompt + `Create ${questionCount} fill-in-the-blank questions.
${gapPositionInstruction}

CRITICAL NEGATIVE CONSTRAINT: You are PROHIBITED from placing the blank at the very end of the sentence more than 30% of the time. Vary positions naturally.

Return ONLY valid JSON:
{
  "dialogue": "Speaker1: Welcome to the museum.<break time='500ms'/>\\nSpeaker2: Thank you for having me...",
  "speaker_names": {"Speaker1": "Guide", "Speaker2": "Visitor"},
  "instruction": "Complete the notes. Write NO MORE THAN THREE WORDS.",
  "questions": [
    {"question_number": 1, "question_text": "_____ is located near the entrance.", "correct_answer": "The gift shop", "explanation": "Speaker mentions location (START gap)"},
    {"question_number": 2, "question_text": "The tour starts at _____ each morning.", "correct_answer": "9:30 AM", "explanation": "Speaker mentions time (MIDDLE gap)"},
    {"question_number": 3, "question_text": "Visitors should bring _____.", "correct_answer": "comfortable shoes", "explanation": "Speaker recommends footwear (END gap)"}
  ]
}`;

    case "MULTIPLE_CHOICE_SINGLE":
      return basePrompt + `Create ${questionCount} multiple choice questions (single answer).

Return ONLY valid JSON:
{
  "dialogue": "Speaker1: Let me explain...<break time='500ms'/>",
  "speaker_names": {"Speaker1": "Instructor"},
  "instruction": "Choose the correct letter, A, B or C.",
  "questions": [
    {"question_number": 1, "question_text": "What is the main topic?", "options": ["A First", "B Second", "C Third"], "correct_answer": "A", "explanation": "Why"}
  ]
}`;

    case "MULTIPLE_CHOICE_MULTIPLE":
      // MCMA for Listening presets must be the same UX as Reading MCMA:
      // Questions 1-3 are a SINGLE checkbox task (select 3 answers from A-F).
      // We duplicate the same question object 3 times so the UI can label the range consistently.
      return basePrompt + `Create ONE multiple choice question set where the test-taker must choose THREE correct answers from six options (A-F).

CRITICAL REQUIREMENTS:
- This question set spans Questions 1 to 3 (3 question numbers)
- Return EXACTLY 3 question objects with question_number 1, 2, and 3
- ALL 3 question objects must have IDENTICAL content (same question_text, same options, same correct_answer)
- Provide exactly 6 options labeled A-F
- correct_answer MUST be a comma-separated list of exactly 3 letters (e.g., "A,C,E")
- Set max_answers to 3
- The statements MUST be clearly supported by the dialogue (so answers are objectively checkable)

Return ONLY valid JSON:
{
  "dialogue": "Speaker1: ...<break time='500ms'/>\nSpeaker2: ...",
  "speaker_names": {"Speaker1": "Name", "Speaker2": "Name"},
  "instruction": "Questions 1-3. Choose THREE letters, A-F.",
  "max_answers": 3,
  "questions": [
    {
      "question_number": 1,
      "question_text": "Which THREE of the following statements are correct?",
      "options": ["A ...", "B ...", "C ...", "D ...", "E ...", "F ..."],
      "correct_answer": "A,C,E",
      "max_answers": 3,
      "explanation": "A is correct because... C is correct because... E is correct because..."
    },
    {
      "question_number": 2,
      "question_text": "Which THREE of the following statements are correct?",
      "options": ["A ...", "B ...", "C ...", "D ...", "E ...", "F ..."],
      "correct_answer": "A,C,E",
      "max_answers": 3,
      "explanation": "A is correct because... C is correct because... E is correct because..."
    },
    {
      "question_number": 3,
      "question_text": "Which THREE of the following statements are correct?",
      "options": ["A ...", "B ...", "C ...", "D ...", "E ...", "F ..."],
      "correct_answer": "A,C,E",
      "max_answers": 3,
      "explanation": "A is correct because... C is correct because... E is correct because..."
    }
  ]
}`;

    case "TABLE_COMPLETION":
      return basePrompt + `Create a table completion task with ${questionCount} blanks.

Return ONLY valid JSON:
{
  "dialogue": "Speaker1: Here's the schedule...<break time='500ms'/>",
  "speaker_names": {"Speaker1": "Coordinator"},
  "instruction": "Complete the table below.",
  "table_data": {
    "headers": ["Event", "Time", "Location"],
    "rows": [
      [{"text": "Opening"}, {"text": "9:00 AM"}, {"isBlank": true, "questionNumber": 1}]
    ]
  },
  "questions": [
    {"question_number": 1, "question_text": "Location", "correct_answer": "Main Hall", "explanation": "Why"}
  ]
}`;

    case "NOTE_COMPLETION":
      return basePrompt + `Create a note completion task with ${questionCount} blanks.

Return ONLY valid JSON:
{
  "dialogue": "Speaker1: The key points are...<break time='500ms'/>",
  "speaker_names": {"Speaker1": "Lecturer"},
  "instruction": "Complete the notes below.",
  "note_sections": [
    {"title": "Main Topic", "items": [{"text_before": "Focus is on", "question_number": 1, "text_after": ""}]}
  ],
  "questions": [
    {"question_number": 1, "question_text": "Note 1", "correct_answer": "research methods", "explanation": "Why"}
  ]
}`;

    case "MATCHING_CORRECT_LETTER":
      return basePrompt + `Create ${questionCount} matching questions.

Return ONLY valid JSON:
{
  "dialogue": "Speaker1: Each department has...<break time='500ms'/>",
  "speaker_names": {"Speaker1": "Manager"},
  "instruction": "Match each person to their department.",
  "options": [{"letter": "A", "text": "Marketing"}, {"letter": "B", "text": "Finance"}, {"letter": "C", "text": "HR"}],
  "questions": [
    {"question_number": 1, "question_text": "John works in", "correct_answer": "A", "explanation": "Why"}
  ]
}`;

    default:
      return basePrompt + `Create ${questionCount} fill-in-the-blank questions.

Return ONLY valid JSON:
{
  "dialogue": "Speaker1: dialogue...<break time='500ms'/>\\nSpeaker2: response...",
  "speaker_names": {"Speaker1": "Host", "Speaker2": "Guest"},
  "instruction": "Complete the notes below.",
  "questions": [
    {"question_number": 1, "question_text": "The event is in _____.", "correct_answer": "main garden", "explanation": "Why"}
  ]
}`;
  }
}

function getWritingPrompt(topic: string, difficulty: string, taskType: string, writingConfig?: any): string {
  // For Task 1, we MUST enforce the specific visual type from writingConfig
  if (
    taskType === "TASK_1" ||
    taskType === "BAR_CHART" ||
    taskType === "LINE_GRAPH" ||
    taskType === "PIE_CHART" ||
    taskType === "TABLE" ||
    taskType === "MIXED_CHARTS" ||
    taskType === "PROCESS_DIAGRAM" ||
    taskType === "MAP"
  ) {
    // Determine the visual type - use explicit type if passed, or from config, or randomize
    let visualTypeToUse: string;

    // Priority: taskType if it's a specific visual type > writingConfig.task1VisualType > RANDOM
    const specificVisualTypes = ['BAR_CHART', 'LINE_GRAPH', 'PIE_CHART', 'TABLE', 'MIXED_CHARTS', 'PROCESS_DIAGRAM', 'MAP'];
    if (specificVisualTypes.includes(taskType)) {
      visualTypeToUse = taskType;
    } else if (writingConfig?.task1VisualType && writingConfig.task1VisualType !== 'RANDOM') {
      visualTypeToUse = writingConfig.task1VisualType;
    } else {
      // For bulk generation, default to chart types only (BAR, LINE, PIE, TABLE, MIXED_CHARTS)
      const chartTypes = ['BAR_CHART', 'LINE_GRAPH', 'PIE_CHART', 'TABLE', 'MIXED_CHARTS'];
      visualTypeToUse = chartTypes[Math.floor(Math.random() * chartTypes.length)];
    }

    console.log(`[Writing Task 1] Using visual type: ${visualTypeToUse}`);

    const instructionVerb = visualTypeToUse === 'MIXED_CHARTS' ? 'show' : 'shows';

    // Build type-specific visualData examples - EXACTLY matching generate-ai-practice
    let visualDataExample: string;
    let typeSpecificInstructions: string;

    switch (visualTypeToUse) {
      case 'MIXED_CHARTS':
        visualDataExample = `{
    "type": "MIXED_CHARTS",
    "title": "Mixed Visuals Title",
    "charts": [
      {
        "type": "BAR_CHART",
        "title": "Bar Chart Title",
        "xAxisLabel": "Category",
        "yAxisLabel": "Percentage (%)",
        "data": [
          { "label": "Group A", "value": 45 },
          { "label": "Group B", "value": 32 },
          { "label": "Group C", "value": 28 },
          { "label": "Group D", "value": 55 }
        ]
      },
      {
        "type": "PIE_CHART",
        "title": "Pie Chart Title",
        "data": [
          { "label": "Segment A", "value": 35 },
          { "label": "Segment B", "value": 25 },
          { "label": "Segment C", "value": 20 },
          { "label": "Segment D", "value": 20 }
        ]
      }
    ]
  }`;
        typeSpecificInstructions = `Create EXACTLY TWO charts in the "charts" array. Each chart MUST be one of: BAR_CHART, LINE_GRAPH, PIE_CHART, TABLE. Use TWO DIFFERENT types. For PIE_CHART, values must add up to 100. Keep labels under 15 characters.`;
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

    // Return prompt that EXACTLY matches generate-ai-practice structure
    return `You are a data analyst. Generate an IELTS Academic Writing Task 1 with BOTH the essay question AND the chart/diagram data.

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
    // Task 2 prompt
    const essayTypeToUse = writingConfig?.task2EssayType && writingConfig.task2EssayType !== 'RANDOM'
      ? writingConfig.task2EssayType
      : ['OPINION', 'DISCUSSION', 'PROBLEM_SOLUTION', 'ADVANTAGES_DISADVANTAGES', 'TWO_PART_QUESTION'][Math.floor(Math.random() * 5)];

    const essayFormatGuide: Record<string, string> = {
      'OPINION': 'To what extent do you agree or disagree?',
      'DISCUSSION': 'Discuss both views and give your own opinion.',
      'PROBLEM_SOLUTION': 'What are the causes of this problem and what solutions can you suggest?',
      'ADVANTAGES_DISADVANTAGES': 'What are the advantages and disadvantages of this?',
      'TWO_PART_QUESTION': 'Include two related questions that the student must address.'
    };

    // Add uniqueness for Task 2
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

    return `Generate an IELTS Academic Writing Task 2.

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
- End with the appropriate question format for ${essayTypeToUse}: "${essayFormatGuide[essayTypeToUse] || ''}"
- Include: "Give reasons for your answer and include any relevant examples from your own knowledge or experience."
- End with: "Write at least 250 words."

Return this EXACT JSON structure:
{
  "task_type": "task2",
  "instruction": "[Context statement about the topic]. [Main argument or question]. ${essayFormatGuide[essayTypeToUse] || ''} Give reasons for your answer and include any relevant examples from your own knowledge or experience. Write at least 250 words.",
  "essay_type": "${essayTypeToUse}"
}`;
  }
}

function getSpeakingPrompt(topic: string, difficulty: string, questionType: string): string {
  // Add uniqueness seed and thematic angles to ensure variety
  const uniquenessSeed = crypto.randomUUID().slice(0, 8);
  const randomAngles = [
    'personal experiences and childhood memories',
    'social and cultural perspectives',
    'future trends and technological changes',
    'advantages, disadvantages, and trade-offs',
    'generational differences and age perspectives',
    'regional and international comparisons',
    'environmental and sustainability considerations',
    'economic and financial aspects',
  ];
  const selectedAngle = randomAngles[Math.floor(Math.random() * randomAngles.length)];
  
  const questionVariety = [
    'Include questions starting with "When", "Where", "Who", "How", not just "Do you" or "What".',
    'Mix hypothetical questions ("If you could...") with factual ones.',
    'Include comparison questions ("How has X changed over the years?").',
    'Add preference questions ("Which do you prefer...and why?").',
  ];
  const selectedVariety = questionVariety[Math.floor(Math.random() * questionVariety.length)];

  // CRITICAL: Strict sample_answers enforcement for all speaking parts
  const sampleAnswerEnforcement = `
MANDATORY - SAMPLE ANSWERS REQUIREMENTS (STRICT WORD COUNTS):
1. You MUST include "sample_answers" array for EVERY part - this is NOT optional
2. Each sample_answer MUST be a COMPLETE, GRAMMATICALLY CORRECT sentence or paragraph
3. NEVER end a sentence mid-phrase (e.g., "I frequent." is WRONG - it should be "I frequent regularly.")
4. NEVER truncate or cut off answers - complete every thought
5. Each Part 1 sample_answer: 60-85 words per question (natural, conversational with personal examples and details)
6. Part 2 sample_answer: 260-340 words (comprehensive long turn covering ALL cue card points with elaboration, examples, and a proper conclusion)
7. Each Part 3 sample_answer: 130-170 words per question (in-depth discussion with clear reasoning, examples, and balanced perspectives)
8. Verify each sample_answer ends with proper punctuation and a complete thought
9. Re-read each sample_answer before finalizing to ensure it makes grammatical sense
10. These word counts are MINIMUM STANDARDS - sample answers must demonstrate ideal IELTS response structure`;

  // Generate only the requested part(s) based on questionType
  if (questionType === "PART_1") {
    return `Generate an IELTS Speaking Part 1 test matching EXACT Cambridge IELTS standard:
Topic: ${topic}
Uniqueness ID: ${uniquenessSeed}
Thematic Focus: ${selectedAngle}

CRITICAL - CAMBRIDGE STANDARD QUESTIONS:
- Target Band 7-8 level: SIMPLE, NATURAL, CONVERSATIONAL questions
- Keep questions SHORT (8-15 words maximum)
- ${selectedVariety}
- Each question explores a DIFFERENT aspect of the topic
- Questions should sound like natural examiner speech, not written text
- DO NOT use generic "Do you like X?" - use specific angles instead

Part 1 = everyday personal questions. Generate 4 SHORT, DIRECT questions.
Examples of good questions: "When did you last...?", "Where do you usually...?", "How has... changed?"

${sampleAnswerEnforcement}

Return ONLY valid JSON:
{
  "part1": {
    "instruction": "I'd like to ask you some questions about yourself.",
    "questions": ["Short Q1 (8-15 words)?", "Short Q2?", "Short Q3?", "Short Q4?"],
    "sample_answers": [
      "Complete 2-4 sentence answer to Q1. It should be natural and flow well. End with proper punctuation.",
      "Complete answer to Q2 with 2-4 sentences. Make sure every sentence is grammatically complete.",
      "Complete answer to Q3. Each response should demonstrate Band 7+ vocabulary naturally.",
      "Complete answer to Q4. Never leave sentences incomplete or cut off mid-phrase."
    ]
  }
}`;
  }

  if (questionType === "PART_2") {
    return `Generate an IELTS Speaking Part 2 cue card matching EXACT Cambridge IELTS standard:
Topic: ${topic}
Uniqueness ID: ${uniquenessSeed}
Thematic Focus: ${selectedAngle}

CRITICAL - CAMBRIDGE STANDARD CUE CARD:
- Target Band 7-8 level: Clear, accessible topic that any candidate can discuss
- Keep bullet points CONCISE (5-8 words each)
- The "Describe..." topic should be specific but NOT overly complex
- Avoid philosophical or abstract topics - focus on concrete experiences

Part 2 = describe a specific experience/thing. Create a clear, answerable cue card.

IMPORTANT: DO NOT include an "instruction" field - Part 2 instructions are static shared audio.

${sampleAnswerEnforcement}

Return ONLY valid JSON:
{
  "part2": {
    "cue_card": "Describe [specific thing related to ${topic}].\\nYou should say:\\n- bullet 1 (5-8 words)\\n- bullet 2 (5-8 words)\\n- bullet 3 (5-8 words)\\nAnd explain why/how...",
    "preparation_time": 60,
    "speaking_time": 120,
    "sample_answer": "Complete 180-220 word model answer. Start with an introduction, cover all bullet points naturally, and end with a proper conclusion. Every sentence must be grammatically complete. Do not truncate or cut off any sentence. The answer should flow naturally as spoken English and demonstrate Band 7+ fluency and vocabulary."
  }
}`;
  }

  if (questionType === "PART_3") {
    return `Generate IELTS Speaking Part 3 discussion questions matching EXACT Cambridge IELTS standard:
Topic: ${topic}
Uniqueness ID: ${uniquenessSeed}
Thematic Focus: ${selectedAngle}

CRITICAL - CAMBRIDGE STANDARD DISCUSSION:
- Target Band 7-8 level: CLEAR, ACCESSIBLE discussion questions
- STRICT QUESTION LENGTH: Each Part 3 question MUST be EXACTLY 12-16 words. Count carefully!
- MINIMUM 12 words per question - questions with fewer than 12 words will be rejected
- MAXIMUM 16 words per question - questions with more than 16 words will be rejected
- ${selectedVariety}
- Questions need opinion/analysis but should NOT be overly philosophical
- Avoid complex academic language - use conversational tone

Part 3 = discussion questions. Generate 4 or 5 CLEAR questions requiring opinion/analysis (minimum 4, maximum 5).
STRICT WORD COUNT: Each question MUST have EXACTLY 12-16 words (minimum 12, maximum 16). Count every word!
Example good questions (12-16 words each):
- "What do you think are the main benefits of learning a foreign language?" (14 words)
- "How has technology changed the way people communicate with each other nowadays?" (12 words)
- "Why do you think some people prefer to live in cities rather than rural areas?" (15 words)

${sampleAnswerEnforcement}

Return ONLY valid JSON:
{
  "part3": {
    "instruction": "Let's discuss some more general questions related to this topic.",
    "questions": ["Clear discussion Q1 (12-16 words)?", "Q2 (12-16 words)?", "Q3 (12-16 words)?", "Q4 (12-16 words)?"],
    "sample_answers": [
      "Complete 3-5 sentence analytical answer to Q1. Include reasoning and examples. Every sentence must be complete.",
      "Complete analytical answer to Q2 with proper structure and conclusion.",
      "Complete analytical answer to Q3. End with a clear, complete final thought.",
      "Complete analytical answer to Q4. End with a clear, complete final thought."
    ]
  }
}`;
  }

  // FULL_TEST - all three parts
  return `Generate an IELTS Speaking test with all three parts matching EXACT Cambridge IELTS standard:
Topic: ${topic}
Uniqueness ID: ${uniquenessSeed}
Thematic Focus: ${selectedAngle}

CRITICAL - CAMBRIDGE STANDARD FOR ALL PARTS:
1. Target Band 7-8 level throughout - NOT Band 9+ complexity
2. Part 1 questions: SHORT (8-15 words), simple, conversational
3. Part 2 cue card: Clear topic, CONCISE bullet points (5-8 words each)
4. Part 3 questions: 4-5 questions, STRICT 12-16 words each (MINIMUM 12 words, count carefully!)
5. ${selectedVariety}
6. Each question explores a DIFFERENT aspect of the topic
7. Questions should sound like natural examiner speech
8. Avoid overly academic, philosophical, or complex language

PART 3 WORD COUNT ENFORCEMENT:
- Each Part 3 question MUST have EXACTLY 12-16 words (not 10, not 11 - minimum is 12!)
- Example: "What do you think are the main benefits of learning a foreign language?" = 14 words ✓
- Example: "How has technology changed the way people communicate with each other nowadays?" = 12 words ✓

${sampleAnswerEnforcement}

Return ONLY valid JSON:
{
  "part1": {
    "instruction": "I'd like to ask you some questions about yourself.",
    "questions": ["Short Q1 (8-15 words)?", "Short Q2?", "Short Q3?", "Short Q4?"],
    "sample_answers": [
      "Complete 2-4 sentence answer. Natural, flowing response with proper grammar.",
      "Complete answer with examples. Every sentence grammatically complete.",
      "Complete answer demonstrating vocabulary. No truncated phrases.",
      "Complete final answer with proper conclusion and punctuation."
    ]
  },
  "part2": {
    "cue_card": "Describe [specific thing]...\\nYou should say:\\n- bullet 1 (5-8 words)\\n- bullet 2\\n- bullet 3\\nAnd explain why/how...",
    "preparation_time": 60,
    "speaking_time": 120,
    "sample_answer": "Complete 180-220 word model answer covering all bullet points. Must have proper introduction, body, and conclusion. Every sentence complete. No truncation."
  },
  "part3": {
    "instruction": "Let's discuss some more general questions.",
    "questions": ["Clear discussion Q1 (12-16 words)?", "Q2 (12-16 words)?", "Q3 (12-16 words)?", "Q4 (12-16 words)?"],
    "sample_answers": [
      "Complete 3-5 sentence analytical answer with reasoning and examples.",
      "Complete analytical response with clear structure and conclusion.",
      "Complete analytical answer with proper ending. No incomplete sentences.",
      "Complete final answer with proper ending. No incomplete sentences."
    ]
  }
}`;
}

// Direct Gemini TTS call using api_keys table with FULL retry across ALL available keys
// Uses TTS-specific quota tracking
async function generateGeminiTtsDirect(
  supabaseServiceClient: any,
  text: string,
  voiceName: string
): Promise<{ audioBase64: string; sampleRate: number }> {
  // Ensure we have TTS API keys cached (filtered by TTS quota)
  if (ttsKeyCache.length === 0) {
    ttsKeyCache = await getActiveGeminiKeysForTTS(supabaseServiceClient);
    if (ttsKeyCache.length === 0) {
      throw new Error("No active Gemini API keys available for TTS (all may have hit quota limit)");
    }
  }

  const prompt = `You are an IELTS Speaking examiner with a neutral British accent.\n\nRead aloud EXACTLY the following text. Do not add, remove, or paraphrase anything. Use natural pacing and clear pronunciation.\n\n"""\n${text}\n"""`;

  // Try ALL available API keys - if one fails, move to the next
  let lastError: Error | null = null;
  const keysToTry = ttsKeyCache.length; // Try ALL keys, not just 3
  const triedKeyIds = new Set<string>();
  
  for (let i = 0; i < keysToTry; i++) {
    const keyRecord = getNextTTSApiKey();
    if (!keyRecord || triedKeyIds.has(keyRecord.id)) continue;
    triedKeyIds.add(keyRecord.id);
    
    try {
      const resp = await fetchWithTimeout(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${keyRecord.key_value}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              responseModalities: ["AUDIO"],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName },
                },
              },
            },
          }),
        },
        90_000
      );

      if (!resp.ok) {
        const errorText = await resp.text();
        console.error(`Gemini TTS error with key ${keyRecord.id}:`, resp.status, errorText.slice(0, 200));
        
        // Check if this is a PERMANENT daily quota exhaustion (not just rate limit)
        if (isPermanentQuotaError(errorText)) {
          console.log(`Key ${keyRecord.id} hit permanent TTS quota limit, marking as exhausted for ${TTS_MODEL}`);
          await markTTSQuotaExhausted(supabaseServiceClient, keyRecord.id);
        } else if (isQuotaExhaustedError(resp.status, errorText)) {
          // Rate limit - just log and continue to next key
          console.log(`Key ${keyRecord.id} hit rate limit for TTS, trying next key`);
        } else {
          // Track error for this key - deactivate on auth errors
          await incrementKeyErrorCount(supabaseServiceClient, keyRecord.id, resp.status === 401 || resp.status === 403);
        }
        
        lastError = new Error(`Gemini TTS failed (${resp.status})`);
        // Continue to next key
        continue;
      }

      const data = await resp.json();
      const audioData = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data as string | undefined;
      
      if (!audioData) {
        lastError = new Error("No audio returned from Gemini TTS");
        continue;
      }
      
      // Success - reset error count
      await resetKeyErrorCount(supabaseServiceClient, keyRecord.id);
      
      return { audioBase64: audioData, sampleRate: 24000 };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.error(`Gemini TTS attempt with key ${keyRecord.id} failed:`, lastError.message);
      // Continue to next key
    }
  }

  throw lastError || new Error("All Gemini API keys failed for TTS");
}

async function generateGeminiTtsMultiSpeaker(
  supabaseServiceClient: any,
  text: string,
  voices: { Speaker1: string; Speaker2: string }
): Promise<{ audioBase64: string; sampleRate: number }> {
  // Ensure we have TTS API keys cached (filtered by TTS quota)
  if (ttsKeyCache.length === 0) {
    ttsKeyCache = await getActiveGeminiKeysForTTS(supabaseServiceClient);
    if (ttsKeyCache.length === 0) {
      throw new Error("No active Gemini API keys available for TTS (all may have hit quota limit)");
    }
  }

  const prompt = `Read the following IELTS Listening dialogue naturally.
- Do NOT speak the labels "Speaker1" or "Speaker2" out loud.
- Keep a short pause between turns.
- Speak clearly at a moderate pace.

${text}`;

  let lastError: Error | null = null;
  const keysToTry = ttsKeyCache.length;
  const triedKeyIds = new Set<string>();

  for (let i = 0; i < keysToTry; i++) {
    const keyRecord = getNextTTSApiKey();
    if (!keyRecord || triedKeyIds.has(keyRecord.id)) continue;
    triedKeyIds.add(keyRecord.id);

    try {
      const resp = await fetchWithTimeout(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${keyRecord.key_value}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              responseModalities: ["AUDIO"],
              speechConfig: {
                multiSpeakerVoiceConfig: {
                  speakerVoiceConfigs: [
                    {
                      speaker: "Speaker1",
                      voiceConfig: { prebuiltVoiceConfig: { voiceName: voices.Speaker1 } },
                    },
                    {
                      speaker: "Speaker2",
                      voiceConfig: { prebuiltVoiceConfig: { voiceName: voices.Speaker2 } },
                    },
                  ],
                },
              },
            },
          }),
        },
        90_000
      );

      if (!resp.ok) {
        const errorText = await resp.text();
        console.error(
          `Gemini multi-speaker TTS error with key ${keyRecord.id}:`,
          resp.status,
          errorText.slice(0, 200)
        );
        
        // Check if this is a PERMANENT daily quota exhaustion (not just rate limit)
        if (isPermanentQuotaError(errorText)) {
          console.log(`Key ${keyRecord.id} hit permanent TTS quota limit, marking as exhausted for ${TTS_MODEL}`);
          await markTTSQuotaExhausted(supabaseServiceClient, keyRecord.id);
        } else if (isQuotaExhaustedError(resp.status, errorText)) {
          // Rate limit - just log and continue to next key
          console.log(`Key ${keyRecord.id} hit rate limit for TTS (multi-speaker), trying next key`);
        } else {
          await incrementKeyErrorCount(
            supabaseServiceClient,
            keyRecord.id,
            resp.status === 401 || resp.status === 403
          );
        }
        
        lastError = new Error(`Gemini multi-speaker TTS failed (${resp.status})`);
        continue;
      }

      const data = await resp.json();
      const audioData = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data as string | undefined;

      if (!audioData) {
        lastError = new Error("No audio returned from Gemini multi-speaker TTS");
        continue;
      }

      await resetKeyErrorCount(supabaseServiceClient, keyRecord.id);
      return { audioBase64: audioData, sampleRate: 24000 };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.error(
        `Gemini multi-speaker TTS attempt with key ${keyRecord.id} failed:`,
        lastError.message
      );
    }
  }

  throw lastError || new Error("All Gemini API keys failed for TTS (multi-speaker)");
}

// Generate and upload audio for listening tests
async function generateAndUploadAudio(
  supabaseServiceClient: any,
  text: string,
  speaker1Voice: string,
  speaker2Voice: string | undefined,
  monologue: boolean,
  jobId: string,
  index: number
): Promise<string> {
  const normalized = text
    .replace(/\r\n/g, "\n")
    .replace(/\[pause\s*\d*s?\]/gi, "...")
    .trim();

  const isDialogue = !monologue && /Speaker1\s*:/i.test(normalized) && /Speaker2\s*:/i.test(normalized);

  // Keep speaker turn boundaries for multi-speaker TTS
  let cleanText = normalized;
  if (isDialogue) {
    cleanText = cleanText
      // Ensure each speaker label starts on a new line
      .replace(/\s*(Speaker1\s*:)/gi, "\n$1")
      .replace(/\s*(Speaker2\s*:)/gi, "\n$1")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  } else {
    cleanText = cleanText
      .replace(/\n+/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  cleanText = cleanText.slice(0, 5000).trim();

  if (!cleanText) {
    throw new Error("Empty text for TTS");
  }

  // Use multi-speaker Gemini TTS when we detect Speaker1/Speaker2 dialogue
  const { audioBase64, sampleRate } = isDialogue && speaker2Voice
    ? await generateGeminiTtsMultiSpeaker(supabaseServiceClient, cleanText, {
        Speaker1: speaker1Voice,
        Speaker2: speaker2Voice,
      })
    : await generateGeminiTtsDirect(supabaseServiceClient, cleanText, speaker1Voice);

  // Use WAV for bulk admin audio (MP3 encoding exceeds CPU time limits on edge functions)
  // The file size increase is acceptable for admin presets; can be compressed offline if needed
  const { createWavFromPcm } = await import("../_shared/audioCompressor.ts");
  const { uploadToR2 } = await import("../_shared/r2Client.ts");

  const pcmBytes = Uint8Array.from(atob(audioBase64), (c) => c.charCodeAt(0));
  const wavBytes = createWavFromPcm(pcmBytes, sampleRate);
  // Admin audio goes to "presets/" folder for permanent storage
  const key = `presets/${jobId}/${index}.wav`;

  const uploadResult = await uploadToR2(key, wavBytes, "audio/wav");

  if (!uploadResult.success || !uploadResult.url) {
    throw new Error(uploadResult.error || "R2 upload failed");
  }

  return uploadResult.url;
}

// Parallel processing helper with concurrency limit
async function processWithConcurrency<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number
): Promise<R[]> {
  const results: R[] = [];
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const currentIndex = index++;
      try {
        results[currentIndex] = await fn(items[currentIndex]);
      } catch (err) {
        // Store null for failed items - caller handles
        results[currentIndex] = null as unknown as R;
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// Generate speaking audio for QUESTIONS ONLY (PARALLELIZED)
// Instruction/transition/ending audio is NOT generated here - those are fetched from speaking_shared_audio table
// This saves TTS API calls and storage, and ensures voice consistency across all tests
async function generateSpeakingAudio(
  supabaseServiceClient: any,
  content: any,
  voiceName: string,
  jobId: string,
  index: number,
  questionType: string = "FULL_TEST"
): Promise<Record<string, string> | null> {
  const ttsItems: Array<{ key: string; text: string }> = [];
  
  // Only collect TTS items for the requested part(s)
  // IMPORTANT: We only generate audio for QUESTIONS, not instructions/transitions
  // Shared audio keys (part1_intro, part1_ending, part2_intro, part2_prep_start, part2_prep_end, 
  // part2_ending, part3_intro, part3_ending, test_ending) are fetched from speaking_shared_audio table
  const includePart1 = questionType === "FULL_TEST" || questionType === "PART_1";
  const includePart2 = questionType === "FULL_TEST" || questionType === "PART_2";
  const includePart3 = questionType === "FULL_TEST" || questionType === "PART_3";
  
  // Part 1: Only generate question audio (not instruction - that's shared)
  if (includePart1 && content.part1) {
    content.part1.questions?.forEach((q: string, idx: number) => {
      ttsItems.push({ key: `part1_q${idx + 1}`, text: q });
    });
  }
  
  // Part 2: NO audio generation needed
  // The cue card is displayed visually (not spoken by examiner)
  // All instructions (part2_intro, part2_prep_start, part2_prep_end) use shared audio
  // Part 2 content is purely text-based for display and evaluation
  // if (includePart2 && content.part2) { 
  //   // DISABLED: No TTS for Part 2 - cue card is shown on screen, not read aloud
  // }
  
  // Part 3: Only generate question audio (not instruction - that's shared)
  if (includePart3 && content.part3) {
    content.part3.questions?.forEach((q: string, idx: number) => {
      ttsItems.push({ key: `part3_q${idx + 1}`, text: q });
    });
  }
  
  // Note: test_ending is NOT generated - it's fetched from speaking_shared_audio
  
  if (ttsItems.length === 0) {
    return null;
  }

  console.log(`[Job ${jobId}] Generating audio for ${ttsItems.length} speaking QUESTION items only (${questionType}) - shared audio excluded`);

  // IMPORTANT: Do NOT MP3-encode inside the edge function.
  // Full speaking tests can exceed CPU limits during MP3 encoding.
  // We upload WAV here and (optionally) let the admin UI auto-compress to MP3 client-side.
  const { createWavFromPcm } = await import("../_shared/audioCompressor.ts");
  const { uploadToR2 } = await import("../_shared/r2Client.ts");

  // Process TTS items in parallel with concurrency limit (use all available API keys efficiently)
  const concurrency = Math.min(apiKeyCache.length || 3, 5);

  const results = await processWithConcurrency(
    ttsItems,
    async (item) => {
      try {
        const { audioBase64, sampleRate } = await generateGeminiTtsDirect(
          supabaseServiceClient,
          item.text,
          voiceName
        );

        const pcmBytes = Uint8Array.from(atob(audioBase64), (c) => c.charCodeAt(0));
        const wavBytes = createWavFromPcm(pcmBytes, sampleRate);

        // Admin speaking audio goes to "presets/" folder for permanent storage
        const key = `presets/speaking/${jobId}/${index}/${item.key}.wav`;

        const uploadResult = await uploadToR2(key, wavBytes, "audio/wav");
        if (uploadResult.success && uploadResult.url) {
          return { key: item.key, url: uploadResult.url };
        }
        return null;
      } catch (err) {
        console.warn(`[Job ${jobId}] Failed TTS for ${item.key}:`, err);
        return null;
      }
    },
    concurrency
  );

  const audioUrls: Record<string, string> = {};
  results.forEach((r) => {
    if (r && r.key && r.url) {
      audioUrls[r.key] = r.url;
    }
  });

  console.log(`[Job ${jobId}] Generated ${Object.keys(audioUrls).length}/${ttsItems.length} speaking question audio files`);
  return Object.keys(audioUrls).length > 0 ? audioUrls : null;
}

// Declare EdgeRuntime for TypeScript
declare const EdgeRuntime: {
  waitUntil?: (promise: Promise<any>) => void;
} | undefined;
