import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { GoogleGenerativeAI } from "https://esm.sh/@google/generative-ai@0.21.0";
import { 
  getActiveGeminiKeysForModel, 
  markKeyQuotaExhausted,
  isQuotaExhaustedError
} from "../_shared/apiKeyQuotaUtils.ts";
import { getFromR2 } from "../_shared/r2Client.ts";
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
 * OPTIMIZED Speaking Evaluation Edge Function for Cambridge Tests
 * 
 * Uses Google File API for audio uploads to avoid base64 token bloat.
 * Applies prompt optimizations for ~35% token reduction.
 */

const GEMINI_MODELS = ['gemini-2.5-flash'];

function isPermanentQuotaExhausted(err: any): boolean {
  const msg = String(err?.message || err || '').toLowerCase();
  if (msg.includes('check your plan') || msg.includes('billing')) return true;
  if (msg.includes('limit: 0')) return true;
  if (msg.includes('per day') && !msg.includes('retry')) return true;
  return false;
}

// OPTIMIZED prompt with reduced word counts for model answers
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
  
  const audioMappingLines = orderedSegments.map((seg, idx) => 
    `AUDIO_${idx}: "${seg.segmentKey}" → Part ${seg.partNumber}, Q${seg.questionNumber}: "${seg.questionText}"`
  ).join('\n');

  // OPTIMIZED: Reduced model answer word counts
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
SCORING & OUTPUT LIMITS (STRICT - LIKE A REAL IELTS EXAMINER)
══════════════════════════════════════════════════════════════

🚨 MANDATORY SCORING RULES - DO NOT INFLATE SCORES 🚨

A real IELTS examiner would NEVER give high scores for minimal responses.
Apply these MANDATORY penalties:

RESPONSE LENGTH PENALTIES (STRICTLY ENFORCED):
🔴 Band 1.0-2.0: NO RESPONSE / Silence / Just says "pass" or "skip"
🔴 Band 2.0-2.5: 1-5 words (e.g., "I don't know", "Maybe yes")
🟠 Band 3.0-3.5: 6-15 words (one short sentence, minimal content)
🟡 Band 4.0-4.5: 16-30 words (2-3 basic sentences, underdeveloped)
🟢 Band 5.0+: Requires 30+ words with coherent content

For Part 2 SPECIFICALLY (Long Turn - should be 1.5-2 minutes):
- Under 60 words: Band 3.0-4.0 MAXIMUM (severely insufficient)
- 60-100 words: Band 4.5-5.0 MAXIMUM (insufficient length)
- 100-150 words: Band 5.0-6.0 (minimum acceptable)
- 150-200 words: Band 6.0-7.0 (adequate development)
- 200+ words: Can score 7.0+ if quality is good

REAL EXAMINER MINDSET:
- Would YOU give someone 6.5 for saying only "I think yes" or "would be very crucial"?
- A 6.5 means "good command of English" - 3-5 word responses show LIMITED command
- Short responses = LIMITED vocabulary, LIMITED grammar, POOR fluency
- If audio shows hesitation/minimal content, score MUST reflect this

IMPORTANT OUTPUT LIMITS:
- strengths: maximum 2 items per criterion
- weaknesses: maximum 2 items per criterion (MUST include example quote from transcript)
- suggestions: maximum 2 items per criterion
- whyItWorks: maximum 2 reasons
- keyImprovements: maximum 2 items
- lexical_upgrades: maximum 5 total

MODEL ANSWER WORD COUNTS (STRICT - MUST FOLLOW):
- Part 1: 35-45 words (natural, conversational with supporting details)
- Part 2: 130-150 words (MANDATORY - covers all cue card points with examples - this is the LONG TURN)
- Part 3: 50-60 words (analytical response with reasoning and example)

For Part 2 model answers, you MUST:
1. Write 130-150 words (COUNT THEM!)
2. Address ALL bullet points from the cue card
3. Include personal examples and details
4. Use varied vocabulary and sentence structures

ALWAYS PROVIDE MODEL ANSWERS:
- Even if the candidate's response is empty or says "[NO SPEECH]" or "[INAUDIBLE]"
- Model answers help the candidate learn what they SHOULD have said
- Never skip a model answer - provide it regardless of candidate performance

LENGTH ASSESSMENT RULES:
- NEVER criticize responses for being too long. Longer responses demonstrate willingness to speak at length.
- ONLY flag responses as insufficient if they are TOO SHORT for the expected task
- Verbose responses are a STRENGTH, not a weakness.

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
  "summary": "2-3 sentence performance summary reflecting ACTUAL performance",
  "lexical_upgrades": [{"original": "good", "upgraded": "beneficial", "context": "usage"}],
  "part_analysis": [{"part_number": 1, "performance_notes": "...", "key_moments": [], "areas_for_improvement": []}],
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
      "modelAnswer": "FULL model answer: Part1=40w, Part2=140w (COUNT!), Part3=55w - ALWAYS PROVIDE",
      "whyItWorks": ["reason1","reason2"],
      "keyImprovements": ["improvement1"]
    }
  ]
}

INPUT DATA:
questions_json: ${questionJson}
segment_map_json (${numQ} segments): ${segmentJson}

