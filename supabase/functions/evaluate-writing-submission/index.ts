import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { crypto } from "https://deno.land/std@0.168.0/crypto/mod.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-gemini-api-key',
};

// ============================================================================
// CREDIT SYSTEM - Cost Map and Daily Limits
// ============================================================================
const COSTS = {
  'generate_speaking': 5,
  'generate_writing': 5,
  'generate_listening': 20,
  'generate_reading': 20,
  'evaluate_speaking': 15,
  'evaluate_writing': 10,
  'evaluate_reading': 0,
  'evaluate_listening': 0,
  'explain_answer': 2
};

const DAILY_CREDIT_LIMIT = 100;

// DB-managed API key interface
interface ApiKeyRecord {
  id: string;
  provider: string;
  key_value: string;
  is_active: boolean;
  error_count: number;
}

// Fetch active Gemini keys from api_keys table
async function getActiveGeminiKeys(serviceClient: any): Promise<ApiKeyRecord[]> {
  try {
    const { data, error } = await serviceClient
      .from('api_keys')
      .select('id, provider, key_value, is_active, error_count')
      .eq('provider', 'gemini')
      .eq('is_active', true)
      .order('error_count', { ascending: true });
    
    if (error) {
      console.error('Failed to fetch API keys:', error);
      return [];
    }
    return data || [];
  } catch (err) {
    console.error('Error fetching API keys:', err);
    return [];
  }
}

// ============================================================================
// ATOMIC CREDIT FUNCTIONS - Uses DB functions to prevent race conditions
// ============================================================================

// Check and RESERVE credits atomically BEFORE calling AI
async function checkAndReserveCredits(
  serviceClient: any, 
  userId: string, 
  operationType: keyof typeof COSTS
): Promise<{ ok: boolean; error?: string; creditsUsed?: number; creditsRemaining?: number }> {
  const cost = COSTS[operationType] || 0;
  if (cost === 0) return { ok: true, creditsUsed: 0, creditsRemaining: DAILY_CREDIT_LIMIT };
  
  try {
    const { data, error } = await serviceClient.rpc('check_and_reserve_credits', {
      p_user_id: userId,
      p_cost: cost
    });
    
    if (error) {
      console.error('check_and_reserve_credits RPC error:', error);
      return { ok: true, creditsUsed: 0, creditsRemaining: DAILY_CREDIT_LIMIT };
    }
    
    console.log(`Credit check result for ${operationType} (cost ${cost}):`, data);
    
    if (!data.ok) {
      return {
        ok: false,
        error: data.error || `Daily credit limit reached. Add your own Gemini API key in Settings.`,
        creditsUsed: data.credits_used,
        creditsRemaining: data.credits_remaining
      };
    }
    
    return {
      ok: true,
      creditsUsed: data.credits_used,
      creditsRemaining: data.credits_remaining
    };
  } catch (err) {
    console.error('Error in atomic credit check:', err);
    return { ok: true, creditsUsed: 0, creditsRemaining: DAILY_CREDIT_LIMIT };
  }
}

// Refund credits if the AI operation fails AFTER we reserved them
async function refundCredits(
  serviceClient: any, 
  userId: string, 
  operationType: keyof typeof COSTS
): Promise<void> {
  const cost = COSTS[operationType] || 0;
  if (cost === 0) return;
  
  try {
    const { error } = await serviceClient.rpc('refund_credits', {
      p_user_id: userId,
      p_cost: cost
    });
    
    if (error) {
      console.error('refund_credits RPC error:', error);
    } else {
      console.log(`Refunded ${cost} credits for failed ${operationType}`);
    }
  } catch (err) {
    console.error('Failed to refund credits:', err);
  }
}

