import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { GoogleGenerativeAI } from "https://esm.sh/@google/generative-ai@0.21.0";
import { 
  getActiveGeminiKeysForModel, 
  markKeyQuotaExhausted,
  isQuotaExhaustedError
} from "../_shared/apiKeyQuotaUtils.ts";
import { uploadToR2 } from "../_shared/r2Client.ts";
import {
  decryptKey,
  uploadToGoogleFileAPI,
  parseJson,
  extractRetryAfterSeconds,
  sleep,
  calculateBandFromCriteria,
  computeWeightedPartBand,
  validateEvaluationResult,
  normalizeGeminiResponse,
  corsHeaders,
  QuotaError,
} from "../_shared/speakingUtils.ts";

/**
 * PARALLEL Speaking Evaluation Edge Function
 * 
 * Accepts base64 audio data directly and:
 * 1. Immediately starts text-based evaluation using Google File API
 * 2. Uploads audio to R2 in background (non-blocking)
 * 
 * This provides ~50% faster perceived response time by not waiting for R2 upload.
 */

const GEMINI_MODELS = ['gemini-2.5-flash'];

declare const EdgeRuntime: {
  waitUntil: (promise: Promise<unknown>) => void;
};

function isPermanentQuotaExhausted(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message || err || '').toLowerCase();
  if (msg.includes('check your plan') || msg.includes('billing')) return true;
  if (msg.includes('limit: 0')) return true;
  if (msg.includes('per day') && !msg.includes('retry')) return true;
  return false;
}

