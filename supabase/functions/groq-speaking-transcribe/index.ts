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
const NO_SPEECH_THRESHOLD = 0.8;

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
      const id = typeof q?.id === 'string' ? q.id : null;
      const n = typeof q?.question_number === 'number' ? q.question_number : Number(q?.question_number);
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
  formData.append('model', 'whisper-large-v3-turbo');
  formData.append('response_format', 'verbose_json');
  formData.append('timestamp_granularities[]', 'word');
  formData.append('timestamp_granularities[]', 'segment');
  formData.append('language', 'en');
  
  // Enhanced prompt to ensure FULL audio transcription with all details
  // The prompt primes Whisper for IELTS-style responses and prevents early stopping
  formData.append('prompt', 
    'This is an IELTS speaking test recording. ' +
    'Transcribe the ENTIRE audio from start to finish completely and accurately. ' +
    'Do NOT stop early or truncate the transcription. ' +
    'Include ALL filler words: um, uh, ah, er, hmm, like, you know, I mean, sort of, kind of. ' +
    'Include ALL false starts, repetitions, and self-corrections exactly as spoken. ' +
    'Include stutters and hesitations. ' +
    'Write "[INAUDIBLE]" for unclear portions. ' +
    'If there is complete silence, output "[NO SPEECH]". ' +
    'Do not invent or add any words not actually spoken. ' +
    'Do not add "thank you", "goodbye", or other phrases unless clearly spoken.'
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

  // Filter out segments with high no_speech probability to prevent hallucinations
  const filteredSegments = result.segments?.filter(s => {
    if (s.no_speech_prob > NO_SPEECH_THRESHOLD) {
      console.log(`[groq-speaking-transcribe] Filtering out segment with no_speech_prob=${s.no_speech_prob.toFixed(2)}: "${s.text}"`);
      return false;
    }
    return true;
  }) || [];

  // Rebuild text from filtered segments
  const filteredText = filteredSegments.map(s => s.text).join(' ').trim();

  // Filter out common hallucination phrases at the end of audio
  const cleanedText = filteredText
    .replace(/\s*(thank you\.?|thanks\.?|goodbye\.?|bye\.?)\s*$/gi, '')
    .trim();

  // If the filtered text is empty or significantly different, log it
  if (cleanedText !== result.text.trim()) {
    console.log(`[groq-speaking-transcribe] Cleaned transcript: "${result.text}" -> "${cleanedText}"`);
  }

  // Extract all words from filtered segments
  const words: WhisperWord[] = filteredSegments.flatMap(s => s.words || []);

  // Calculate average confidence
  const avgConfidence = words.length > 0
    ? words.reduce((sum, w) => sum + (w.probability || 0), 0) / words.length
    : 0;

  // Calculate average logprob from filtered segments
  const avgLogprob = filteredSegments.length > 0
    ? filteredSegments.reduce((sum, s) => sum + (s.avg_logprob || 0), 0) / filteredSegments.length
    : 0;

  // Detect filler words
  const fillerPattern = /\b(um|uh|ah|er|hmm|like|you know|i mean|sort of|kind of)\b/gi;
  const fillerMatches = cleanedText.match(fillerPattern) || [];
  const fillerWords = [...new Set(fillerMatches.map(f => f.toLowerCase()))];

  // Detect long pauses (gaps > 2 seconds between words)
  const longPauses: { start: number; end: number; duration: number }[] = [];
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

  // Log pause information for evaluation
  if (longPauses.length > 0) {
    console.log(`[groq-speaking-transcribe] ${segmentKey} has ${longPauses.length} long pauses (>2s): ${longPauses.map(p => `${p.duration.toFixed(1)}s`).join(', ')}`);
  }

  return {
    segmentKey,
    partNumber,
    questionNumber,
    text: cleanedText,
    duration: result.duration || 0,
    segments: filteredSegments,
    words,
    avgConfidence,
    avgLogprob,
    fillerWords,
    longPauses,
    wordCount: words.length,
    noSpeechProb: avgNoSpeechProb,
  };
}
