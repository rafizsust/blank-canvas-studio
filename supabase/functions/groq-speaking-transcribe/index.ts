import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getFromR2 } from "../_shared/r2Client.ts";

/**
 * Groq Speaking Transcribe
 * 
 * Step 1 of Groq evaluation pipeline:
 * - Downloads audio segments from R2
 * - Calls Groq Whisper API with verbose_json for rich metadata
 * - Stores transcription with word-level timestamps and confidence
 * 
 * Features:
 * - Filler word detection via prompt engineering
 * - Word-level timestamps for pause analysis
 * - Confidence scores for pronunciation estimation
 * - NO_SPEECH detection to filter out silent gaps / hallucinations
 * - Optimized timing: 1s delay (safe for up to 60 requests/min, Groq allows 20 RPM)
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Groq API endpoint
const GROQ_API_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';

// Inter-segment delay (ms) - reduced from 3000ms since we typically have <12 segments
// and Groq free tier allows 20 RPM. 1 second delay = 60 req/min max, well under limit.
const INTER_SEGMENT_DELAY_MS = 1000;

// Threshold for no_speech_prob above which we consider the segment silent
// Lowered from 0.8 to 0.5 to catch more Whisper hallucinations
const NO_SPEECH_THRESHOLD = 0.5;

// Compression ratio above which segments are likely hallucinations
const COMPRESSION_RATIO_THRESHOLD = 2.4;

// Threshold for filtering words that appear after long gaps with low confidence
// Words after 2+ second gaps with confidence < this are likely hallucinations
const POST_GAP_CONFIDENCE_THRESHOLD = 0.6;
const GAP_DURATION_THRESHOLD = 2.0; // seconds

// Hallucination patterns - known Whisper/Distil-Whisper artifacts
const HALLUCINATION_PATTERNS = [
  /[가-힣]/g,              // Korean characters
  /[ぁ-んァ-ン]/g,          // Japanese hiragana/katakana
  /[一-龯]/g,              // Chinese characters
  /[ก-๙]/g,               // Thai characters
  /[а-яА-ЯёЁ]/g,          // Cyrillic
  /[؀-ۿ]/g,               // Arabic
  /thank\s?you\.?\s*$/gi,  // Common hallucination endings
  /thanks\s+for\s+watching/gi,
  /goodbye\.?\s*$/gi,
  /bye\.?\s*$/gi,
  /see\s+(?:the\s+)?following/gi,
  /please\s+subscribe/gi,
  /like\s+and\s+subscribe/gi,
  /\b(Melanie|publication|assembled|member|amara\.org|subtitles|captions)\b/gi,  // Known Whisper artifacts
  /^\s*\.\s*$/g,           // Just a period (common silence hallucination)
  /^\s*,\s*$/g,            // Just a comma
];

// Additional phrases to strip from end of transcripts - ONLY obvious hallucinations
// CONSERVATIVE: Only remove phrases that are clearly NOT part of valid IELTS responses
// Do NOT remove common words like "okay", "yeah", "so" which are valid speech
const HALLUCINATION_END_PHRASES = [
  /\s*thank\s*you\s+for\s+(watching|listening)\.?\s*$/gi,  // YouTube-style endings
  /\s*please\s+(subscribe|like)\.?\s*$/gi,
  /\s*like\s+and\s+subscribe\.?\s*$/gi,
  /\s*goodbye\.?\s*$/gi,  // Only "goodbye" not other common words
  /\s*[.]{3,}\s*$/g,  // Trailing ellipsis artifacts
];

// Leading hallucination phrases Whisper injects at the start (from context prompt bleed)
// CONSERVATIVE: Only remove obvious Whisper artifacts, not natural speech starters
const HALLUCINATION_START_PHRASES = [
  /^ielts\s+speaking\s+test\.?\s*interview\.?\s*/gi,
  /^ielts\s+speaking\s+test\.?\s*/gi,
  /^welcome\s+to\s+the\s+ielts\s+speaking\s+test\.?\s*/gi,
  /^this\s+is\s+an?\s+ielts\s+speaking\.?\s*/gi,
];

// ============================================================================
// CONSERVATIVE TRAILING HALLUCINATION DETECTION
// ============================================================================
// This addresses trailing hallucinations WITHOUT being overly aggressive.
// Key principle: PRESERVE VALID SPEECH. Only remove content that is CLEARLY
// beyond the audio duration or matches known hallucination patterns.
//
// We prioritize keeping user speech over aggressively filtering.
// ============================================================================