function buildPrompt(
  payload: unknown,
  topic: string | undefined,
  difficulty: string | undefined,
  fluencyFlag: boolean | undefined,
  orderedSegments: Array<{ segmentKey: string; partNumber: 1 | 2 | 3; questionNumber: number; questionText: string }>,
): string {
  const payloadObj = payload as { speakingParts?: Array<{ part_number: number; questions?: Array<{ id: string; question_number: number; question_text: string }> }> };
  const parts = Array.isArray(payloadObj?.speakingParts) ? payloadObj.speakingParts : [];
  const questions = parts
    .flatMap((p) =>
      (Array.isArray(p?.questions)
        ? p.questions.map((q) => ({
            id: String(q?.id || ''),
            part_number: Number(p?.part_number),
            question_number: Number(q?.question_number),
            question_text: String(q?.question_text || ''),
          }))
        : []),
    )
    .filter((q) => q.part_number === 1 || q.part_number === 2 || q.part_number === 3);

  const questionJson = JSON.stringify(questions);
  const segmentJson = JSON.stringify(orderedSegments);
  
  const includedParts = [...new Set(orderedSegments.map(s => s.partNumber))].sort();
  const partsDescription = includedParts.length === 1 
    ? `Part ${includedParts[0]} only` 
    : `Parts ${includedParts.join(', ')}`;

  const numQ = orderedSegments.length;
  
  const audioMappingLines = orderedSegments.map((seg, idx) => 
    `AUDIO_${idx}: "${seg.segmentKey}" → Part ${seg.partNumber}, Q${seg.questionNumber}: "${seg.questionText}"`
  ).join('\n');

  return `You are a CERTIFIED SENIOR IELTS Speaking Examiner with 20+ years experience.
Evaluate exactly as an official IELTS examiner. Return ONLY valid JSON.

CONTEXT: Topic: ${topic || 'General'}, Difficulty: ${difficulty || 'Medium'}, Parts: ${partsDescription}, Questions: ${numQ}
${fluencyFlag ? '⚠️ Part 2 speaking time under 80 seconds - apply fluency penalty.' : ''}

══════════════════════════════════════════════════════════════
🚨 CRITICAL TRANSCRIPTION RULES 🚨
══════════════════════════════════════════════════════════════

**ZERO HALLUCINATION POLICY**: Transcribe ONLY what the candidate ACTUALLY SAID.

🚫 FORBIDDEN:
- DO NOT invent, fabricate, or guess content
- DO NOT create plausible answers based on context
- DO NOT paraphrase or improve what was said

✅ REQUIRED:
- Transcribe EXACT words spoken, word-for-word
- Include ALL filler words: "uh", "um", "like", "you know"
- Include false starts, repetitions, self-corrections
- Write "[INAUDIBLE]" for unclear portions
- Write "[NO SPEECH]" for silence

══════════════════════════════════════════════════════════════
AUDIO-TO-QUESTION MAPPING
══════════════════════════════════════════════════════════════
${numQ} audio files in EXACT order:

${audioMappingLines}

══════════════════════════════════════════════════════════════
SCORING & OUTPUT LIMITS
══════════════════════════════════════════════════════════════

Score harshly for poor responses:
🔴 Band 1-2: Just says question number, no answer, <5 words
🟠 Band 2.5-3.5: 5-10 words, minimal relevance
🟡 Band 4-4.5: 10-20 words, basic grammar only

IMPORTANT OUTPUT LIMITS:
- strengths: maximum 2 items per criterion
- weaknesses: maximum 2 items per criterion (MUST include example quote from transcript in format: "Issue description. Example: 'exact quote from transcript'")
- suggestions: maximum 2 items per criterion
- whyItWorks: maximum 2 reasons
- keyImprovements: maximum 2 items
- lexical_upgrades: maximum 5 total
- improvement_priorities: REQUIRED 2-3 specific priorities based on lowest scoring criteria

MODEL ANSWER WORD COUNTS (STRICT - MUST FOLLOW):
- Part 1: 40-50 words EXACTLY (natural, conversational - do NOT exceed)
- Part 2: 170-190 words EXACTLY (covers all cue card points with examples - this is the long turn)
- Part 3: 70-90 words EXACTLY (analytical with one supporting example)

══════════════════════════════════════════════════════════════
WEAKNESS FORMAT (IMPORTANT)
══════════════════════════════════════════════════════════════
Each weakness MUST include an example quote from the transcript to help the user understand exactly where they made the mistake.

Format: "Issue description. Example: 'exact quote from transcript demonstrating the issue'"

Examples:
✓ "Frequent hesitations interrupt flow. Example: 'I think... um... it's like... you know... important'"
✓ "Limited vocabulary range for describing emotions. Example: 'I felt happy' instead of more nuanced expressions"
✓ "Subject-verb agreement errors. Example: 'The people was going' should be 'The people were going'"

══════════════════════════════════════════════════════════════
IMPROVEMENT PRIORITIES (REQUIRED)
══════════════════════════════════════════════════════════════
Generate 2-3 improvement priorities based on the LOWEST scoring criteria. Focus on:
1. The most impactful areas for score improvement
2. Specific, actionable recommendations
3. Link to the weakest criterion/criteria

══════════════════════════════════════════════════════════════
JSON OUTPUT SCHEMA
══════════════════════════════════════════════════════════════
{
  "overall_band": 6.0,
  "part_scores": {"part1": 6.0, "part2": 5.5, "part3": 6.5},
  "criteria": {
    "fluency_coherence": {"band": 6.0, "feedback": "...", "strengths": ["str1","str2"], "weaknesses": ["Issue + Example: 'quote'"], "suggestions": ["tip1"]},
    "lexical_resource": {"band": 6.0, "feedback": "...", "strengths": [...], "weaknesses": ["Issue + Example: 'quote'"], "suggestions": [...]},
    "grammatical_range": {"band": 5.5, "feedback": "...", "strengths": [...], "weaknesses": ["Issue + Example: 'quote'"], "suggestions": [...]},
    "pronunciation": {"band": 6.0, "feedback": "...", "strengths": [...], "weaknesses": ["Issue + Example: 'quote'"], "suggestions": [...]}
  },
  "summary": "2-3 sentence performance summary",
  "lexical_upgrades": [{"original": "good", "upgraded": "beneficial", "context": "usage"}],
  "part_analysis": [{"part_number": 1, "performance_notes": "...", "key_moments": [], "areas_for_improvement": []}],
  "improvement_priorities": ["Focus on [lowest criterion]: specific actionable advice", "Work on [second lowest]: concrete recommendation"],
  "strengths_to_maintain": ["Strength 1"],
  "transcripts_by_part": {"1": "...", "2": "...", "3": "..."},
  "transcripts_by_question": {
    "1": [{"segment_key": "...", "question_number": 1, "question_text": "...", "transcript": "EXACT words"}],
    "2": [...], "3": [...]
  },
  "modelAnswers": [
    {
      "segment_key": "match from audio mapping",
      "partNumber": 1,
      "questionNumber": 1,
      "question": "...",
      "candidateResponse": "EXACT transcript - NO FABRICATION",
      "estimatedBand": 5.5,
      "targetBand": 6.5,
      "modelAnswer": "Concise 50/150/80 word model response",
      "whyItWorks": ["reason1","reason2"],
      "keyImprovements": ["improvement1"]
    }
  ]
}

INPUT DATA:
questions_json: ${questionJson}
segment_map_json (${numQ} segments): ${segmentJson}

FINAL: Return exactly ${numQ} modelAnswers. candidateResponse MUST be EXACT words from audio.`;
}

