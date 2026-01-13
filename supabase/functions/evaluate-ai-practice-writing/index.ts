import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { crypto } from "https://deno.land/std@0.168.0/crypto/mod.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash'];

// DB-managed API key interface
interface ApiKeyRecord {
  id: string;
  provider: string;
  key_value: string;
  is_active: boolean;
  error_count: number;
}

// Fetch active Gemini keys from api_keys table with rotation support
async function getActiveGeminiKeys(supabaseServiceClient: any): Promise<ApiKeyRecord[]> {
  try {
    const { data, error } = await supabaseServiceClient
      .from('api_keys')
      .select('id, provider, key_value, is_active, error_count')
      .eq('provider', 'gemini')
      .eq('is_active', true)
      .order('error_count', { ascending: true });
    
    if (error) {
      console.error('[evaluate-ai-practice-writing] Failed to fetch API keys:', error);
      return [];
    }
    
    return data || [];
  } catch (err) {
    console.error('[evaluate-ai-practice-writing] Error fetching API keys:', err);
    return [];
  }
}

// Increment error count for a failed key
async function incrementKeyErrorCount(supabaseServiceClient: any, keyId: string, deactivate: boolean = false): Promise<void> {
  try {
    if (deactivate) {
      await supabaseServiceClient
        .from('api_keys')
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq('id', keyId);
    } else {
      const { data: currentKey } = await supabaseServiceClient
        .from('api_keys')
        .select('error_count')
        .eq('id', keyId)
        .single();
      
      if (currentKey) {
        await supabaseServiceClient
          .from('api_keys')
          .update({ 
            error_count: (currentKey.error_count || 0) + 1,
            updated_at: new Date().toISOString()
          })
          .eq('id', keyId);
      }
    }
  } catch (err) {
    console.error('[evaluate-ai-practice-writing] Failed to update key error count:', err);
  }
}

// Reset error count on successful use
async function resetKeyErrorCount(supabaseServiceClient: any, keyId: string): Promise<void> {
  try {
    await supabaseServiceClient
      .from('api_keys')
      .update({ error_count: 0, updated_at: new Date().toISOString() })
      .eq('id', keyId);
  } catch (err) {
    console.error('[evaluate-ai-practice-writing] Failed to reset key error count:', err);
  }
}

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

// Error classification for user-friendly messages
interface GeminiErrorInfo {
  code: string;
  userMessage: string;
  isQuota: boolean;
  isRateLimit: boolean;
  isInvalidKey: boolean;
}

function classifyGeminiError(status: number, errorText: string): GeminiErrorInfo {
  const lower = errorText.toLowerCase();
  
  if (status === 429 || lower.includes('quota') || lower.includes('resource_exhausted')) {
    return {
      code: 'QUOTA_EXCEEDED',
      userMessage: 'Gemini API quota exceeded. Please wait a few minutes or check your Google AI Studio billing.',
      isQuota: true,
      isRateLimit: false,
      isInvalidKey: false,
    };
  }
  
  if (lower.includes('rate limit') || lower.includes('too many requests')) {
    return {
      code: 'RATE_LIMITED',
      userMessage: 'Too many requests. Please wait 30 seconds and try again.',
      isQuota: false,
      isRateLimit: true,
      isInvalidKey: false,
    };
  }
  
  if (status === 400 && (lower.includes('api_key') || lower.includes('api key'))) {
    return {
      code: 'INVALID_API_KEY',
      userMessage: 'Invalid Gemini API key. Please update your API key in Settings.',
      isQuota: false,
      isRateLimit: false,
      isInvalidKey: true,
    };
  }
  
  if (status === 403) {
    return {
      code: 'PERMISSION_DENIED',
      userMessage: 'API access denied. Your key may not have permissions for this model.',
      isQuota: false,
      isRateLimit: false,
      isInvalidKey: false,
    };
  }
  
  return {
    code: 'UNKNOWN_ERROR',
    userMessage: 'An unexpected error occurred. Please try again.',
    isQuota: false,
    isRateLimit: false,
    isInvalidKey: false,
  };
}

