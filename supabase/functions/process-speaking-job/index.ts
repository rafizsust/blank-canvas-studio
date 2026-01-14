import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { GoogleGenerativeAI } from "https://esm.sh/@google/generative-ai@0.21.0";
import { crypto } from "https://deno.land/std@0.168.0/crypto/mod.ts";
import { 
  getActiveGeminiKeysForModel, 
  markKeyQuotaExhausted,
  isQuotaExhaustedError
} from "../_shared/apiKeyQuotaUtils.ts";
import { getFromR2 } from "../_shared/r2Client.ts";

/**
 * SEPARATED Speaking Job Processor
 * 
 * This function ONLY processes jobs - it does NOT create them.
 * Jobs are created by evaluate-speaking-async which returns immediately.
 * 
 * This processor can be called via:
 * 1. Supabase cron job (scheduled polling)
 * 2. Direct invocation from frontend (manual retry)
 * 3. Webhook trigger after job creation
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash'];

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

function exponentialBackoffWithJitter(attempt: number, baseDelayMs = 1000, maxDelayMs = 60000): number {
  const exponentialDelay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
  const jitter = Math.random() * exponentialDelay * 0.5;
  return Math.round(exponentialDelay + jitter);
}

function extractRetryAfterSeconds(err: any): number | undefined {
  const msg = String(err?.message || err || '');
  const m1 = msg.match(/retryDelay"\s*:\s*"(\d+)s"/i);
  if (m1) return Math.max(0, Number(m1[1]));
  const m2 = msg.match(/retry\s+in\s+([0-9.]+)s/i);
  if (m2) return Math.max(0, Math.ceil(Number(m2[1])));
  return undefined;
}

function isPermanentQuotaExhausted(err: any): boolean {
  const msg = String(err?.message || err || '').toLowerCase();
  if (msg.includes('check your plan') || msg.includes('billing')) return true;
  if (msg.includes('limit: 0')) return true;
  if (msg.includes('per day') && !msg.includes('retry')) return true;
  return false;
}

async function uploadToGoogleFileAPI(
  apiKey: string,
  audioBytes: Uint8Array,
  fileName: string,
  mimeType: string
): Promise<{ uri: string; mimeType: string }> {
  console.log(`[process-speaking-job] Uploading ${fileName} to Google File API (${audioBytes.length} bytes)...`);
  
  const initiateUrl = `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`;
  
  const metadata = { file: { displayName: fileName } };
  
  const initiateResponse = await fetch(initiateUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(audioBytes.length),
      'X-Goog-Upload-Header-Content-Type': mimeType,
    },
    body: JSON.stringify(metadata),
  });
  
  if (!initiateResponse.ok) {
    const errorText = await initiateResponse.text();
    throw new Error(`Failed to initiate upload: ${initiateResponse.status} - ${errorText}`);
  }
  
  const uploadUrl = initiateResponse.headers.get('X-Goog-Upload-URL');
  if (!uploadUrl) throw new Error('No upload URL returned');
  
  const uploadResponse = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Length': String(audioBytes.length),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
    },
    body: audioBytes.buffer as ArrayBuffer,
  });
  
  if (!uploadResponse.ok) {
    const errorText = await uploadResponse.text();
    throw new Error(`Failed to upload file: ${uploadResponse.status} - ${errorText}`);
  }
  
  const result = await uploadResponse.json();
  if (!result.file?.uri) throw new Error('No file URI returned');
  
  console.log(`[process-speaking-job] Uploaded ${fileName}: ${result.file.uri}`);
  return { uri: result.file.uri, mimeType: result.file.mimeType || mimeType };
}

serve(async (req) => {
  console.log(`[process-speaking-job] Request at ${new Date().toISOString()}`);
  
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const appEncryptionKey = Deno.env.get('app_encryption_key')!;

    const supabaseService = createClient(supabaseUrl, supabaseServiceKey);

    const body = await req.json();
    const { jobId } = body;

    if (!jobId) {
      return new Response(JSON.stringify({ error: 'Missing jobId' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Fetch the job
    const { data: job, error: jobError } = await supabaseService
      .from('speaking_evaluation_jobs')
      .select('*')
      .eq('id', jobId)
      .single();

    if (jobError || !job) {
      return new Response(JSON.stringify({ error: 'Job not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Check if job is already completed or cancelled
    if (job.status === 'completed' || job.status === 'failed') {
      console.log(`[process-speaking-job] Job ${jobId} already ${job.status}, skipping`);
      return new Response(JSON.stringify({ success: true, status: job.status, skipped: true }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Mark as processing
    await supabaseService
      .from('speaking_evaluation_jobs')
      .update({ status: 'processing', updated_at: new Date().toISOString() })
      .eq('id', jobId);

    try {
      await processJob(job, supabaseService, appEncryptionKey);
      
      return new Response(JSON.stringify({ success: true, status: 'completed' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    } catch (processError: any) {
      console.error('[process-speaking-job] Processing failed:', processError);
      
      // Update job with error
      const retryCount = (job.retry_count || 0) + 1;
      const maxRetries = job.max_retries || 3;
      
      if (retryCount >= maxRetries) {
        await supabaseService
          .from('speaking_evaluation_jobs')
          .update({
            status: 'failed',
            last_error: processError.message,
            retry_count: retryCount,
            updated_at: new Date().toISOString(),
          })
          .eq('id', jobId);
      } else {
        // Mark as pending for retry
        await supabaseService
          .from('speaking_evaluation_jobs')
          .update({
            status: 'pending',
            last_error: processError.message,
            retry_count: retryCount,
            updated_at: new Date().toISOString(),
          })
          .eq('id', jobId);
      }

      return new Response(JSON.stringify({ success: false, error: processError.message, retryCount }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  } catch (error: any) {
    console.error('[process-speaking-job] Error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

async function processJob(job: any, supabaseService: any, appEncryptionKey: string): Promise<void> {
  const { id: jobId, user_id: userId, test_id, file_paths, durations, topic, difficulty, fluency_flag } = job;

  console.log(`[processJob] Starting job ${jobId} for test ${test_id}`);

  // Get test payload
  const { data: testRow } = await supabaseService
    .from('ai_practice_tests')
    .select('payload, topic, difficulty, preset_id')
    .eq('id', test_id)
    .eq('user_id', userId)
    .maybeSingle();

  if (!testRow) throw new Error('Test not found');

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

  for (const segmentKey of Object.keys(file_paths as Record<string, string>)) {
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

  // Download audio files in exact order
  console.log('[processJob] Downloading audio files from R2...');
  const audioFiles: { index: number; key: string; bytes: Uint8Array; mimeType: string }[] = [];
  const filePathsMap = file_paths as Record<string, string>;

  for (let i = 0; i < orderedSegments.length; i++) {
    const segment = orderedSegments[i];
    const r2Path = filePathsMap[segment.segmentKey];
    
    if (!r2Path) {
      console.warn(`[processJob] No R2 path for segment: ${segment.segmentKey}`);
      continue;
    }
    
    try {
      console.log(`[processJob] [${i}] Downloading Part ${segment.partNumber} Q${segment.questionNumber}: ${segment.segmentKey}`);
      const result = await getFromR2(r2Path);
      if (!result.success || !result.bytes) throw new Error(result.error || 'Download failed');
      
      const ext = r2Path.split('.').pop()?.toLowerCase() || 'webm';
      const mimeType = ext === 'mp3' ? 'audio/mpeg' : 'audio/webm';
      
      audioFiles.push({ index: i, key: segment.segmentKey, bytes: result.bytes, mimeType });
      console.log(`[processJob] [${i}] Downloaded: ${result.bytes.length} bytes`);
    } catch (e) {
      console.error(`[processJob] Download error for ${segment.segmentKey}:`, e);
    }
  }

  if (audioFiles.length === 0) throw new Error('No audio files downloaded');

  // Build API key queue
  interface KeyCandidate { key: string; keyId: string | null; isUserProvided: boolean; }
  const keyQueue: KeyCandidate[] = [];

  // User's key first
  const { data: userSecret } = await supabaseService
    .from('user_secrets')
    .select('encrypted_value')
    .eq('user_id', userId)
    .eq('secret_name', 'GEMINI_API_KEY')
    .single();

  if (userSecret?.encrypted_value && appEncryptionKey) {
    try {
      const userKey = await decryptKey(userSecret.encrypted_value, appEncryptionKey);
      keyQueue.push({ key: userKey, keyId: null, isUserProvided: true });
    } catch (e) {
      console.warn('[processJob] Failed to decrypt user key:', e);
    }
  }

  // Admin keys
  const dbApiKeys = await getActiveGeminiKeysForModel(supabaseService, 'flash_2_5');
  for (const dbKey of dbApiKeys) {
    keyQueue.push({ key: dbKey.key_value, keyId: dbKey.id, isUserProvided: false });
  }

  if (keyQueue.length === 0) throw new Error('No API keys available');

  console.log(`[processJob] Key queue: ${keyQueue.length} keys`);

  // Build prompt with explicit audio indexing
  const prompt = buildPrompt(payload, topic || testRow.topic, difficulty || testRow.difficulty, fluency_flag, orderedSegments);

  // Evaluation loop
  let evaluationResult: any = null;
  let usedModel: string | null = null;

  for (const candidateKey of keyQueue) {
    if (evaluationResult) break;
    
    console.log(`[processJob] Trying key ${candidateKey.isUserProvided ? '(user)' : `(admin: ${candidateKey.keyId})`}`);

    try {
      const genAI = new GoogleGenerativeAI(candidateKey.key);
      
      // Upload files with EXPLICIT index in filename for Gemini to reference
      const fileUris: Array<{ index: number; fileData: { mimeType: string; fileUri: string } }> = [];
      
      console.log(`[processJob] Uploading ${audioFiles.length} files to Google File API...`);
      
      for (const audioFile of audioFiles) {
        // Include explicit index in filename: "AUDIO_INDEX_0_part1-q123.webm"
        const explicitFileName = `AUDIO_INDEX_${audioFile.index}_${audioFile.key}.webm`;
        const uploadResult = await uploadToGoogleFileAPI(
          candidateKey.key,
          audioFile.bytes,
          explicitFileName,
          audioFile.mimeType
        );
        
        fileUris.push({
          index: audioFile.index,
          fileData: { mimeType: uploadResult.mimeType, fileUri: uploadResult.uri }
        });
      }
      
      // Sort by index to guarantee order
      fileUris.sort((a, b) => a.index - b.index);
      
      console.log(`[processJob] Uploaded ${fileUris.length} files`);

      for (const modelName of GEMINI_MODELS) {
        if (evaluationResult) break;

        console.log(`[processJob] Attempting evaluation with model: ${modelName}`);
        
        const model = genAI.getGenerativeModel({ 
          model: modelName,
          generationConfig: { temperature: 0.3, maxOutputTokens: 65000 },
        });

        // Build content: files in order, then prompt
        // CRITICAL: Gemini expects { fileData: { mimeType, fileUri } } NOT just the inner object
        const contentParts: any[] = [
          ...fileUris.map(f => ({ fileData: f.fileData })),
          { text: prompt }
        ];

        const MAX_RETRIES = 4;
        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
          try {
            const response = await model.generateContent({ contents: [{ role: 'user', parts: contentParts }] });
            const text = response.response?.text?.() || '';

            if (!text) {
              console.warn(`[processJob] Empty response from ${modelName}`);
              break;
            }

            const parsed = parseJson(text);
            if (parsed) {
              evaluationResult = parsed;
              usedModel = modelName;
              console.log(`[processJob] Success with ${modelName}`);
              break;
            } else {
              console.warn(`[processJob] Failed to parse JSON`);
              break;
            }
          } catch (err: any) {
            const errMsg = String(err?.message || '');
            console.error(`[processJob] ${modelName} failed (${attempt + 1}/${MAX_RETRIES}):`, errMsg.slice(0, 200));

            if (isPermanentQuotaExhausted(err)) {
              if (!candidateKey.isUserProvided && candidateKey.keyId) {
                await markKeyQuotaExhausted(supabaseService, candidateKey.keyId, 'flash_2_5');
              }
              throw new QuotaError(errMsg, { permanent: true });
            }

            if (isQuotaExhaustedError(errMsg)) {
              const retryAfter = extractRetryAfterSeconds(err);
              if (attempt < MAX_RETRIES - 1) {
                const delay = retryAfter ? Math.min(retryAfter * 1000, 60000) : exponentialBackoffWithJitter(attempt, 2000, 60000);
                console.log(`[processJob] Rate limited, retrying in ${Math.round(delay / 1000)}s...`);
                await sleep(delay);
                continue;
              } else {
                throw new QuotaError(errMsg, { permanent: false });
              }
            }

            if (attempt < MAX_RETRIES - 1) {
              const delay = exponentialBackoffWithJitter(attempt, 1000, 30000);
              console.log(`[processJob] Transient error, retrying in ${Math.round(delay / 1000)}s...`);
              await sleep(delay);
              continue;
            }
            break;
          }
        }
      }
    } catch (keyError: any) {
      if (keyError instanceof QuotaError) {
        console.log(`[processJob] Key quota exhausted, trying next...`);
        continue;
      }
      console.error(`[processJob] Key error:`, keyError?.message);
    }
  }

  if (!evaluationResult) throw new Error('Evaluation failed: all models/keys exhausted');

  const overallBand = evaluationResult.overall_band || calculateBand(evaluationResult);

  // Build public audio URLs
  const publicBase = (Deno.env.get('R2_PUBLIC_URL') || '').replace(/\/$/, '');
  const audioUrls: Record<string, string> = {};
  if (publicBase) {
    for (const [k, r2Key] of Object.entries(file_paths as Record<string, string>)) {
      audioUrls[k] = `${publicBase}/${String(r2Key).replace(/^\//, '')}`;
    }
  }

  // Save result
  const { data: resultRow, error: saveError } = await supabaseService
    .from('ai_practice_results')
    .insert({
      test_id,
      user_id: userId,
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
        file_paths,
      },
      completed_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (saveError) console.error('[processJob] Save error:', saveError);

  // Mark job completed
  await supabaseService
    .from('speaking_evaluation_jobs')
    .update({
      status: 'completed',
      result_id: resultRow?.id,
      completed_at: new Date().toISOString(),
    })
    .eq('id', jobId);

  console.log(`[processJob] Complete, band: ${overallBand}, result_id: ${resultRow?.id}`);
}

async function decryptKey(encrypted: string, appKey: string): Promise<string> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const keyData = encoder.encode(appKey).slice(0, 32);
  const cryptoKey = await crypto.subtle.importKey('raw', keyData, { name: 'AES-GCM' }, false, ['decrypt']);
  const bytes = Uint8Array.from(atob(encrypted), c => c.charCodeAt(0));
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, cryptoKey, bytes.slice(12));
  return decoder.decode(decrypted);
}

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

  const numQ = orderedSegments.length;
  
  // Build explicit audio mapping section
  const audioMappingLines = orderedSegments.map((seg, idx) => 
    `AUDIO_${idx}: "${seg.segmentKey}" → Part ${seg.partNumber}, Question ${seg.questionNumber}: "${seg.questionText}"`
  ).join('\n');

  return `You are a CERTIFIED SENIOR IELTS Speaking Examiner with 20+ years of experience.
Evaluate exactly as an official IELTS examiner. Return ONLY valid JSON.

CONTEXT: Topic: ${topic || 'General'}, Difficulty: ${difficulty || 'Medium'}, Questions: ${numQ}
${fluencyFlag ? '⚠️ Part 2 speaking time under 80 seconds - apply fluency penalty.' : ''}

══════════════════════════════════════════════════════════════
CRITICAL: AUDIO-TO-QUESTION MAPPING (FIXED - DO NOT CHANGE!)
══════════════════════════════════════════════════════════════
The ${numQ} audio files are provided in this EXACT fixed order:

${audioMappingLines}

RULES:
1. Audio file at position 0 = AUDIO_0 = first segment in the list above
2. Audio file at position 1 = AUDIO_1 = second segment in the list above
3. Continue this pattern for ALL files
4. The file names contain "AUDIO_INDEX_N" where N is the position
5. DO NOT reorder, swap, or guess. The mapping is FIXED.
6. Transcribe each audio to its corresponding question EXACTLY as mapped above

══════════════════════════════════════════════════════════════
OFFICIAL IELTS BAND DESCRIPTORS (MANDATORY)
══════════════════════════════════════════════════════════════

FLUENCY AND COHERENCE (FC):
- Band 9: Speaks fluently with rare hesitation; hesitation is content-related
- Band 7: Speaks at length without noticeable effort; some language-related hesitation
- Band 5: Maintains flow with repetition/self-correction/slow speech
- Band 4: Cannot respond without noticeable pauses; frequent repetition

LEXICAL RESOURCE (LR):
- Band 9: Full flexibility; idiomatic language naturally
- Band 7: Flexible vocabulary; some less common/idiomatic vocabulary
- Band 5: Limited vocabulary; pauses to search for words
- Band 4: Basic vocabulary, repetitive or inappropriate

GRAMMATICAL RANGE AND ACCURACY (GRA):
- Band 9: Full range of structures; consistently accurate
- Band 7: Range of complex structures; frequently error-free
- Band 5: Basic sentence forms; limited complex structures
- Band 4: Basic sentences; subordinate structures rare

PRONUNCIATION (P):
- Band 9: Full range of features with precision
- Band 7: Most features of Band 8; some L1 influence
- Band 5: Some Band 6 features; mispronounces individual words
- Band 4: Limited features; frequent mispronunciations

SCORING GUIDELINES:
- Short responses (<15 words): Max Band 4.0-4.5
- Off-topic: Severe FC penalty (1-2 bands)
- No response: Band 1.0-2.0
- Part 2: Holistic evaluation - quality > quantity
- Excellent concise Part 2 that fully addresses cue card can score Band 8+

EXACT JSON OUTPUT SCHEMA:
{
  "overall_band": 6.0,
  "criteria": {
    "fluency_coherence": {"band": 6.0, "feedback": "...", "strengths": [...], "weaknesses": [...], "suggestions": [...]},
    "lexical_resource": {"band": 6.0, "feedback": "...", "strengths": [...], "weaknesses": [...], "suggestions": [...]},
    "grammatical_range": {"band": 5.5, "feedback": "...", "strengths": [...], "weaknesses": [...], "suggestions": [...]},
    "pronunciation": {"band": 6.0, "feedback": "...", "strengths": [...], "weaknesses": [...], "suggestions": [...]}
  },
  "summary": "Overall performance summary",
  "lexical_upgrades": [{"original": "...", "upgraded": "...", "context": "..."}],
  "part_analysis": [{"part_number": 1, "performance_notes": "...", "key_moments": [...]}],
  "improvement_priorities": ["Priority 1...", "Priority 2..."],
  "transcripts_by_part": {"1": "...", "2": "...", "3": "..."},
  "transcripts_by_question": {
    "1": [{"segment_key": "part1-q...", "question_number": 1, "question_text": "...", "transcript": "..."}],
    "2": [...],
    "3": [...]
  },
  "modelAnswers": [
    {
      "segment_key": "MUST match segment_key from audio mapping",
      "partNumber": 1,
      "questionNumber": 1,
      "question": "Question text",
      "candidateResponse": "EXACT transcript",
      "estimatedBand": 5.5,
      "modelAnswer": "Model answer",
      "whyItWorks": [...],
      "keyImprovements": [...]
    }
  ]
}

QUESTIONS JSON: ${JSON.stringify(questions)}

REMINDER: There are exactly ${numQ} audio files. Return exactly ${numQ} modelAnswers with correct segment_keys matching the AUDIO_0 to AUDIO_${numQ - 1} mapping above.`;
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
  
  // Step 1: Calculate criterion-based score (fluency, lexical, grammatical, pronunciation)
  const criterionScores = c ? [
    c.fluency_coherence?.band,
    c.lexical_resource?.band,
    c.grammatical_range?.band,
    c.pronunciation?.band,
  ].filter(s => typeof s === 'number') : [];
  
  const criterionAvg = criterionScores.length > 0
    ? criterionScores.reduce((a: number, b: number) => a + b, 0) / criterionScores.length
    : 6.0;
  
  // Step 2: Extract per-question scores from modelAnswers
  const modelAnswers = Array.isArray(result.modelAnswers) ? result.modelAnswers : [];
  const questionScores = modelAnswers
    .map((ma: any) => {
      const band = ma.estimatedBand ?? ma.estimated_band ?? ma.questionBandScore ?? ma.question_band_score;
      const partNum = ma.partNumber ?? ma.part_number ?? 1;
      return { band: typeof band === 'number' ? band : null, partNum };
    })
    .filter((qs: any) => qs.band !== null);
  
  console.log(`[calculateBand] Criterion avg: ${criterionAvg.toFixed(2)}, Question scores: ${questionScores.length}`);
  
  // If no per-question scores, fall back to criterion average
  if (questionScores.length === 0) {
    return Math.round(criterionAvg * 2) / 2;
  }
  
  // Step 3: Group question scores by part for weighted calculation
  const scoresByPart: Record<number, number[]> = { 1: [], 2: [], 3: [] };
  for (const qs of questionScores) {
    const partNum = qs.partNum;
    if (partNum >= 1 && partNum <= 3) {
      scoresByPart[partNum].push(qs.band);
    }
  }
  
  // Calculate weighted average: each part with questions gets equal weight
  const partsWithScores = Object.entries(scoresByPart)
    .filter(([_, scores]) => scores.length > 0)
    .map(([partNum, scores]) => ({
      partNum: parseInt(partNum),
      avgScore: scores.reduce((a, b) => a + b, 0) / scores.length,
    }));
  
  if (partsWithScores.length === 0) {
    return Math.round(criterionAvg * 2) / 2;
  }
  
  const weightedAvgQuestionScore = partsWithScores.reduce((sum, p) => sum + p.avgScore, 0) / partsWithScores.length;
  console.log(`[calculateBand] Weighted avg question score: ${weightedAvgQuestionScore.toFixed(2)} from ${partsWithScores.length} parts`);
  console.log(`[calculateBand] Per-part averages: ${partsWithScores.map(p => `P${p.partNum}=${p.avgScore.toFixed(1)}`).join(', ')}`);
  
  // Step 4: Count minimal responses (score <= 2) for penalty caps
  const minimalCount = questionScores.filter((qs: any) => qs.band <= 2).length;
  const minimalRatio = minimalCount / questionScores.length;
  console.log(`[calculateBand] Minimal responses: ${minimalCount}/${questionScores.length} (${(minimalRatio * 100).toFixed(0)}%)`);
  
  // Apply penalty caps based on minimal response count
  let maxAllowedBand = 9.0;
  if (minimalRatio >= 0.5) {
    maxAllowedBand = 4.0; // 50% or more minimal responses
    console.log(`[calculateBand] Capping band to ${maxAllowedBand} due to ${(minimalRatio * 100).toFixed(0)}% minimal responses`);
  } else if (minimalRatio >= 0.3) {
    maxAllowedBand = 5.0; // 30% or more minimal responses
    console.log(`[calculateBand] Capping band to ${maxAllowedBand} due to ${(minimalRatio * 100).toFixed(0)}% minimal responses`);
  }
  
  // Step 5: Calculate final band
  // Add a small bonus (max 0.5) from criterion scores, but question scores are primary
  const bonusFromCriteria = Math.min(0.5, Math.max(0, (criterionAvg - weightedAvgQuestionScore) / 2));
  const questionBasedBand = Math.round((weightedAvgQuestionScore + bonusFromCriteria) * 2) / 2;
  console.log(`[calculateBand] Question-based band: ${questionBasedBand} (weighted avg: ${weightedAvgQuestionScore.toFixed(1)}, criteria bonus: ${bonusFromCriteria.toFixed(2)})`);
  
  // Take the lower of question-based and criterion-based scores
  let overallBand = Math.min(questionBasedBand, Math.round(criterionAvg * 2) / 2);
  
  // Apply the cap for minimal responses
  if (overallBand > maxAllowedBand) {
    console.log(`[calculateBand] Reducing overall band from ${overallBand} to ${maxAllowedBand} due to minimal responses cap`);
    overallBand = maxAllowedBand;
  }
  
  console.log(`[calculateBand] FINAL overall band: ${overallBand}`);
  return overallBand;
}
