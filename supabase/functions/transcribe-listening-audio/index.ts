import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { crypto } from "https://deno.land/std@0.168.0/crypto/mod.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// List of Gemini models in fallback order - gemini-2.5-flash as primary, gemini-2.0-flash as fallback
const GEMINI_MODELS_FALLBACK_ORDER = [
  'gemini-2.5-flash',
  'gemini-2.0-flash',
];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface TranscriptSegment {
  text: string;
  start_time: number;
  end_time: number;
}

interface QuestionGroup {
  start_question: number;
  end_question: number;
  start_time: number;
  end_time: number;
  description: string;
}

interface PartInfo {
  part_number: number;
  start_time: number;
  end_time: number;
  question_groups: QuestionGroup[];
}

interface TranscriptionResult {
  full_transcript: string;
  segments: TranscriptSegment[];
  parts: PartInfo[];
  total_duration: number;
}

async function decryptApiKey(encryptedValue: string, encryptionKey: string): Promise<string> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const combined = Uint8Array.from(atob(encryptedValue), (c) => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const encryptedData = combined.slice(12);

  const keyData = encoder.encode(encryptionKey);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyData.slice(0, 32),
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );

  const decryptedData = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    cryptoKey,
    encryptedData,
  );

  return decoder.decode(decryptedData);
}

