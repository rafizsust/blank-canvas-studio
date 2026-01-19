-- Phase 1: Add API Key Mutex Locking Support
-- Add locking columns to api_keys table
ALTER TABLE public.api_keys 
ADD COLUMN IF NOT EXISTS locked_by_job_id uuid,
ADD COLUMN IF NOT EXISTS locked_until timestamptz;

-- Create index for efficient lock queries
CREATE INDEX IF NOT EXISTS idx_api_keys_lock ON public.api_keys (locked_by_job_id, locked_until);

-- Function to checkout (lock) an API key for a specific job
-- Uses FOR UPDATE SKIP LOCKED to avoid blocking
CREATE OR REPLACE FUNCTION public.checkout_api_key(
  p_job_id uuid,
  p_model_name text,
  p_lock_minutes int DEFAULT 2
)
RETURNS TABLE(key_id uuid, key_value text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_key_record RECORD;
  v_lock_until timestamptz := now() + (p_lock_minutes || ' minutes')::interval;
BEGIN
  -- Find an available key that:
  -- 1. Is active
  -- 2. Is not locked (or lock expired)
  -- 3. Has quota available for the model
  SELECT ak.id, ak.key_value INTO v_key_record
  FROM public.api_keys ak
  WHERE ak.is_active = true
    AND (ak.locked_by_job_id IS NULL OR ak.locked_until < now())
    AND (
      -- Check model-specific quota not exhausted
      CASE p_model_name
        WHEN 'gemini-2.5-flash' THEN COALESCE(ak.gemini_2_5_flash_exhausted, false) = false
        WHEN 'gemini-2.0-flash' THEN COALESCE(ak.gemini_2_0_flash_exhausted, false) = false
        ELSE true
      END
    )
  ORDER BY ak.updated_at ASC  -- Prefer least recently used
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF v_key_record IS NULL THEN
    -- No available key found
    RETURN;
  END IF;

  -- Lock the key for this job
  UPDATE public.api_keys
  SET locked_by_job_id = p_job_id,
      locked_until = v_lock_until,
      updated_at = now()
  WHERE id = v_key_record.id;

  -- Return the key
  key_id := v_key_record.id;
  key_value := v_key_record.key_value;
  RETURN NEXT;
END;
$$;

-- Function to release an API key lock
CREATE OR REPLACE FUNCTION public.release_api_key(p_job_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  UPDATE public.api_keys
  SET locked_by_job_id = NULL,
      locked_until = NULL,
      updated_at = now()
  WHERE locked_by_job_id = p_job_id;
END;
$$;