// Shared utility for API key quota management
// Model types that can hit quota limits
export type QuotaModelType = 'tts' | 'flash_2_5';

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

// Fetch active Gemini keys that are not quota-exhausted for the specified model type
export async function getActiveGeminiKeysForModel(
  supabaseServiceClient: any,
  modelType: QuotaModelType
): Promise<ApiKeyRecord[]> {
  try {
    const today = getTodayDate();
    const quotaField = modelType === 'tts' ? 'tts_quota_exhausted' : 'flash_2_5_quota_exhausted';
    const quotaDateField = modelType === 'tts' ? 'tts_quota_exhausted_date' : 'flash_2_5_quota_exhausted_date';
    
    // First, reset any quotas from previous days
    await supabaseServiceClient.rpc('reset_api_key_quotas');
    
    // Fetch keys that are active and not quota-exhausted for today
    const { data, error } = await supabaseServiceClient
      .from('api_keys')
      .select('id, provider, key_value, is_active, error_count, tts_quota_exhausted, tts_quota_exhausted_date, flash_2_5_quota_exhausted, flash_2_5_quota_exhausted_date')
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
    const updateData = modelType === 'tts' 
      ? { tts_quota_exhausted: true, tts_quota_exhausted_date: today, updated_at: new Date().toISOString() }
      : { flash_2_5_quota_exhausted: true, flash_2_5_quota_exhausted_date: today, updated_at: new Date().toISOString() };
    
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
    
    if (!modelType || modelType === 'tts') {
      updateData.tts_quota_exhausted = false;
      updateData.tts_quota_exhausted_date = null;
    }
    if (!modelType || modelType === 'flash_2_5') {
      updateData.flash_2_5_quota_exhausted = false;
      updateData.flash_2_5_quota_exhausted_date = null;
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