// =============================================================================
// THE CRITIC - Writing Evaluation Models (Split-Brain Architecture)
// =============================================================================
// Prioritize "Deep Reasoning" models for essay grading
// These models excel at nuanced grammar, coherence, and argument analysis
const GEMINI_MODELS_FALLBACK_ORDER = [
  'gemini-3-pro-preview', // 1. Primary: Maximum IQ for Grammar/Coherence (Gemini 3.0)
  'gemini-exp-1206',      // 2. Secondary: High Quality Experimental
  'gemini-2.5-pro',       // 3. Fallback: Stable Pro model
];

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      {
        global: {
          headers: { Authorization: req.headers.get('Authorization')! },
        },
      }
    );

    const { data: { user } } = await supabaseClient.auth.getUser();

    if (!user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { submissionId } = await req.json();

    if (!submissionId) {
      return new Response(JSON.stringify({ error: 'Missing submissionId' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // 1. Fetch submission details
    const { data: submission, error: submissionError } = await supabaseClient
      .from('writing_submissions')
      .select('submission_text, task_id, user_id')
      .eq('id', submissionId)
      .eq('user_id', user.id) // Ensure user owns the submission
      .single();

    if (submissionError || !submission) {
      throw new Error(submissionError?.message || 'Submission not found or unauthorized.');
    }

    // 2. Fetch the associated task details to get word limits, instruction, text_content, and image_url
    const { data: task, error: taskError } = await supabaseClient
      .from('writing_tasks')
      .select('writing_test_id, task_type, instruction, text_content, word_limit_min, word_limit_max, image_url')
      .eq('id', submission.task_id)
      .single();

    if (taskError || !task) {
      throw new Error(taskError?.message || 'Associated writing task not found.');
    }

    // Fetch image as base64 if it's a Task 1 with an image
    let imageBase64: string | null = null;
    if (task.task_type === 'task1' && task.image_url) {
      try {
        console.log('Fetching Task 1 image for vision analysis:', task.image_url);
        const imageResponse = await fetch(task.image_url);
        if (imageResponse.ok) {
          const imageBuffer = await imageResponse.arrayBuffer();
          const imageBytes = new Uint8Array(imageBuffer);
          // Convert to base64
          let binary = '';
          for (let i = 0; i < imageBytes.length; i++) {
            binary += String.fromCharCode(imageBytes[i]);
          }
          imageBase64 = btoa(binary);
          console.log('Successfully fetched and encoded image for vision analysis');
        }
      } catch (imgError) {
        console.error('Failed to fetch image for Task 1:', imgError);
        // Continue without image if fetch fails
      }
    }

    // Service client for credit operations
    const serviceClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    // ============ HYBRID KEY PRIORITY SYSTEM ============
    const headerApiKey = req.headers.get('x-gemini-api-key');
    let geminiApiKey: string | null = null;
    let isUserProvidedKey = false;
    
    // Priority 1: Check for user-provided key
    if (headerApiKey) {
      console.log('Using user-provided API key from header (Priority 1)');
      geminiApiKey = headerApiKey;
      isUserProvidedKey = true;
    } else {
      // Check user_secrets table for stored encrypted key
      const { data: userSecret } = await supabaseClient
        .from('user_secrets')
        .select('encrypted_value')
        .eq('user_id', user.id)
        .eq('secret_name', 'GEMINI_API_KEY')
        .single();

      if (userSecret) {
        const appEncryptionKey = Deno.env.get('app_encryption_key');
        if (appEncryptionKey) {
          const encoder = new TextEncoder();
          const decoder = new TextDecoder();
          const keyData = encoder.encode(appEncryptionKey);
          const cryptoKey = await crypto.subtle.importKey(
            "raw",
            keyData.slice(0, 32),
            { name: "AES-GCM" },
            false,
            ["decrypt"]
          );
          
          const encryptedBytes = Uint8Array.from(atob(userSecret.encrypted_value), c => c.charCodeAt(0));
          const iv = encryptedBytes.slice(0, 12);
          const ciphertext = encryptedBytes.slice(12);
          
          const decryptedData = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv },
            cryptoKey,
            ciphertext
          );
          geminiApiKey = decoder.decode(decryptedData);
          isUserProvidedKey = true;
          console.log('Using user API key from user_secrets (Priority 1)');
        }
      }
    }
    
    // Priority 2: System pool (only if no user key)
    if (!isUserProvidedKey) {
      const dbApiKeys = await getActiveGeminiKeys(serviceClient);
      console.log(`No user key found. Using system pool: ${dbApiKeys.length} DB-managed keys (Priority 2)`);
      
      if (dbApiKeys.length > 0) {
        geminiApiKey = dbApiKeys[0].key_value;
      }
    }
    
    if (!geminiApiKey) {
      throw new Error('No API key available. Please add your Gemini API key in Settings.');
    }

    // Credit check and reserve for system pool users (atomic to prevent race conditions)
    let creditsReserved = false;
    if (!isUserProvidedKey) {
      const creditCheck = await checkAndReserveCredits(serviceClient, user.id, 'evaluate_writing');
      if (!creditCheck.ok) {
        return new Response(JSON.stringify({ 
          error: creditCheck.error,
          code: 'CREDIT_LIMIT_EXCEEDED'
        }), {
          status: 403,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      creditsReserved = true;
      console.log(`Credits reserved: ${creditCheck.creditsUsed}/${DAILY_CREDIT_LIMIT}`);
    }

    // 4. Call Gemini API for evaluation with fallback models
    let responseText: string | null = null;
    let usedModel: string | null = null;

    for (const modelName of GEMINI_MODELS_FALLBACK_ORDER) {
      console.log(`Attempting evaluation with Gemini model: ${modelName}`);
      const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${geminiApiKey}`;

      // Move prompt construction inside the loop to access modelName
      const prompt = `You are an expert IELTS writing examiner and a supportive English teacher. Please provide a detailed evaluation of your student's IELTS ${task.task_type === 'task1' ? 'Task 1 Report' : 'Task 2 Essay'} submission. Focus on offering constructive feedback and an overall band score, speaking directly to the student as their teacher would.

IMPORTANT: Write your feedback as a teacher speaking directly to the student. Use "you" and "your" when addressing them. Do NOT use technical terms like "prompt" - instead say "the question", "the task", or "what was asked". Make the feedback feel like a one-on-one tutoring session.

      ${task.task_type === 'task1' ? `This is an IELTS Task 1 Report. The student's submission should describe a visual (e.g., chart, graph, diagram, map, or process). ${imageBase64 ? 'I have provided the actual image/diagram that the student was asked to describe. Please carefully analyze this visual and evaluate how accurately and comprehensively the student has described it.' : 'Please note that you are NOT provided with the actual image, but the textual instructions and any accompanying text content for the task are given below.'} Evaluate the report based on how well it addresses these requirements.

      Task 1 Instructions:
      "${task.instruction}"
      ${task.text_content ? `Additional Task Content: "${task.text_content}"` : ''}` : `This is an IELTS Task 2 Essay. The student's submission should be a response to the essay question provided below.

      Essay Question:
      "${task.instruction}"
      ${task.text_content ? `Essay Topic: "${task.text_content}"` : ''}`}

    Student's Submission:
    "${submission.submission_text}"

    Word Count: ${submission.submission_text.split(/\s+/).filter(Boolean).length}
    Minimum Word Limit: ${task.word_limit_min}
    ${task.word_limit_max ? `Maximum Word Limit: ${task.word_limit_max}` : ''}

    Provide your evaluation focusing on the following IELTS criteria. For each criterion, give a band score (from 0 to 9, in 0.5 increments), identify strengths, point out weaknesses, and offer specific suggestions for improvement. Address the student directly using "you" and "your".
    
    **When providing strengths, weaknesses, and suggestions, use markdown for emphasis:**
    -   Wrap **important words or phrases** in double asterisks for bolding (e.g., **strong vocabulary**).
    -   Wrap ==key terms or examples== in double equals signs for highlighting (e.g., ==cohesive devices==).

    1.  **Task Achievement/Response**:
        -   **Band**: [0-9, in 0.5 increments]
        -   **Strengths**: What you did well in addressing the task, presenting an overview, and supporting main features.
        -   **Weaknesses**: Areas where you could improve in fully addressing the task requirements.
        -   **Suggestions for Improvement**: Actionable advice to enhance your task achievement.
    2.  **Coherence and Cohesion**:
        -   **Band**: [0-9, in 0.5 increments]
        -   **Strengths**: What you did well in organizing your response, logical flow, and use of cohesive devices.
        -   **Weaknesses**: Areas where your organization, paragraphing, or connection between ideas could be clearer.
        -   **Suggestions for Improvement**: Advice to improve the clarity and connection of your ideas.
    3.  **Lexical Resource**:
        -   **Band**: [0-9, in 0.5 increments]
        -   **Strengths**: What you did well in using a range of vocabulary accurately and appropriately.
        -   **Weaknesses**: Areas where your vocabulary could be more varied, precise, or natural.
        -   **Suggestions for Improvement**: Advice on expanding your vocabulary and using less common lexical items effectively.
    4.  **Grammatical Range and Accuracy**:
        -   **Band**: [0-9, in 0.5 increments]
        -   **Strengths**: What you did well in using a variety of grammatical structures accurately.
        -   **Weaknesses**: Common errors or areas where your grammatical control could be improved.
        -   **Suggestions for Improvement**: Advice to enhance your grammatical range and accuracy.
    5.  **Overall Suggestions for Improvement**: Offer general actionable advice and strategies you can use to improve your writing for future IELTS tests.

    Also, provide an **Overall Band Score** (from 0 to 9, in 0.5 increments).
    
    Format your response as a JSON object with the following structure:
    {
      "overall_band": number,
      "evaluation_report": {
        "task_achievement_response": {
          "band": number,
          "strengths": string,
          "weaknesses": string,
          "suggestions_for_improvement": string
        },
        "coherence_and_cohesion": {
          "band": number,
          "strengths": string,
          "weaknesses": string,
          "suggestions_for_improvement": string
        },
        "lexical_resource": {
          "band": number,
          "strengths": string,
          "weaknesses": string,
          "suggestions_for_improvement": string
        },
        "grammatical_range_and_accuracy": {
          "band": number,
          "strengths": string,
          "weaknesses": string,
          "suggestions_for_improvement": string
        },
        "overall_suggestions": string
      }
    }
    
    Ensure your response is ONLY the JSON object, with no additional text or markdown formatting outside of the JSON itself.
    (Using model: ${modelName})`; // Added model name to prompt for debugging/context

      try {
        // Build the request body with optional image for Task 1
        const parts: any[] = [{ text: prompt }];
        
        // Include image for vision-enabled evaluation if available
        if (imageBase64 && task.task_type === 'task1') {
          // Determine image mime type (default to png)
          let mimeType = 'image/png';
          if (task.image_url?.includes('.jpg') || task.image_url?.includes('.jpeg')) {
            mimeType = 'image/jpeg';
          } else if (task.image_url?.includes('.gif')) {
            mimeType = 'image/gif';
          } else if (task.image_url?.includes('.webp')) {
            mimeType = 'image/webp';
          }
          
          parts.push({
            inline_data: {
              mime_type: mimeType,
              data: imageBase64
            }
          });
          console.log(`Including image in request (${mimeType})`);
        }

        const geminiResponse = await fetch(GEMINI_API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            contents: [{ parts }],
          }),
        });

        if (geminiResponse.ok) {
          const geminiData = await geminiResponse.json();
          const content = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
          if (content) {
            responseText = content;
            usedModel = modelName;
            break; // Exit loop on successful response with content
          } else {
            console.warn(`Model ${modelName} returned OK but no content. Trying next model.`);
          }
        } else {
          const errorText = await geminiResponse.text();
          console.error(`Gemini API error with model ${modelName} (Status: ${geminiResponse.status}): ${errorText}`);

          // Check for recoverable errors: rate limit (429), server errors (5xx), or specific messages
          const isRecoverableError = 
            geminiResponse.status === 429 || 
            (geminiResponse.status >= 500 && geminiResponse.status < 600) || // 5xx server errors
            errorText.includes('rate limit') || 
            errorText.includes('overloaded') || 
            errorText.includes('model not found') || 
            errorText.includes('invalid model');

          if (isRecoverableError) {
            console.log(`Recoverable error with model ${modelName}. Trying next model.`);
            continue; // Try next model
          } else {
            // Non-recoverable error, throw it
            throw new Error(`Gemini API error with model ${modelName}: ${geminiResponse.status} - ${errorText}`);
          }
        }
      } catch (fetchError: any) {
        console.error(`Fetch error with model ${modelName}:`, fetchError.message);
        // Network error or other fetch-related issue, try next model
        continue;
      }
    }

    if (!responseText || !usedModel) {
      throw new Error('All Gemini models failed to provide a valid response after multiple attempts.');
    }

    console.log(`Successfully received response from model: ${usedModel}`);

    let evaluationReport: any;
    let overallBand: number | null = null;

    try {
      // Strip markdown code block delimiters before parsing
      responseText = responseText.replace(/```json\n|\n```/g, '').trim();
      console.log('Cleaned Gemini response:', responseText); // Log the cleaned response

      // Attempt to parse the JSON response from Gemini
      const parsedResponse = JSON.parse(responseText);
      overallBand = parsedResponse.overall_band;
      evaluationReport = parsedResponse.evaluation_report;
    } catch (parseError) {
      console.error('Failed to parse Gemini JSON response:', parseError);
      // Fallback: If Gemini doesn't return perfect JSON, try to extract what we can
      evaluationReport = {
        raw_response: responseText,
        parse_error: 'Failed to parse full JSON from Gemini. Raw response provided.',
      };
      // Try to find a band score in the raw text if JSON parsing failed
      const bandMatch = responseText.match(/Overall Band Score:\s*(\d+(\.\d)?)/i);
      if (bandMatch && bandMatch[1]) {
        overallBand = parseFloat(bandMatch[1]);
      }
    }

    // 5. Update submission with evaluation results
    const { error: updateError } = await supabaseClient
      .from('writing_submissions')
      .update({
        evaluation_report: evaluationReport,
        overall_band: overallBand,
      })
      .eq('id', submissionId);

    if (updateError) throw updateError;

    // 6. Implement cleanup: Keep only the last 3 submissions for this user and writing test
    const { data: allTasksForTest, error: tasksForTestError } = await supabaseClient
      .from('writing_tasks')
      .select('id')
      .eq('writing_test_id', task.writing_test_id);

    if (tasksForTestError) {
      console.error('Error fetching tasks for cleanup:', tasksForTestError);
      // Don't throw, cleanup is secondary
    } else if (allTasksForTest && allTasksForTest.length > 0) {
      const allTaskIdsForTest = allTasksForTest.map(t => t.id);

      const { data: userSubmissionsForTest, error: userSubmissionsError } = await supabaseClient
        .from('writing_submissions')
        .select('id, submitted_at')
        .eq('user_id', user.id)
        .in('task_id', allTaskIdsForTest)
        .order('submitted_at', { ascending: false }); // Newest first

      if (userSubmissionsError) {
        console.error('Error fetching user submissions for cleanup:', userSubmissionsError);
      } else if (userSubmissionsForTest) {
        // Group submissions by their submitted_at timestamp to identify unique attempts
        const attemptsMap = new Map<string, string[]>(); // submitted_at -> [submission_ids]
        userSubmissionsForTest.forEach(sub => {
          const submittedAt = sub.submitted_at || 'unknown';
          if (!attemptsMap.has(submittedAt)) {
            attemptsMap.set(submittedAt, []);
          }
          attemptsMap.get(submittedAt)?.push(sub.id);
        });

        // Get sorted unique submitted_at timestamps (representing attempts)
        const sortedAttemptTimestamps = Array.from(attemptsMap.keys()).sort((a, b) => new Date(b).getTime() - new Date(a).getTime());

        if (sortedAttemptTimestamps.length > 3) {
          const timestampsToDelete = sortedAttemptTimestamps.slice(3);
          const submissionIdsToDelete: string[] = [];
          timestampsToDelete.forEach(ts => {
            submissionIdsToDelete.push(...(attemptsMap.get(ts) || []));
          });

          if (submissionIdsToDelete.length > 0) {
            const { error: deleteError } = await supabaseClient
              .from('writing_submissions')
              .delete()
              .in('id', submissionIdsToDelete);

            if (deleteError) {
              console.error('Error deleting old submissions:', deleteError);
            } else {
              console.log(`Deleted ${submissionIdsToDelete.length} old submissions for user ${user.id} and test ${task.writing_test_id}.`);
            }
          }
        }
      }
    }

    // Credits already reserved atomically - no deduction needed

    return new Response(JSON.stringify({ message: 'Evaluation completed successfully', overallBand, evaluationReport }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
    console.error('Edge Function error:', error.message);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});