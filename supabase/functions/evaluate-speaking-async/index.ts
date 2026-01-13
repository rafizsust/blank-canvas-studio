import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { crypto } from "https://deno.land/std@0.168.0/crypto/mod.ts";
import { 
  getActiveGeminiKeysForModel, 
  markKeyQuotaExhausted
} from "../_shared/apiKeyQuotaUtils.ts";
import { getFromR2 } from "../_shared/r2Client.ts";

/**
 * ASYNC Speaking Evaluation Edge Function
 * 
 * Returns 202 Accepted IMMEDIATELY. User gets instant "submitted" feedback.
 * Actual evaluation runs in background via EdgeRuntime.waitUntil.
 * Results are saved to DB and user is notified via Supabase Realtime.
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Model priority: 2.0 Flash -> 2.5 Flash -> 1.5 Pro
const GEMINI_MODELS = [
  'gemini-2.0-flash',
  'gemini-2.5-flash',
  'gemini-1.5-pro',
];

// Exponential backoff for retries
const RETRY_CONFIG = {
  maxRetries: 5,
  initialDelayMs: 2000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
};

// Declare EdgeRuntime for background processing
declare const EdgeRuntime: { waitUntil?: (promise: Promise<void>) => void } | undefined;

interface EvaluationRequest {
  testId: string;
  filePaths: Record<string, string>;
  durations?: Record<string, number>;
  topic?: string;
  difficulty?: string;
  fluencyFlag?: boolean;
}

serve(async (req) => {
  console.log(`[evaluate-speaking-async] Request at ${new Date().toISOString()}`);
  
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const appEncryptionKey = Deno.env.get('app_encryption_key')!;

    const supabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: req.headers.get('Authorization')! } },
    });

    const supabaseService = createClient(supabaseUrl, supabaseServiceKey);

    // Authenticate user
    const { data: { user }, error: authError } = await supabaseClient.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const body: EvaluationRequest = await req.json();
    const { testId, filePaths, durations, topic, difficulty, fluencyFlag } = body;

    if (!testId || !filePaths || Object.keys(filePaths).length === 0) {
      return new Response(JSON.stringify({ error: 'Missing testId or filePaths' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`[evaluate-speaking-async] Creating job for test ${testId}, ${Object.keys(filePaths).length} files`);

    // Create job record in database (triggers realtime for frontend)
    const { data: job, error: jobError } = await supabaseService
      .from('speaking_evaluation_jobs')
      .insert({
        user_id: user.id,
        test_id: testId,
        status: 'pending',
        file_paths: filePaths,
        durations: durations || {},
        topic,
        difficulty,
        fluency_flag: fluencyFlag || false,
      })
      .select()
      .single();

    if (jobError) {
      console.error('[evaluate-speaking-async] Job creation failed:', jobError);
      return new Response(JSON.stringify({ error: 'Failed to create job' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`[evaluate-speaking-async] Job created: ${job.id}`);

    // Background processing function
    const processInBackground = async () => {
      try {
        await runEvaluation(job.id, user.id, supabaseService, supabaseClient, appEncryptionKey);
      } catch (err) {
        console.error('[evaluate-speaking-async] Background error:', err);
        await supabaseService
          .from('speaking_evaluation_jobs')
          .update({ 
            status: 'failed', 
            last_error: err instanceof Error ? err.message : 'Unknown error',
          })
          .eq('id', job.id);
      }
    };

    // Use EdgeRuntime.waitUntil for true async background processing
    if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime.waitUntil) {
      console.log('[evaluate-speaking-async] Using EdgeRuntime.waitUntil');
      EdgeRuntime.waitUntil(processInBackground());
    } else {
      console.log('[evaluate-speaking-async] EdgeRuntime not available, running async');
      processInBackground().catch(console.error);
    }

    // Return 202 IMMEDIATELY - user gets instant feedback
    return new Response(JSON.stringify({
      success: true,
      jobId: job.id,
      status: 'pending',
      message: 'Evaluation submitted. You will be notified when results are ready.',
    }), {
      status: 202,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
    console.error('[evaluate-speaking-async] Error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

// Main evaluation logic (runs in background)
async function runEvaluation(
  jobId: string,
  userId: string,
  supabaseService: any,
  supabaseClient: any,
  appEncryptionKey: string
): Promise<void> {
  console.log(`[runEvaluation] Starting job ${jobId}`);
  
  // Mark as processing
  await supabaseService
    .from('speaking_evaluation_jobs')
    .update({ status: 'processing' })
    .eq('id', jobId);

  // Get job details
  const { data: job } = await supabaseService
    .from('speaking_evaluation_jobs')
    .select('*')
    .eq('id', jobId)
    .single();

  if (!job) throw new Error('Job not found');

  const { test_id, file_paths, durations, topic, difficulty, fluency_flag, retry_count, max_retries } = job;

  // Get test payload
  const { data: testRow } = await supabaseService
    .from('ai_practice_tests')
    .select('payload, topic, difficulty, preset_id')
    .eq('id', test_id)
    .eq('user_id', userId)
    .maybeSingle();

  if (!testRow) throw new Error('Test not found');

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

  // Download audio files from R2
  console.log('[runEvaluation] Downloading audio files from R2...');
  const audioContents: { key: string; data: Uint8Array; mimeType: string }[] = [];
  
  for (const [key, path] of Object.entries(file_paths)) {
    try {
      const result = await getFromR2(path as string);
      if (result.success && result.bytes) {
        const ext = (path as string).split('.').pop()?.toLowerCase() || 'webm';
        const mimeType = ext === 'mp3' ? 'audio/mpeg' : 'audio/webm';
        audioContents.push({ key, data: result.bytes, mimeType });
        console.log(`[runEvaluation] Downloaded: ${key} (${result.bytes.length} bytes)`);
      }
    } catch (e) {
      console.error(`[runEvaluation] Download error for ${key}:`, e);
    }
  }

  if (audioContents.length === 0) {
    throw new Error('No audio files could be downloaded');
  }

  // Build API key queue
  const keyQueue: { key: string; id: string | null; isUser: boolean }[] = [];

  // Try user's key first
  const { data: userSecret } = await supabaseClient
    .from('user_secrets')
    .select('encrypted_value')
    .eq('user_id', userId)
    .eq('secret_name', 'GEMINI_API_KEY')
    .single();

  if (userSecret?.encrypted_value) {
    try {
      const userKey = await decryptKey(userSecret.encrypted_value, appEncryptionKey);
      keyQueue.push({ key: userKey, id: null, isUser: true });
    } catch (e) {
      console.error('[runEvaluation] User key decryption failed:', e);
    }
  }

  // Add admin pool keys
  const poolKeys = await getActiveGeminiKeysForModel(supabaseService, 'flash');
  for (const pk of poolKeys) {
    keyQueue.push({ key: pk.key_value, id: pk.id, isUser: false });
  }

  if (keyQueue.length === 0) {
    throw new Error('No API keys available');
  }

  // Build evaluation prompt
  const prompt = buildPrompt(payload, topic || testRow.topic, difficulty || testRow.difficulty, fluency_flag);

  // Try evaluation with retries
  let result: any = null;
  let usedModel: string | null = null;
  
  for (const candidate of keyQueue) {
    if (result) break;
    
    for (const model of GEMINI_MODELS) {
      // Retry loop with backoff
      for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
        try {
          console.log(`[runEvaluation] Trying ${model} (attempt ${attempt + 1})`);
          
          const inlineParts = audioContents.map(ac => ({
            inline_data: {
              mime_type: ac.mimeType,
              data: btoa(String.fromCharCode(...ac.data)),
            }
          }));

          const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(candidate.key)}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [{ role: 'user', parts: [...inlineParts, { text: prompt }] }],
                generationConfig: { temperature: 0.3, maxOutputTokens: 8000, responseMimeType: 'application/json' },
              }),
            }
          );

          console.log(`[runEvaluation] ${model} response: ${response.status}`);

          if (!response.ok) {
            const errText = await response.text();
            console.error(`[runEvaluation] ${model} error:`, errText.slice(0, 200));
            
            const errLower = errText.toLowerCase();
            const isQuota = response.status === 429 || errLower.includes('quota');
            const isRetryable = response.status === 429 || response.status === 503 || response.status === 504;
            const isNotFound = response.status === 404;
            
            if (isNotFound) {
              break; // Try next model
            }
            
            if (isRetryable && attempt < RETRY_CONFIG.maxRetries) {
              const delay = Math.min(
                RETRY_CONFIG.initialDelayMs * Math.pow(RETRY_CONFIG.backoffMultiplier, attempt),
                RETRY_CONFIG.maxDelayMs
              );
              console.log(`[runEvaluation] Retrying in ${delay}ms...`);
              await new Promise(r => setTimeout(r, delay));
              continue;
            }
            
            if (isQuota && candidate.id) {
              await markKeyQuotaExhausted(supabaseService, candidate.id, 'flash');
            }
            
            break; // Try next model or key
          }

          const data = await response.json();
          const text = data?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text).filter(Boolean).join('');
          
          if (text) {
            result = parseJson(text);
            if (result) {
              usedModel = model;
              console.log(`[runEvaluation] Success with ${model}`);
              break;
            }
          }
          break; // Got response but no valid JSON, try next model
          
        } catch (err: any) {
          console.error(`[runEvaluation] Error with ${model}:`, err.message);
          if (attempt < RETRY_CONFIG.maxRetries) {
            await new Promise(r => setTimeout(r, RETRY_CONFIG.initialDelayMs * Math.pow(2, attempt)));
            continue;
          }
          break;
        }
      }
      if (result) break;
    }
    if (result) break;
  }

  if (!result) {
    throw new Error('Evaluation failed: all models/keys exhausted');
  }

  // Calculate band score
  const overallBand = result.overall_band || calculateBand(result);

  // Build public audio URLs (client cannot access R2_PUBLIC_URL)
  const publicBase = (Deno.env.get('R2_PUBLIC_URL') || '').replace(/\/$/, '');
  const audioUrls: Record<string, string> = {};
  if (publicBase) {
    for (const [k, r2Key] of Object.entries(file_paths as Record<string, string>)) {
      audioUrls[k] = `${publicBase}/${String(r2Key).replace(/^\//, '')}`;
    }
  }

  // Save to ai_practice_results
  const transcriptsByPart = (result?.transcripts_by_part && typeof result.transcripts_by_part === 'object')
    ? result.transcripts_by_part
    : {};
  const transcriptsByQuestion = (result?.transcripts_by_question && typeof result.transcripts_by_question === 'object')
    ? result.transcripts_by_question
    : {};

  const { data: resultRow, error: saveError } = await supabaseService
    .from('ai_practice_results')
    .insert({
      test_id,
      user_id: userId,
      module: 'speaking',
      score: Math.round(overallBand * 10),
      band_score: overallBand,
      total_questions: audioContents.length,
      time_spent_seconds: durations
        ? Math.round(Object.values(durations as Record<string, number>).reduce((a, b) => a + b, 0))
        : 60,
      question_results: result,
      // IMPORTANT: store client-usable audio_urls + transcripts for results UI
      answers: {
        audio_urls: audioUrls,
        transcripts_by_part: transcriptsByPart,
        transcripts_by_question: transcriptsByQuestion,
        file_paths,
      },
      completed_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (saveError) {
    console.error('[runEvaluation] Save error:', saveError);
  }

  // Mark job as completed - this triggers Realtime notification to frontend
  await supabaseService
    .from('speaking_evaluation_jobs')
    .update({
      status: 'completed',
      result_id: resultRow?.id,
      completed_at: new Date().toISOString(),
    })
    .eq('id', jobId);

  console.log(`[runEvaluation] Job ${jobId} completed, band: ${overallBand}`);
}

// Helper functions
async function decryptKey(encrypted: string, appKey: string): Promise<string> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const keyData = encoder.encode(appKey).slice(0, 32);
  const cryptoKey = await crypto.subtle.importKey('raw', keyData, { name: 'AES-GCM' }, false, ['decrypt']);
  const bytes = Uint8Array.from(atob(encrypted), c => c.charCodeAt(0));
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, cryptoKey, bytes.slice(12));
  return decoder.decode(decrypted);
}

function buildPrompt(payload: any, topic?: string, difficulty?: string, fluencyFlag?: boolean): string {
  const parts = Array.isArray(payload?.speakingParts) ? payload.speakingParts : [];
  const questions = parts
    .flatMap((p: any) => (Array.isArray(p?.questions) ? p.questions.map((q: any) => ({
      part_number: Number(p?.part_number),
      question_number: Number(q?.question_number),
      question_text: String(q?.question_text || ''),
    })) : []))
    .filter((q: any) => q.part_number === 1 || q.part_number === 2 || q.part_number === 3);

  const questionJson = JSON.stringify(questions);

  return [
    `You are an expert IELTS Speaking examiner.`,
    `Evaluate the candidate's audio recordings for ALL parts provided.`,
    `Topic: ${topic || 'General'}. Difficulty: ${difficulty || 'Medium'}.`,
    fluencyFlag ? `Important: Part 2 speaking was under 80 seconds; reflect this in Fluency & Coherence feedback.` : null,
    ``,
    `You must return STRICT JSON ONLY (no markdown, no backticks).`,
    `Use this exact schema and key names:`,
    ``,
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
    `    "1": [{"question_number": 1, "question_text": "...", "transcript": "..."}],`,
    `    "2": [{"question_number": 5, "question_text": "...", "transcript": "..."}],`,
    `    "3": [{"question_number": 9, "question_text": "...", "transcript": "..."}]`,
    `  },`,
    `  "modelAnswers": [{`,
    `    "partNumber": 1,`,
    `    "question": "...",`,
    `    "candidateResponse": "...",`,
    `    "modelAnswerBand7": "...",`,
    `    "modelAnswerBand8": "...",`,
    `    "keyFeatures": ["..."]`,
    `  }]`,
    `}`,
    ``,
    `For transcripts: keep them concise but complete; if audio is unclear, write "(inaudible)" for missing words.`,
    `Use these questions (JSON): ${questionJson}`,
  ].filter(Boolean).join('\n');
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
