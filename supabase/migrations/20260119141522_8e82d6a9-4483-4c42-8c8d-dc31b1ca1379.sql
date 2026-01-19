-- Fix linter: RLS enabled but no policies on api_key_locks
-- This table contains internal key-locking state and should only be accessible to admins.

ALTER TABLE public.api_key_locks ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  -- SELECT
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='api_key_locks' AND policyname='Admins can manage api_key_locks'
  ) THEN
    CREATE POLICY "Admins can manage api_key_locks"
    ON public.api_key_locks
    FOR ALL
    USING (is_admin(auth.uid()))
    WITH CHECK (is_admin(auth.uid()));
  END IF;
END $$;