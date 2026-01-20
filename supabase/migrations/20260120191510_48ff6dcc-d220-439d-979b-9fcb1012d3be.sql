-- Fix PGRST203 ambiguity by removing overloaded Groq key checkout RPCs.
-- PostgREST cannot reliably resolve overloaded functions when parameters are passed as JSON.
-- We keep the newer TEXT-based implementations (used by edge functions) and drop the older UUID overloads.

BEGIN;

-- Drop older UUID overloads (keep TEXT versions)
DROP FUNCTION IF EXISTS public.checkout_groq_key_for_stt(uuid, smallint, integer);
DROP FUNCTION IF EXISTS public.checkout_groq_key_for_llm(uuid, smallint, integer);

COMMIT;