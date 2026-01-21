import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getFromR2 } from "../_shared/r2Client.ts";

/**
 * DUAL-WHISPER TRANSCRIPTION ENGINE v2.0
 * 
 * Production-grade transcription using BOTH Groq Whisper models:
 * - whisper-large-v3: Better vocabulary accuracy
 * - whisper-large-v3-turbo: Better noise handling, fewer hallucinations
 * 
 * The engine runs both models and intelligently merges results based on
 * agreement, hallucination detection, and validation rules.
 * 
 * NO browser transcripts are used - they are too unreliable.
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// =============================================================================
// CONFIGURATION
// =============================================================================

const GROQ_API_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const WHISPER_V3 = 'whisper-large-v3';
const WHISPER_TURBO = 'whisper-large-v3-turbo';
const INTER_SEGMENT_DELAY_MS = 500; // Delay between segments

// =============================================================================
// HALLUCINATION PATTERNS
// =============================================================================

const HALLUCINATION_PATTERNS = {
  // Non-English languages (Whisper often hallucinates in other languages)
  german: /\b(wieder|und|oder|nicht|aber|danke|bitte|ja|nein|gut|sehr|ich|sie|wir|das|ist|haben|werden|kann|muss|soll)\b/gi,
  spanish: /\b(hablando|como|pero|para|gracias|bueno|entonces|porque|tambien|esta|este|una|los|las|del|por|con|sin|sobre)\b/gi,
  french: /\b(merci|bonjour|alors|peut|tres|bien|donc|mais|avec|pour|dans|cette|sont|nous|vous|leur|faire|etre)\b/gi,
  portuguese: /\b(obrigado|muito|entao|porque|ainda|agora|mais|isso|esse|esta|voce|nao|sim|com|por|para)\b/gi,
  italian: /\b(grazie|molto|allora|perche|ancora|adesso|questo|quello|sono|siamo|hanno|fare|essere|potere)\b/gi,
  dutch: /\b(bedankt|heel|omdat|nog|steeds|dit|dat|zijn|hebben|worden|kunnen|moeten|zullen)\b/gi,

  // CJK and other scripts
  cjk: /[\u4e00-\u9fff\u3400-\u4dbf\uac00-\ud7af\u3040-\u309f\u30a0-\u30ff]/g,
  arabic: /[\u0600-\u06ff\u0750-\u077f]/g,
  cyrillic: /[\u0400-\u04ff]/g,
  hebrew: /[\u0590-\u05ff]/g,
  thai: /[\u0e00-\u0e7f]/g,
  devanagari: /[\u0900-\u097f]/g,

  // Common Whisper artifacts
  youtubeEndings: /\b(thank\s*you\s*(for\s*)?(watching|listening|viewing)|please\s*(like|subscribe|share)|don'?t\s*forget\s*to\s*subscribe)\b/gi,
  podcastArtifacts: /\b(this\s*episode|brought\s*to\s*you\s*by|sponsored\s*by|our\s*sponsor)\b/gi,
  subtitleArtifacts: /\b(subtitles?\s*by|captions?\s*by|transcribed?\s*by)\b/gi,

  // Garbage patterns
  repeatedPunctuation: /[,."'\s]{5,}/g,
  manyEllipses: /\.{4,}/g,
  placeholder: /\b(XXX+|___+|\*\*\*+)\b/gi,

  // Sound descriptions that shouldn't appear in speech
  soundDescriptions: /\[(music|applause|laughter|silence|inaudible|crosstalk)\]/gi,
};

const STRIP_START_PATTERNS = [
  /^(ielts\s+)?speaking\s+test\.?\s*(interview)?\.?\s*/gi,
  /^welcome\s+to\s+(the\s+)?(ielts\s+)?speaking\s+test\.?\s*/gi,
  /^this\s+is\s+(an?\s+)?ielts\s+speaking\.?\s*/gi,
  /^okay\.?\s+so\.?\s*/gi,
];

