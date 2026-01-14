// Shared utility for logging AI model performance to the model_performance_logs table
// This enables the Model Performance Analytics dashboard to track all AI calls

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

export type TaskType = 
  | 'generate'           // Test generation (reading, listening, writing, speaking)
  | 'evaluate_writing'   // Writing submission evaluation
  | 'evaluate_speaking'  // Speaking submission evaluation
  | 'explain'            // Answer explanation / tutoring
  | 'tts'                // Text-to-speech generation
  | 'transcribe'         // Audio transcription
  | 'analyze'            // Performance analysis
  | 'translate';         // Word translation

export type LogStatus = 'success' | 'error' | 'quota_exceeded';

export interface PerformanceLogEntry {
  modelName: string;
  taskType: TaskType;
  status: LogStatus;
  responseTimeMs?: number;
  errorMessage?: string;
  apiKeyId?: string;
}

// Create a service client for logging (uses service role to bypass RLS)
function createServiceClient(): SupabaseClient {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Missing Supabase configuration for performance logging');
  }
  
  return createClient(supabaseUrl, serviceRoleKey);
}

/**
 * Log a single AI model call to the performance tracking table.
 * This is fire-and-forget - errors are logged but don't throw.
 */
export async function logModelPerformance(
  entry: PerformanceLogEntry,
  serviceClient?: SupabaseClient
): Promise<void> {
  try {
    const client = serviceClient || createServiceClient();
    
    const { error } = await client.rpc('log_model_performance', {
      p_api_key_id: entry.apiKeyId || null,
      p_model_name: entry.modelName,
      p_task_type: entry.taskType,
      p_status: entry.status,
      p_response_time_ms: entry.responseTimeMs || null,
      p_error_message: entry.errorMessage || null,
    });
    
    if (error) {
      console.warn('[PerformanceLogger] Failed to log performance:', error.message);
    } else {
      console.log(`[PerformanceLogger] Logged ${entry.status} for ${entry.modelName} (${entry.taskType})`);
    }
  } catch (err) {
    // Don't throw - logging should never break the main flow
    console.warn('[PerformanceLogger] Error logging performance:', err);
  }
}

/**
 * Helper to time an AI call and log the result.
 * Wraps any async function and automatically logs success/error with timing.
 */
export async function withPerformanceLogging<T>(
  modelName: string,
  taskType: TaskType,
  fn: () => Promise<T>,
  options?: {
    serviceClient?: SupabaseClient;
    apiKeyId?: string;
  }
): Promise<T> {
  const startTime = Date.now();
  
  try {
    const result = await fn();
    const responseTimeMs = Date.now() - startTime;
    
    // Log success
    await logModelPerformance({
      modelName,
      taskType,
      status: 'success',
      responseTimeMs,
      apiKeyId: options?.apiKeyId,
    }, options?.serviceClient);
    
    return result;
  } catch (error) {
    const responseTimeMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    // Determine if this is a quota error
    const isQuota = errorMessage.toLowerCase().includes('quota') ||
                    errorMessage.toLowerCase().includes('resource_exhausted') ||
                    errorMessage.toLowerCase().includes('resource exhausted');
    
    // Log error or quota_exceeded
    await logModelPerformance({
      modelName,
      taskType,
      status: isQuota ? 'quota_exceeded' : 'error',
      responseTimeMs,
      errorMessage: errorMessage.slice(0, 500), // Truncate long errors
      apiKeyId: options?.apiKeyId,
    }, options?.serviceClient);
    
    throw error; // Re-throw so caller can handle
  }
}

/**
 * Create a logger instance bound to a specific task type and optional service client.
 * Useful for edge functions that make multiple AI calls.
 */
export function createPerformanceLogger(
  taskType: TaskType,
  serviceClient?: SupabaseClient
) {
  return {
    logSuccess: (modelName: string, responseTimeMs: number, apiKeyId?: string) => 
      logModelPerformance({
        modelName,
        taskType,
        status: 'success',
        responseTimeMs,
        apiKeyId,
      }, serviceClient),
    
    logError: (modelName: string, errorMessage: string, responseTimeMs?: number, apiKeyId?: string) =>
      logModelPerformance({
        modelName,
        taskType,
        status: 'error',
        responseTimeMs,
        errorMessage: errorMessage.slice(0, 500),
        apiKeyId,
      }, serviceClient),
    
    logQuotaExceeded: (modelName: string, errorMessage: string, apiKeyId?: string) =>
      logModelPerformance({
        modelName,
        taskType,
        status: 'quota_exceeded',
        errorMessage: errorMessage.slice(0, 500),
        apiKeyId,
      }, serviceClient),
  };
}

/**
 * Classify an error response from Gemini API and return appropriate status
 */
export function classifyGeminiErrorStatus(
  httpStatus: number,
  errorMessage: string
): LogStatus {
  const msg = errorMessage.toLowerCase();
  
  // Quota exhaustion indicators
  if (
    httpStatus === 429 ||
    msg.includes('resource_exhausted') ||
    msg.includes('resource exhausted') ||
    msg.includes('quota') ||
    msg.includes('check your plan') ||
    msg.includes('billing')
  ) {
    return 'quota_exceeded';
  }
  
  return 'error';
}
