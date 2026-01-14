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

// =============================================================================
// THE TUTOR - Follow-up Chat Models (Split-Brain Architecture)
// =============================================================================
// Prioritize speed and high-quota models for instant chat responses
// These models have faster response times and higher daily quotas
const GEMINI_MODELS = [
  'gemini-2.0-flash-lite-preview-02-05', // 1. Primary: Instant speed, 1500 daily quota
  'gemini-2.0-flash-lite',               // 2. Secondary: Stable Lite model
  'gemini-2.0-flash',                    // 3. Fallback: Low latency standard
];

async function callGemini(apiKey: string, prompt: string): Promise<string | null> {
  for (const model of GEMINI_MODELS) {
    try {
      console.log(`Trying Gemini model: ${model}`);
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.7,
              maxOutputTokens: 2048,
            },
          }),
        }
      );

      if (!response.ok) {
        const errorData = await response.json();
        console.error(`Gemini ${model} failed:`, JSON.stringify(errorData));
        if (response.status === 429) continue;
        continue;
      }

      const data = await response.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) {
        console.log(`Success with ${model}`);
        return text;
      }
    } catch (err) {
      console.error(`Error with ${model}:`, err);
      continue;
    }
  }
  return null;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    console.log("Starting explain-answer-followup function");
    
    // Auth
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: req.headers.get('Authorization')! } } }
    );

    const { data: { user } } = await supabaseClient.auth.getUser();
    if (!user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Get API key
    const { data: secretData } = await supabaseClient
      .from('user_secrets')
      .select('encrypted_value')
      .eq('user_id', user.id)
      .eq('secret_name', 'GEMINI_API_KEY')
      .single();

    if (!secretData) {
      return new Response(JSON.stringify({ 
        error: 'Gemini API key not found. Please add your API key in Settings.' 
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const appEncryptionKey = Deno.env.get('app_encryption_key');
    if (!appEncryptionKey) throw new Error('Encryption key not configured');
    
    const geminiApiKey = await decryptApiKey(secretData.encrypted_value, appEncryptionKey);

    // Parse request
    const { 
      question, // User's follow-up question
      context // Full context about the test
    } = await req.json();

    if (!question || !context) {
      return new Response(JSON.stringify({ error: 'Missing question or context' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`Processing follow-up question: ${question.substring(0, 100)}...`);

    // Build comprehensive prompt - Teacher persona (no AI references)
    const moduleContext = context.module === 'listening' 
      ? `## AUDIO TRANSCRIPT
${context.transcript || context.passage?.content || '(No transcript available)'}
`
      : context.passage ? `## PASSAGE
Title: ${context.passage.title || 'Untitled'}

${context.passage.content || '(No passage content available)'}
` : '';

    const prompt = `You are a professional IELTS tutor with 15+ years of experience preparing students for the exam. You speak directly and warmly to your student, as in a one-on-one tutoring session.

CRITICAL RULES:
- Never mention that you are an AI, a language model, or that you were given instructions
- Never say things like "Based on the context provided" or "According to my instructions"
- Speak naturally as a human teacher would - use "I" and "you" naturally
- Share insights as if from your own teaching experience
- If the student's message is unclear, contains random characters, is too vague, or doesn't make sense, ask them to clarify what they want to know. For example: "I'm not quite sure what you're asking. Could you rephrase your question or tell me more specifically what you'd like me to explain about this question?"

---

${moduleContext}

## QUESTION AND ANSWER DETAILS

QUESTION ${context.questionNumber || ''}: ${context.questionText || ''}
${context.options ? `Options: ${JSON.stringify(context.options)}` : ''}

**STUDENT'S ANSWER**: "${context.userAnswer || '(No answer provided)'}"
**CORRECT ANSWER**: "${context.correctAnswer || ''}"
**RESULT**: ${context.isCorrect ? 'CORRECT ✓' : 'INCORRECT ✗'}

${context.explanation ? `Initial explanation: ${context.explanation}` : ''}

---

STUDENT'S FOLLOW-UP MESSAGE: ${question}

---

IMPORTANT: You have access to the student's answer above ("${context.userAnswer || '(No answer)'}"). When they ask "what was my answer?" or similar, tell them directly. Do not claim you cannot see their answer - you can.

First, evaluate if the student's message is meaningful and related to the question/passage:
- If it's random characters, gibberish, or nonsensical, politely ask them to clarify what they want to know
- If it's vague but somewhat understandable, try to address it but also ask for clarification if needed
- If it's clear and meaningful, respond helpfully

Respond naturally as their personal tutor. Be encouraging, specific, and reference the actual ${context.module === 'listening' ? 'transcript' : 'passage'} content when helpful. Keep it conversational - 2-4 short paragraphs unless they need more detail.`;

    const result = await callGemini(geminiApiKey, prompt);
    
    if (!result) {
      return new Response(JSON.stringify({ error: 'Failed to generate response' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ 
      response: result.trim(),
      success: true 
    }), {
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