// Convert Uint8Array to base64 in chunks to avoid stack overflow
function uint8ArrayToBase64(uint8Array: Uint8Array): string {
  const chunkSize = 8192;
  let result = '';
  for (let i = 0; i < uint8Array.length; i += chunkSize) {
    const chunk = uint8Array.subarray(i, i + chunkSize);
    result += String.fromCharCode.apply(null, Array.from(chunk));
  }
  return btoa(result);
}

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Require logged-in user to access their stored Gemini key
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      {
        global: {
          headers: { Authorization: req.headers.get('Authorization')! },
        },
      },
    );

    const { data: { user } } = await supabaseClient.auth.getUser();

    if (!user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const appEncryptionKey = Deno.env.get('app_encryption_key');
    if (!appEncryptionKey) {
      throw new Error('app_encryption_key is not configured');
    }

    const { data: secretData, error: secretError } = await supabaseClient
      .from('user_secrets')
      .select('encrypted_value')
      .eq('user_id', user.id)
      .eq('secret_name', 'GEMINI_API_KEY')
      .maybeSingle();

    if (secretError) throw secretError;

    if (!secretData?.encrypted_value) {
      return new Response(JSON.stringify({
        error: 'Gemini API key not found. Please add your GEMINI_API_KEY in Settings.',
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const geminiApiKey = await decryptApiKey(secretData.encrypted_value, appEncryptionKey);

    const formData = await req.formData();
    const audioFile = formData.get('audio') as File | null;
    const audioUrl = formData.get('audioUrl') as string | null;

    if (!audioFile && !audioUrl) {
      return new Response(
        JSON.stringify({ error: 'No audio file or URL provided' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    let audioBase64 = '';
    let mimeType = 'audio/mpeg';

    if (audioFile) {
      const arrayBuffer = await audioFile.arrayBuffer();
      const uint8Array = new Uint8Array(arrayBuffer);
      audioBase64 = uint8ArrayToBase64(uint8Array);
      mimeType = audioFile.type || 'audio/mpeg';
    } else if (audioUrl) {
      console.log('Fetching audio from URL:', audioUrl);
      const audioResponse = await fetch(audioUrl);
      if (!audioResponse.ok) {
        throw new Error(`Failed to fetch audio from URL: ${audioResponse.status}`);
      }
      const arrayBuffer = await audioResponse.arrayBuffer();
      const uint8Array = new Uint8Array(arrayBuffer);
      audioBase64 = uint8ArrayToBase64(uint8Array);

      const contentType = audioResponse.headers.get('content-type');
      if (contentType) {
        mimeType = contentType;
      } else if (audioUrl.endsWith('.mp3')) {
        mimeType = 'audio/mpeg';
      } else if (audioUrl.endsWith('.wav')) {
        mimeType = 'audio/wav';
      }
    }

    console.log('Audio prepared, sending to Gemini for transcription...');
    console.log('Audio size (base64 length):', audioBase64.length);

    const systemPrompt = `You are an IELTS listening test audio analyzer. Your task is to:

1. Transcribe the entire audio with sentence-level timestamps
2. Identify the 4 parts of the IELTS listening test (Part 1, Part 2, Part 3, Part 4)
3. For each part, identify the question groups (e.g., Questions 1-6, Questions 7-10)

IMPORTANT: Listen carefully for phrases like:
- "Part 1", "Part 2", "Part 3", "Part 4" or "Section 1", "Section 2", etc.
- "Questions 1 to 6", "Questions 7 to 10", etc.
- "Now turn to Part 2", "You will hear...", etc.

Return your response as a valid JSON object with this exact structure:
{
  "full_transcript": "The complete transcript text",
  "segments": [
    {
      "text": "Sentence or phrase",
      "start_time": 0.0,
      "end_time": 3.5
    }
  ],
  "parts": [
    {
      "part_number": 1,
      "start_time": 0.0,
      "end_time": 120.5,
      "question_groups": [
        {
          "start_question": 1,
          "end_question": 6,
          "start_time": 10.0,
          "end_time": 60.0,
          "description": "Form completion about hotel booking"
        }
      ]
    }
  ],
  "total_duration": 1800.0
}

Times should be in seconds (decimals allowed). Be as accurate as possible with timestamps.
ONLY return the JSON object, no other text.`;

    // Try models in fallback order
    let responseText: string | null = null;
    let usedModel: string | null = null;
    let lastError: string | null = null;

    for (const modelName of GEMINI_MODELS_FALLBACK_ORDER) {
      console.log(`Attempting transcription with Gemini model: ${modelName}`);
      
      try {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(geminiApiKey)}`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              contents: [
                {
                  role: 'user',
                  parts: [
                    { text: systemPrompt },
                    { text: 'Please transcribe this IELTS listening test audio and identify all parts and question groups with their timestamps.' },
                    {
                      inlineData: {
                        mimeType,
                        data: audioBase64,
                      },
                    },
                  ],
                },
              ],
              generationConfig: {
                temperature: 0.2,
                responseMimeType: 'application/json',
              },
            }),
          },
        );

        if (response.ok) {
          const data = await response.json();
          const content = data?.candidates?.[0]?.content?.parts
            ?.map((p: any) => p?.text)
            .filter(Boolean)
            .join('\n');

          if (content) {
            responseText = content;
            usedModel = modelName;
            console.log(`Transcription successful with model: ${modelName}`);
            break;
          } else {
            console.warn(`Model ${modelName} returned OK but no content. Trying next model.`);
            lastError = `${modelName}: Empty response`;
          }
        } else {
          const errorText = await response.text();
          console.error(`Gemini ${modelName} failed:`, response.status, errorText);
          
          // Rate limit - try next model
          if (response.status === 429) {
            console.log(`Rate limited on ${modelName}, trying next model...`);
            lastError = `Rate limited on ${modelName}`;
            continue;
          }
          
          lastError = `${modelName}: ${response.status}`;
          continue;
        }
      } catch (fetchError: any) {
        console.error(`Fetch error with ${modelName}:`, fetchError.message);
        lastError = fetchError.message;
        continue;
      }
    }

    if (!responseText) {
      const isRateLimited = lastError?.includes('Rate limited');
      return new Response(
        JSON.stringify({ 
          error: `All models failed. Last error: ${lastError}`,
          rateLimited: isRateLimited
        }),
        { 
          status: isRateLimited ? 429 : 500, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        },
      );
    }

    console.log('Gemini response received from model:', usedModel);
    console.log('Raw Gemini response:', responseText.substring(0, 500));

    let result: TranscriptionResult;
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        result = JSON.parse(jsonMatch[0]);
      } else {
        result = JSON.parse(responseText);
      }
    } catch (parseError) {
      console.error('Failed to parse Gemini response as JSON:', parseError);
      console.error('Content was:', responseText);
      throw new Error('Failed to parse transcription result');
    }

    console.log('Transcription complete. Parts found:', result.parts?.length || 0);
    console.log('Segments found:', result.segments?.length || 0);

    return new Response(
      JSON.stringify(result),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (error) {
    console.error('Error in transcribe-listening-audio:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
