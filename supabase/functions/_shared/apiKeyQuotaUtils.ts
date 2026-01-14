// Shared utility for API key quota management
// Model types that can hit quota limits - Split-Brain Architecture
// Each feature uses a dedicated model category to prevent quota contamination
export type QuotaModelType = 
  | 'tts'           // Text-to-speech generation
  | 'flash_2_5'     // Standard flash models (gemini-2.5-flash, gemini-2.0-flash)
  | 'flash_lite'    // Speed-optimized lite models (gemini-2.0-flash-lite, tutor/explainer)
  | 'pro_3_0'       // Deep reasoning models (gemini-3-pro-preview, writing evaluation)
  | 'exp_pro';      // Experimental pro models (gemini-exp-1206, test generation)

interface ApiKeyRecord {
  id: string;
  provider: string;
  key_value: string;
  is_active: boolean;
  error_count: number;
  tts_quota_exhausted?: boolean;
  tts_quota_exhausted_date?: string;
  flash_2_5_quota_exhausted?: boolean;
  flash_2_5_quota_exhausted_date?: string;
  flash_lite_quota_exhausted?: boolean;
  flash_lite_quota_exhausted_date?: string;
  pro_3_0_quota_exhausted?: boolean;
  pro_3_0_quota_exhausted_date?: string;
  exp_pro_quota_exhausted?: boolean;
  exp_pro_quota_exhausted_date?: string;
}

// Get today's date in YYYY-MM-DD format
export function getTodayDate(): string {
  return new Date().toISOString().split('T')[0];
}

// Check if a quota exhaustion is still valid (same day)
export function isQuotaExhaustedToday(exhaustedDate: string | null | undefined): boolean {
  if (!exhaustedDate) return false;
  return exhaustedDate === getTodayDate();
}

// Get the quota field names for a given model type
function getQuotaFieldNames(modelType: QuotaModelType): { quotaField: string; quotaDateField: string } {
  switch (modelType) {
    case 'tts':
      return { quotaField: 'tts_quota_exhausted', quotaDateField: 'tts_quota_exhausted_date' };
    case 'flash_lite':
      return { quotaField: 'flash_lite_quota_exhausted', quotaDateField: 'flash_lite_quota_exhausted_date' };
    case 'pro_3_0':
      return { quotaField: 'pro_3_0_quota_exhausted', quotaDateField: 'pro_3_0_quota_exhausted_date' };
    case 'exp_pro':
      return { quotaField: 'exp_pro_quota_exhausted', quotaDateField: 'exp_pro_quota_exhausted_date' };
    case 'flash_2_5':
    default:
      return { quotaField: 'flash_2_5_quota_exhausted', quotaDateField: 'flash_2_5_quota_exhausted_date' };
  }
}

// Fetch active Gemini keys that are not quota-exhausted for the specified model type
export async function getActiveGeminiKeysForModel(
  supabaseServiceClient: any,
  modelType: QuotaModelType
): Promise<ApiKeyRecord[]> {
  try {
    const today = getTodayDate();
    const { quotaField, quotaDateField } = getQuotaFieldNames(modelType);
    
    // First, reset any quotas from previous days
    await supabaseServiceClient.rpc('reset_api_key_quotas');
    
    // Fetch keys that are active and not quota-exhausted for today
    const { data, error } = await supabaseServiceClient
      .from('api_keys')
      .select('id, provider, key_value, is_active, error_count, tts_quota_exhausted, tts_quota_exhausted_date, flash_2_5_quota_exhausted, flash_2_5_quota_exhausted_date, flash_lite_quota_exhausted, flash_lite_quota_exhausted_date, pro_3_0_quota_exhausted, pro_3_0_quota_exhausted_date, exp_pro_quota_exhausted, exp_pro_quota_exhausted_date')
      .eq('provider', 'gemini')
      .eq('is_active', true)
      .or(`${quotaField}.is.null,${quotaField}.eq.false,${quotaDateField}.lt.${today}`)
      .order('error_count', { ascending: true });
    
    if (error) {
      console.error('Failed to fetch API keys:', error);
      return [];
    }
    
    console.log(`Found ${data?.length || 0} active Gemini keys available for ${modelType} model`);
    return data || [];
  } catch (err) {
    console.error('Error fetching API keys:', err);
    return [];
  }
}

// Mark a key as having exhausted its quota for a specific model type
export async function markKeyQuotaExhausted(
  supabaseServiceClient: any,
  keyId: string,
  modelType: QuotaModelType
): Promise<void> {
  try {
    const today = getTodayDate();
    const { quotaField, quotaDateField } = getQuotaFieldNames(modelType);
    
    const updateData: Record<string, any> = {
      [quotaField]: true,
      [quotaDateField]: today,
      updated_at: new Date().toISOString()
    };
    
    await supabaseServiceClient
      .from('api_keys')
      .update(updateData)
      .eq('id', keyId);
    
    console.log(`Marked key ${keyId} as ${modelType} quota exhausted for ${today}`);
  } catch (err) {
    console.error(`Failed to mark key quota exhausted:`, err);
  }
}

// Check if an error indicates *daily quota exhaustion* (NOT per-minute rate limiting)
export function isQuotaExhaustedError(error: any): boolean {
  if (!error) return false;

  const errorMessage = typeof error === 'string'
    ? error
    : (error.message || error.error?.message || '');
  const errorStatus = error.status || error.error?.status || '';

  const msg = String(errorMessage).toLowerCase();

  // IMPORTANT:
  // - 429 "Too Many Requests" is often an RPM/RPS rate limit and should NOT be treated as "daily quota exhausted".
  // - Only treat explicit "quota" / "resource exhausted" style signals as quota exhaustion.
  return (
    errorStatus === 'RESOURCE_EXHAUSTED' ||
    msg.includes('resource_exhausted') ||
    msg.includes('resource exhausted') ||
    msg.includes('quota') ||
    msg.includes('exceeded') && msg.includes('quota') ||
    msg.includes('check your plan') ||
    msg.includes('billing')
  );
}

// Reset quota exhaustion for a key (admin action)
export async function resetKeyQuota(
  supabaseServiceClient: any,
  keyId: string,
  modelType?: QuotaModelType
): Promise<void> {
  try {
    const updateData: any = { updated_at: new Date().toISOString() };
    
    // Reset all quota types if no specific type is provided
    const typesToReset: QuotaModelType[] = modelType 
      ? [modelType] 
      : ['tts', 'flash_2_5', 'flash_lite', 'pro_3_0', 'exp_pro'];
    
    for (const type of typesToReset) {
      const { quotaField, quotaDateField } = getQuotaFieldNames(type);
      updateData[quotaField] = false;
      updateData[quotaDateField] = null;
    }
    
    await supabaseServiceClient
      .from('api_keys')
      .update(updateData)
      .eq('id', keyId);
    
    console.log(`Reset ${modelType || 'all'} quota for key ${keyId}`);
  } catch (err) {
    console.error('Failed to reset key quota:', err);
  }
}
