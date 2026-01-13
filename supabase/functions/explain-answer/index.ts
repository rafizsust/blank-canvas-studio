import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { crypto } from "https://deno.land/std@0.168.0/crypto/mod.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
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

const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash'];

async function callGemini(apiKey: string, systemPrompt: string, userPrompt: string): Promise<string | null> {
  for (const model of GEMINI_MODELS) {
    try {
      console.log(`Trying Gemini model: ${model}`);
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [
              { role: 'user', parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }] }
            ],
            generationConfig: {
              temperature: 0.7,
              maxOutputTokens: 2048,
            },
          }),
        }
      );

      if (!response.ok) {
        console.error(`Gemini ${model} failed with status ${response.status}`);
        continue;
      }

      const data = await response.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) return text;
    } catch (err) {
      console.error(`Error with ${model}:`, err);
      continue;
    }
  }
  return null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Create Supabase client with user auth
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: req.headers.get('Authorization')! } } }
    );

    // Get authenticated user
    const { data: { user }, error: authError } = await supabaseClient.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Get user's Gemini API key
    const { data: secretData, error: secretError } = await supabaseClient
      .from('user_secrets')
      .select('encrypted_value')
      .eq('user_id', user.id)
      .eq('secret_name', 'GEMINI_API_KEY')
      .single();

    if (secretError || !secretData) {
      return new Response(JSON.stringify({ 
        error: 'Gemini API key not found. Please set it in Settings.',
        code: 'API_KEY_NOT_FOUND'
      }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const appEncryptionKey = Deno.env.get('app_encryption_key');
    if (!appEncryptionKey) {
      throw new Error('Encryption key not configured');
    }

    const geminiApiKey = await decryptApiKey(secretData.encrypted_value, appEncryptionKey);

    const { 
      questionText, 
      userAnswer, 
      correctAnswer, 
      isCorrect,
      options,
      questionType,
      transcriptContext,
      passageContext,
      testType
    } = await req.json();

    // Build options context if available
    let optionsText = '';
    if (options && Array.isArray(options) && options.length > 0) {
      optionsText = `\n\nAvailable Options:\n${options.map((opt: string, i: number) => 
        `${String.fromCharCode(65 + i)}. ${opt}`
      ).join('\n')}`;
    } else if (options && typeof options === 'object') {
      const optEntries = Object.entries(options);
      if (optEntries.length > 0) {
        optionsText = `\n\nAvailable Options:\n${optEntries.map(([key, val]) => 
          `${key}. ${val}`
        ).join('\n')}`;
      }
    }

    // Build transcript context for listening tests
    let transcriptText = '';
    if (transcriptContext && transcriptContext.trim()) {
      transcriptText = `\n\nRelevant Audio Transcript:\n"""${transcriptContext}"""`;
    }

    // Build passage context for reading tests
    let passageText = '';
    if (passageContext && passageContext.trim()) {
      passageText = `\n\nRelevant Reading Passage:\n"""${passageContext}"""`;
    }

    const testTypeLabel = testType === 'listening' ? 'IELTS Listening' : 'IELTS Reading';
    const questionTypeLabel = questionType ? ` (${questionType.replace(/_/g, ' ').toLowerCase()})` : '';

    // Special handling for Multiple Choice Multiple Answers
    const isMCQMultiple = questionType === 'MULTIPLE_CHOICE_MULTIPLE';
    
    let mcqMultipleGuidelines = '';
    if (isMCQMultiple) {
      const userAnswers: string[] = userAnswer ? userAnswer.split(',').map((a: string) => a.trim()) : [];
      const correctAnswersArr: string[] = correctAnswer ? correctAnswer.split(',').map((a: string) => a.trim()) : [];
      const correctOnes = userAnswers.filter((a: string) => correctAnswersArr.includes(a));
      const wrongOnes = userAnswers.filter((a: string) => !correctAnswersArr.includes(a));
      const missedOnes = correctAnswersArr.filter((a: string) => !userAnswers.includes(a));
      
      mcqMultipleGuidelines = `
This is a MULTIPLE CHOICE MULTIPLE ANSWERS question where the student must select ${correctAnswersArr.length} correct answers.
- Student selected: ${userAnswers.join(', ') || '(none)'}
- Correct answers are: ${correctAnswersArr.join(', ')}
- Correctly identified: ${correctOnes.join(', ') || '(none)'}
- Incorrectly selected: ${wrongOnes.join(', ') || '(none)'}
- Missed: ${missedOnes.join(', ') || '(none)'}

IMPORTANT: Address each selection individually. Explain why the correct answers are right, and if the student selected any wrong options, explain why those are incorrect.`;
    }

    const systemPrompt = `You are an expert ${testTypeLabel} tutor. Your task is to explain ${isCorrect ? 'why a student\'s answer was correct' : 'why a student\'s answer was incorrect'} in a helpful and educational way.

Guidelines:
- Be concise but thorough (4-6 sentences)
- ${isCorrect ? 'Explain what made this the correct answer and reinforce the key concept' : 'IMPORTANT: First explain specifically why the student\'s answer is wrong (what makes it incorrect, what concept they may have misunderstood). Then explain why the correct answer is right.'}
- ${!isCorrect && userAnswer ? 'Address the student\'s specific wrong answer directly - explain what that option/answer actually refers to and why it doesn\'t fit the question' : ''}
- ${testType === 'listening' ? 'If transcript context is provided, reference the specific part that contains the answer' : 'If passage context is provided, reference the specific part of the text that supports the answer'}
- If options are provided, explain why the correct option is right and briefly why the student\'s chosen option is wrong
- Provide helpful tips for similar questions in the future
- Be encouraging and supportive
- Use simple, clear language
- If the provided "correct answer" seems wrong or questionable, mention this and suggest the user report it to the admin
${mcqMultipleGuidelines}`;

    const contextReference = testType === 'listening' 
      ? (transcriptContext ? 'Reference the specific part of the transcript where the answer can be found.' : '')
      : (passageContext ? 'Reference the specific part of the passage where the answer can be found.' : '');

    const userPrompt = `Question Type: ${testTypeLabel}${questionTypeLabel}

Question: ${questionText}${optionsText}${transcriptText}${passageText}

Student's Answer: ${userAnswer || '(No answer provided)'}
Correct Answer: ${correctAnswer}

Please explain ${isCorrect ? 'why this answer is correct and what concept it demonstrates' : 'why the student\'s answer is wrong and why the correct answer is right'}. ${contextReference} Also, if you notice any issues with the provided correct answer, please mention that the user should report this issue to the admin.`;

    console.log("Generating explanation with Gemini:", {
      questionType,
      testType,
      hasOptions: !!optionsText,
      hasTranscript: !!transcriptText,
      hasPassage: !!passageText,
      isCorrect
    });

    const explanation = await callGemini(geminiApiKey, systemPrompt, userPrompt);
    
    if (!explanation) {
      throw new Error('Failed to generate explanation');
    }

    return new Response(
      JSON.stringify({ explanation }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error in explain-answer function:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
