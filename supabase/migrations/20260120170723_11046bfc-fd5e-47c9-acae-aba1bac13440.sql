-- ================================================
-- GROQ INTEGRATION MIGRATION
-- ================================================

-- 1. Create speaking_evaluation_settings table
CREATE TABLE IF NOT EXISTS public.speaking_evaluation_settings (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'gemini' CHECK (provider IN ('gemini', 'groq')),
  auto_fallback_enabled BOOLEAN NOT NULL DEFAULT true,
  max_groq_retries INTEGER NOT NULL DEFAULT 3,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.speaking_evaluation_settings ENABLE ROW LEVEL SECURITY;

-- Only admins can read/write settings
CREATE POLICY "Admins can manage speaking evaluation settings"
ON public.speaking_evaluation_settings
FOR ALL
USING (public.is_admin(auth.uid()));

-- Insert default settings if not exists
INSERT INTO public.speaking_evaluation_settings (provider, auto_fallback_enabled, max_groq_retries)
SELECT 'gemini', true, 3
WHERE NOT EXISTS (SELECT 1 FROM public.speaking_evaluation_settings LIMIT 1);

-- 2. Extend api_keys table with Groq-specific columns
ALTER TABLE public.api_keys 
ADD COLUMN IF NOT EXISTS groq_whisper_exhausted BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS groq_whisper_exhausted_date DATE,
ADD COLUMN IF NOT EXISTS groq_llama_exhausted BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS groq_llama_exhausted_date DATE,
ADD COLUMN IF NOT EXISTS groq_ash_used_this_hour INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS groq_ash_reset_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS groq_rpm_cooldown_until TIMESTAMP WITH TIME ZONE;

-- 3. Extend speaking_evaluation_jobs with provider columns
ALTER TABLE public.speaking_evaluation_jobs
ADD COLUMN IF NOT EXISTS provider TEXT DEFAULT 'gemini',
ADD COLUMN IF NOT EXISTS transcription_result JSONB,
ADD COLUMN IF NOT EXISTS groq_stt_key_id UUID REFERENCES public.api_keys(id),
ADD COLUMN IF NOT EXISTS groq_llm_key_id UUID REFERENCES public.api_keys(id),
ADD COLUMN IF NOT EXISTS groq_retry_count INTEGER DEFAULT 0;

-- 4. Function to get current speaking evaluation provider
CREATE OR REPLACE FUNCTION public.get_speaking_evaluation_provider()
RETURNS TEXT
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT COALESCE(
    (SELECT provider FROM public.speaking_evaluation_settings LIMIT 1),
    'gemini'
  );
$$;

-- 5. Function to checkout Groq key for STT (Speech-to-Text)
CREATE OR REPLACE FUNCTION public.checkout_groq_key_for_stt(
  p_job_id UUID,
  p_part_number SMALLINT,
  p_lock_duration_seconds INTEGER DEFAULT 120
)
RETURNS TABLE(out_key_id UUID, out_key_value TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_found_key_id UUID;
  v_found_key_value TEXT;
  v_now TIMESTAMPTZ := now();
  v_release_at TIMESTAMPTZ;
BEGIN
  v_release_at := v_now + (p_lock_duration_seconds || ' seconds')::interval;
  
  SELECT ak.id, ak.key_value
  INTO v_found_key_id, v_found_key_value
  FROM public.api_keys ak
  WHERE ak.is_active = true
    AND ak.provider = 'groq'
    AND (ak.groq_rpm_cooldown_until IS NULL OR ak.groq_rpm_cooldown_until < v_now)
    AND (ak.groq_whisper_exhausted IS NULL OR ak.groq_whisper_exhausted = false 
         OR ak.groq_whisper_exhausted_date < CURRENT_DATE)
    -- Check ASH limit (28,800 per hour for whisper-large-v3-turbo)
    AND (ak.groq_ash_used_this_hour IS NULL OR ak.groq_ash_used_this_hour < 28000
         OR ak.groq_ash_reset_at IS NULL OR ak.groq_ash_reset_at < v_now)
    AND NOT EXISTS (
      SELECT 1 FROM public.api_key_locks akl
      WHERE akl.key_id = ak.id
        AND akl.released_at IS NULL
        AND akl.release_at > v_now
    )
  ORDER BY ak.groq_ash_used_this_hour ASC NULLS FIRST, ak.error_count ASC
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
  RETURN NEXT;
END;
$$;

-- 6. Function to record ASH usage for Groq
CREATE OR REPLACE FUNCTION public.record_groq_ash_usage(
  p_key_id UUID,
  p_audio_seconds INTEGER
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
BEGIN
  UPDATE public.api_keys
  SET 
    groq_ash_used_this_hour = CASE 
      WHEN groq_ash_reset_at IS NULL OR groq_ash_reset_at < v_now 
      THEN p_audio_seconds 
      ELSE COALESCE(groq_ash_used_this_hour, 0) + p_audio_seconds 
    END,
    groq_ash_reset_at = CASE 
      WHEN groq_ash_reset_at IS NULL OR groq_ash_reset_at < v_now 
      THEN v_now + interval '1 hour'
      ELSE groq_ash_reset_at 
    END,
    updated_at = v_now
  WHERE id = p_key_id;
END;
$$;

-- 7. Function to mark Groq key as RPM limited
CREATE OR REPLACE FUNCTION public.mark_groq_key_rpm_limited(
  p_key_id UUID,
  p_cooldown_seconds INTEGER DEFAULT 60
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  UPDATE public.api_keys
  SET 
    groq_rpm_cooldown_until = now() + (p_cooldown_seconds || ' seconds')::interval,
    updated_at = now()
  WHERE id = p_key_id;
END;
$$;

-- 8. Function to checkout Groq key for LLM
CREATE OR REPLACE FUNCTION public.checkout_groq_key_for_llm(
  p_job_id UUID,
  p_part_number SMALLINT,
  p_lock_duration_seconds INTEGER DEFAULT 120
)
RETURNS TABLE(out_key_id UUID, out_key_value TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_found_key_id UUID;
  v_found_key_value TEXT;
  v_now TIMESTAMPTZ := now();
  v_release_at TIMESTAMPTZ;
BEGIN
  v_release_at := v_now + (p_lock_duration_seconds || ' seconds')::interval;
  
  SELECT ak.id, ak.key_value
  INTO v_found_key_id, v_found_key_value
  FROM public.api_keys ak
  WHERE ak.is_active = true
    AND ak.provider = 'groq'
    AND (ak.groq_rpm_cooldown_until IS NULL OR ak.groq_rpm_cooldown_until < v_now)
    AND (ak.groq_llama_exhausted IS NULL OR ak.groq_llama_exhausted = false 
         OR ak.groq_llama_exhausted_date < CURRENT_DATE)
    AND NOT EXISTS (
      SELECT 1 FROM public.api_key_locks akl
      WHERE akl.key_id = ak.id
        AND akl.released_at IS NULL
        AND akl.release_at > v_now
    )
  ORDER BY ak.error_count ASC
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
  RETURN NEXT;
END;
$$;

-- 9. Function to mark Groq key model as exhausted
CREATE OR REPLACE FUNCTION public.mark_groq_key_exhausted(
  p_key_id UUID,
  p_model TEXT
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF p_model = 'whisper' THEN
    UPDATE public.api_keys
    SET 
      groq_whisper_exhausted = true,
      groq_whisper_exhausted_date = CURRENT_DATE,
      updated_at = now()
    WHERE id = p_key_id;
  ELSIF p_model = 'llama' THEN
    UPDATE public.api_keys
    SET 
      groq_llama_exhausted = true,
      groq_llama_exhausted_date = CURRENT_DATE,
      updated_at = now()
    WHERE id = p_key_id;
  END IF;
END;
$$;

-- 10. Update reset_api_key_model_quotas to include Groq quotas
CREATE OR REPLACE FUNCTION public.reset_api_key_model_quotas(p_key_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF p_key_id IS NULL THEN
    UPDATE public.api_keys
    SET 
      -- Legacy bucket quotas
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
      -- Gemini per-model quotas
      gemini_2_0_flash_exhausted = false,
      gemini_2_0_flash_exhausted_date = NULL,
      gemini_2_0_flash_lite_exhausted = false,
      gemini_2_0_flash_lite_exhausted_date = NULL,
      gemini_2_5_flash_exhausted = false,
      gemini_2_5_flash_exhausted_date = NULL,
      gemini_2_5_flash_tts_exhausted = false,
      gemini_2_5_flash_tts_exhausted_date = NULL,
      gemini_2_5_pro_exhausted = false,
      gemini_2_5_pro_exhausted_date = NULL,
      gemini_3_pro_exhausted = false,
      gemini_3_pro_exhausted_date = NULL,
      gemini_exp_1206_exhausted = false,
      gemini_exp_1206_exhausted_date = NULL,
      -- Groq quotas
      groq_whisper_exhausted = false,
      groq_whisper_exhausted_date = NULL,
      groq_llama_exhausted = false,
      groq_llama_exhausted_date = NULL,
      updated_at = now()
    WHERE 
      is_active = true AND (
        -- Check legacy quotas
        (tts_quota_exhausted = true AND tts_quota_exhausted_date < CURRENT_DATE) OR
        (flash_2_5_quota_exhausted = true AND flash_2_5_quota_exhausted_date < CURRENT_DATE) OR
        (flash_lite_quota_exhausted = true AND flash_lite_quota_exhausted_date < CURRENT_DATE) OR
        (pro_3_0_quota_exhausted = true AND pro_3_0_quota_exhausted_date < CURRENT_DATE) OR
        (exp_pro_quota_exhausted = true AND exp_pro_quota_exhausted_date < CURRENT_DATE) OR
        -- Check Gemini model quotas
        (gemini_2_0_flash_exhausted = true AND gemini_2_0_flash_exhausted_date < CURRENT_DATE) OR
        (gemini_2_0_flash_lite_exhausted = true AND gemini_2_0_flash_lite_exhausted_date < CURRENT_DATE) OR
        (gemini_2_5_flash_exhausted = true AND gemini_2_5_flash_exhausted_date < CURRENT_DATE) OR
        (gemini_2_5_flash_tts_exhausted = true AND gemini_2_5_flash_tts_exhausted_date < CURRENT_DATE) OR
        (gemini_2_5_pro_exhausted = true AND gemini_2_5_pro_exhausted_date < CURRENT_DATE) OR
        (gemini_3_pro_exhausted = true AND gemini_3_pro_exhausted_date < CURRENT_DATE) OR
        (gemini_exp_1206_exhausted = true AND gemini_exp_1206_exhausted_date < CURRENT_DATE) OR
        -- Check Groq quotas
        (groq_whisper_exhausted = true AND groq_whisper_exhausted_date < CURRENT_DATE) OR
        (groq_llama_exhausted = true AND groq_llama_exhausted_date < CURRENT_DATE)
      );
  ELSE
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
      gemini_2_0_flash_exhausted = false,
      gemini_2_0_flash_exhausted_date = NULL,
      gemini_2_0_flash_lite_exhausted = false,
      gemini_2_0_flash_lite_exhausted_date = NULL,
      gemini_2_5_flash_exhausted = false,
      gemini_2_5_flash_exhausted_date = NULL,
      gemini_2_5_flash_tts_exhausted = false,
      gemini_2_5_flash_tts_exhausted_date = NULL,
      gemini_2_5_pro_exhausted = false,
      gemini_2_5_pro_exhausted_date = NULL,
      gemini_3_pro_exhausted = false,
      gemini_3_pro_exhausted_date = NULL,
      gemini_exp_1206_exhausted = false,
      gemini_exp_1206_exhausted_date = NULL,
      groq_whisper_exhausted = false,
      groq_whisper_exhausted_date = NULL,
      groq_llama_exhausted = false,
      groq_llama_exhausted_date = NULL,
      updated_at = now()
    WHERE id = p_key_id;
  END IF;
END;
$function$;