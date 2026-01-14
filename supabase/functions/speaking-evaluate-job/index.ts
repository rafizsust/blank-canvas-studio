import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { GoogleGenerativeAI } from "https://esm.sh/@google/generative-ai@0.21.0";
import { crypto } from "https://deno.land/std@0.168.0/crypto/mod.ts";
import { 
  getActiveGeminiKeysForModel, 
  markKeyQuotaExhausted,
  isQuotaExhaustedError
} from "../_shared/apiKeyQuotaUtils.ts";

/**
 * Speaking Evaluate Job - Stage 2 of Speaking Evaluation
 * 
 * This function ONLY handles:
 * 1. Reading persisted Google File URIs from the database
 * 2. Calling Gemini for evaluation
 * 3. Saving results
 * 
 * This assumes uploads are already done (idempotent stage 1).
 * Updates heartbeat during evaluation to prevent timeout detection.
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash'];
const HEARTBEAT_INTERVAL_MS = 20000; // 20 seconds for AI calls
const LOCK_DURATION_MINUTES = 8; // Longer for AI evaluation
const AI_CALL_TIMEOUT_MS = 180000; // 3 minutes per model call

class QuotaError extends Error {
  permanent: boolean;
  constructor(message: string, opts: { permanent: boolean }) {
    super(message);
    this.name = 'QuotaError';
    this.permanent = opts.permanent;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: number | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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

serve(async (req) => {
  console.log(`[speaking-evaluate-job] Request at ${new Date().toISOString()}`);
  
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const appEncryptionKey = Deno.env.get('app_encryption_key')!;
  const supabaseService = createClient(supabaseUrl, supabaseServiceKey);

  let jobId: string | null = null;
  let heartbeatInterval: number | null = null;

  try {
    const body = await req.json();
    jobId = body.jobId;

    if (!jobId) {
      return new Response(JSON.stringify({ error: 'Missing jobId' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Generate lock token
    const lockToken = crypto.randomUUID();
    const lockExpiresAt = new Date(Date.now() + LOCK_DURATION_MINUTES * 60 * 1000).toISOString();

    // Try to claim the job with a lock - first fetch the job to check conditions
    const { data: existingJob, error: fetchError } = await supabaseService
      .from('speaking_evaluation_jobs')
      .select('*')
      .eq('id', jobId)
      .maybeSingle();

    if (fetchError) {
      console.error(`[speaking-evaluate-job] Error fetching job ${jobId}:`, fetchError.message);
      return new Response(JSON.stringify({ 
        success: false, 
        error: `Failed to fetch job: ${fetchError.message}`,
        skipped: true 
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!existingJob) {
      console.log(`[speaking-evaluate-job] Job ${jobId} not found`);
      return new Response(JSON.stringify({ 
        success: false, 
        error: 'Job not found',
        skipped: true 
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Check if job is in claimable state
    const isClaimableStatus = ['pending', 'processing'].includes(existingJob.status);
    const isClaimableStage = ['pending_eval', 'evaluating', null].includes(existingJob.stage);
    const lockExpired = !existingJob.lock_expires_at || new Date(existingJob.lock_expires_at) < new Date();
    const noLock = !existingJob.lock_token;

    if (!isClaimableStatus || !isClaimableStage || (!noLock && !lockExpired)) {
      console.log(`[speaking-evaluate-job] Job ${jobId} not claimable: status=${existingJob.status}, stage=${existingJob.stage}, lockExpired=${lockExpired}, noLock=${noLock}`);
      return new Response(JSON.stringify({ 
        success: false, 
        error: 'Job already claimed or in wrong state',
        skipped: true,
        currentStatus: existingJob.status,
        currentStage: existingJob.stage,
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Now claim the job with an update
    const { data: updatedJobs, error: claimError } = await supabaseService
      .from('speaking_evaluation_jobs')
      .update({
        status: 'processing',
        stage: 'evaluating',
        lock_token: lockToken,
        lock_expires_at: lockExpiresAt,
        heartbeat_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', jobId)
      .select();

    if (claimError) {
      console.error(`[speaking-evaluate-job] Error claiming job ${jobId}:`, claimError.message);
      return new Response(JSON.stringify({ 
        success: false, 
        error: `Failed to claim job: ${claimError.message}`,
        skipped: true 
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const job = updatedJobs?.[0];
    if (!job) {
      console.log(`[speaking-evaluate-job] No job returned after update for ${jobId}`);
      return new Response(JSON.stringify({ 
        success: false, 
        error: 'Job claim failed - no data returned',
        skipped: true 
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Verify uploads exist
    const googleFileUris = job.google_file_uris as Record<string, { fileUri: string; mimeType: string; index: number }>;
    if (!googleFileUris || Object.keys(googleFileUris).length === 0) {
      throw new Error('No Google File URIs found - upload stage incomplete');
    }

    console.log(`[speaking-evaluate-job] Claimed job ${jobId}, ${Object.keys(googleFileUris).length} files ready`);

    // Set up heartbeat updater
    heartbeatInterval = setInterval(async () => {
      try {
        await supabaseService
          .from('speaking_evaluation_jobs')
          .update({ 
            heartbeat_at: new Date().toISOString(),
            lock_expires_at: new Date(Date.now() + LOCK_DURATION_MINUTES * 60 * 1000).toISOString(),
          })
          .eq('id', jobId)
          .eq('lock_token', lockToken);
        console.log(`[speaking-evaluate-job] Heartbeat updated for ${jobId}`);
      } catch (e) {
        console.error(`[speaking-evaluate-job] Heartbeat failed:`, e);
      }
    }, HEARTBEAT_INTERVAL_MS);

    const { user_id: userId, test_id, file_paths, durations, topic, difficulty, fluency_flag } = job;

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

    // Build segment metadata for prompt
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

    const orderedSegments: Array<{ segmentKey: string; partNumber: 1 | 2 | 3; questionNumber: number; questionText: string }> = [];
    
    for (const segmentKey of Object.keys(googleFileUris)) {
      const m = String(segmentKey).match(/^part([123])\-q(.+)$/);
      if (!m) continue;
      const questionId = m[2];
      const q = questionById.get(questionId);
      if (!q) continue;
      orderedSegments.push({ 
        segmentKey, 
        partNumber: q.partNumber, 
        questionNumber: q.questionNumber,
        questionText: q.questionText,
      });
    }

    orderedSegments.sort((a, b) => {
      if (a.partNumber !== b.partNumber) return a.partNumber - b.partNumber;
      return a.questionNumber - b.questionNumber;
    });

    // Build prompt
    const prompt = buildPrompt(
      payload, 
      topic || testRow.topic, 
      difficulty || testRow.difficulty, 
      fluency_flag, 
      orderedSegments
    );

    // Build API key queue
    interface KeyCandidate { key: string; keyId: string | null; isUserProvided: boolean; }
    const keyQueue: KeyCandidate[] = [];

    // User's key first
    const { data: userSecret } = await supabaseService
      .from('user_secrets')
      .select('encrypted_value')
      .eq('user_id', userId)
      .eq('secret_name', 'GEMINI_API_KEY')
      .maybeSingle();

    if (userSecret?.encrypted_value && appEncryptionKey) {
      try {
        const userKey = await decryptKey(userSecret.encrypted_value, appEncryptionKey);
        keyQueue.push({ key: userKey, keyId: null, isUserProvided: true });
      } catch (e) {
        console.warn('[speaking-evaluate-job] Failed to decrypt user key:', e);
      }
    }

    // Admin keys
    const dbApiKeys = await getActiveGeminiKeysForModel(supabaseService, 'flash_2_5');
    for (const dbKey of dbApiKeys) {
      keyQueue.push({ key: dbKey.key_value, keyId: dbKey.id, isUserProvided: false });
    }

    if (keyQueue.length === 0) throw new Error('No API keys available');

    console.log(`[speaking-evaluate-job] Key queue: ${keyQueue.length} keys`);

    // Build file URIs in order for Gemini
    const sortedFileUris = orderedSegments.map(seg => {
      const uri = googleFileUris[seg.segmentKey];
      return { fileData: { mimeType: uri.mimeType, fileUri: uri.fileUri } };
    });

    // Evaluation loop
    let evaluationResult: any = null;
    let usedModel: string | null = null;

    for (const candidateKey of keyQueue) {
      if (evaluationResult) break;
      
      console.log(`[speaking-evaluate-job] Trying key ${candidateKey.isUserProvided ? '(user)' : `(admin: ${candidateKey.keyId})`}`);

      try {
        const genAI = new GoogleGenerativeAI(candidateKey.key);

        for (const modelName of GEMINI_MODELS) {
          if (evaluationResult) break;

          console.log(`[speaking-evaluate-job] Attempting evaluation with model: ${modelName}`);
          
          const model = genAI.getGenerativeModel({ 
            model: modelName,
            generationConfig: { temperature: 0.3, maxOutputTokens: 50000 },
          });

          const contentParts: any[] = [
            ...sortedFileUris,
            { text: prompt }
          ];

          const MAX_RETRIES = 3;
          for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            try {
              // Update heartbeat before long AI call
              await supabaseService
                .from('speaking_evaluation_jobs')
                .update({ 
                  heartbeat_at: new Date().toISOString(),
                  lock_expires_at: new Date(Date.now() + LOCK_DURATION_MINUTES * 60 * 1000).toISOString(),
                })
                .eq('id', jobId)
                .eq('lock_token', lockToken);

              const response = await model.generateContent({ contents: [{ role: 'user', parts: contentParts }] });
              const text = response.response?.text?.() || '';

              if (!text) {
                console.warn(`[speaking-evaluate-job] Empty response from ${modelName}`);
                break;
              }

              const parsed = parseJson(text);
              if (parsed) {
                evaluationResult = parsed;
                usedModel = modelName;
                console.log(`[speaking-evaluate-job] Success with ${modelName}`);
                break;
              } else {
                console.warn(`[speaking-evaluate-job] Failed to parse JSON from ${modelName}`);
                break;
              }
            } catch (err: any) {
              const errMsg = String(err?.message || '');
              console.error(`[speaking-evaluate-job] ${modelName} failed (${attempt + 1}/${MAX_RETRIES}):`, errMsg.slice(0, 200));

              if (isPermanentQuotaExhausted(err)) {
                if (!candidateKey.isUserProvided && candidateKey.keyId) {
                  await markKeyQuotaExhausted(supabaseService, candidateKey.keyId, 'flash_2_5');
                }
                throw new QuotaError(errMsg, { permanent: true });
              }

              if (isQuotaExhaustedError(errMsg)) {
                const retryAfter = extractRetryAfterSeconds(err);
                if (attempt < MAX_RETRIES - 1) {
                  const delay = retryAfter ? Math.min(retryAfter * 1000, 45000) : exponentialBackoffWithJitter(attempt, 2000, 45000);
                  console.log(`[speaking-evaluate-job] Rate limited, retrying in ${Math.round(delay / 1000)}s...`);
                  await sleep(delay);
                  continue;
                } else {
                  throw new QuotaError(errMsg, { permanent: false });
                }
              }

              if (attempt < MAX_RETRIES - 1) {
                const delay = exponentialBackoffWithJitter(attempt, 1000, 20000);
                console.log(`[speaking-evaluate-job] Transient error, retrying in ${Math.round(delay / 1000)}s...`);
                await sleep(delay);
                continue;
              }
              break;
            }
          }
        }
      } catch (keyError: any) {
        if (keyError instanceof QuotaError) {
          console.log(`[speaking-evaluate-job] Key quota exhausted, trying next...`);
          continue;
        }
        console.error(`[speaking-evaluate-job] Key error:`, keyError?.message);
      }
    }

    // Clear heartbeat interval
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }

    if (!evaluationResult) {
      throw new Error('Evaluation failed: all models/keys exhausted');
    }

    // Calculate band score
    const overallBand = evaluationResult.overall_band || calculateBand(evaluationResult);

    // Build public audio URLs
    const publicBase = (Deno.env.get('R2_PUBLIC_URL') || '').replace(/\/$/, '');
    const audioUrls: Record<string, string> = {};
    const filePathsMap = file_paths as Record<string, string>;
    if (publicBase) {
      for (const [k, r2Key] of Object.entries(filePathsMap)) {
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
        total_questions: orderedSegments.length,
        time_spent_seconds: durations ? Math.round(Object.values(durations as Record<string, number>).reduce((a: number, b: number) => a + b, 0)) : 60,
        question_results: evaluationResult,
        answers: {
          audio_urls: audioUrls,
          transcripts_by_part: evaluationResult?.transcripts_by_part || {},
          transcripts_by_question: evaluationResult?.transcripts_by_question || {},
          file_paths: filePathsMap,
        },
        completed_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (saveError) console.error('[speaking-evaluate-job] Save error:', saveError);

    // Mark job completed
    await supabaseService
      .from('speaking_evaluation_jobs')
      .update({
        status: 'completed',
        stage: 'completed',
        result_id: resultRow?.id,
        completed_at: new Date().toISOString(),
        lock_token: null,
        lock_expires_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', jobId);

    console.log(`[speaking-evaluate-job] Complete, band: ${overallBand}, result_id: ${resultRow?.id}`);

    return new Response(JSON.stringify({ 
      success: true, 
      status: 'completed',
      resultId: resultRow?.id,
      band: overallBand,
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
    console.error('[speaking-evaluate-job] Error:', error);

    // Clear heartbeat interval on error
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
    }

    // Update job with error
    if (jobId) {
      const { data: currentJob } = await supabaseService
        .from('speaking_evaluation_jobs')
        .select('retry_count, max_retries')
        .eq('id', jobId)
        .maybeSingle();

      const retryCount = (currentJob?.retry_count || 0) + 1;
      const maxRetries = currentJob?.max_retries || 3;

      if (retryCount >= maxRetries) {
        await supabaseService
          .from('speaking_evaluation_jobs')
          .update({
            status: 'failed',
            stage: 'failed',
            last_error: `Evaluation failed: ${error.message}`,
            retry_count: retryCount,
            lock_token: null,
            lock_expires_at: null,
            updated_at: new Date().toISOString(),
          })
          .eq('id', jobId);
      } else {
        await supabaseService
          .from('speaking_evaluation_jobs')
          .update({
            status: 'pending',
            stage: 'pending_eval',
            last_error: `Evaluation error (will retry): ${error.message}`,
            retry_count: retryCount,
            lock_token: null,
            lock_expires_at: null,
            updated_at: new Date().toISOString(),
          })
          .eq('id', jobId);
      }
    }

    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

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
  
  const audioMappingLines = orderedSegments.map((seg, idx) => 
    `AUDIO_${idx}: "${seg.segmentKey}" → Part ${seg.partNumber}, Question ${seg.questionNumber}: "${seg.questionText}"`
  ).join('\n');

  return `You are a CERTIFIED SENIOR IELTS Speaking Examiner with 20+ years of experience.
Evaluate exactly as an official IELTS examiner. Return ONLY valid JSON.

CONTEXT: Topic: ${topic || 'General'}, Difficulty: ${difficulty || 'Medium'}, Questions: ${numQ}
${fluencyFlag ? '⚠️ Part 2 speaking time under 80 seconds - apply fluency penalty.' : ''}

══════════════════════════════════════════════════════════════
🚨🚨🚨 CRITICAL TRANSCRIPTION RULES - READ CAREFULLY 🚨🚨🚨
══════════════════════════════════════════════════════════════

**ZERO HALLUCINATION POLICY**: You MUST transcribe ONLY what the candidate ACTUALLY SAID in each audio file.

🚫 ABSOLUTELY FORBIDDEN:
- DO NOT invent, fabricate, or guess what the candidate might have said
- DO NOT create plausible answers based on the question context
- DO NOT fill in gaps with assumed content
- DO NOT paraphrase or improve what was said
- DO NOT generate example answers if you cannot hear the audio

✅ YOU MUST:
- Transcribe the EXACT words spoken in each audio file, word-for-word
- Include ALL filler words: "uh", "um", "like", "you know", "so", etc.
- Include false starts, repetitions, and self-corrections
- If a candidate says "Question one" or "Question two", write EXACTLY that
- If the audio is unclear, write "[INAUDIBLE]" for unclear portions
- If there is silence or no speech, write "[NO SPEECH DETECTED]"
- If the audio is too short/empty, write "[AUDIO TOO SHORT - NO CONTENT]"

VERIFICATION CHECK: Before submitting, ask yourself for EACH transcript:
"Did I hear these exact words in the audio, or did I make this up?"
If you made it up, you have FAILED and must fix it.

══════════════════════════════════════════════════════════════
AUDIO-TO-QUESTION MAPPING (FIXED ORDER)
══════════════════════════════════════════════════════════════
The ${numQ} audio files are provided in this EXACT fixed order:

${audioMappingLines}

RULES:
1. Audio file at position 0 = AUDIO_0 = first segment in the list above
2. Audio file at position 1 = AUDIO_1 = second segment in the list above
3. Continue this pattern for ALL files
4. DO NOT reorder or swap. The mapping is FIXED.

══════════════════════════════════════════════════════════════
SCORING FOR POOR/OFF-TOPIC RESPONSES (STRICTLY ENFORCE)
══════════════════════════════════════════════════════════════

The candidate may give completely off-topic or inadequate responses. Score them HARSHLY:

🔴 UNACCEPTABLE RESPONSES - Band 1.0-2.0:
- Candidate just says "Question one", "Question two", or the question number
- No actual answer to the question
- Complete silence or unintelligible mumbling
- Less than 5 words total with no meaningful content

🟠 VERY POOR RESPONSES - Band 2.5-3.5:
- Only 5-10 words with minimal relevance
- Generic one-liner that doesn't address the question
- "I don't know" type responses

🟡 POOR RESPONSES - Band 4.0-4.5:
- 10-20 words with some attempt at answering
- Limited vocabulary, basic grammar only
- Significant hesitation and repetition

📊 WORD COUNT GUIDELINES (MANDATORY):
- Part 1: Expect 30-60 words per answer for Band 5-6
- Part 2: Expect 150-250 words for Band 5-6
- Part 3: Expect 40-80 words per answer for Band 5-6

If response is significantly shorter, cap the band score accordingly.

══════════════════════════════════════════════════════════════
OFFICIAL IELTS BAND DESCRIPTORS
══════════════════════════════════════════════════════════════

FLUENCY AND COHERENCE (FC):
- Band 9: Speaks fluently with rare hesitation; hesitation is content-related
- Band 7: Speaks at length without noticeable effort; some language-related hesitation
- Band 5: Maintains flow with repetition/self-correction/slow speech
- Band 4: Cannot respond without noticeable pauses; frequent repetition
- Band 3: Pauses occur frequently; simple connectives only
- Band 2: Speech is very slow and fragmented; minimal communication

LEXICAL RESOURCE (LR):
- Band 9: Full flexibility; idiomatic language naturally
- Band 7: Flexible vocabulary; some less common/idiomatic vocabulary
- Band 5: Limited vocabulary; pauses to search for words
- Band 4: Basic vocabulary, repetitive or inappropriate
- Band 3: Simple vocabulary; meaning unclear at times
- Band 2: Only isolated words or memorized utterances

GRAMMATICAL RANGE AND ACCURACY (GRA):
- Band 9: Full range of structures; consistently accurate
- Band 7: Range of complex structures; frequently error-free
- Band 5: Basic sentence forms; limited complex structures
- Band 4: Basic sentences; subordinate structures rare
- Band 3: Attempts basic sentence forms; errors common
- Band 2: Cannot produce basic sentence forms

PRONUNCIATION (P):
- Band 9: Full range of features with precision
- Band 7: Most features of Band 8; some L1 influence
- Band 5: Some Band 6 features; mispronounces individual words
- Band 4: Limited features; frequent mispronunciations
- Band 3: Very limited control; frequent misunderstandings
- Band 2: Pronunciation makes comprehension very difficult

══════════════════════════════════════════════════════════════
MODEL ANSWERS REQUIREMENTS (MANDATORY)
══════════════════════════════════════════════════════════════

For EACH question, you MUST provide a modelAnswer showing how a Band 7-8 candidate would respond.

Word count requirements for model answers:
- Part 1: ~75 words (natural, conversational)
- Part 2: ~250-300 words (covers all cue card points)
- Part 3: ~120-150 words (analytical with examples)

Each modelAnswer MUST include:
- estimatedBand: The candidate's actual band for THIS question
- targetBand: One band higher (or 8.5 if already high)
- modelAnswer: A complete Band 7-8 response demonstrating ideal techniques
- whyItWorks: 3-4 specific reasons this answer would score well
- keyImprovements: 3-4 specific things the candidate should improve

══════════════════════════════════════════════════════════════
EXACT JSON OUTPUT SCHEMA (FOLLOW PRECISELY)
══════════════════════════════════════════════════════════════
{
  "overall_band": 6.0,
  "criteria": {
    "fluency_coherence": {"band": 6.0, "feedback": "Specific assessment of this criterion", "strengths": ["str1", "str2"], "weaknesses": ["weak1"], "suggestions": ["tip1", "tip2"]},
    "lexical_resource": {"band": 6.0, "feedback": "...", "strengths": [...], "weaknesses": [...], "suggestions": [...]},
    "grammatical_range": {"band": 5.5, "feedback": "...", "strengths": [...], "weaknesses": [...], "suggestions": [...]},
    "pronunciation": {"band": 6.0, "feedback": "...", "strengths": [...], "weaknesses": [...], "suggestions": [...]}
  },
  "summary": "2-4 sentence overall performance summary",
  "lexical_upgrades": [{"original": "good", "upgraded": "beneficial", "context": "example usage"}],
  "part_analysis": [
    {"part_number": 1, "performance_notes": "How the candidate performed in Part 1...", "key_moments": ["Notable strength or issue 1", "Notable moment 2"], "areas_for_improvement": ["Improvement 1", "Improvement 2"]}
  ],
  "improvement_priorities": ["Priority 1: Most important thing to work on", "Priority 2: Second priority"],
  "strengths_to_maintain": ["Strength 1: Something they did well", "Strength 2: Another positive"],
  "transcripts_by_part": {"1": "Full concatenated Part 1 transcript...", "2": "...", "3": "..."},
  "transcripts_by_question": {
    "1": [{"segment_key": "part1-q...", "question_number": 1, "question_text": "...", "transcript": "EXACT words spoken by candidate"}],
    "2": [...],
    "3": [...]
  },
  "modelAnswers": [
    {
      "segment_key": "MUST match segment_key from audio mapping above",
      "partNumber": 1,
      "questionNumber": 1,
      "question": "The question text",
      "candidateResponse": "EXACT transcript from the audio - NO FABRICATION",
      "estimatedBand": 5.5,
      "targetBand": 6.5,
      "modelAnswer": "A complete ~75 word (Part 1) / ~300 word (Part 2) / ~150 word (Part 3) model response...",
      "whyItWorks": ["Uses topic vocabulary", "Clear structure", "Natural examples"],
      "keyImprovements": ["Add more detail", "Vary vocabulary", "Use complex sentences"]
    }
  ]
}

QUESTIONS JSON: ${JSON.stringify(questions)}

FINAL REMINDER:
1. There are exactly ${numQ} audio files - return exactly ${numQ} modelAnswers
2. segment_key in each modelAnswer MUST match the AUDIO_0 to AUDIO_${numQ - 1} mapping
3. candidateResponse MUST be the EXACT words heard in the audio - NEVER fabricate
4. If the candidate said something irrelevant like "Question one" - transcribe it and score Band 1-2
5. Model answers MUST be substantial (75/300/150 words per part)
6. part_analysis MUST have entries for each part with real performance notes`;
}

function parseJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {}
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (match)
    try {
      return JSON.parse(match[1].trim());
    } catch {}
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch)
    try {
      return JSON.parse(objMatch[0]);
    } catch {}
  return null;
}

function sanitizeEvaluation(result: any): any {
  if (!result || typeof result !== 'object') return result;

  const transcriptText = getAllTranscriptText(result);
  const transcriptLc = transcriptText.toLowerCase();

  // Remove lexical suggestions that are not literally present in the candidate transcript.
  if (Array.isArray(result.lexical_upgrades)) {
    result.lexical_upgrades = result.lexical_upgrades.filter((row: any) => {
      const original = String(row?.original || '').trim();
      if (!original) return false;
      // Allow multi-word matches; basic substring is enough for our use-case.
      return transcriptLc.includes(original.toLowerCase());
    });
  }

  // If almost no speech, don't show hallucinated lexical upgrades at all.
  const wordCount = transcriptText.split(/\s+/).filter(Boolean).length;
  if (wordCount < 8) {
    result.lexical_upgrades = [];
  }

  return result;
}

function getAllTranscriptText(result: any): string {
  const chunks: string[] = [];
  const byPart = result?.transcripts_by_part;
  if (byPart && typeof byPart === 'object') {
    for (const v of Object.values(byPart)) chunks.push(String(v || ''));
  }
  const byQ = result?.transcripts_by_question;
  if (byQ && typeof byQ === 'object') {
    for (const partArr of Object.values(byQ)) {
      if (!Array.isArray(partArr)) continue;
      for (const row of partArr) {
        chunks.push(String((row as any)?.transcript || ''));
      }
    }
  }
  // Some older shapes store candidateResponse in modelAnswers
  if (Array.isArray(result?.modelAnswers)) {
    for (const ma of result.modelAnswers) {
      chunks.push(String((ma as any)?.candidateResponse || ''));
    }
  }
  return chunks.join(' ').replace(/\s+/g, ' ').trim();
}

function calculateBand(result: any): number {
  const c = result.criteria;
  if (!c) return 6.0;
  const scores = [
    c.fluency_coherence?.band,
    c.lexical_resource?.band,
    c.grammatical_range?.band,
    c.pronunciation?.band,
  ].filter((s: any) => typeof s === 'number');

  if (scores.length === 0) return 6.0;
  const avg = scores.reduce((a: number, b: number) => a + b, 0) / scores.length;
  return Math.round(avg * 2) / 2;
}