interface EvaluationRequest {
  submissionText: string;
  taskType: 'task1' | 'task2';
  instruction: string;
  imageDescription?: string;
  imageBase64?: string;
  visualType?: string;
  isFullTest?: boolean;
  task1Text?: string;
  task2Text?: string;
  task1Instruction?: string;
  task2Instruction?: string;
  task1ImageBase64?: string;
  task1VisualType?: string;
}

function getWritingEvaluationPrompt(
  taskType: 'task1' | 'task2',
  instruction: string,
  submissionText: string,
  wordCount: number,
  imageDescription?: string,
  visualType?: string
): string {
  const isTask1 = taskType === 'task1';
  
  const task1Criteria = `
TASK 1 SPECIFIC BAND DESCRIPTORS:

TASK ACHIEVEMENT (assess how well the task requirements are fulfilled):
- Band 9: Fully satisfies all requirements; clearly presents a fully developed response with relevant, extended and well-supported ideas
- Band 8: Sufficiently addresses all parts of the task; presents a well-developed response with relevant, extended and supported ideas
- Band 7: Addresses all parts of the task; presents a clear overview with appropriately highlighted key features/bullet points
- Band 6: Addresses the requirements of the task; presents an overview with some key features highlighted
- Band 5: Generally addresses the task; format may be inappropriate in places; recounts detail mechanically
- Band 4: Attempts to address the task but does not cover all key features; format may be inappropriate
- Band 3: Does not adequately address the task; no clear overview; key features largely irrelevant

COHERENCE AND COHESION (assess organization and logical flow):
- Band 9: Uses cohesion in such a way that it attracts no attention; skilfully manages paragraphing
- Band 8: Sequences information and ideas logically; manages all aspects of cohesion well; uses paragraphing sufficiently and appropriately
- Band 7: Logically organises information and ideas; clear progression throughout; uses a range of cohesive devices appropriately
- Band 6: Arranges information and ideas coherently; uses cohesive devices effectively, but cohesion within sentences may be faulty
- Band 5: Presents information with some organisation but no overall progression; inadequate or overused cohesive devices
- Band 4: Presents information and ideas but not arranged coherently; uses some basic cohesive devices
- Band 3: Does not organise ideas logically; very limited use of cohesive devices

LEXICAL RESOURCE (assess vocabulary range and accuracy):
- Band 9: Uses a wide range of vocabulary with very natural and sophisticated control of lexical features
- Band 8: Uses a wide range of vocabulary fluently and flexibly; skilfully uses uncommon lexical items
- Band 7: Uses a sufficient range of vocabulary to allow some flexibility and precision; uses less common lexical items with some awareness of style
- Band 6: Uses an adequate range of vocabulary for the task; attempts to use less common vocabulary with some inaccuracy
- Band 5: Uses a limited range of vocabulary; may make noticeable errors in spelling and word formation
- Band 4: Uses only basic vocabulary; makes numerous errors in spelling and word formation
- Band 3: Uses only a very limited range of words and expressions; errors in word formation are frequent

GRAMMATICAL RANGE AND ACCURACY (assess sentence structures and error frequency):
- Band 9: Uses a wide range of structures with full flexibility and accuracy; rare minor errors occur only as slips
- Band 8: Uses a wide range of structures; the majority of sentences are error-free; makes only very occasional errors
- Band 7: Uses a variety of complex structures; produces frequent error-free sentences; has good control of grammar and punctuation
- Band 6: Uses a mix of simple and complex sentence forms; makes some errors in grammar and punctuation
- Band 5: Uses only a limited range of structures; attempts complex sentences but with limited accuracy
- Band 4: Uses only a very limited range of structures; rare use of subordinate clauses; errors predominate
- Band 3: Attempts sentence forms but errors in grammar and punctuation predominate`;

  const task2Criteria = `
TASK 2 SPECIFIC BAND DESCRIPTORS:

TASK RESPONSE (assess how well the essay addresses the task):
- Band 9: Fully addresses all parts of the task; presents a fully developed position with relevant, fully extended and well-supported ideas
- Band 8: Sufficiently addresses all parts of the task; presents a well-developed response with relevant, extended and supported ideas
- Band 7: Addresses all parts of the task; presents a clear position throughout the response; presents, extends and supports main ideas
- Band 6: Addresses all parts of the task although some parts may be more fully covered than others; presents a relevant position
- Band 5: Addresses the task only partially; the format may be inappropriate in places; expresses a position but development is not always clear
- Band 4: Responds to the task only in a minimal way; the format may be inappropriate; position may be unclear
- Band 3: Does not adequately address any part of the task; does not express a clear position

COHERENCE AND COHESION (assess organization and logical flow):
- Band 9: Uses cohesion in such a way that it attracts no attention; skilfully manages paragraphing
- Band 8: Sequences information and ideas logically; manages all aspects of cohesion well; uses paragraphing sufficiently and appropriately
- Band 7: Logically organises information and ideas; clear progression throughout; uses a range of cohesive devices appropriately
- Band 6: Arranges information and ideas coherently; uses cohesive devices effectively, but cohesion within sentences may be faulty
- Band 5: Presents information with some organisation but no overall progression; inadequate or overused cohesive devices
- Band 4: Presents information and ideas but not arranged coherently; uses some basic cohesive devices
- Band 3: Does not organise ideas logically; very limited use of cohesive devices

LEXICAL RESOURCE (assess vocabulary range and accuracy):
- Band 9: Uses a wide range of vocabulary with very natural and sophisticated control of lexical features
- Band 8: Uses a wide range of vocabulary fluently and flexibly; skilfully uses uncommon lexical items with occasional inaccuracies
- Band 7: Uses a sufficient range of vocabulary to allow some flexibility and precision; uses less common lexical items with awareness of style
- Band 6: Uses an adequate range of vocabulary for the task; attempts to use less common vocabulary with some inaccuracy
- Band 5: Uses a limited range of vocabulary; may make noticeable errors in spelling and word formation
- Band 4: Uses only basic vocabulary; control of word formation and spelling is weak
- Band 3: Uses only a very limited range of words and expressions; errors in word formation are common

GRAMMATICAL RANGE AND ACCURACY (assess sentence structures and error frequency):
- Band 9: Uses a wide range of structures with full flexibility and accuracy; rare minor errors occur only as slips
- Band 8: Uses a wide range of structures; the majority of sentences are error-free; makes only very occasional errors
- Band 7: Uses a variety of complex structures; produces frequent error-free sentences; has good control of grammar and punctuation
- Band 6: Uses a mix of simple and complex sentence forms; makes some errors in grammar and punctuation
- Band 5: Uses only a limited range of structures; attempts complex sentences but with limited accuracy
- Band 4: Uses only a very limited range of structures; subordinate clauses are rare; errors predominate
- Band 3: Attempts sentence forms but errors in grammar and punctuation predominate`;

  const wordCountGuidance = isTask1 
    ? `Word count requirement: Minimum 150 words. Candidate wrote ${wordCount} words.${wordCount < 150 ? ' PENALTY: Under word count will affect Task Achievement score.' : ''}`
    : `Word count requirement: Minimum 250 words. Candidate wrote ${wordCount} words.${wordCount < 250 ? ' PENALTY: Under word count will affect Task Response score.' : ''}`;

  const visualContext = isTask1 && visualType 
    ? `\nVISUAL TYPE: ${visualType}${imageDescription ? `\nIMAGE DESCRIPTION: ${imageDescription}` : ''}\n\nIMPORTANT: Evaluate how accurately and completely the candidate has described the data/visual elements. For ${visualType}, check for:\n- Accurate data interpretation\n- Key trends and comparisons\n- Appropriate overview\n- Relevant details selected`
    : '';

  return `You are an expert IELTS Writing examiner (2025 standards). Evaluate this ${isTask1 ? 'Task 1 Report' : 'Task 2 Essay'} submission with professional rigor.

TASK INSTRUCTIONS: "${instruction}"
${visualContext}
${wordCountGuidance}

CANDIDATE'S SUBMISSION:
"""
${submissionText}
"""

${isTask1 ? task1Criteria : task2Criteria}

CRITICAL SCORING GUIDELINES:
1. Score each criterion INDEPENDENTLY based on the specific evidence you observe
2. Each criterion measures DIFFERENT skills - a candidate may excel in vocabulary but struggle with grammar
3. Use half-band scores (5.5, 6.5, 7.5) when performance falls between bands
4. Justify each score with specific examples from the text
5. Calculate overall band as the arithmetic mean of all four criteria (rounded to nearest 0.5)
6. Be strict but fair - real IELTS examiners rarely give 8+ bands
7. Address the candidate directly using "you" and "your" in feedback

IMPORTANT DIFFERENTIATION:
- A candidate with excellent vocabulary but poor grammar should show DIFFERENT scores for those criteria
- A well-organized essay with limited vocabulary should score HIGH on coherence but LOWER on lexical resource
- Consider each criterion in isolation based ONLY on evidence relevant to that skill

Respond with ONLY valid JSON in this exact format:
{
  "overall_band": number,
  "evaluation_report": {
    "${isTask1 ? 'task_achievement' : 'task_response'}": {
      "band": number,
      "feedback": "Detailed feedback addressing the candidate directly...",
      "strengths": ["specific strength 1", "specific strength 2"],
      "weaknesses": ["specific weakness 1", "specific weakness 2"],
      "examples": ["quote from text demonstrating assessment"]
    },
    "coherence_cohesion": {
      "band": number,
      "feedback": "Detailed feedback on organization...",
      "strengths": ["specific strength"],
      "weaknesses": ["specific weakness"],
      "examples": ["example from text"]
    },
    "lexical_resource": {
      "band": number,
      "feedback": "Detailed feedback on vocabulary...",
      "strengths": ["specific strength"],
      "weaknesses": ["specific weakness"],
      "examples": ["vocabulary examples from text"],
      "vocabulary_upgrades": [
        {"original": "word used", "suggested": "better alternative", "context": "sentence context"}
      ]
    },
    "grammatical_accuracy": {
      "band": number,
      "feedback": "Detailed feedback on grammar...",
      "strengths": ["specific strength"],
      "weaknesses": ["specific weakness"],
      "examples": ["grammar examples from text"],
      "error_corrections": [
        {"error": "incorrect phrase", "correction": "corrected version", "explanation": "brief explanation"}
      ]
    },
    "overall_feedback": "Comprehensive summary addressing the candidate directly...",
    "key_strengths": ["main strength 1", "main strength 2", "main strength 3"],
    "priority_improvements": ["most important improvement 1", "improvement 2", "improvement 3"],
    "model_paragraph": "A sample paragraph demonstrating ideal writing for this task..."
  }
}`;
}