function computeOverallBandFromQuestionBands(result: unknown): number | null {
  const resultObj = result as { modelAnswers?: Array<{ partNumber?: number; estimatedBand?: number }> };
  const modelAnswers = Array.isArray(resultObj?.modelAnswers) ? resultObj.modelAnswers : [];
  const bands = modelAnswers
    .map((a) => ({
      part: Number(a?.partNumber),
      band: typeof a?.estimatedBand === 'number' ? a.estimatedBand : Number(a?.estimatedBand),
    }))
    .filter((x) => (x.part === 1 || x.part === 2 || x.part === 3) && Number.isFinite(x.band));

  if (!bands.length) return null;

  const weightForPart = (p: number) => (p === 2 ? 2.0 : p === 3 ? 1.5 : 1.0);
  const weighted = bands.reduce(
    (acc, x) => {
      const w = weightForPart(x.part);
      return { sum: acc.sum + x.band * w, w: acc.w + w };
    },
    { sum: 0, w: 0 },
  );

  if (weighted.w <= 0) return null;

  const avg = weighted.sum / weighted.w;
  const rounded = Math.round(avg * 2) / 2;
  return Math.min(9, Math.max(1, rounded));
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

interface AudioDataInput {
  [key: string]: string; // segmentKey -> base64 data URL
}

serve(async (req) => {
  console.log(`[evaluate-speaking-parallel] Request at ${new Date().toISOString()}`);
  
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

    const { testId, audioData, durations, topic, difficulty, fluencyFlag } = await req.json() as {
      testId: string;
      audioData: AudioDataInput;
      durations?: Record<string, number>;
      topic?: string;
      difficulty?: string;
      fluencyFlag?: boolean;
    };

    if (!testId || !audioData || Object.keys(audioData).length === 0) {
      return new Response(JSON.stringify({ error: 'Missing testId or audioData', code: 'BAD_REQUEST' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const audioKeys = Object.keys(audioData);
    console.log(`[evaluate-speaking-parallel] ${audioKeys.length} audio segments for test ${testId}`);

    // =========================================================================
    // PARALLEL PROCESSING: Start R2 upload in background immediately
    // =========================================================================
    const r2FilePaths: Record<string, string> = {};
    const r2PublicUrls: Record<string, string> = {};
    
    const backgroundUploadTask = async () => {
      console.log(`[evaluate-speaking-parallel] Starting background R2 upload for ${audioKeys.length} files`);
      
      for (const segmentKey of audioKeys) {
        try {
          const { mimeType, base64 } = parseDataUrl(audioData[segmentKey]);
          if (!base64 || base64.length < 100) {
            console.log(`[evaluate-speaking-parallel] Skipping ${segmentKey} - too small`);
            continue;
          }

          const audioBytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
          const ext = mimeType === 'audio/mpeg' ? 'mp3' : 'webm';
          const r2Key = `speaking-audios/parallel/${user.id}/${testId}/${segmentKey}.${ext}`;

          const result = await uploadToR2(r2Key, audioBytes, mimeType);
          if (result.success && result.url) {
            r2FilePaths[segmentKey] = r2Key;
            r2PublicUrls[segmentKey] = result.url;
            console.log(`[evaluate-speaking-parallel] Background uploaded: ${segmentKey}`);
          } else {
            console.warn(`[evaluate-speaking-parallel] Background upload failed for ${segmentKey}:`, result.error);
          }
        } catch (err) {
          console.error(`[evaluate-speaking-parallel] Background upload error for ${segmentKey}:`, err);
        }
      }

      console.log(`[evaluate-speaking-parallel] Background upload complete: ${Object.keys(r2FilePaths).length} files`);
      
      // Update the result record with audio URLs after upload completes
      // This is done as part of the background task
      return { filePaths: r2FilePaths, publicUrls: r2PublicUrls };
    };

    // Start background upload - don't wait for it
    const backgroundUploadPromise = backgroundUploadTask();
    
    // Use EdgeRuntime.waitUntil if available (Supabase Edge Functions)
    if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime.waitUntil) {
      EdgeRuntime.waitUntil(backgroundUploadPromise);
    }

    // =========================================================================
    // IMMEDIATE EVALUATION: Convert base64 to bytes and start evaluation
    // =========================================================================

    // Fetch test payload
    const { data: testRow, error: testError } = await supabaseService
      .from('ai_practice_tests')
      .select('payload, topic, difficulty, preset_id')
      .eq('id', testId)
      .eq('user_id', user.id)
      .maybeSingle();

    if (testError || !testRow) {
      return new Response(JSON.stringify({ error: 'Test not found', code: 'TEST_NOT_FOUND' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    type PayloadType = { speakingParts?: Array<{ part_number: number; questions?: Array<{ id: string; question_number: number; question_text: string }> }> };
    let payload = testRow.payload as PayloadType || {};

    if (testRow.preset_id && (!payload.speakingParts)) {
      const { data: presetData } = await supabaseService
        .from('generated_test_audio')
        .select('content_payload')
        .eq('id', testRow.preset_id)
        .maybeSingle();
      
      if (presetData?.content_payload) {
        payload = presetData.content_payload as PayloadType;
      }
    }

    // Build segment metadata
    // IMPORTANT: We must build orderedSegments for *all* audioKeys.
    // The test payload format can vary (speakingParts vs older part1/part2/part3),
    // so we cannot drop segments just because we fail to find question metadata.
    const parts = Array.isArray(payload?.speakingParts) ? payload.speakingParts : [];
    const questionById = new Map<string, { partNumber: 1 | 2 | 3; questionNumber: number; questionText: string }>();
    for (const p of parts) {
      const partNumber = Number(p?.part_number) as 1 | 2 | 3;
      if (partNumber !== 1 && partNumber !== 2 && partNumber !== 3) continue;
      for (const q of (p?.questions || [])) {
        const id = String(q?.id || '');
        if (!id) continue;
        questionById.set(id, {
          partNumber,
          questionNumber: Number(q?.question_number),
          questionText: String(q?.question_text || ''),
        });
      }
    }

    const segmentList: Array<{ segmentKey: string; partNumber: 1 | 2 | 3; questionNumber: number; questionText: string; originalIndex: number }> = [];

    for (let i = 0; i < audioKeys.length; i++) {
      const segmentKey = audioKeys[i];

      // Segment keys are formatted as: part{1|2|3}-q{questionId}
      const m = String(segmentKey).match(/^part([123])\-q(.+)$/);
      const partNumber = (m ? Number(m[1]) : 1) as 1 | 2 | 3;
      const questionId = m?.[2] ? String(m[2]) : '';
      const q = questionId ? questionById.get(questionId) : undefined;

      segmentList.push({
        segmentKey,
        partNumber,
        questionNumber: q?.questionNumber ?? i + 1,
        questionText: q?.questionText ?? `Question for ${segmentKey}`,
        originalIndex: i,
      });
    }

    const orderedSegments = segmentList.sort((a, b) => {
      if (a.partNumber !== b.partNumber) return a.partNumber - b.partNumber;
      if (a.questionNumber !== b.questionNumber) return a.questionNumber - b.questionNumber;
      return a.originalIndex - b.originalIndex;
    });

    // Build API key queue
    interface KeyCandidate { key: string; keyId: string | null; isUserProvided: boolean; }
    const keyQueue: KeyCandidate[] = [];

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
          console.warn('[evaluate-speaking-parallel] Failed to decrypt user key:', e);
        }
      }
    }

    const dbApiKeys = await getActiveGeminiKeysForModel(supabaseService, 'flash_2_5');
    for (const dbKey of dbApiKeys) {
      keyQueue.push({ key: dbKey.key_value, keyId: dbKey.id, isUserProvided: false });
    }

    if (keyQueue.length === 0) {
      return new Response(JSON.stringify({ error: 'No API key available', code: 'API_KEY_NOT_FOUND' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`[evaluate-speaking-parallel] ${keyQueue.length} keys available`);

    // Convert base64 audio to bytes for Google File API
    const audioFiles: { key: string; bytes: Uint8Array; mimeType: string }[] = [];
    
    for (const segmentKey of audioKeys) {
      const { mimeType, base64 } = parseDataUrl(audioData[segmentKey]);
      if (!base64 || base64.length < 100) {
        console.log(`[evaluate-speaking-parallel] Skipping ${segmentKey} - too small`);
        continue;
      }
      const audioBytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      audioFiles.push({ key: segmentKey, bytes: audioBytes, mimeType });
    }

    console.log(`[evaluate-speaking-parallel] Prepared ${audioFiles.length} audio files for evaluation`);

    const prompt = buildPrompt(payload, topic || testRow.topic, difficulty || testRow.difficulty, fluencyFlag, orderedSegments);

    // Evaluation loop
    type EvaluationResult = {
      overall_band?: number;
      overallBand?: number;
      part_scores?: { part1?: number; part2?: number; part3?: number };
      criteria?: Record<string, unknown>;
      modelAnswers?: Array<unknown>;
      transcripts_by_part?: Record<string, string>;
      transcripts_by_question?: Record<string, Array<unknown>>;
      [key: string]: unknown;
    };
    
    let evaluationResult: EvaluationResult | null = null;
    let usedModel: string | null = null;
    let usedKey: KeyCandidate | null = null;
    let bestRetryAfterSeconds: number | null = null;
    let sawTemporaryRateLimit = false;

    for (const candidateKey of keyQueue) {
      if (evaluationResult) break;

      try {
        const genAI = new GoogleGenerativeAI(candidateKey.key);

        // Upload to Google File API
        const fileUris: Array<{ fileData: { mimeType: string; fileUri: string } }> = [];
        
        for (const audioFile of audioFiles) {
          const uploadResult = await uploadToGoogleFileAPI(candidateKey.key, audioFile.bytes, `${audioFile.key}.webm`, audioFile.mimeType);
          fileUris.push({ fileData: { mimeType: uploadResult.mimeType, fileUri: uploadResult.uri } });
        }

        for (const modelName of GEMINI_MODELS) {
          if (evaluationResult) break;

          const model = genAI.getGenerativeModel({ 
            model: modelName,
            generationConfig: { temperature: 0.3, maxOutputTokens: 100000 },
          });

          // Build content parts with proper typing for Gemini API
          const contentParts = [
            ...fileUris,
            { text: prompt }
          ];
          let lastQuotaError: QuotaError | null = null;

          // Try up to 3 times if response is incomplete (missing modelAnswers/transcripts)
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              console.log(`[evaluate-speaking-parallel] Attempt ${attempt + 1} with model ${modelName}`);
              // Use any type for the request to avoid strict typing issues with the Gemini SDK
              const result = await model.generateContent({ contents: [{ role: 'user', parts: contentParts }] } as any);
              const responseText = result.response?.text();
              
              if (responseText) {
                console.log(`[evaluate-speaking-parallel] Response length: ${responseText.length} chars`);
                const parsed = parseJson(responseText);
                if (parsed) {
                  const normalized = normalizeGeminiResponse(parsed) as EvaluationResult;
                  const validation = validateEvaluationResult(normalized, audioFiles.length);
                  
                  if (validation.valid) {
                    evaluationResult = normalized;
                    usedModel = modelName;
                    usedKey = candidateKey;
                    console.log(`[evaluate-speaking-parallel] Valid result on attempt ${attempt + 1}`);
                    break;
                  } else {
                    console.warn(`[evaluate-speaking-parallel] Validation issues (attempt ${attempt + 1}): ${validation.issues.join(', ')}`);
                    const overallBand = normalized.overall_band ?? normalized.overallBand;
                    const hasSomeCriteria = normalized.criteria && Object.keys(normalized.criteria).length > 0;
                    const modelAnswersCount = Array.isArray(normalized.modelAnswers) ? normalized.modelAnswers.length : 0;
                    
                    // Accept if we have band, criteria, AND at least some modelAnswers
                    if (typeof overallBand === 'number' && overallBand > 0 && hasSomeCriteria && modelAnswersCount > 0) {
                      evaluationResult = normalized;
                      usedModel = modelName;
                      usedKey = candidateKey;
                      console.log(`[evaluate-speaking-parallel] Accepted partial result with ${modelAnswersCount} modelAnswers`);
                      break;
                    }
                    
                    // If missing modelAnswers entirely, retry on next attempt
                    if (modelAnswersCount === 0 && attempt < 2) {
                      console.log(`[evaluate-speaking-parallel] No modelAnswers, retrying...`);
                      await sleep(1000);
                      continue;
                    }
                    
                    // Last resort: accept any result with band and criteria
                    if (typeof overallBand === 'number' && overallBand > 0 && hasSomeCriteria) {
                      evaluationResult = normalized;
                      usedModel = modelName;
                      usedKey = candidateKey;
                      console.warn(`[evaluate-speaking-parallel] Accepted result without modelAnswers on final attempt`);
                      break;
                    }
                  }
                }
              }
              break;
            } catch (modelError: unknown) {
              const err = modelError as { message?: string; status?: number };
              const msg = String(err?.message || modelError);
              const isQuotaLike = isQuotaExhaustedError(modelError) || err?.status === 429 || err?.status === 403;

              if (!isQuotaLike) break;

              const retryAfter = extractRetryAfterSeconds(modelError);
              const permanent = isPermanentQuotaExhausted(modelError) || retryAfter === undefined;

              if (!permanent && retryAfter && retryAfter > 0 && attempt === 0) {
                sawTemporaryRateLimit = true;
                bestRetryAfterSeconds = bestRetryAfterSeconds === null ? retryAfter : Math.min(bestRetryAfterSeconds, retryAfter);
                await sleep((retryAfter + 1) * 1000);
                continue;
              }

              lastQuotaError = new QuotaError(msg, { permanent, retryAfterSeconds: retryAfter });
              break;
            }
          }

          if (evaluationResult) break;
          if (lastQuotaError) {
            if (GEMINI_MODELS[GEMINI_MODELS.length - 1] === modelName) throw lastQuotaError;
          }
        }

      } catch (error: unknown) {
        if (error instanceof QuotaError) {
          if (error.permanent && !candidateKey.isUserProvided && candidateKey.keyId) {
            await markKeyQuotaExhausted(supabaseService, candidateKey.keyId, 'flash_2_5');
          }
          if (!error.permanent) {
            sawTemporaryRateLimit = true;
            if (typeof error.retryAfterSeconds === 'number') {
              bestRetryAfterSeconds = bestRetryAfterSeconds === null ? error.retryAfterSeconds : Math.min(bestRetryAfterSeconds, error.retryAfterSeconds);
            }
          }
          continue;
        }
        console.error('[evaluate-speaking-parallel] Error:', (error as Error)?.message);
        continue;
      }
    }

    if (!evaluationResult || !usedModel || !usedKey) {
      if (sawTemporaryRateLimit) {
        const retryAfter = bestRetryAfterSeconds ?? 60;
        return new Response(JSON.stringify({ error: `Rate limited. Retry in ~${retryAfter}s.`, code: 'RATE_LIMITED', retryAfterSeconds: retryAfter }), {
          status: 429,
          headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Retry-After': String(retryAfter) },
        });
      }
      return new Response(JSON.stringify({ error: 'All API keys exhausted', code: 'ALL_KEYS_EXHAUSTED' }), {
        status: 503,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Calculate band score using weighted part scores if available
    const partScores = evaluationResult.part_scores || {};
    const weightedBand = computeWeightedPartBand(partScores);
    const derivedFromQuestions = computeOverallBandFromQuestionBands(evaluationResult);
    const derivedFromCriteria = calculateBandFromCriteria(evaluationResult.criteria);
    
    const overallBand = weightedBand ?? 
      (typeof evaluationResult?.overall_band === 'number' ? evaluationResult.overall_band : null) ??
      derivedFromQuestions ?? 
      derivedFromCriteria;

    evaluationResult.overall_band = overallBand;

    // Wait for background upload to complete before saving results
    // This ensures we have the audio URLs for the result record
    let audioUrls: Record<string, string> = {};
    let filePaths: Record<string, string> = {};
    
    try {
      const uploadResult = await backgroundUploadPromise;
      audioUrls = uploadResult.publicUrls;
      filePaths = uploadResult.filePaths;
      console.log(`[evaluate-speaking-parallel] Background upload completed with ${Object.keys(audioUrls).length} URLs`);
    } catch (uploadErr) {
      console.warn('[evaluate-speaking-parallel] Background upload failed, proceeding without audio URLs:', uploadErr);
    }

    // Save result
    const { data: resultRow, error: saveError } = await supabaseService
      .from('ai_practice_results')
      .insert({
        test_id: testId,
        user_id: user.id,
        module: 'speaking',
        score: Math.round(overallBand * 10),
        band_score: overallBand,
        total_questions: audioFiles.length,
        time_spent_seconds: durations ? Math.round(Object.values(durations).reduce((a, b) => a + b, 0)) : 60,
        question_results: evaluationResult,
        answers: {
          audio_urls: audioUrls,
          transcripts_by_part: evaluationResult?.transcripts_by_part || {},
          transcripts_by_question: evaluationResult?.transcripts_by_question || {},
          file_paths: filePaths,
        },
        completed_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (saveError) console.error('[evaluate-speaking-parallel] Save error:', saveError);

    console.log(`[evaluate-speaking-parallel] Complete, band: ${overallBand}, result_id: ${resultRow?.id}`);

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

  } catch (error: unknown) {
    console.error('[evaluate-speaking-parallel] Error:', (error as Error)?.message);
    return new Response(JSON.stringify({ error: (error as Error)?.message || 'Unexpected error', code: 'UNKNOWN_ERROR' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
