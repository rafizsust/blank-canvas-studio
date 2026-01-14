// Shared utility for User API key pool management
// Similar to admin api_keys but for individual users

export type QuotaModelType = 'tts' | 'flash_2_5';

interface UserApiKeyRecord {
  id: string;
  user_id: string;
  provider: string;
  key_value: string;
  is_active: boolean;
  tts_quota_exhausted?: boolean;
  tts_quota_exhausted_date?: string;
  flash_2_5_quota_exhausted?: boolean;
  flash_2_5_quota_exhausted_date?: string;
}

// Get today's date in YYYY-MM-DD format
export function getTodayDate(): string {
  return new Date().toISOString().split('T')[0];
}

// Fetch active user API keys for a specific model type
export async function getUserActiveKeysForModel(
  supabaseServiceClient: any,
  userId: string,
  modelType: QuotaModelType
): Promise<UserApiKeyRecord[]> {
  try {
    const today = getTodayDate();
    const quotaField = modelType === 'tts' ? 'tts_quota_exhausted' : 'flash_2_5_quota_exhausted';
    const quotaDateField = modelType === 'tts' ? 'tts_quota_exhausted_date' : 'flash_2_5_quota_exhausted_date';
    
    // First, reset any quotas from previous days
    await supabaseServiceClient.rpc('reset_user_api_key_quotas');
    
    // Fetch user's active keys that are not quota-exhausted for today
    const { data, error } = await supabaseServiceClient
      .from('user_api_keys')
      .select('*')
      .eq('user_id', userId)
      .eq('provider', 'gemini')
      .eq('is_active', true)
      .or(`${quotaField}.is.null,${quotaField}.eq.false,${quotaDateField}.lt.${today}`);
    
    if (error) {
      console.error('Failed to fetch user API keys:', error);
      return [];
    }
    
    console.log(`Found ${data?.length || 0} active user API keys for ${modelType} model`);
    return data || [];
  } catch (err) {
    console.error('Error fetching user API keys:', err);
    return [];
  }
}

// Mark a user's key as having exhausted its quota for a specific model type
export async function markUserKeyQuotaExhausted(
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
      .from('user_api_keys')
      .update(updateData)
      .eq('id', keyId);
    
    console.log(`Marked user key ${keyId} as ${modelType} quota exhausted for ${today}`);
  } catch (err) {
    console.error(`Failed to mark user key quota exhausted:`, err);
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

// Get combined keys: user keys first, then admin keys as fallback
export async function getCombinedActiveKeys(
  supabaseServiceClient: any,
  userId: string,
  modelType: QuotaModelType
): Promise<{ keys: UserApiKeyRecord[]; isUserKey: boolean[] }> {
  // First try to get user's own keys
  const userKeys = await getUserActiveKeysForModel(supabaseServiceClient, userId, modelType);
  
  if (userKeys.length > 0) {
    console.log(`Using ${userKeys.length} user API keys`);
    return { 
      keys: userKeys, 
      isUserKey: userKeys.map(() => true) 
    };
  }
  
  // Fallback to admin keys (from api_keys table)
  console.log('No user API keys available, falling back to admin keys');
  const today = getTodayDate();
  const quotaField = modelType === 'tts' ? 'tts_quota_exhausted' : 'flash_2_5_quota_exhausted';
  const quotaDateField = modelType === 'tts' ? 'tts_quota_exhausted_date' : 'flash_2_5_quota_exhausted_date';
  
  try {
    await supabaseServiceClient.rpc('reset_api_key_quotas');
    
    const { data, error } = await supabaseServiceClient
      .from('api_keys')
      .select('id, provider, key_value, is_active, tts_quota_exhausted, tts_quota_exhausted_date, flash_2_5_quota_exhausted, flash_2_5_quota_exhausted_date')
      .eq('provider', 'gemini')
      .eq('is_active', true)
      .or(`${quotaField}.is.null,${quotaField}.eq.false,${quotaDateField}.lt.${today}`);
    
    if (error) {
      console.error('Failed to fetch admin API keys:', error);
      return { keys: [], isUserKey: [] };
    }
    
    // Convert admin keys to UserApiKeyRecord format
    const adminKeys = (data || []).map((k: any) => ({
      ...k,
      user_id: 'admin',
    }));
    
    console.log(`Using ${adminKeys.length} admin API keys as fallback`);
    return { 
      keys: adminKeys, 
      isUserKey: adminKeys.map(() => false) 
    };
  } catch (err) {
    console.error('Error fetching admin API keys:', err);
    return { keys: [], isUserKey: [] };
  }
}

// Mark a key as quota exhausted (handles both user and admin keys)
export async function markKeyExhausted(
  supabaseServiceClient: any,
  keyId: string,
  isUserKey: boolean,
  modelType: QuotaModelType
): Promise<void> {
  const today = getTodayDate();
  const table = isUserKey ? 'user_api_keys' : 'api_keys';
  const updateData = modelType === 'tts' 
    ? { tts_quota_exhausted: true, tts_quota_exhausted_date: today, updated_at: new Date().toISOString() }
    : { flash_2_5_quota_exhausted: true, flash_2_5_quota_exhausted_date: today, updated_at: new Date().toISOString() };
  
  try {
    await supabaseServiceClient
      .from(table)
      .update(updateData)
      .eq('id', keyId);
    
    console.log(`Marked ${isUserKey ? 'user' : 'admin'} key ${keyId} as ${modelType} quota exhausted`);
  } catch (err) {
    console.error('Failed to mark key exhausted:', err);
  }
}