function getFullTestEvaluationPrompt(
  task1Instruction: string,
  task1Text: string,
  task1WordCount: number,
  task2Instruction: string,
  task2Text: string,
  task2WordCount: number,
  task1VisualType?: string,
  task1ImageDescription?: string
): string {
  return `You are an expert IELTS Writing examiner (2025 standards). Evaluate this FULL WRITING TEST with both Task 1 and Task 2.

=== TASK 1 (Report) ===
Instructions: "${task1Instruction}"
${task1VisualType ? `Visual Type: ${task1VisualType}` : ''}
${task1ImageDescription ? `Image Description: ${task1ImageDescription}` : ''}
Word Count: ${task1WordCount} words (minimum 150 required)

Candidate's Task 1 Response:
"""
${task1Text}
"""

=== TASK 2 (Essay) ===
Instructions: "${task2Instruction}"
Word Count: ${task2WordCount} words (minimum 250 required)

Candidate's Task 2 Response:
"""
${task2Text}
"""

SCORING GUIDELINES:
- Task 1 contributes 1/3 to overall score
- Task 2 contributes 2/3 to overall score
- Score each task independently on all four criteria
- Use half-band scores when appropriate
- Address the candidate directly using "you" and "your"

Respond with ONLY valid JSON:
{
  "overall_band": number,
  "task1_band": number,
  "task2_band": number,
  "task1_evaluation": {
    "task_achievement": { "band": number, "feedback": string, "strengths": [], "weaknesses": [], "examples": [] },
    "coherence_cohesion": { "band": number, "feedback": string, "strengths": [], "weaknesses": [], "examples": [] },
    "lexical_resource": { "band": number, "feedback": string, "strengths": [], "weaknesses": [], "vocabulary_upgrades": [] },
    "grammatical_accuracy": { "band": number, "feedback": string, "strengths": [], "weaknesses": [], "error_corrections": [] },
    "overall_feedback": string,
    "key_strengths": [],
    "priority_improvements": []
  },
  "task2_evaluation": {
    "task_response": { "band": number, "feedback": string, "strengths": [], "weaknesses": [], "examples": [] },
    "coherence_cohesion": { "band": number, "feedback": string, "strengths": [], "weaknesses": [], "examples": [] },
    "lexical_resource": { "band": number, "feedback": string, "strengths": [], "weaknesses": [], "vocabulary_upgrades": [] },
    "grammatical_accuracy": { "band": number, "feedback": string, "strengths": [], "weaknesses": [], "error_corrections": [] },
    "overall_feedback": string,
    "key_strengths": [],
    "priority_improvements": []
  },
  "combined_feedback": {
    "overall_assessment": string,
    "writing_style_notes": string,
    "time_management_tips": string,
    "next_steps": []
  }
}`;
}