const STRIP_END_PATTERNS = [
  /\s*thank\s*you\.?\s*$/gi,
  /\s*thanks\.?\s*$/gi,
  /\s*bye\.?\s*$/gi,
  /\s*goodbye\.?\s*$/gi,
  /\s*\.{3,}\s*$/g,
];

// =============================================================================
// INTERFACES
// =============================================================================

interface WhisperResponse {
  text: string;
  segments?: Array<{
    text: string;
    start: number;
    end: number;
    no_speech_prob?: number;
    avg_logprob?: number;
  }>;
  duration?: number;
  language?: string;
}

interface DualWhisperResult {
  finalText: string;
  confidence: 'high' | 'medium' | 'low' | 'very-low';
  method: 'consensus' | 'v3-selected' | 'turbo-selected' | 'merged' | 'single-fallback';
  v3Text: string | null;
  turboText: string | null;
  agreementScore: number;
  duration: number;
  issues: string[];
  wordCount: number;
}

interface SegmentTranscription {
  segmentKey: string;
  partNumber: number;
  questionNumber: number;
  text: string;
  duration: number;
  wordCount: number;
  confidence: string;
  method: string;
  agreementScore: number;
  issues: string[];
}

// =============================================================================
// WHISPER API CALLS
// =============================================================================

async function callWhisperAPI(
  audioBlob: Blob,
  apiKey: string,
  model: string,
  retryCount = 0
): Promise<WhisperResponse | null> {
  const MAX_RETRIES = 2;

  try {
    const fileExtension = audioBlob.type.includes('mp3') || audioBlob.type.includes('mpeg')
      ? 'mp3'
      : audioBlob.type.includes('wav')
        ? 'wav'
        : 'webm';

    const prompt = `Verbatim English transcription of an IELTS speaking test response.
Rules:
- Transcribe EXACTLY what is spoken, word for word
- Include filler words: um, uh, er, like, you know, I mean
- Include false starts and self-corrections
- Silence or noise = NO text output
- Do NOT add any words that weren't spoken
- Do NOT translate or interpret
- English language ONLY`;

    const formData = new FormData();
    formData.append('file', audioBlob, `audio.${fileExtension}`);
    formData.append('model', model);
    formData.append('response_format', 'verbose_json');
    formData.append('language', 'en');
    formData.append('temperature', '0');
    formData.append('prompt', prompt);

    const response = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.warn(`[DualWhisper] ${model} HTTP ${response.status}: ${errorText.slice(0, 200)}`);

      // Retry on 5xx errors
      if (response.status >= 500 && retryCount < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 1000 * (retryCount + 1)));
        return callWhisperAPI(audioBlob, apiKey, model, retryCount + 1);
      }
      return null;
    }

    const result = await response.json();
    return result;
  } catch (err) {
    console.warn(`[DualWhisper] ${model} exception:`, err);
    if (retryCount < MAX_RETRIES) {
      await new Promise(r => setTimeout(r, 1000 * (retryCount + 1)));
      return callWhisperAPI(audioBlob, apiKey, model, retryCount + 1);
    }
    return null;
  }
}

// =============================================================================
// VALIDATION & CLEANING FUNCTIONS
// =============================================================================

function detectHallucinations(text: string): string[] {
  const detected: string[] = [];

  for (const [name, pattern] of Object.entries(HALLUCINATION_PATTERNS)) {
    if (pattern.test(text)) {
      detected.push(name);
      pattern.lastIndex = 0;
    }
  }

  return detected;
}

function hasDuplication(text: string): boolean {
  const words = text.toLowerCase().split(/\s+/).filter(w => w.length > 1);
  if (words.length < 16) return false;

  // Check if second half significantly overlaps with first half
  const halfLen = Math.floor(words.length / 2);
  const firstHalf = words.slice(0, halfLen);
  const secondHalf = words.slice(halfLen);

  const firstSet = new Set(firstHalf);
  const overlapCount = secondHalf.filter(w => firstSet.has(w)).length;
  const overlapRatio = overlapCount / halfLen;

  // Check for exact phrase repetition
  const quarterLen = Math.floor(words.length / 4);
  if (quarterLen >= 4) {
    const firstQuarter = words.slice(0, quarterLen).join(' ');
    const rest = words.slice(quarterLen).join(' ');
    if (rest.includes(firstQuarter)) {
      return true;
    }
  }

  return overlapRatio > 0.65;
}