FINAL RULES:
1. Return exactly ${numQ} modelAnswers with candidateResponse = EXACT words from audio
2. Model answer lengths: Part1=35-45w, Part2=130-150w (COUNT!), Part3=50-60w
3. ALWAYS provide model answers even if transcript is "[NO SPEECH]" or "[INAUDIBLE]"
4. DO NOT inflate scores - a 3-word response CANNOT score above 3.0`;
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
  return Math.min(9, Math.max(1, rounded));
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
      return new Response(JSON.stringify({ error: 'Missing testId or filePaths', code: 'BAD_REQUEST' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`[evaluate-speaking-submission] ${Object.keys(filePaths).length} files for test ${testId}`);

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

    let payload = testRow.payload as any || {};

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

    // Build segment metadata
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

    const segmentMetaByKey = new Map<string, { segmentKey: string; partNumber: 1 | 2 | 3; questionNumber: number; questionText: string }>();

    for (const segmentKey of Object.keys(filePaths as Record<string, string>)) {
      const m = String(segmentKey).match(/^part([123])\-q(.+)$/);
      if (!m) continue;
      const partNumber = Number(m[1]) as 1 | 2 | 3;
      const questionId = m[2];
      const q = questionById.get(questionId);
      if (!q) continue;
      segmentMetaByKey.set(segmentKey, { segmentKey, partNumber, questionNumber: q.questionNumber, questionText: q.questionText });
    }

    const orderedSegments = Array.from(segmentMetaByKey.values()).sort((a, b) => {
      if (a.partNumber !== b.partNumber) return a.partNumber - b.partNumber;
      return a.questionNumber - b.questionNumber;
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
          console.warn('[evaluate-speaking-submission] Failed to decrypt user key:', e);
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

    console.log(`[evaluate-speaking-submission] ${keyQueue.length} keys available`);

    // Download files from R2
    const audioFiles: { key: string; bytes: Uint8Array; mimeType: string }[] = [];
    
    for (const [audioKey, r2Path] of Object.entries(filePaths as Record<string, string>)) {
      const result = await getFromR2(r2Path);
      if (!result.success || !result.bytes) {
        throw new Error(`Failed to download from R2: ${result.error}`);
      }
      const ext = r2Path.split('.').pop()?.toLowerCase() || 'webm';
      const mimeType = ext === 'mp3' ? 'audio/mpeg' : 'audio/webm';
      audioFiles.push({ key: audioKey, bytes: result.bytes, mimeType });
    }

    console.log(`[evaluate-speaking-submission] Downloaded ${audioFiles.length} files`);

    const prompt = buildPrompt(payload, topic || testRow.topic, difficulty || testRow.difficulty, fluencyFlag, orderedSegments);

    // Evaluation loop
    let evaluationResult: any = null;
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
            generationConfig: { temperature: 0.3, maxOutputTokens: 65000 },
          });

          const contentParts: any[] = [...fileUris, { text: prompt }];
          let lastQuotaError: QuotaError | null = null;

          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              const result = await model.generateContent({ contents: [{ role: 'user', parts: contentParts }] });
              const responseText = result.response?.text();
              
              if (responseText) {
                const parsed = parseJson(responseText);
                if (parsed) {
                  const normalized = normalizeGeminiResponse(parsed);
                  const validation = validateEvaluationResult(normalized, audioFiles.length);
                  
                  if (validation.valid) {
                    evaluationResult = normalized;
                    usedModel = modelName;
                    usedKey = candidateKey;
                    break;
                  } else {
                    console.warn(`[evaluate-speaking-submission] Validation issues: ${validation.issues.join(', ')}`);
                    const overallBand = normalized.overall_band ?? normalized.overallBand;
                    const hasSomeCriteria = normalized.criteria && Object.keys(normalized.criteria).length > 0;
                    
                    if (typeof overallBand === 'number' && overallBand > 0 && hasSomeCriteria) {
                      evaluationResult = normalized;
                      usedModel = modelName;
                      usedKey = candidateKey;
                      break;
                    }
                  }
                }
              }
              break;
            } catch (modelError: any) {
              const msg = String(modelError?.message || modelError);
              const isQuotaLike = isQuotaExhaustedError(modelError) || modelError?.status === 429 || modelError?.status === 403;

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

      } catch (error: any) {
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
        console.error('[evaluate-speaking-submission] Error:', error?.message);
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

    // Build public audio URLs
    const publicBase = r2PublicUrl.replace(/\/$/, '');
    const audioUrls: Record<string, string> = {};
    if (publicBase) {
      for (const [k, r2Key] of Object.entries(filePaths as Record<string, string>)) {
        audioUrls[k] = `${publicBase}/${String(r2Key).replace(/^\//, '')}`;
      }
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
        time_spent_seconds: durations ? Math.round(Object.values(durations as Record<string, number>).reduce((a, b) => a + b, 0)) : 60,
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

    if (saveError) console.error('[evaluate-speaking-submission] Save error:', saveError);

    console.log(`[evaluate-speaking-submission] Complete, band: ${overallBand}, result_id: ${resultRow?.id}`);

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
    return new Response(JSON.stringify({ error: error.message || 'Unexpected error', code: 'UNKNOWN_ERROR' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