const TRAILING_HALLUCINATION_BUFFER_SECONDS = 1.0; // Allow 1s grace period

/**
 * CONSERVATIVE filter: Only removes words that CLEARLY extend beyond audio.
 * Words within (audioDuration + buffer) are PRESERVED.
 */
function filterTrailingHallucinationsByDuration(
  words: WhisperWord[], 
  audioDurationSeconds: number
): WhisperWord[] {
  if (words.length === 0 || audioDurationSeconds <= 0) return words;
  
  // Only filter words that end CLEARLY after the audio (with generous buffer)
  const maxValidEndTime = audioDurationSeconds + TRAILING_HALLUCINATION_BUFFER_SECONDS;
  
  const filtered = words.filter((word) => {
    // Word ends clearly beyond audio duration - definitely hallucination
    if (word.end > maxValidEndTime) {
      console.log(`[groq-speaking-transcribe] Filtering word beyond audio (end=${word.end.toFixed(2)}s, max=${maxValidEndTime.toFixed(2)}s): "${word.word}"`);
      return false;
    }
    return true;
  });
  
  return filtered;
}

/**
 * DISABLED: This function was too aggressive and removing valid speech.
 * Only keeps the timestamp-based filter above which is reliable.
 * 
 * The previous implementation incorrectly flagged content ending after 85%
 * of audio duration as "suspicious" - this is wrong because speech can
 * naturally continue until the very end of the audio.
 */
function filterTrailingSentenceHallucinations(
  text: string,
  words: WhisperWord[],
  _audioDurationSeconds: number
): { text: string; words: WhisperWord[] } {
  // NO-OP: Return input unchanged. The duration-based filter above
  // handles true trailing hallucinations (words beyond audio end).
  // This function was causing empty transcripts by being too aggressive.
  return { text, words };
}

// Check if text contains hallucination patterns
function containsHallucinationPatterns(text: string): boolean {
  return HALLUCINATION_PATTERNS.some(pattern => pattern.test(text));
}

/**
 * Filters out words that appear after long gaps (2+ seconds) with low confidence.
 * These are typically Whisper hallucinations that occur during silence.
 */
function filterGapHallucinations(words: WhisperWord[]): WhisperWord[] {
  if (words.length === 0) return words;
  
  const filtered: WhisperWord[] = [];
  let lastValidEnd = 0;
  
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const prob = typeof word.probability === 'number' ? word.probability : 0;
    
    // First word is always included (unless it's extremely low confidence)
    if (i === 0) {
      if (prob >= 0.3) {
        filtered.push(word);
        lastValidEnd = word.end;
      } else {
        console.log(`[groq-speaking-transcribe] Filtering first word (conf=${prob.toFixed(2)}): "${word.word}"`);
      }
      continue;
    }
    
    // Calculate gap from last valid word
    const gap = word.start - lastValidEnd;
    
    // If gap > 2s and confidence is low, this is likely a hallucination
    if (gap > GAP_DURATION_THRESHOLD && prob < POST_GAP_CONFIDENCE_THRESHOLD) {
      console.log(`[groq-speaking-transcribe] Filtering post-gap hallucination (gap=${gap.toFixed(1)}s, conf=${prob.toFixed(2)}): "${word.word}"`);
      continue;
    }
    
    // Check for common hallucination words after gaps
    if (gap > GAP_DURATION_THRESHOLD) {
      const lowerWord = word.word.toLowerCase().trim();
      const hallucinationWords = ['thanks', 'thank', 'you', 'bye', 'goodbye', 'subscribe', 'like'];
      if (hallucinationWords.some(h => lowerWord.includes(h))) {
        console.log(`[groq-speaking-transcribe] Filtering common hallucination after gap: "${word.word}"`);
        continue;
      }
    }
    
    filtered.push(word);
    lastValidEnd = word.end;
  }
  
  return filtered;
}

interface WhisperWord {
  word: string;
  start: number;
  end: number;
  probability: number;
}

interface WhisperSegment {
  id: number;
  text: string;
  start: number;
  end: number;
  avg_logprob: number;
  no_speech_prob: number;
  compression_ratio: number;
  words?: WhisperWord[];
}

interface WhisperResponse {
  text: string;
  segments: WhisperSegment[];
  language: string;
  duration: number;
  words?: WhisperWord[];
}