function removeDuplication(text: string): string {
  const words = text.split(/\s+/);
  if (words.length < 16) return text;

  const halfLen = Math.floor(words.length / 2);

  // Check various split points
  for (let splitPoint = halfLen; splitPoint >= Math.floor(words.length * 0.4); splitPoint--) {
    const firstPart = words.slice(0, splitPoint).join(' ').toLowerCase();
    const secondPart = words.slice(splitPoint).join(' ').toLowerCase();

    const firstWords = firstPart.split(/\s+/).slice(0, 5).join(' ');
    if (secondPart.startsWith(firstWords) || secondPart.includes(firstWords)) {
      console.log(`[DualWhisper] Removed duplication at word ${splitPoint}`);
      return words.slice(0, splitPoint).join(' ');
    }
  }

  if (hasDuplication(text)) {
    return words.slice(0, halfLen).join(' ');
  }

  return text;
}

function cleanTranscript(text: string): string {
  let cleaned = text;

  // Remove start patterns
  for (const pattern of STRIP_START_PATTERNS) {
    cleaned = cleaned.replace(pattern, '');
  }

  // Remove end patterns
  for (const pattern of STRIP_END_PATTERNS) {
    cleaned = cleaned.replace(pattern, '');
  }

  // Remove garbage
  cleaned = cleaned.replace(HALLUCINATION_PATTERNS.repeatedPunctuation, ' ');
  cleaned = cleaned.replace(HALLUCINATION_PATTERNS.manyEllipses, '...');
  cleaned = cleaned.replace(HALLUCINATION_PATTERNS.placeholder, '[unclear]');
  cleaned = cleaned.replace(HALLUCINATION_PATTERNS.soundDescriptions, '');

  // Remove non-English text
  const nonEnglishPatterns = [
    HALLUCINATION_PATTERNS.german,
    HALLUCINATION_PATTERNS.spanish,
    HALLUCINATION_PATTERNS.french,
    HALLUCINATION_PATTERNS.portuguese,
    HALLUCINATION_PATTERNS.italian,
    HALLUCINATION_PATTERNS.dutch,
    HALLUCINATION_PATTERNS.cjk,
    HALLUCINATION_PATTERNS.arabic,
    HALLUCINATION_PATTERNS.cyrillic,
    HALLUCINATION_PATTERNS.hebrew,
    HALLUCINATION_PATTERNS.thai,
    HALLUCINATION_PATTERNS.devanagari,
  ];

  for (const pattern of nonEnglishPatterns) {
    cleaned = cleaned.replace(pattern, '');
  }

  // Remove YouTube/podcast artifacts
  cleaned = cleaned.replace(HALLUCINATION_PATTERNS.youtubeEndings, '');
  cleaned = cleaned.replace(HALLUCINATION_PATTERNS.podcastArtifacts, '');
  cleaned = cleaned.replace(HALLUCINATION_PATTERNS.subtitleArtifacts, '');

  // Remove duplication
  cleaned = removeDuplication(cleaned);

  // Normalize whitespace
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  return cleaned;
}

function validateWordCount(text: string, audioDurationSeconds: number): { isValid: boolean; issue: string | null } {
  const words = text.split(/\s+/).filter(w => w.length > 0);
  const wordCount = words.length;

  // Expected words based on speaking rate (60-200 WPM for IELTS)
  const minExpectedWords = Math.floor(audioDurationSeconds * 1.0); // 60 WPM
  const maxExpectedWords = Math.ceil(audioDurationSeconds * 3.5);   // 210 WPM

  if (wordCount < minExpectedWords * 0.3) {
    return { isValid: false, issue: `Very few words (${wordCount}) for ${audioDurationSeconds.toFixed(1)}s audio` };
  }

  if (wordCount > maxExpectedWords * 1.5) {
    return { isValid: false, issue: `Too many words (${wordCount}) for ${audioDurationSeconds.toFixed(1)}s - likely hallucination` };
  }

  return { isValid: true, issue: null };
}

