import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { crypto } from "https://deno.land/std@0.168.0/crypto/mod.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Decrypt user's Gemini API key
async function decryptApiKey(encryptedValue: string, encryptionKey: string): Promise<string> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  
  const combined = Uint8Array.from(atob(encryptedValue), c => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const encryptedData = combined.slice(12);
  
  const keyData = encoder.encode(encryptionKey);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyData.slice(0, 32),
    { name: "AES-GCM" },
    false,
    ["decrypt"]
  );
  
  const decryptedData = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    cryptoKey,
    encryptedData
  );
  
  return decoder.decode(decryptedData);
}

// Available voices for multi-speaker TTS
// CORRECTED: Based on actual Gemini TTS voice characteristics
const VOICES = {
  male: ['Charon', 'Fenrir', 'Orus', 'Iapetus', 'Algenib', 'Alnilam'],
  female: ['Kore', 'Puck', 'Zephyr', 'Leda', 'Aoede', 'Callirrhoe', 'Autonoe', 'Despina']
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    console.log("Starting generate-listening-audio function");
    
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      {
        global: {
          headers: { Authorization: req.headers.get('Authorization')! },
        },
      }
    );

    // Get authenticated user
    const { data: { user } } = await supabaseClient.auth.getUser();
    if (!user) {
      console.log("User not authenticated");
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log("User authenticated:", user.id);

    // Get user's Gemini API key
    const { data: secretData, error: secretError } = await supabaseClient
      .from('user_secrets')
      .select('encrypted_value')
      .eq('user_id', user.id)
      .eq('secret_name', 'GEMINI_API_KEY')
      .single();

    if (secretError || !secretData) {
      console.log("No Gemini API key found for user");
      return new Response(JSON.stringify({ 
        error: 'Gemini API key not found. Please add your API key in Settings.' 
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const appEncryptionKey = Deno.env.get('app_encryption_key');
    if (!appEncryptionKey) {
      throw new Error('app_encryption_key not configured');
    }

    const geminiApiKey = await decryptApiKey(secretData.encrypted_value, appEncryptionKey);
    console.log("Gemini API key decrypted successfully");

    // Parse request body
    const { topic, scenarioType } = await req.json();
    
    const scenarioPrompts: Record<string, string> = {
      'conversation': 'a casual conversation between two people',
      'lecture': 'a short educational lecture or presentation',
      'interview': 'a job interview or informational interview',
      'tour': 'a guided tour of a facility or location',
      'phone_call': 'a phone conversation about booking or inquiry'
    };

    const scenario = scenarioPrompts[scenarioType] || scenarioPrompts['conversation'];
    console.log("Generating dialogue for topic:", topic, "scenario:", scenarioType);

    // Step 1: Generate dialogue script using Gemini (with fallback models)
    const dialoguePrompt = `Generate a realistic IELTS Listening test dialogue about "${topic}". 
The scenario is: ${scenario}.

Requirements:
- Create a dialogue between exactly 2 speakers named "Speaker1" and "Speaker2"
- The dialogue should be 150-200 words total
- Include natural conversation elements (greetings, confirmations, questions)
- Include specific details that could be tested (names, numbers, dates, locations)
- Format each line as: "SpeakerName: dialogue text"

Example format:
Speaker1: Hello, welcome to the university library. How can I help you today?
Speaker2: Hi, I'd like to register for a library card please.

Generate the dialogue now:`;

    // Models to try in order - gemini-2.5-flash as primary, gemini-2.0-flash as fallback
    const dialogueModels = [
      'gemini-2.5-flash',
      'gemini-2.0-flash',
    ];

    let dialogueScript: string | null = null;
    let lastError: string | null = null;

    for (const model of dialogueModels) {
      console.log(`Attempting dialogue generation with model: ${model}`);
      
      try {
        const dialogueResponse = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiApiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: dialoguePrompt }] }]
            })
          }
        );

        if (!dialogueResponse.ok) {
          const errorData = await dialogueResponse.json();
          console.error(`Gemini ${model} failed:`, JSON.stringify(errorData, null, 2));
          
          // Check if it's a rate limit error (recoverable by trying next model)
          if (dialogueResponse.status === 429) {
            console.log(`Rate limited on ${model}, trying next model...`);
            lastError = `Rate limited on ${model}`;
            continue;
          }
          
          // For other errors, also try next model
          lastError = `${model}: ${dialogueResponse.status}`;
          continue;
        }

        const dialogueData = await dialogueResponse.json();
        dialogueScript = dialogueData.candidates?.[0]?.content?.parts?.[0]?.text;
        
        if (dialogueScript) {
          console.log(`Dialogue generated successfully with ${model}, length:`, dialogueScript.length);
          break;
        }
      } catch (fetchError: any) {
        console.error(`Fetch error with ${model}:`, fetchError.message);
        lastError = fetchError.message;
        continue;
      }
    }

    if (!dialogueScript) {
      return new Response(JSON.stringify({ 
        error: `All models failed to generate dialogue. Last error: ${lastError}`,
        rateLimited: lastError?.includes('Rate limited')
      }), {
        status: 429,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log("Dialogue preview:", dialogueScript.substring(0, 200));

    // Step 2: Convert to audio using Gemini 2.5 TTS with multi-speaker
    // Add natural pacing instructions for slower, clearer speech with pauses
    const ttsPrompt = `Read the following conversation slowly and clearly, as if for a language listening test. 
Use a moderate speaking pace with natural pauses between sentences. 
Pause briefly (about 1 second) after each speaker finishes their turn before the next speaker begins.
Speaker1 and Speaker2 should have distinct, clear voices:

${dialogueScript}`;

    console.log("Calling Gemini TTS API for audio generation");
    const ttsResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${geminiApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: ttsPrompt }] }],
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              multiSpeakerVoiceConfig: {
                speakerVoiceConfigs: [
                  {
                    speaker: "Speaker1",
                    voiceConfig: {
                      // Use Charon (male) for Speaker1 for clear voice distinction
                      prebuiltVoiceConfig: { voiceName: "Charon" }
                    }
                  },
                  {
                    speaker: "Speaker2",
                    voiceConfig: {
                      // Use Aoede (female) for Speaker2 for clear voice distinction
                      prebuiltVoiceConfig: { voiceName: "Aoede" }
                    }
                  }
                ]
              }
            }
          }
        })
      }
    );

    if (!ttsResponse.ok) {
      const errorText = await ttsResponse.text();
      console.error("Gemini TTS failed:", errorText);
      
      // Return dialogue without audio if TTS fails
      return new Response(JSON.stringify({ 
        success: true,
        dialogue: dialogueScript,
        audioBase64: null,
        error: `TTS generation failed: ${ttsResponse.status}. Dialogue was generated successfully.`
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const ttsData = await ttsResponse.json();
    const audioData = ttsData.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    
    if (!audioData) {
      console.log("No audio data in response, returning dialogue only");
      return new Response(JSON.stringify({ 
        success: true,
        dialogue: dialogueScript,
        audioBase64: null,
        message: 'Dialogue generated but audio conversion not available'
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log("Audio generated successfully, base64 length:", audioData.length);

    // Return both dialogue and audio
    return new Response(JSON.stringify({ 
      success: true,
      dialogue: dialogueScript,
      audioBase64: audioData,
      audioFormat: 'pcm', // Raw PCM 24kHz 16-bit
      sampleRate: 24000,
      message: 'Listening audio generated successfully'
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
    console.error('Edge Function error:', error.message, error.stack);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
