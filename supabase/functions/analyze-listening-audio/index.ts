import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { crypto } from "https://deno.land/std@0.168.0/crypto/mod.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type PartKey = "part1" | "part2" | "part3" | "part4";

interface QuestionGroupInfo {
  id: string;
  start_question: number;
  end_question: number;
}

interface AnalysisDetail {
  part: PartKey;
  timestamps: { start: number; end: number; seconds: number; cueText?: string }[];
  transcriptPreview?: string;
  cuesFound?: { start: number; end: number; seconds: number; text: string }[];
  warning?: string;
}

interface TranscriptSegment {
  text: string;
  start_time: number;
  end_time: number;
}

interface GeminiTranscriptionResult {
  full_transcript?: string;
  segments?: TranscriptSegment[];
  total_duration?: number;
}

// List of Gemini models in fallback order - gemini-2.5-flash as primary, gemini-2.0-flash as fallback
const GEMINI_MODELS_FALLBACK_ORDER = [
  "gemini-2.5-flash",
  "gemini-2.0-flash",
] as const;

async function decryptApiKey(encryptedValue: string, encryptionKey: string): Promise<string> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const combined = Uint8Array.from(atob(encryptedValue), (c) => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const encryptedData = combined.slice(12);

  const keyData = encoder.encode(encryptionKey);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyData.slice(0, 32),
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );

  const decryptedData = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    cryptoKey,
    encryptedData,
  );

  return decoder.decode(decryptedData);
}

function uint8ArrayToBase64(uint8Array: Uint8Array): string {
  const chunkSize = 8192;
  let result = "";
  for (let i = 0; i < uint8Array.length; i += chunkSize) {
    const chunk = uint8Array.subarray(i, i + chunkSize);
    result += String.fromCharCode.apply(null, Array.from(chunk));
  }
  return btoa(result);
}

function parseQuestionRangeFromText(text: string): { start: number; end: number }[] {
  const t = (text || "").toLowerCase();
  const ranges: { start: number; end: number }[] = [];

  // Examples to catch:
  // "answer questions 11 to 20"
  // "questions 11-20"
  // "questions 11 and 12"
  // "question 11 to 15"

  const toOrDash = /questions?\s+(\d{1,2})\s*(?:to|\-|–)\s*(\d{1,2})/gi;
  const andPattern = /questions?\s+(\d{1,2})\s*(?:and|&)\s*(\d{1,2})/gi;

  let m: RegExpExecArray | null;
  while ((m = toOrDash.exec(t))) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (Number.isFinite(a) && Number.isFinite(b)) {
      ranges.push({ start: Math.min(a, b), end: Math.max(a, b) });
    }
  }
  while ((m = andPattern.exec(t))) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (Number.isFinite(a) && Number.isFinite(b)) {
      ranges.push({ start: Math.min(a, b), end: Math.max(a, b) });
    }
  }

  return ranges;
}

function estimateCueSeconds(seg: TranscriptSegment): number {
  const start = Number(seg.start_time) || 0;
  const end = Number(seg.end_time) || start;
  const dur = Math.max(0, end - start);
  if (!dur) return start;

  const t = (seg.text || "").toLowerCase();
  const idx = Math.max(t.indexOf("questions"), t.indexOf("question"));
  if (idx < 0 || t.length < 10) return start;

  const ratio = Math.min(1, Math.max(0, idx / t.length));
  return start + ratio * dur;
}

function cuePriority(text: string): number {
  const t = (text || "").toLowerCase();

  // Prefer the real "start" announcements over prep-time or transition lines.
  if (t.includes("now listen") || t.includes("now answer") || t.includes("now turn")) return 0;
  if (t.includes("listen carefully") || t.includes("answer questions")) return 1;
  if (t.includes("before you hear") || t.includes("first, you have some time") || t.includes("you have some time")) return 2;
  return 3;
}

function pickBestCue(cues: { seconds: number; text: string }[]): { seconds: number; text: string } | undefined {
  if (!cues.length) return undefined;
  return [...cues].sort((a, b) => {
    const pa = cuePriority(a.text);
    const pb = cuePriority(b.text);
    if (pa !== pb) return pa - pb;
    // If same type, choose the earliest occurrence.
    return a.seconds - b.seconds;
  })[0];
}