// =============================================================================
// AGREEMENT CALCULATION (LCS-based)
// =============================================================================

function longestCommonSubsequence(arr1: string[], arr2: string[]): number {
  const m = arr1.length;
  const n = arr2.length;

  const dp: number[] = new Array(n + 1).fill(0);

  for (let i = 1; i <= m; i++) {
    let prev = 0;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      if (arr1[i - 1] === arr2[j - 1]) {
        dp[j] = prev + 1;
      } else {
        dp[j] = Math.max(dp[j], dp[j - 1]);
      }
      prev = temp;
    }
  }

  return dp[n];
}

function calculateAgreement(text1: string, text2: string): number {
  const words1 = text1.toLowerCase().split(/\s+/).filter(w => w.length > 1);
  const words2 = text2.toLowerCase().split(/\s+/).filter(w => w.length > 1);

  if (words1.length === 0 && words2.length === 0) return 1;
  if (words1.length === 0 || words2.length === 0) return 0;

  const lcs = longestCommonSubsequence(words1, words2);
  return lcs / Math.max(words1.length, words2.length);
}

// =============================================================================
// DUAL-WHISPER MERGE LOGIC
// =============================================================================

async function dualWhisperTranscribe(
  audioBlob: Blob,
  apiKey: string,
  segmentKey: string
): Promise<DualWhisperResult> {
  const issues: string[] = [];
  let duration = 0;

  // Call both models in parallel
  console.log(`[DualWhisper] ${segmentKey}: Calling both models in parallel...`);

  const [v3Result, turboResult] = await Promise.all([
    callWhisperAPI(audioBlob, apiKey, WHISPER_V3),
    callWhisperAPI(audioBlob, apiKey, WHISPER_TURBO),
  ]);

  const v3Text = v3Result?.text ? cleanTranscript(v3Result.text) : null;
  const turboText = turboResult?.text ? cleanTranscript(turboResult.text) : null;
  duration = v3Result?.duration || turboResult?.duration || 0;

  console.log(`[DualWhisper] ${segmentKey}: v3="${v3Text?.slice(0, 50)}...", turbo="${turboText?.slice(0, 50)}..."`);

  // Handle cases where one or both failed
  if (!v3Text && !turboText) {
    console.warn(`[DualWhisper] ${segmentKey}: Both models returned empty`);
    return {
      finalText: '',
      confidence: 'very-low',
      method: 'single-fallback',
      v3Text: null,
      turboText: null,
      agreementScore: 0,
      duration,
      issues: ['Both Whisper models failed'],
      wordCount: 0,
    };
  }

  if (!v3Text || v3Text.length < 3) {
    console.log(`[DualWhisper] ${segmentKey}: v3 failed, using turbo`);
    issues.push('v3 model failed, using turbo only');
    const wordCount = turboText?.split(/\s+/).filter(w => w.length > 0).length || 0;
    return {
      finalText: turboText || '',
      confidence: 'low',
      method: 'single-fallback',
      v3Text: null,
      turboText,
      agreementScore: 0,
      duration,
      issues,
      wordCount,
    };
  }

  if (!turboText || turboText.length < 3) {
    console.log(`[DualWhisper] ${segmentKey}: turbo failed, using v3`);
    issues.push('turbo model failed, using v3 only');
    const wordCount = v3Text.split(/\s+/).filter(w => w.length > 0).length;
    return {
      finalText: v3Text,
      confidence: 'low',
      method: 'single-fallback',
      v3Text,
      turboText: null,
      agreementScore: 0,
      duration,
      issues,
      wordCount,
    };
  }

  // Check for hallucinations in each
  const v3Hallucinations = detectHallucinations(v3Text);
  const turboHallucinations = detectHallucinations(turboText);

  if (v3Hallucinations.length > 0) {
    issues.push(`v3 hallucinations: ${v3Hallucinations.join(', ')}`);
  }
  if (turboHallucinations.length > 0) {
    issues.push(`turbo hallucinations: ${turboHallucinations.join(', ')}`);
  }

  // Word count validation
  const v3WordValidation = validateWordCount(v3Text, duration);
  const turboWordValidation = validateWordCount(turboText, duration);

  if (!v3WordValidation.isValid) {
    issues.push(`v3: ${v3WordValidation.issue}`);
  }
  if (!turboWordValidation.isValid) {
    issues.push(`turbo: ${turboWordValidation.issue}`);
  }

  // Calculate agreement
  const agreementScore = calculateAgreement(v3Text, turboText);
  console.log(`[DualWhisper] ${segmentKey}: Agreement score: ${(agreementScore * 100).toFixed(1)}%`);

  // Decision logic
  let finalText: string;
  let confidence: 'high' | 'medium' | 'low' | 'very-low';
  let method: DualWhisperResult['method'];

  // HIGH AGREEMENT (>80%): Use consensus
  if (agreementScore >= 0.8) {
    // Texts are very similar - prefer turbo (fewer hallucinations) if lengths are similar
    finalText = turboText.length >= v3Text.length * 0.9 ? turboText : v3Text;
    confidence = 'high';
    method = 'consensus';
    console.log(`[DualWhisper] ${segmentKey}: HIGH consensus (${(agreementScore * 100).toFixed(1)}%)`);
  }
  // MEDIUM AGREEMENT (50-80%): Evaluate quality
  else if (agreementScore >= 0.5) {
    // Prefer the one with fewer issues
    const v3Score = (v3Hallucinations.length === 0 ? 1 : 0) + (v3WordValidation.isValid ? 1 : 0);
    const turboScore = (turboHallucinations.length === 0 ? 1 : 0) + (turboWordValidation.isValid ? 1 : 0);

    if (turboScore > v3Score) {
      finalText = turboText;
      method = 'turbo-selected';
    } else if (v3Score > turboScore) {
      finalText = v3Text;
      method = 'v3-selected';
    } else {
      // Equal scores - prefer turbo for noise robustness
      finalText = turboText;
      method = 'turbo-selected';
    }
    confidence = 'medium';
    console.log(`[DualWhisper] ${segmentKey}: MEDIUM agreement, selected ${method}`);
  }
  // LOW AGREEMENT (<50%): One is likely wrong
  else {
    // Major disagreement - check which one is more valid
    const v3Valid = v3Hallucinations.length === 0 && v3WordValidation.isValid;
    const turboValid = turboHallucinations.length === 0 && turboWordValidation.isValid;

    if (turboValid && !v3Valid) {
      finalText = turboText;
      method = 'turbo-selected';
    } else if (v3Valid && !turboValid) {
      finalText = v3Text;
      method = 'v3-selected';
    } else {
      // Neither is clearly better - prefer shorter one (less hallucination)
      finalText = v3Text.length <= turboText.length ? v3Text : turboText;
      method = v3Text.length <= turboText.length ? 'v3-selected' : 'turbo-selected';
      issues.push('Low agreement, used shorter transcript');
    }
    confidence = 'low';
    console.log(`[DualWhisper] ${segmentKey}: LOW agreement (${(agreementScore * 100).toFixed(1)}%), selected ${method}`);
  }

  const wordCount = finalText.split(/\s+/).filter(w => w.length > 0).length;

  return {
    finalText,
    confidence,
    method,
    v3Text,
    turboText,
    agreementScore,
    duration,
    issues,
    wordCount,
  };
}

