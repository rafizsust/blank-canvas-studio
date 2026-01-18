import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { GoogleGenerativeAI } from "https://esm.sh/@google/generative-ai@0.21.0";
import { 
  getActiveGeminiKeysForModel, 
  markKeyQuotaExhausted,
  isQuotaExhaustedError
} from "../_shared/apiKeyQuotaUtils.ts";
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
 * Resubmit Speaking Test with Parallel Mode
 * 
 * This edge function:
 * 1. Fetches existing audio from R2 (already uploaded in previous submission)
 * 2. Calls evaluate-speaking-parallel logic directly (single call, no R2 upload needed)
 * 3. Returns timing information for performance comparison
 */

const GEMINI_MODELS = ['gemini-2.5-flash'];

function isPermanentQuotaExhausted(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message || err || '').toLowerCase();
  if (msg.includes('check your plan') || msg.includes('billing')) return true;
  if (msg.includes('limit: 0')) return true;
  if (msg.includes('per day') && !msg.includes('retry')) return true;
  return false;
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
SCORING & OUTPUT
══════════════════════════════════════════════════════════════

Score harshly for poor responses:
🔴 Band 1-2: Just says question number, no answer, <5 words
🟠 Band 2.5-3.5: 5-10 words, minimal relevance
🟡 Band 4-4.5: 10-20 words, basic grammar only

MODEL ANSWER WORD COUNTS:
- Part 1: 40-50 words
- Part 2: 170-190 words
- Part 3: 70-90 words

JSON OUTPUT SCHEMA:
{
  "overall_band": 6.0,
  "part_scores": {"part1": 6.0, "part2": 5.5, "part3": 6.5},
  "criteria": {
    "fluency_coherence": {"band": 6.0, "feedback": "...", "strengths": [], "weaknesses": [], "suggestions": []},
    "lexical_resource": {"band": 6.0, "feedback": "...", "strengths": [], "weaknesses": [], "suggestions": []},
    "grammatical_range": {"band": 5.5, "feedback": "...", "strengths": [], "weaknesses": [], "suggestions": []},
    "pronunciation": {"band": 6.0, "feedback": "...", "strengths": [], "weaknesses": [], "suggestions": []}
  },
  "summary": "2-3 sentence performance summary",
  "transcripts_by_part": {"1": "...", "2": "...", "3": "..."},
  "modelAnswers": [
    {
      "segment_key": "...",
      "partNumber": 1,
      "questionNumber": 1,
      "question": "...",
      "candidateResponse": "EXACT transcript",
      "estimatedBand": 5.5,
      "modelAnswer": "Model response"
    }
  ]
}

INPUT DATA:
questions_json: ${questionJson}
segment_map_json: ${segmentJson}