function buildGeminiPrompt(partLabel: string, partGroups: QuestionGroupInfo[]) {
  const groups = partGroups
    .map((g, i) => `- Group ${i + 1}: Questions ${g.start_question}-${g.end_question}`)
    .join("\n");

  return `You are transcribing IELTS Listening ${partLabel} audio.

Return JSON ONLY with this structure:
{
  "full_transcript": "...",
  "segments": [
    { "text": "...", "start_time": 0.0, "end_time": 2.3 }
  ],
  "total_duration": 420.0
}

CRITICAL: segments must include the instructions / announcements like:
"Now listen carefully and answer questions X to Y", "Now answer questions X to Y", "Turn to questions X to Y", etc.

We will extract timestamps from those announcements for these groups:
${groups}

Rules:
- Timestamps are in seconds.
- Transcribe the ENTIRE audio (do not summarize).
- Make segments short enough that the announcement text appears in its own segment when possible.`;
}

async function fetchAudioAsBase64(audioUrl: string): Promise<{ base64: string; mimeType: string; bytes: number }> {
  console.log("Fetching audio:", audioUrl);
  const res = await fetch(audioUrl);
  if (!res.ok) {
    throw new Error(`Failed to fetch audio: ${res.status} ${await res.text()}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  const uint8Array = new Uint8Array(arrayBuffer);
  const base64 = uint8ArrayToBase64(uint8Array);

  const contentType = res.headers.get("content-type");
  const mimeType = contentType || (audioUrl.endsWith(".wav") ? "audio/wav" : "audio/mpeg");

  return { base64, mimeType, bytes: uint8Array.byteLength };
}

async function transcribeWithGemini(opts: {
  geminiApiKey: string;
  mimeType: string;
  audioBase64: string;
  prompt: string;
}): Promise<{ result: GeminiTranscriptionResult; usedModel: string }> {
  let lastError: string | null = null;

  for (const modelName of GEMINI_MODELS_FALLBACK_ORDER) {
    console.log(`Gemini transcribe attempt: ${modelName}`);

    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(opts.geminiApiKey)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [
              {
                role: "user",
                parts: [
                  { text: opts.prompt },
                  {
                    inlineData: {
                      mimeType: opts.mimeType,
                      data: opts.audioBase64,
                    },
                  },
                ],
              },
            ],
            generationConfig: {
              temperature: 0.2,
              responseMimeType: "application/json",
            },
          }),
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Gemini ${modelName} failed:`, response.status, errorText);
        if (response.status === 429) {
          lastError = `Rate limited on ${modelName}`;
          continue;
        }
        lastError = `${modelName}: ${response.status}`;
        continue;
      }

      const data = await response.json();
      const content = data?.candidates?.[0]?.content?.parts
        ?.map((p: any) => p?.text)
        .filter(Boolean)
        .join("\n");

      if (!content) {
        lastError = `${modelName}: Empty response`;
        continue;
      }

      const jsonMatch = content.match(/\{[\s\S]*\}/);
      const parsed: GeminiTranscriptionResult = JSON.parse(jsonMatch ? jsonMatch[0] : content);

      return { result: parsed, usedModel: modelName };
    } catch (e: any) {
      console.error(`Gemini ${modelName} exception:`, e?.message || e);
      lastError = e?.message || "Unknown error";
      continue;
    }
  }

  throw new Error(`All Gemini models failed. Last error: ${lastError}`);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { testId, audioUrls } = await req.json();

    if (!testId) {
      return new Response(JSON.stringify({ success: false, error: "Test ID is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // 1) Identify the calling user (admin) so we can use their stored GEMINI_API_KEY.
    const authHeader = req.headers.get("Authorization") || "";
    const supabaseAuthed = createClient(
      supabaseUrl,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      {
        global: {
          headers: { Authorization: authHeader },
        },
      },
    );

    const { data: authData, error: authErr } = await supabaseAuthed.auth.getUser();
    if (authErr || !authData?.user) {
      return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const userId = authData.user.id;

    const appEncryptionKey = Deno.env.get("app_encryption_key");
    if (!appEncryptionKey) {
      throw new Error("app_encryption_key is not configured");
    }

    const { data: secretData, error: secretError } = await supabaseAuthed
      .from("user_secrets")
      .select("encrypted_value")
      .eq("user_id", userId)
      .eq("secret_name", "GEMINI_API_KEY")
      .maybeSingle();

    if (secretError) throw secretError;
    if (!secretData?.encrypted_value) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Gemini API key not found. Please add your GEMINI_API_KEY in Settings.",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const geminiApiKey = await decryptApiKey(secretData.encrypted_value, appEncryptionKey);

    // 2) Service-role client for DB updates
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    console.log("Starting timestamp analysis for test:", testId);

    const { data: test, error: testError } = await supabaseAdmin
      .from("listening_tests")
      .select("*")
      .eq("id", testId)
      .single();
    if (testError) throw new Error(`Test not found: ${testError.message}`);

    const { data: dbQuestionGroups, error: groupsError } = await supabaseAdmin
      .from("listening_question_groups")
      .select("id, start_question, end_question")
      .eq("test_id", testId)
      .order("start_question");

    if (groupsError) throw new Error(`Failed to fetch question groups: ${groupsError.message}`);

    const urls: Record<PartKey, string | null | undefined> = audioUrls || {
      part1: test.audio_url_part1,
      part2: test.audio_url_part2,
      part3: test.audio_url_part3,
      part4: test.audio_url_part4,
    };

    const parts = (Object.keys(urls) as PartKey[]).filter((k) => !!urls[k]);

    const partRanges: Record<PartKey, { start: number; end: number }> = {
      part1: { start: 1, end: 10 },
      part2: { start: 11, end: 20 },
      part3: { start: 21, end: 30 },
      part4: { start: 31, end: 40 },
    };

    const analysisDetails: AnalysisDetail[] = [];
    let totalTimestampsUpdated = 0;

    for (const part of parts) {
      const audioUrl = urls[part] as string;
      const range = partRanges[part];

      const partGroups = (dbQuestionGroups || [])
        .filter((g) => g.start_question >= range.start && g.end_question <= range.end)
        .sort((a, b) => a.start_question - b.start_question);

      console.log(`Part ${part}: groups=${partGroups.length}`);

      if (!audioUrl || partGroups.length === 0) {
        continue;
      }

      const { base64: audioBase64, mimeType, bytes } = await fetchAudioAsBase64(audioUrl);
      console.log(`Audio loaded for ${part}. bytes=${bytes} mime=${mimeType}`);

      const prompt = buildGeminiPrompt(part.replace("part", "Part "), partGroups);

      const { result, usedModel } = await transcribeWithGemini({
        geminiApiKey,
        mimeType,
        audioBase64,
        prompt,
      });

      console.log(`Gemini used model: ${usedModel}`);

      const segments = Array.isArray(result.segments) ? result.segments : [];
      const cues: { start: number; end: number; seconds: number; text: string }[] = [];

      // Extract cue ranges from segments
      for (const seg of segments) {
        const rangesFound = parseQuestionRangeFromText(seg.text);
        if (!rangesFound.length) continue;

        const cueSeconds = estimateCueSeconds(seg);
        for (const r of rangesFound) {
          cues.push({ start: r.start, end: r.end, seconds: cueSeconds, text: seg.text });
        }
      }

      // Compute group timestamps: prefer exact match, otherwise containment match.
      // IMPORTANT: choose the best cue by priority ("Now listen..." beats "You have some time...")
      const timestamps: AnalysisDetail["timestamps"] = [];
      for (const g of partGroups) {
        const exactCandidates = cues
          .filter((c) => c.start === g.start_question && c.end === g.end_question)
          .map((c) => ({ seconds: c.seconds, text: c.text }));

        const containingCandidates = cues
          .filter((c) => c.start <= g.start_question && c.end >= g.end_question)
          .map((c) => ({ seconds: c.seconds, text: c.text }));

        const best = pickBestCue(exactCandidates) || pickBestCue(containingCandidates);
        if (!best) continue;

        const ts = Number(best.seconds);
        if (!Number.isFinite(ts) || ts < 0) continue;

        const { error: tsError } = await supabaseAdmin
          .from("listening_question_groups")
          .update({ start_timestamp_seconds: ts })
          .eq("id", g.id);

        if (!tsError) {
          totalTimestampsUpdated++;
          timestamps.push({ start: g.start_question, end: g.end_question, seconds: ts, cueText: best.text });
          console.log(`Updated ${part} Q${g.start_question}-${g.end_question} => ${ts}s`);
        } else {
          console.error(`Failed updating group ${g.id}:`, tsError);
        }
      }

      analysisDetails.push({
        part,
        timestamps,
        transcriptPreview: (result.full_transcript || "").slice(0, 800),
        cuesFound: cues.slice(0, 20),
        warning: timestamps.length === 0 ? "No question-range announcements detected in transcript segments." : undefined,
      });
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: `Analysis complete. Updated ${totalTimestampsUpdated} timestamps.`,
        timestampsUpdated: totalTimestampsUpdated,
        analysisDetails,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error: any) {
    console.error("analyze-listening-audio error:", error);
    return new Response(JSON.stringify({ success: false, error: error?.message || "Analysis failed" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
