-- Add new quota tracking columns for Split-Brain Architecture
-- Each model category has separate quota tracking to prevent "quota contamination"

-- Add flash_lite quota columns (for tutor/explainer models)
ALTER TABLE public.api_keys 
ADD COLUMN IF NOT EXISTS flash_lite_quota_exhausted boolean DEFAULT false,
ADD COLUMN IF NOT EXISTS flash_lite_quota_exhausted_date text;

-- Add pro_3_0 quota columns (for deep reasoning/writing evaluation models)
ALTER TABLE public.api_keys 
ADD COLUMN IF NOT EXISTS pro_3_0_quota_exhausted boolean DEFAULT false,
ADD COLUMN IF NOT EXISTS pro_3_0_quota_exhausted_date text;

-- Add exp_pro quota columns (for experimental pro/test generation models)
ALTER TABLE public.api_keys 
ADD COLUMN IF NOT EXISTS exp_pro_quota_exhausted boolean DEFAULT false,
ADD COLUMN IF NOT EXISTS exp_pro_quota_exhausted_date text;

-- Update the reset_api_key_quotas function to include new quota types
CREATE OR REPLACE FUNCTION public.reset_api_key_quotas()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  today_date text := to_char(CURRENT_DATE, 'YYYY-MM-DD');
BEGIN
  -- Reset quotas that are from previous days
  UPDATE public.api_keys
  SET 
    tts_quota_exhausted = false,
    tts_quota_exhausted_date = NULL,
    flash_2_5_quota_exhausted = false,
    flash_2_5_quota_exhausted_date = NULL,
    flash_lite_quota_exhausted = false,
    flash_lite_quota_exhausted_date = NULL,
    pro_3_0_quota_exhausted = false,
    pro_3_0_quota_exhausted_date = NULL,
    exp_pro_quota_exhausted = false,
    exp_pro_quota_exhausted_date = NULL,
    updated_at = NOW()
  WHERE 
    (tts_quota_exhausted = true AND tts_quota_exhausted_date < today_date)
    OR (flash_2_5_quota_exhausted = true AND flash_2_5_quota_exhausted_date < today_date)
    OR (flash_lite_quota_exhausted = true AND flash_lite_quota_exhausted_date < today_date)
    OR (pro_3_0_quota_exhausted = true AND pro_3_0_quota_exhausted_date < today_date)
    OR (exp_pro_quota_exhausted = true AND exp_pro_quota_exhausted_date < today_date);
END;
$$;