interface SegmentTranscription {
  segmentKey: string;
  partNumber: number;
  questionNumber: number;
  text: string;
  duration: number;
  segments: WhisperSegment[];
  words: WhisperWord[];
  avgConfidence: number;
  avgLogprob: number;
  fillerWords: string[];
  longPauses: { start: number; end: number; duration: number }[];
  wordCount: number;
  noSpeechProb: number;
}

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

    // Fetch AI practice test payload so we can correctly map segment keys (which may contain question UUIDs)
    // to human question numbers/text.
    const { data: testRow, error: testError } = await supabaseService
      .from('ai_practice_tests')
      .select('payload')
      .eq('id', job.test_id)
      .maybeSingle();

    if (testError) {
      console.warn('[groq-speaking-transcribe] Failed to load ai_practice_tests payload for mapping:', testError);
    }

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

    // Get Groq API key - use TEXT-based function signature
    const { data: keyData, error: keyError } = await supabaseService.rpc('checkout_groq_key_for_stt', {
      p_job_id: String(jobId),
      p_lock_duration_seconds: 300,
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

    // Update job with STT key used
    await supabaseService
      .from('speaking_evaluation_jobs')
      .update({ groq_stt_key_id: groqKeyId })
      .eq('id', jobId);

    // Get file paths from job
    const filePaths = job.file_paths as Record<string, string>;
    const segments = Object.entries(filePaths);
    
    console.log(`[groq-speaking-transcribe] Transcribing ${segments.length} segments with ${INTER_SEGMENT_DELAY_MS}ms delay`);

    const transcriptions: SegmentTranscription[] = [];
    let totalAudioSeconds = 0;

    // Process each audio segment
    for (let i = 0; i < segments.length; i++) {
      const [segmentKey, filePath] = segments[i];
      
      // Add inter-segment delay (except for first segment)
      if (i > 0) {
        console.log(`[groq-speaking-transcribe] Inter-segment delay: ${INTER_SEGMENT_DELAY_MS}ms`);
        await new Promise(resolve => setTimeout(resolve, INTER_SEGMENT_DELAY_MS));
      }

      // Update heartbeat
      await supabaseService
        .from('speaking_evaluation_jobs')
        .update({ heartbeat_at: new Date().toISOString() })
        .eq('id', jobId);

      console.log(`[groq-speaking-transcribe] Processing segment ${i + 1}/${segments.length}: ${segmentKey}`);

      try {
        // Parse segment key.
        // We support keys like:
        // - part2-q<uuid>
        // - part2-q1
        // - 2-1
        const partMatch = segmentKey.match(/part(\d+)/i) || segmentKey.match(/^(\d+)-/);
        const partNumber = partMatch ? parseInt(partMatch[1]) : 1;

        // Prefer UUID-based mapping when available.
        const qUuidMatch = segmentKey.match(/q([0-9a-f\-]{8,})/i);
        const qUuid = qUuidMatch?.[1];

        const mappedQuestionNumber = qUuid ? questionIdToNumber[qUuid] : undefined;

        // Fallback to numeric parsing.
        const qNumMatch = segmentKey.match(/q(\d+)\b/i) || segmentKey.match(/-(\d+)$/);
        const parsedQuestionNumber = qNumMatch ? parseInt(qNumMatch[1]) : 1;

        const questionNumber = typeof mappedQuestionNumber === 'number' ? mappedQuestionNumber : parsedQuestionNumber;

        // Download audio from R2
        const audioBlob = await downloadFromR2(filePath, supabaseService);
        
        if (!audioBlob) {
          console.error(`[groq-speaking-transcribe] Failed to download audio: ${filePath}`);
          continue;
        }

        // Call Groq Whisper API
        const transcription = await transcribeWithWhisper(
          audioBlob,
          groqApiKey,
          segmentKey,
          partNumber,
          questionNumber
        );

        if (transcription) {
          transcriptions.push(transcription);
          totalAudioSeconds += transcription.duration;
        }

      } catch (segmentError: any) {
        console.error(`[groq-speaking-transcribe] Segment ${segmentKey} error:`, segmentError.message);
        
        // Check if it's a rate limit error
        if (segmentError.message?.includes('429') || segmentError.message?.includes('rate limit')) {
          // Mark key as rate limited and try to switch
          await supabaseService.rpc('mark_groq_key_rpm_limited', {
            p_key_id: groqKeyId,
            p_cooldown_seconds: 60,
          });
          throw new Error('RATE_LIMIT: Groq RPM limit hit');
        }
        
        // Continue with other segments
      }
    }

    // Record ASH usage
    if (totalAudioSeconds > 0) {
      await supabaseService.rpc('record_groq_ash_usage', {
        p_key_id: groqKeyId,
        p_audio_seconds: Math.ceil(totalAudioSeconds),
      });
      console.log(`[groq-speaking-transcribe] Recorded ${Math.ceil(totalAudioSeconds)}s ASH usage`);
    }

    // Store transcription results
    const transcriptionResult = {
      transcriptions,
      totalAudioSeconds,
      segmentCount: transcriptions.length,
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

    // Trigger the evaluation step
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
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
    console.error('[groq-speaking-transcribe] Error:', error);

    // Note: We can't re-parse req.json() here as it's already consumed.
    // The jobId should be updated within the try block or via job runner watchdog.

    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

function buildQuestionIdToNumberMap(payload: any): Record<string, number> {
  const map: Record<string, number> = {};
  const parts = Array.isArray(payload?.speakingParts) ? payload.speakingParts : [];
  for (const p of parts) {
    const questions = Array.isArray(p?.questions) ? p.questions : [];
    for (const q of questions) {
      const idRaw = typeof q?.id === 'string' ? q.id : null;
      const n = typeof q?.question_number === 'number' ? q.question_number : Number(q?.question_number);
      // IMPORTANT: Some pipelines prefix question ids with "q" (e.g. "q<uuid>") while
      // audio segment keys are typically "...-q<uuid>" and our regex captures only the uuid.
      // Normalize both by stripping a leading "q" so mapping works reliably.
      const id = idRaw ? idRaw.replace(/^q/i, '') : null;
      if (id && Number.isFinite(n)) map[id] = n;
    }
  }
  return map;
}

// ============================================================================
// Helper Functions
// ============================================================================

async function downloadFromR2(
  filePath: string,
  _supabaseService: any
): Promise<Blob | null> {
  try {
    // Download directly from R2 using our shared client
    // The filePath is already the full R2 key (e.g., "speaking-audios/ai-speaking/...")
    console.log(`[groq-speaking-transcribe] Downloading from R2: ${filePath}`);
    
    const result = await getFromR2(filePath);
    
    if (!result.success || !result.bytes) {
      console.error(`[groq-speaking-transcribe] R2 download error:`, result.error);
      return null;
    }

    // Convert Uint8Array to Blob - slice to create a new ArrayBuffer for compatibility
    const arrayBuffer = result.bytes.slice().buffer as ArrayBuffer;
    const blob = new Blob([arrayBuffer], { type: result.contentType || 'audio/mpeg' });
    console.log(`[groq-speaking-transcribe] Downloaded ${result.bytes.length} bytes`);
    return blob;
  } catch (err: any) {
    console.error(`[groq-speaking-transcribe] Download exception:`, err.message);
    return null;
  }
}

async function transcribeWithWhisper(
  audioBlob: Blob,
  apiKey: string,
  segmentKey: string,
  partNumber: number,
  questionNumber: number
): Promise<SegmentTranscription | null> {
  const startTime = Date.now();

  // Prepare form data for Whisper API
  // IMPORTANT: Use proper file extension based on blob type for better Groq handling
  const fileExtension = audioBlob.type.includes('mpeg') || audioBlob.type.includes('mp3') ? 'mp3' : 'webm';
  const formData = new FormData();
  formData.append('file', audioBlob, `audio.${fileExtension}`);
  
  // Use whisper-large-v3-turbo - recommended replacement after distil-whisper deprecation
  // Offers good balance of speed and accuracy with free tier support
  formData.append('model', 'whisper-large-v3-turbo');
  formData.append('response_format', 'verbose_json');
  formData.append('timestamp_granularities[]', 'word');
  formData.append('timestamp_granularities[]', 'segment');
  formData.append('language', 'en');
  formData.append('temperature', '0');  // Reduce randomness to minimize hallucinations
  
  // MINIMAL prompt to avoid Whisper echoing it back into transcripts.
  // We rely on post-processing to strip artifacts instead of injecting context.
  formData.append('prompt', 
    'Transcribe exactly what is spoken. ' +
    'Include filler words: um, uh, like, you know. ' +
    'Silence produces no text. ' +
    'Speech unclear: [INAUDIBLE].'
  );

  const response = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[groq-speaking-transcribe] Whisper API error: ${response.status} - ${errorText}`);
    throw new Error(`Whisper API error: ${response.status} - ${errorText}`);
  }

  const result: WhisperResponse = await response.json();
  const processingTime = Date.now() - startTime;

  console.log(`[groq-speaking-transcribe] ${segmentKey} transcribed in ${processingTime}ms, ${result.duration?.toFixed(1)}s audio`);

  // Calculate average no_speech_prob across all segments
  const avgNoSpeechProb = result.segments?.length > 0
    ? result.segments.reduce((sum, s) => sum + (s.no_speech_prob || 0), 0) / result.segments.length
    : 0;

  // Filter out segments with high no_speech probability, high compression ratio, or hallucination patterns
  // Also apply DYNAMIC threshold for 2-5s silences (more aggressive filtering)
  const filteredSegments = result.segments?.filter(s => {
    const segmentDuration = (s.end || 0) - (s.start || 0);

    // Some Whisper providers omit these fields; treat missing values conservatively.
    const noSpeechProb = typeof s.no_speech_prob === 'number' ? s.no_speech_prob : 0;
    const compressionRatio = typeof s.compression_ratio === 'number' ? s.compression_ratio : 0;
    
    // Dynamic no_speech threshold based on segment duration
    // For 2-5 second segments, use stricter threshold to catch more hallucinations
    let noSpeechThreshold = NO_SPEECH_THRESHOLD;
    if (segmentDuration >= 2 && segmentDuration <= 5) {
      noSpeechThreshold = 0.35; // More strict for 2-5s gaps
      console.log(`[groq-speaking-transcribe] Using strict no_speech threshold (0.35) for ${segmentDuration.toFixed(1)}s segment`);
    }
    
    // Filter by no_speech probability
    if (noSpeechProb > noSpeechThreshold) {
      console.log(`[groq-speaking-transcribe] Filtering segment (no_speech=${noSpeechProb.toFixed(2)}, threshold=${noSpeechThreshold}): "${s.text}"`);
      return false;
    }
    
    // Filter by compression ratio (hallucinations often have high compression)
    if (compressionRatio > COMPRESSION_RATIO_THRESHOLD) {
      console.log(`[groq-speaking-transcribe] Filtering segment (compression=${compressionRatio.toFixed(2)}): "${s.text}"`);
      return false;
    }
    
    // Filter by hallucination patterns (non-English, known artifacts)
    if (containsHallucinationPatterns(s.text)) {
      console.log(`[groq-speaking-transcribe] Filtering segment (hallucination pattern): "${s.text}"`);
      return false;
    }
    
    // Additional check: very short text in longer segments is suspicious
    const wordCount = (s.text?.split(/\s+/) || []).length;
    if (segmentDuration > 3 && wordCount <= 2 && noSpeechProb > 0.2) {
      console.log(`[groq-speaking-transcribe] Filtering suspicious short segment (${wordCount}w in ${segmentDuration.toFixed(1)}s): "${s.text}"`);
      return false;
    }
    
    return true;
  }) || [];

  // Rebuild text from filtered segments
  const filteredText = filteredSegments.map(s => s.text).join(' ').trim();

  // Filter out common hallucination phrases at START and END of audio
  let cleanedText = filteredText;
  
  // Strip leading hallucinations first (e.g., "IELTS speaking test interview.")
  for (const pattern of HALLUCINATION_START_PHRASES) {
    cleanedText = cleanedText.replace(pattern, '');
  }
  
  // Strip trailing hallucinations
  for (const pattern of HALLUCINATION_END_PHRASES) {
    cleanedText = cleanedText.replace(pattern, '');
  }
  cleanedText = cleanedText.trim();

  // If the filtered text is empty or significantly different, log it
  if (cleanedText !== result.text.trim()) {
    console.log(`[groq-speaking-transcribe] Cleaned transcript: "${result.text}" -> "${cleanedText}"`);
  }

  // Extract all words from filtered segments
  // NOTE: Some providers/models do not return word-level timestamps/probabilities
  // inside segments (or at all). Our previous implementation rebuilt the final
  // transcript ONLY from `words`, which caused EMPTY transcripts when `words`
  // is missing.
  let words: WhisperWord[] = filteredSegments.flatMap(s => Array.isArray(s.words) ? s.words : []);

  // Fallback: Some implementations may return words at the root level.
  if (words.length === 0 && Array.isArray((result as any).words)) {
    words = (result as any).words as WhisperWord[];
  }

  // Apply word-gap hallucination filter - removes low-confidence words after 2+ second gaps
  words = filterGapHallucinations(words);

  // Log if words were filtered
  const originalWordCount = filteredSegments.reduce((sum, s) => sum + (s.words?.length || 0), 0);
  if (words.length < originalWordCount) {
    console.log(`[groq-speaking-transcribe] Filtered ${originalWordCount - words.length} post-gap hallucination words`);
  }

  // ============================================================================
  // FINAL TRANSCRIPT TEXT (NEVER EMPTY DUE TO MISSING WORD TIMESTAMPS)
  // ============================================================================
  // Prefer word-derived text when available (enables trailing hallucination removal).
  // Otherwise, fall back to the cleaned segment text.

  const audioDuration = result.duration || 0;

  // Base text derived from segment text filtering (works even without word timestamps)
  const baseText = (cleanedText || filteredText || result.text || '').trim();

  let finalTextFromWords = '';
  if (words.length > 0) {
    // Apply duration-based trailing hallucination filter
    const wordsBeforeTrailingFilter = words.length;
    words = filterTrailingHallucinationsByDuration(words, audioDuration);
    
    if (words.length < wordsBeforeTrailingFilter) {
      console.log(`[groq-speaking-transcribe] Duration filter removed ${wordsBeforeTrailingFilter - words.length} trailing words`);
    }

    // Apply sentence-level trailing hallucination detection
    finalTextFromWords = words.map(w => w.word).join(' ').trim();
    const sentenceFilterResult = filterTrailingSentenceHallucinations(finalTextFromWords, words, audioDuration);
    words = sentenceFilterResult.words;
    finalTextFromWords = sentenceFilterResult.text;
    finalTextFromWords = String(finalTextFromWords || '').trim();
  }

  // Choose final text, ensuring we NEVER drop to empty just because word timestamps are missing
  let finalText = (finalTextFromWords || baseText).trim();

  // Final cleanup: apply phrase-based filters to the final text
  for (const pattern of HALLUCINATION_START_PHRASES) {
    finalText = finalText.replace(pattern, '');
  }
  for (const pattern of HALLUCINATION_END_PHRASES) {
    finalText = finalText.replace(pattern, '');
  }
  finalText = finalText.trim();

  // Safety: if aggressive filtering ever produces empty, fall back to baseText
  if (!finalText && baseText) {
    finalText = baseText;
  }

  // Log final result comparison
  if (finalText !== result.text.trim()) {
    console.log(`[groq-speaking-transcribe] Final cleaned transcript: "${result.text}" -> "${finalText}"`);
  }

  // Calculate average logprob from filtered segments
  const avgLogprob = filteredSegments.length > 0
    ? filteredSegments.reduce((sum, s) => sum + (s.avg_logprob || 0), 0) / filteredSegments.length
    : 0;

  // Calculate average confidence (word-level if available)
  const avgConfidence = words.length > 0
    ? words.reduce((sum, w) => sum + (w.probability || 0), 0) / words.length
    : 0;

  // Detect filler words
  const fillerPattern = /\b(um|uh|ah|er|hmm|like|you know|i mean|sort of|kind of)\b/gi;
  const fillerMatches = finalText.match(fillerPattern) || [];
  const fillerWords = [...new Set(fillerMatches.map(f => f.toLowerCase()))];

  // Detect long pauses (gaps > 2 seconds between words)
  const longPauses: { start: number; end: number; duration: number }[] = [];
  // Only possible when we have timestamped words
  if (words.length > 1) {
    for (let i = 1; i < words.length; i++) {
      const gap = words[i].start - words[i - 1].end;
      if (gap > 2.0) {
        longPauses.push({
          start: words[i - 1].end,
          end: words[i].start,
          duration: gap,
        });
      }
    }
  }

  // Log pause information for evaluation
  if (longPauses.length > 0) {
    console.log(`[groq-speaking-transcribe] ${segmentKey} has ${longPauses.length} long pauses (>2s): ${longPauses.map(p => `${p.duration.toFixed(1)}s`).join(', ')}`);
  }

  return {
    segmentKey,
    partNumber,
    questionNumber,
    text: finalText,
    duration: result.duration || 0,
    segments: filteredSegments,
    words,
    avgConfidence,
    avgLogprob,
    fillerWords,
    longPauses,
    // IMPORTANT: If word timestamps are missing, fall back to text-based word counting.
    wordCount: words.length > 0
      ? words.length
      : (finalText ? finalText.trim().split(/\s+/).filter(Boolean).length : 0),
    noSpeechProb: avgNoSpeechProb,
  };
}
