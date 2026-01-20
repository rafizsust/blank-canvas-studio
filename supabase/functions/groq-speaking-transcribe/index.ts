import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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
 * - Inter-segment delay to respect 20 RPM limit
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Groq API endpoint
const GROQ_API_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';

// Inter-segment delay (ms) to stay under 20 RPM
const INTER_SEGMENT_DELAY_MS = 3000;

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
      p_job_id: jobId,
      p_part_number: 1,
      p_lock_duration_seconds: 300,
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
    
    console.log(`[groq-speaking-transcribe] Transcribing ${segments.length} segments`);

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
        // Parse segment key (e.g., "part1_q1" or "1-1")
        const partMatch = segmentKey.match(/part(\d+)/i) || segmentKey.match(/^(\d+)-/);
        const qMatch = segmentKey.match(/q(\d+)/i) || segmentKey.match(/-(\d+)$/);
        const partNumber = partMatch ? parseInt(partMatch[1]) : 1;
        const questionNumber = qMatch ? parseInt(qMatch[1]) : 1;

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

    // Update job with error
    const { jobId } = await req.json().catch(() => ({}));
    if (jobId) {
      await supabaseService
        .from('speaking_evaluation_jobs')
        .update({
          last_error: error.message,
          heartbeat_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', jobId);
    }

    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

// ============================================================================
// Helper Functions
// ============================================================================

async function downloadFromR2(
  filePath: string,
  supabaseService: any
): Promise<Blob | null> {
  try {
    // Download from Supabase storage (which may be backed by R2)
    const { data, error } = await supabaseService.storage
      .from('speaking-audio')
      .download(filePath);

    if (error) {
      console.error(`[groq-speaking-transcribe] R2 download error:`, error);
      return null;
    }

    return data;
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
  const formData = new FormData();
  formData.append('file', audioBlob, 'audio.webm');
  formData.append('model', 'whisper-large-v3-turbo');
  formData.append('response_format', 'verbose_json');
  formData.append('timestamp_granularities[]', 'word');
  formData.append('timestamp_granularities[]', 'segment');
  formData.append('language', 'en');
  // Prompt to encourage filler word transcription
  formData.append('prompt', 
    'Transcribe exactly as spoken. Include all filler words such as um, uh, ah, er, hmm, like, you know. ' +
    'Include false starts, repetitions, and self-corrections. Do not clean up the speech.'
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

  // Extract all words from segments or top-level
  const words: WhisperWord[] = result.words || 
    result.segments?.flatMap(s => s.words || []) || 
    [];

  // Calculate average confidence
  const avgConfidence = words.length > 0
    ? words.reduce((sum, w) => sum + (w.probability || 0), 0) / words.length
    : 0;

  // Calculate average logprob
  const avgLogprob = result.segments?.length > 0
    ? result.segments.reduce((sum, s) => sum + (s.avg_logprob || 0), 0) / result.segments.length
    : 0;

  // Detect filler words
  const fillerPattern = /\b(um|uh|ah|er|hmm|like|you know|i mean|sort of|kind of)\b/gi;
  const fillerMatches = result.text.match(fillerPattern) || [];
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

  return {
    segmentKey,
    partNumber,
    questionNumber,
    text: result.text,
    duration: result.duration || 0,
    segments: result.segments || [],
    words,
    avgConfidence,
    avgLogprob,
    fillerWords,
    longPauses,
    wordCount: words.length,
  };
}