interface GeminiCallResult {
  success: boolean;
  text?: string;
  error?: GeminiErrorInfo;
  shouldFallbackToPool?: boolean;
}

async function callGeminiWithImage(
  apiKey: string, 
  prompt: string, 
  imageBase64?: string,
  supabaseService?: any,
  poolKeyId?: string
): Promise<GeminiCallResult> {
  for (const model of GEMINI_MODELS) {
    try {
      const parts: any[] = [{ text: prompt }];
      
      // Add image if provided
      if (imageBase64) {
        const base64Data = imageBase64.includes(',') 
          ? imageBase64.split(',')[1] 
          : imageBase64;
        
        parts.push({
          inlineData: {
            mimeType: 'image/png',
            data: base64Data
          }
        });
      }

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts }],
            generationConfig: { 
              temperature: 0.5,
              maxOutputTokens: 8192,
              responseMimeType: 'application/json'
            },
          }),
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Model ${model} failed (${response.status}):`, errorText.slice(0, 300));
        
        const errorInfo = classifyGeminiError(response.status, errorText);
        
        // If pool key failed with quota/rate limit, try next key
        if (poolKeyId && supabaseService && (errorInfo.isQuota || errorInfo.isRateLimit)) {
          await incrementKeyErrorCount(supabaseService, poolKeyId, false);
          return { success: false, error: errorInfo };
        }
        
        // If invalid pool key, deactivate it
        if (poolKeyId && supabaseService && errorInfo.isInvalidKey) {
          await incrementKeyErrorCount(supabaseService, poolKeyId, true);
          return { success: false, error: errorInfo };
        }
        
        // For user key quota/rate limit, signal to fallback to pool
        if (!poolKeyId && (errorInfo.isQuota || errorInfo.isRateLimit)) {
          return { success: false, error: errorInfo, shouldFallbackToPool: true };
        }
        
        continue; // Try next model
      }

      const data = await response.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) {
        // Reset error count on success for pool keys
        if (poolKeyId && supabaseService) {
          await resetKeyErrorCount(supabaseService, poolKeyId);
        }
        return { success: true, text };
      }
    } catch (err) {
      console.error(`Model ${model} error:`, err);
      continue;
    }
  }
  return { success: false, error: { code: 'ALL_MODELS_FAILED', userMessage: 'All AI models failed. Please try again.', isQuota: false, isRateLimit: false, isInvalidKey: false } };
}

function parseJsonResponse(responseText: string): any {
  try {
    // Try to extract JSON from markdown code blocks
    const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[1].trim());
    }
    // Try direct JSON parsing
    return JSON.parse(responseText.trim());
  } catch {
    // Try to find JSON object in the response
    const objectMatch = responseText.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      try {
        return JSON.parse(objectMatch[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

serve(async (req) => {
  const startTime = Date.now();
  console.log(`[evaluate-ai-practice-writing] Request received`);

  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const appEncryptionKey = Deno.env.get('app_encryption_key');
    
    const supabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: req.headers.get('Authorization')! } }
    });
    const supabaseService = createClient(supabaseUrl, supabaseServiceKey);

    const { data: { user } } = await supabaseClient.auth.getUser();
    if (!user) {
      return new Response(JSON.stringify({ error: 'Unauthorized', code: 'UNAUTHORIZED' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!appEncryptionKey) {
      return new Response(JSON.stringify({ error: 'Server configuration error', code: 'SERVER_CONFIG_ERROR' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Load pool keys for fallback
    const activePoolKeys = await getActiveGeminiKeys(supabaseService);
    console.log(`[evaluate-ai-practice-writing] Found ${activePoolKeys.length} active pool keys`);

    // Try to get user's API key first
    let userApiKey: string | null = null;
    let usingUserKey = false;
    
    const { data: secretData } = await supabaseClient
      .from('user_secrets')
      .select('encrypted_value')
      .eq('user_id', user.id)
      .eq('secret_name', 'GEMINI_API_KEY')
      .single();

    if (secretData) {
      try {
        userApiKey = await decryptApiKey(secretData.encrypted_value, appEncryptionKey);
        usingUserKey = true;
        console.log('[evaluate-ai-practice-writing] User API key found');
      } catch (err) {
        console.error('[evaluate-ai-practice-writing] Failed to decrypt user key:', err);
      }
    }
    
    // Check if we have any API key available
    if (!userApiKey && activePoolKeys.length === 0) {
      return new Response(JSON.stringify({ 
        error: 'QUOTA_EXCEEDED: All API keys have reached their rate limit. Please wait a few minutes and try again.',
        code: 'QUOTA_EXCEEDED',
        errorType: 'QUOTA_EXCEEDED',
        suggestion: 'Add your own Gemini API key in Settings for unlimited access.'
      }), {
        status: 429,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const body: EvaluationRequest = await req.json();
    const { 
      submissionText, 
      taskType, 
      instruction, 
      imageDescription, 
      imageBase64,
      visualType,
      isFullTest,
      task1Text,
      task2Text,
      task1Instruction,
      task2Instruction,
      task1ImageBase64,
      task1VisualType
    } = body;

    let evaluationPrompt: string;
    let imageToInclude: string | undefined;

    if (isFullTest && task1Text && task2Text) {
      // Full test evaluation
      const task1WordCount = task1Text.trim().split(/\s+/).filter(Boolean).length;
      const task2WordCount = task2Text.trim().split(/\s+/).filter(Boolean).length;
      
      evaluationPrompt = getFullTestEvaluationPrompt(
        task1Instruction || 'Describe the visual data',
        task1Text,
        task1WordCount,
        task2Instruction || 'Write an essay',
        task2Text,
        task2WordCount,
        task1VisualType,
        imageDescription
      );
      imageToInclude = task1ImageBase64;
      
      console.log(`[evaluate-ai-practice-writing] Full test: Task1=${task1WordCount} words, Task2=${task2WordCount} words`);
    } else {
      // Single task evaluation
      const wordCount = submissionText.trim().split(/\s+/).filter(Boolean).length;
      
      evaluationPrompt = getWritingEvaluationPrompt(
        taskType,
        instruction,
        submissionText,
        wordCount,
        imageDescription,
        visualType
      );
      imageToInclude = imageBase64;
      
      console.log(`[evaluate-ai-practice-writing] Single task: ${taskType}, ${wordCount} words`);
    }

    // Try user key first, then fall back to pool
    let result: GeminiCallResult | null = null;
    let lastError: GeminiErrorInfo | null = null;
    
    if (userApiKey) {
      console.log('[evaluate-ai-practice-writing] Trying user API key first');
      result = await callGeminiWithImage(userApiKey, evaluationPrompt, imageToInclude);
      
      if (result.success) {
        console.log('[evaluate-ai-practice-writing] User key succeeded');
      } else if (result.shouldFallbackToPool && activePoolKeys.length > 0) {
        console.log('[evaluate-ai-practice-writing] User key failed, falling back to pool');
        lastError = result.error || null;
        result = null; // Reset to try pool
      } else if (result.error) {
        lastError = result.error;
      }
    }
    
    // Try pool keys if user key failed or not available
    if (!result?.success && activePoolKeys.length > 0) {
      for (const poolKey of activePoolKeys) {
        console.log(`[evaluate-ai-practice-writing] Trying pool key ${poolKey.id.slice(0, 8)}...`);
        result = await callGeminiWithImage(poolKey.key_value, evaluationPrompt, imageToInclude, supabaseService, poolKey.id);
        
        if (result.success) {
          console.log('[evaluate-ai-practice-writing] Pool key succeeded');
          break;
        }
        lastError = result.error || null;
      }
    }
    
    if (!result?.success || !result.text) {
      console.error('[evaluate-ai-practice-writing] All API keys failed');
      const errorMessage = lastError?.userMessage || 'All API keys have reached their rate limit. Please wait a few minutes and try again.';
      return new Response(JSON.stringify({ 
        error: `QUOTA_EXCEEDED: ${errorMessage}`,
        code: lastError?.code || 'QUOTA_EXCEEDED',
        errorType: lastError?.code || 'QUOTA_EXCEEDED',
        suggestion: 'Add your own Gemini API key in Settings for unlimited access.'
      }), {
        status: 429,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const parsed = parseJsonResponse(result.text);
    
    if (!parsed) {
      console.error('[evaluate-ai-practice-writing] Failed to parse JSON response');
      return new Response(JSON.stringify({ 
        overall_band: 5.5,
        evaluation_report: { 
          overall_feedback: result.text,
          task_achievement: { band: 5.5, feedback: 'Evaluation parsing failed. Raw response preserved.' },
          coherence_cohesion: { band: 5.5, feedback: '' },
          lexical_resource: { band: 5.5, feedback: '' },
          grammatical_accuracy: { band: 5.5, feedback: '' }
        }
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const elapsed = Date.now() - startTime;
    console.log(`[evaluate-ai-practice-writing] Completed in ${elapsed}ms, overall band: ${parsed.overall_band}`);

    return new Response(JSON.stringify(parsed), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
    const elapsed = Date.now() - startTime;
    console.error(`[evaluate-ai-practice-writing] Error after ${elapsed}ms:`, error);
    return new Response(JSON.stringify({ 
      error: error.message,
      code: 'UNKNOWN_ERROR'
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
