import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { deleteFromR2, getR2Config } from "../_shared/r2Client.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface CleanupResult {
  success: boolean;
  deletedFromDb: number;
  deletedFromR2: number;
  r2Errors: string[];
  error?: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  console.log("[cleanup-expired-tests] Starting cleanup job...");

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const r2Config = getR2Config();
    const r2PublicUrl = r2Config.publicUrl.replace(/\/$/, "");

    // Calculate cutoff date (7 days ago)
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 7);
    const cutoffIso = cutoffDate.toISOString();

    console.log(`[cleanup-expired-tests] Cutoff date: ${cutoffIso}`);

    // CRITICAL SAFETY: Only select user-generated tests (is_preset = false or null)
    // Never delete admin/preset tests
    const { data: expiredTests, error: fetchError } = await supabase
      .from("ai_practice_tests")
      .select("id, audio_url")
      .lt("generated_at", cutoffIso)
      .or("is_preset.is.null,is_preset.eq.false");

    if (fetchError) {
      console.error("[cleanup-expired-tests] Error fetching expired tests:", fetchError);
      return new Response(
        JSON.stringify({ success: false, error: fetchError.message } as CleanupResult),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!expiredTests || expiredTests.length === 0) {
      console.log("[cleanup-expired-tests] No expired tests found.");
      return new Response(
        JSON.stringify({
          success: true,
          deletedFromDb: 0,
          deletedFromR2: 0,
          r2Errors: [],
        } as CleanupResult),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`[cleanup-expired-tests] Found ${expiredTests.length} expired tests to clean up.`);

    // Extract R2 keys and delete audio files
    let deletedFromR2 = 0;
    const r2Errors: string[] = [];

    for (const test of expiredTests) {
      if (test.audio_url) {
        // Parse R2 key from audio_url
        // URL format: https://r2-public-url.com/tts/uuid.wav or similar
        let r2Key: string | null = null;

        if (test.audio_url.startsWith(r2PublicUrl)) {
          // Extract path after public URL
          r2Key = test.audio_url.replace(r2PublicUrl + "/", "");
        } else {
          // Try to extract from URL path
          try {
            const url = new URL(test.audio_url);
            r2Key = url.pathname.replace(/^\//, "");
          } catch {
            console.warn(`[cleanup-expired-tests] Invalid audio URL for test ${test.id}: ${test.audio_url}`);
          }
        }

        if (r2Key) {
          console.log(`[cleanup-expired-tests] Deleting R2 object: ${r2Key}`);
          const deleteResult = await deleteFromR2(r2Key);
          
          if (deleteResult.success) {
            deletedFromR2++;
          } else {
            const errorMsg = `Failed to delete ${r2Key}: ${deleteResult.error}`;
            console.warn(`[cleanup-expired-tests] ${errorMsg}`);
            r2Errors.push(errorMsg);
          }
        }
      }
    }

    // Delete records from database
    const testIds = expiredTests.map((t) => t.id);
    
    // First delete related results (foreign key constraint)
    const { error: resultsDeleteError } = await supabase
      .from("ai_practice_results")
      .delete()
      .in("test_id", testIds);

    if (resultsDeleteError) {
      console.warn("[cleanup-expired-tests] Error deleting related results:", resultsDeleteError);
    }

    // Now delete the tests
    const { error: deleteError } = await supabase
      .from("ai_practice_tests")
      .delete()
      .in("id", testIds);

    if (deleteError) {
      console.error("[cleanup-expired-tests] Error deleting tests from DB:", deleteError);
      return new Response(
        JSON.stringify({
          success: false,
          deletedFromDb: 0,
          deletedFromR2,
          r2Errors,
          error: deleteError.message,
        } as CleanupResult),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // === PHASE 2: Clean up user-uploaded speaking recordings ===
    // These are stored in R2 under "speaking-audio/" prefix
    let userRecordingsDeleted = 0;
    const userRecordingErrors: string[] = [];
    
    try {
      // Query speaking_evaluation_jobs for completed jobs older than 7 days
      const { data: oldJobs } = await supabase
        .from("speaking_evaluation_jobs")
        .select("id, file_paths")
        .lt("created_at", cutoffIso)
        .in("status", ["completed", "failed"]);
      
      if (oldJobs && oldJobs.length > 0) {
        console.log(`[cleanup-expired-tests] Found ${oldJobs.length} old speaking jobs to clean`);
        
        for (const job of oldJobs) {
          const filePaths = job.file_paths as Record<string, string> | null;
          if (filePaths) {
            for (const [, r2Key] of Object.entries(filePaths)) {
              if (r2Key && typeof r2Key === "string") {
                const deleteResult = await deleteFromR2(r2Key);
                if (deleteResult.success) {
                  userRecordingsDeleted++;
                } else {
                  userRecordingErrors.push(`Failed to delete ${r2Key}: ${deleteResult.error}`);
                }
              }
            }
          }
        }
        
        // Delete the old job records
        const jobIds = oldJobs.map(j => j.id);
        await supabase
          .from("speaking_evaluation_jobs")
          .delete()
          .in("id", jobIds);
        
        console.log(`[cleanup-expired-tests] Deleted ${userRecordingsDeleted} user recording files`);
      }
    } catch (userRecErr) {
      console.warn("[cleanup-expired-tests] Error cleaning user recordings:", userRecErr);
    }

    const result: CleanupResult = {
      success: true,
      deletedFromDb: testIds.length,
      deletedFromR2: deletedFromR2 + userRecordingsDeleted,
      r2Errors: [...r2Errors, ...userRecordingErrors],
    };

    console.log(`[cleanup-expired-tests] Cleanup complete:`, result);

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[cleanup-expired-tests] Unexpected error:", error);
    return new Response(
      JSON.stringify({
        success: false,
        deletedFromDb: 0,
        deletedFromR2: 0,
        r2Errors: [],
        error: error instanceof Error ? error.message : "Unknown error",
      } as CleanupResult),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