// =============================================================================
// MAIN HANDLER
// =============================================================================

serve(async (req) => {
  console.log(`[groq-speaking-transcribe] Request at ${new Date().toISOString()}`);

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabaseService = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const { jobId } = await req.json();

    if (!jobId) {
      return new Response(JSON.stringify({ error: 'Missing jobId' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`[groq-speaking-transcribe] Processing job ${jobId}`);

    // Fetch job details
    const { data: job, error: jobError } = await supabaseService
      .from('speaking_evaluation_jobs')
      .select('*')
      .eq('id', jobId)
      .single();

    if (jobError || !job) {
      console.error(`[groq-speaking-transcribe] Job not found:`, jobError);
      return new Response(JSON.stringify({ error: 'Job not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Build question ID mapping
    const { data: testRow } = await supabaseService
      .from('ai_practice_tests')
      .select('payload')
      .eq('id', job.test_id)
      .maybeSingle();

    const payload = (testRow as any)?.payload;
    const questionIdToNumber = buildQuestionIdToNumberMap(payload);

    // Update job status
    await supabaseService
      .from('speaking_evaluation_jobs')
      .update({
        status: 'processing',
        stage: 'transcribing',
        heartbeat_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', jobId);

    // Get Groq API key
    const { data: keyData, error: keyError } = await supabaseService.rpc('checkout_groq_key_for_stt', {
      p_job_id: String(jobId),
      p_lock_duration_seconds: 600, // 10 min for dual-model calls
      p_part_number: 1,
    });

    if (keyError || !keyData || keyData.length === 0) {
      console.error(`[groq-speaking-transcribe] No Groq keys available:`, keyError);
      throw new Error('No Groq API keys available for STT');
    }

    const groqKey = keyData[0];
    const groqApiKey = groqKey.out_key_value;
    const groqKeyId = groqKey.out_key_id;

    console.log(`[groq-speaking-transcribe] Using Groq key ${groqKeyId?.slice(0, 8)}...`);

    await supabaseService
      .from('speaking_evaluation_jobs')
      .update({ groq_stt_key_id: groqKeyId })
      .eq('id', jobId);

    // Process segments
    const filePaths = job.file_paths as Record<string, string>;
    const segments = Object.entries(filePaths);
    const transcriptions: SegmentTranscription[] = [];
    let totalAudioSeconds = 0;

    console.log(`[groq-speaking-transcribe] Processing ${segments.length} segments with Dual-Whisper engine`);

    for (let i = 0; i < segments.length; i++) {
      const [segmentKey, filePath] = segments[i];

      // Inter-segment delay
      if (i > 0) {
        await new Promise(resolve => setTimeout(resolve, INTER_SEGMENT_DELAY_MS));
      }

      // Update heartbeat
      await supabaseService
        .from('speaking_evaluation_jobs')
        .update({ heartbeat_at: new Date().toISOString() })
        .eq('id', jobId);

      console.log(`[groq-speaking-transcribe] Processing segment ${i + 1}/${segments.length}: ${segmentKey}`);

      try {
        // Parse segment key
        const partMatch = segmentKey.match(/part(\d+)/i) || segmentKey.match(/^(\d+)-/);
        const partNumber = partMatch ? parseInt(partMatch[1]) : 1;

        const qUuidMatch = segmentKey.match(/q([0-9a-f\-]{8,})/i);
        const qUuid = qUuidMatch?.[1];
        const mappedQuestionNumber = qUuid ? questionIdToNumber[qUuid] : undefined;

        const qNumMatch = segmentKey.match(/q(\d+)\b/i) || segmentKey.match(/-(\d+)$/);
        const parsedQuestionNumber = qNumMatch ? parseInt(qNumMatch[1]) : 1;
        const questionNumber = typeof mappedQuestionNumber === 'number' ? mappedQuestionNumber : parsedQuestionNumber;

        // Download audio from R2
        const audioBlob = await downloadFromR2(filePath);

        if (!audioBlob) {
          console.error(`[groq-speaking-transcribe] Failed to download audio: ${filePath}`);
          continue;
        }

        // Run Dual-Whisper transcription
        const result = await dualWhisperTranscribe(audioBlob, groqApiKey, segmentKey);

        transcriptions.push({
          segmentKey,
          partNumber,
          questionNumber,
          text: result.finalText,
          duration: result.duration,
          wordCount: result.wordCount,
          confidence: result.confidence,
          method: result.method,
          agreementScore: result.agreementScore,
          issues: result.issues,
        });

        totalAudioSeconds += result.duration;

        console.log(`[groq-speaking-transcribe] ${segmentKey}: ${result.wordCount} words, ${result.confidence} confidence, method=${result.method}`);

      } catch (segmentError: any) {
        console.error(`[groq-speaking-transcribe] Segment ${segmentKey} error:`, segmentError.message);

        if (segmentError.message?.includes('429') || segmentError.message?.includes('rate limit')) {
          await supabaseService.rpc('mark_groq_key_rpm_limited', {
            p_key_id: groqKeyId,
            p_cooldown_seconds: 60,
          });
          throw new Error('RATE_LIMIT: Groq RPM limit hit');
        }
      }
    }

    // Record ASH usage
    if (totalAudioSeconds > 0) {
      // Multiply by 2 since we use both models
      await supabaseService.rpc('record_groq_ash_usage', {
        p_key_id: groqKeyId,
        p_audio_seconds: Math.ceil(totalAudioSeconds * 2),
      });
      console.log(`[groq-speaking-transcribe] Recorded ${Math.ceil(totalAudioSeconds * 2)}s ASH usage (2x for dual-model)`);
    }

    // Store results
    const transcriptionResult = {
      transcriptions,
      totalAudioSeconds,
      segmentCount: transcriptions.length,
      pipelineVersion: 'dual-whisper-2.0',
      processedAt: new Date().toISOString(),
    };

    await supabaseService
      .from('speaking_evaluation_jobs')
      .update({
        transcription_result: transcriptionResult,
        stage: 'pending_groq_eval',
        status: 'pending',
        heartbeat_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', jobId);

    console.log(`[groq-speaking-transcribe] Transcription complete. ${transcriptions.length} segments, ${totalAudioSeconds.toFixed(1)}s audio`);

    // Trigger evaluation
    const evalUrl = `${supabaseUrl}/functions/v1/groq-speaking-evaluate`;
    fetch(evalUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${supabaseServiceKey}`,
      },
      body: JSON.stringify({ jobId }),
    }).catch(err => {
      console.error('[groq-speaking-transcribe] Failed to trigger evaluate:', err);
    });

    return new Response(JSON.stringify({
      success: true,
      segmentsTranscribed: transcriptions.length,
      totalAudioSeconds,
      pipelineVersion: 'dual-whisper-2.0',
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
    console.error('[groq-speaking-transcribe] Error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function buildQuestionIdToNumberMap(payload: any): Record<string, number> {
  const map: Record<string, number> = {};
  const parts = Array.isArray(payload?.speakingParts) ? payload.speakingParts : [];
  for (const p of parts) {
    const questions = Array.isArray(p?.questions) ? p.questions : [];
    for (const q of questions) {
      const idRaw = typeof q?.id === 'string' ? q.id : null;
      const n = typeof q?.question_number === 'number' ? q.question_number : Number(q?.question_number);
      const id = idRaw ? idRaw.replace(/^q/i, '') : null;
      if (id && Number.isFinite(n)) map[id] = n;
    }
  }
  return map;
}

async function downloadFromR2(filePath: string): Promise<Blob | null> {
  try {
    console.log(`[groq-speaking-transcribe] Downloading from R2: ${filePath}`);

    const result = await getFromR2(filePath);

    if (!result.success || !result.bytes) {
      console.error(`[groq-speaking-transcribe] R2 download error:`, result.error);
      return null;
    }

    const arrayBuffer = result.bytes.slice().buffer as ArrayBuffer;
    const blob = new Blob([arrayBuffer], { type: result.contentType || 'audio/mpeg' });
    console.log(`[groq-speaking-transcribe] Downloaded ${result.bytes.length} bytes`);
    return blob;
  } catch (err: any) {
    console.error(`[groq-speaking-transcribe] Download exception:`, err.message);
    return null;
  }
}
