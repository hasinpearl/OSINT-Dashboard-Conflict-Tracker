import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CACHE_TTL_MS = 60 * 60 * 1000; // 60 minutes

function getSupabaseAdmin() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
}

export async function getCached(functionName: string): Promise<any | null> {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from("api_cache")
    .select("response_data, fetched_at")
    .eq("function_name", functionName)
    .single();

  if (error || !data) return null;

  // Cache entries written before cached_at existed must be treated as expired.
  const payloadCachedAt = data.response_data?.cached_at;
  if (!payloadCachedAt) {
    console.log(`Cache missing cached_at for ${functionName}, treating as expired`);
    return null;
  }

  const referenceTime = new Date(payloadCachedAt).getTime();

  if (isNaN(referenceTime)) {
    console.log(`Cache INVALID timestamp for ${functionName}, treating as expired`);
    return null;
  }

  const age = Date.now() - referenceTime;
  if (age < CACHE_TTL_MS) {
    console.log(`Cache HIT for ${functionName} (age: ${Math.round(age / 1000)}s)`);
    // Strip the cached_at marker before returning so consumers see clean data
    if (payloadCachedAt && typeof data.response_data === "object") {
      const { cached_at, ...rest } = data.response_data;
      return rest;
    }
    return data.response_data;
  }

  console.log(`Cache EXPIRED for ${functionName} (age: ${Math.round(age / 1000)}s)`);
  return null;
}

export async function setCache(functionName: string, responseData: any): Promise<void> {
  const sb = getSupabaseAdmin();
  const nowIso = new Date().toISOString();

  // Embed cached_at into the payload so TTL travels with the data
  const payload =
    responseData && typeof responseData === "object" && !Array.isArray(responseData)
      ? { ...responseData, cached_at: nowIso }
      : { data: responseData, cached_at: nowIso };

  const { error } = await sb
    .from("api_cache")
    .upsert(
      { function_name: functionName, response_data: payload, fetched_at: nowIso },
      { onConflict: "function_name" }
    );

  if (error) {
    console.error(`Cache WRITE failed for ${functionName}:`, error);
  } else {
    console.log(`Cache WRITE for ${functionName}`);
  }
}
