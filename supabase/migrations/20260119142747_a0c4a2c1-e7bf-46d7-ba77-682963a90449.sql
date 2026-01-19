-- Fix ambiguous column reference in checkout_key_for_part and checkout_key_for_part_v2
-- The issue is that RETURNS TABLE columns (key_id, key_value, is_user_key) conflict with
-- internal variable assignments. We fix this by using OUT parameters instead of RETURNS TABLE.

-- Drop and recreate checkout_key_for_part with OUT parameters
DROP FUNCTION IF EXISTS public.checkout_key_for_part(uuid, smallint, integer, text);

CREATE OR REPLACE FUNCTION public.checkout_key_for_part(
  p_job_id uuid, 
  p_part_number smallint, 
  p_lock_duration_seconds integer DEFAULT 120, 
  p_model_name text DEFAULT 'gemini-2.5-flash'::text,
  OUT out_key_id uuid,
  OUT out_key_value text,
  OUT out_is_user_key boolean
)
RETURNS SETOF RECORD
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_found_key_id uuid;
  v_found_key_value text;
  v_now timestamptz := now();
  v_release_at timestamptz;
BEGIN
  v_release_at := v_now + (p_lock_duration_seconds || ' seconds')::interval;
  
  SELECT ak.id, ak.key_value
  INTO v_found_key_id, v_found_key_value
  FROM public.api_keys ak
  WHERE ak.is_active = true
    AND ak.provider = 'gemini'
    AND (ak.rate_limited_until IS NULL OR ak.rate_limited_until < v_now)
    AND CASE 
      WHEN p_model_name = 'gemini-2.5-flash' THEN 
        (ak.gemini_2_5_flash_exhausted IS NULL OR ak.gemini_2_5_flash_exhausted = false 
         OR ak.gemini_2_5_flash_exhausted_date < CURRENT_DATE)
      WHEN p_model_name = 'gemini-2.5-pro' THEN
        (ak.gemini_2_5_pro_exhausted IS NULL OR ak.gemini_2_5_pro_exhausted = false
         OR ak.gemini_2_5_pro_exhausted_date < CURRENT_DATE)
      WHEN p_model_name = 'gemini-2.5-flash-tts' THEN
        (ak.gemini_2_5_flash_tts_exhausted IS NULL OR ak.gemini_2_5_flash_tts_exhausted = false
         OR ak.gemini_2_5_flash_tts_exhausted_date < CURRENT_DATE)
      WHEN p_model_name = 'gemini-3-pro' THEN
        (ak.gemini_3_pro_exhausted IS NULL OR ak.gemini_3_pro_exhausted = false
         OR ak.gemini_3_pro_exhausted_date < CURRENT_DATE)
      ELSE true
    END
    AND NOT EXISTS (
      SELECT 1 FROM public.api_key_locks akl
      WHERE akl.key_id = ak.id
        AND akl.released_at IS NULL
        AND akl.release_at > v_now
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.api_key_locks akl
      WHERE akl.key_id = ak.id
        AND akl.cooldown_until IS NOT NULL
        AND akl.cooldown_until > v_now
    )
  ORDER BY ak.error_count ASC, ak.consecutive_429_count ASC
  LIMIT 1
  FOR UPDATE OF ak SKIP LOCKED;
  
  IF v_found_key_id IS NULL THEN
    RETURN;
  END IF;
  
  INSERT INTO public.api_key_locks (key_id, job_id, part_number, locked_at, release_at)
  VALUES (v_found_key_id, p_job_id, p_part_number, v_now, v_release_at)
  ON CONFLICT (key_id, job_id, part_number) 
  DO UPDATE SET 
    locked_at = v_now,
    release_at = v_release_at,
    released_at = NULL,
    cooldown_until = NULL;
  
  out_key_id := v_found_key_id;
  out_key_value := v_found_key_value;
  out_is_user_key := false;
  RETURN NEXT;
END;
$$;

-- Drop and recreate checkout_key_for_part_v2 with OUT parameters
DROP FUNCTION IF EXISTS public.checkout_key_for_part_v2(uuid, smallint, integer, text);

CREATE OR REPLACE FUNCTION public.checkout_key_for_part_v2(
  p_job_id uuid, 
  p_part_number smallint, 
  p_lock_duration_seconds integer DEFAULT 120, 
  p_model_name text DEFAULT 'gemini-2.5-flash'::text,
  OUT out_key_id uuid,
  OUT out_key_value text,
  OUT out_is_user_key boolean
)
RETURNS SETOF RECORD
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_found_key_id uuid;
  v_found_key_value text;
  v_now timestamptz := now();
  v_release_at timestamptz;
BEGIN
  v_release_at := v_now + (p_lock_duration_seconds || ' seconds')::interval;

  SELECT ak.id, ak.key_value
  INTO v_found_key_id, v_found_key_value
  FROM public.api_keys ak
  WHERE ak.is_active = true
    AND ak.provider = 'gemini'
    AND (ak.rate_limited_until IS NULL OR ak.rate_limited_until < v_now)
    AND CASE
      WHEN p_model_name = 'gemini-2.5-flash' THEN
        (ak.gemini_2_5_flash_exhausted IS NULL OR ak.gemini_2_5_flash_exhausted = false
         OR ak.gemini_2_5_flash_exhausted_date < CURRENT_DATE)
      WHEN p_model_name = 'gemini-2.5-pro' THEN
        (ak.gemini_2_5_pro_exhausted IS NULL OR ak.gemini_2_5_pro_exhausted = false
         OR ak.gemini_2_5_pro_exhausted_date < CURRENT_DATE)
      WHEN p_model_name = 'gemini-2.5-flash-tts' THEN
        (ak.gemini_2_5_flash_tts_exhausted IS NULL OR ak.gemini_2_5_flash_tts_exhausted = false
         OR ak.gemini_2_5_flash_tts_exhausted_date < CURRENT_DATE)
      WHEN p_model_name = 'gemini-3-pro' THEN
        (ak.gemini_3_pro_exhausted IS NULL OR ak.gemini_3_pro_exhausted = false
         OR ak.gemini_3_pro_exhausted_date < CURRENT_DATE)
      ELSE true
    END
    AND NOT EXISTS (
      SELECT 1
      FROM public.api_key_locks akl
      WHERE akl.key_id = ak.id
        AND akl.released_at IS NULL
        AND akl.release_at > v_now
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.api_key_locks akl
      WHERE akl.key_id = ak.id
        AND akl.cooldown_until IS NOT NULL
        AND akl.cooldown_until > v_now
    )
  ORDER BY ak.error_count ASC, ak.consecutive_429_count ASC
  LIMIT 1
  FOR UPDATE OF ak SKIP LOCKED;

  IF v_found_key_id IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO public.api_key_locks (key_id, job_id, part_number, locked_at, release_at)
  VALUES (v_found_key_id, p_job_id, p_part_number, v_now, v_release_at)
  ON CONFLICT (key_id, job_id, part_number)
  DO UPDATE SET
    locked_at = v_now,
    release_at = v_release_at,
    released_at = NULL,
    cooldown_until = NULL;

  out_key_id := v_found_key_id;
  out_key_value := v_found_key_value;
  out_is_user_key := false;
  RETURN NEXT;
END;
$$;