Return exactly ${numQ} modelAnswers.`;
}

serve(async (req) => {
  const startTime = Date.now();
  console.log(`[resubmit-parallel] ====== REQUEST START at ${new Date().toISOString()} ======`);
  
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const timing: Record<string, number> = {};

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

    const authStart = Date.now();
    const { data: { user } } = await supabaseClient.auth.getUser();
    timing.auth = Date.now() - authStart;

    if (!user) {
      return new Response(JSON.stringify({ error: 'Unauthorized', code: 'UNAUTHORIZED' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { testId, jobId } = await req.json() as {
      testId: string;
      jobId?: string;
    };

    if (!testId) {
      return new Response(JSON.stringify({ error: 'Missing testId', code: 'BAD_REQUEST' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`[resubmit-parallel] testId=${testId}, jobId=${jobId || 'none'}`);

    // STEP 1: Find existing job with file_paths
    const fetchJobStart = Date.now();
    let filePaths: Record<string, string> = {};
    let topic: string | undefined;
    let difficulty: string | undefined;

    if (jobId) {
      const { data: job, error: jobError } = await supabaseService
        .from('speaking_evaluation_jobs')
        .select('file_paths, topic, difficulty')
        .eq('id', jobId)
        .eq('user_id', user.id)
        .single();

      if (jobError || !job) {
        console.error('[resubmit-parallel] Job not found:', jobError);
        return new Response(JSON.stringify({ error: 'Job not found', code: 'JOB_NOT_FOUND' }), {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      filePaths = (job.file_paths as Record<string, string>) || {};
      topic = job.topic || undefined;
      difficulty = job.difficulty || undefined;
    } else {
      // Find most recent completed job for this test
      const { data: jobs } = await supabaseService
        .from('speaking_evaluation_jobs')
        .select('file_paths, topic, difficulty')
        .eq('test_id', testId)
        .eq('user_id', user.id)
        .eq('status', 'completed')
        .order('created_at', { ascending: false })
        .limit(1);

      if (jobs && jobs.length > 0) {
        filePaths = (jobs[0].file_paths as Record<string, string>) || {};
        topic = jobs[0].topic || undefined;
        difficulty = jobs[0].difficulty || undefined;
      }
    }
    timing.fetchJob = Date.now() - fetchJobStart;

    if (!filePaths || Object.keys(filePaths).length === 0) {
      return new Response(JSON.stringify({ error: 'No stored audio found for this test', code: 'NO_AUDIO' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`[resubmit-parallel] Found ${Object.keys(filePaths).length} audio files`);

    // STEP 2: Fetch test payload
    const fetchTestStart = Date.now();
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
    timing.fetchTest = Date.now() - fetchTestStart;

    topic = topic || testRow.topic;
    difficulty = difficulty || testRow.difficulty;

    // STEP 3: Download audio files from R2
    const downloadStart = Date.now();
    const audioFiles: { key: string; bytes: Uint8Array; mimeType: string }[] = [];
    
    for (const [segmentKey, r2Path] of Object.entries(filePaths)) {
      try {
        const audioUrl = `${r2PublicUrl}/${r2Path}`;
        console.log(`[resubmit-parallel] Downloading: ${segmentKey} from ${audioUrl}`);
        
        const response = await fetch(audioUrl);
        if (!response.ok) {
          console.warn(`[resubmit-parallel] Failed to download ${segmentKey}: ${response.status}`);
          continue;
        }
        
        const arrayBuffer = await response.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);
        const mimeType = response.headers.get('content-type') || 'audio/mpeg';
        
        audioFiles.push({ key: segmentKey, bytes, mimeType });
        console.log(`[resubmit-parallel] Downloaded ${segmentKey}: ${bytes.length} bytes`);
      } catch (err) {
        console.error(`[resubmit-parallel] Download error for ${segmentKey}:`, err);
      }
    }
    timing.downloadAudio = Date.now() - downloadStart;

    if (audioFiles.length === 0) {
      return new Response(JSON.stringify({ error: 'Failed to download any audio files', code: 'DOWNLOAD_FAILED' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`[resubmit-parallel] Downloaded ${audioFiles.length} audio files in ${timing.downloadAudio}ms`);

    // STEP 4: Build segment metadata
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

    const audioKeys = audioFiles.map(f => f.key);
    const segmentMetaByKey = new Map<string, { segmentKey: string; partNumber: 1 | 2 | 3; questionNumber: number; questionText: string }>();

    for (const segmentKey of audioKeys) {
      // Match patterns: part1-q<id>, part1-qp1-q<n>-<id>, etc.
      const m = String(segmentKey).match(/^part([123])\-q(?:p[123]\-q\d+\-)?(.+)$/);
      if (!m) continue;
      const partNumber = Number(m[1]) as 1 | 2 | 3;
      const questionId = m[2];
      const q = questionById.get(questionId);
      if (!q) {
        // Try extracting question number from the key pattern like "part1-qp1-q1-xxx"
        const numMatch = segmentKey.match(/part(\d)\-qp\d\-q(\d+)/);
        if (numMatch) {
          segmentMetaByKey.set(segmentKey, { 
            segmentKey, 
            partNumber: Number(numMatch[1]) as 1 | 2 | 3, 
            questionNumber: Number(numMatch[2]), 
            questionText: `Question ${numMatch[2]}` 
          });
        }
        continue;
      }
      segmentMetaByKey.set(segmentKey, { segmentKey, partNumber, questionNumber: q.questionNumber, questionText: q.questionText });
    }

    const orderedSegments = Array.from(segmentMetaByKey.values()).sort((a, b) => {
      if (a.partNumber !== b.partNumber) return a.partNumber - b.partNumber;
      return a.questionNumber - b.questionNumber;
    });

    console.log(`[resubmit-parallel] Ordered segments: ${orderedSegments.length}`);

    // STEP 5: Build API key queue
    const keyQueueStart = Date.now();
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
          console.warn('[resubmit-parallel] Failed to decrypt user key:', e);
        }
      }
    }

    const dbApiKeys = await getActiveGeminiKeysForModel(supabaseService, 'flash_2_5');
    for (const dbKey of dbApiKeys) {
      keyQueue.push({ key: dbKey.key_value, keyId: dbKey.id, isUserProvided: false });
    }
    timing.keyQueue = Date.now() - keyQueueStart;

    if (keyQueue.length === 0) {
      return new Response(JSON.stringify({ error: 'No API key available', code: 'API_KEY_NOT_FOUND' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`[resubmit-parallel] ${keyQueue.length} API keys available`);

    // STEP 6: Upload to Google File API and evaluate
    const evaluateStart = Date.now();
    const prompt = buildPrompt(payload, topic, difficulty, false, orderedSegments);

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
        const uploadStart = Date.now();
        const fileUris: Array<{ fileData: { mimeType: string; fileUri: string } }> = [];
        
        for (const audioFile of audioFiles) {
          const uploadResult = await uploadToGoogleFileAPI(candidateKey.key, audioFile.bytes, `${audioFile.key}.mp3`, audioFile.mimeType);
          fileUris.push({ fileData: { mimeType: uploadResult.mimeType, fileUri: uploadResult.uri } });
        }
        timing.uploadToGoogleFileAPI = Date.now() - uploadStart;
        console.log(`[resubmit-parallel] Uploaded ${fileUris.length} files to Google File API in ${timing.uploadToGoogleFileAPI}ms`);

        for (const modelName of GEMINI_MODELS) {
          if (evaluationResult) break;

          const model = genAI.getGenerativeModel({ 
            model: modelName,
            generationConfig: { temperature: 0.3, maxOutputTokens: 65000 },
          });

          const contentParts = [
            ...fileUris,
            { text: prompt }
          ];
          let lastQuotaError: QuotaError | null = null;

          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              const geminiStart = Date.now();
              const result = await model.generateContent({ contents: [{ role: 'user', parts: contentParts }] } as any);
              timing.geminiEvaluation = Date.now() - geminiStart;
              
              const responseText = result.response?.text();
              
              if (responseText) {
                const parsed = parseJson(responseText);
                if (parsed) {
                  const normalized = normalizeGeminiResponse(parsed) as EvaluationResult;
                  const validation = validateEvaluationResult(normalized, audioFiles.length);
                  
                  if (validation.valid) {
                    evaluationResult = normalized;
                    usedModel = modelName;
                    usedKey = candidateKey;
                    break;
                  } else {
                    console.warn(`[resubmit-parallel] Validation issues: ${validation.issues.join(', ')}`);
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
                console.log(`[resubmit-parallel] Rate limited, waiting ${retryAfter}s...`);
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
        console.error('[resubmit-parallel] Error:', (error as Error)?.message);
        continue;
      }
    }
    timing.evaluate = Date.now() - evaluateStart;

    if (!evaluationResult || !usedModel || !usedKey) {
      if (sawTemporaryRateLimit) {
        const retryAfter = bestRetryAfterSeconds ?? 60;
        return new Response(JSON.stringify({ 
          error: `Rate limited. Retry in ~${retryAfter}s.`, 
          code: 'RATE_LIMITED', 
          retryAfterSeconds: retryAfter,
          timing,
          totalTimeMs: Date.now() - startTime,
        }), {
          status: 429,
          headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Retry-After': String(retryAfter) },
        });
      }
      return new Response(JSON.stringify({ 
        error: 'All API keys exhausted', 
        code: 'ALL_KEYS_EXHAUSTED',
        timing,
        totalTimeMs: Date.now() - startTime,
      }), {
        status: 503,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`[resubmit-parallel] Evaluation complete with model ${usedModel}`);

    // Calculate band score
    const partScores = evaluationResult.part_scores || {};
    const weightedBand = computeWeightedPartBand(partScores);
    const derivedFromQuestions = computeOverallBandFromQuestionBands(evaluationResult);
    const derivedFromCriteria = calculateBandFromCriteria(evaluationResult.criteria);
    
    const overallBand = weightedBand ?? 
      (typeof evaluationResult?.overall_band === 'number' ? evaluationResult.overall_band : null) ??
      derivedFromQuestions ?? 
      derivedFromCriteria;

    evaluationResult.overall_band = overallBand;

    // Save result
    const saveStart = Date.now();
    const { data: resultRow, error: saveError } = await supabaseService
      .from('ai_practice_results')
      .insert({
        test_id: testId,
        user_id: user.id,
        module: 'speaking',
        score: Math.round((overallBand || 0) * 10),
        band_score: overallBand,
        total_questions: audioFiles.length,
        time_spent_seconds: 60,
        question_results: evaluationResult,
        answers: {
          audio_urls: Object.fromEntries(Object.entries(filePaths).map(([k, v]) => [k, `${r2PublicUrl}/${v}`])),
          transcripts_by_part: evaluationResult?.transcripts_by_part || {},
          transcripts_by_question: evaluationResult?.transcripts_by_question || {},
          file_paths: filePaths,
          parallel_mode: true,
        },
        completed_at: new Date().toISOString(),
      })
      .select()
      .single();
    timing.saveResult = Date.now() - saveStart;

    if (saveError) {
      console.error('[resubmit-parallel] Save error:', saveError);
    }

    const totalTimeMs = Date.now() - startTime;
    console.log(`[resubmit-parallel] ====== COMPLETE in ${totalTimeMs}ms ======`);
    console.log(`[resubmit-parallel] Timing breakdown:`, JSON.stringify(timing));

    return new Response(JSON.stringify({ 
      success: true,
      overallBand,
      evaluationReport: evaluationResult,
      resultId: resultRow?.id,
      timing,
      totalTimeMs,
      model: usedModel,
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: unknown) {
    const totalTimeMs = Date.now() - startTime;
    console.error('[resubmit-parallel] Error:', (error as Error)?.message);
    return new Response(JSON.stringify({ 
      error: (error as Error)?.message || 'Unexpected error', 
      code: 'UNKNOWN_ERROR',
      timing,
      totalTimeMs,
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
