import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logCost, logCacheHit, PRICES } from "../_shared/costs.ts";
import { corsHeadersFor, errorResponse } from "../_shared/cors.ts";

const CACHE_KEY = "bias-tracker";
const PANEL = "bias-tracker";
const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

interface BiasResult {
  total_stories: number;
  left_count: number;
  center_count: number;
  right_count: number;
  left_pct: number;
  center_pct: number;
  right_pct: number;
  summary: string;
  top_left_story: string;
  top_center_story: string;
  top_right_story: string;
  last_updated: string;
}

function getSupabaseAdmin() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

async function getCachedWithTTL(): Promise<BiasResult | null> {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from("api_cache")
    .select("response_data, fetched_at")
    .eq("function_name", CACHE_KEY)
    .single();
  if (error || !data) return null;
  const cachedAt = data.response_data?.cached_at;
  if (!cachedAt) return null;
  const age = Date.now() - new Date(cachedAt).getTime();
  if (isNaN(age) || age >= CACHE_TTL_MS) {
    console.log(`bias-tracker cache EXPIRED (age: ${Math.round(age / 1000)}s)`);
    return null;
  }
  console.log(`bias-tracker cache HIT (age: ${Math.round(age / 1000)}s)`);
  const { cached_at, ...rest } = data.response_data;
  return rest as BiasResult;
}

async function setCachedWithTimestamp(payload: BiasResult): Promise<void> {
  const sb = getSupabaseAdmin();
  const nowIso = new Date().toISOString();
  const { error } = await sb
    .from("api_cache")
    .upsert(
      {
        function_name: CACHE_KEY,
        response_data: { ...payload, cached_at: nowIso },
        fetched_at: nowIso,
      },
      { onConflict: "function_name" },
    );
  if (error) console.error("bias-tracker cache write failed:", error);
}

Deno.serve(async (req) => {
  const cors = corsHeadersFor(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  try {
    const url = new URL(req.url);
    let forceRefresh = url.searchParams.get("force_refresh") === "true";
    if (!forceRefresh && req.method === "POST") {
      try {
        const body = await req.clone().json();
        if (body && body.force_refresh === true) forceRefresh = true;
      } catch { /* ignore */ }
    }

    if (!forceRefresh) {
      const cached = await getCachedWithTTL();
      if (cached) {
        logCacheHit(PANEL, "perplexity");
        return new Response(JSON.stringify(cached), {
          headers: { ...cors, "Content-Type": "application/json" },
        });
      }
    }

    const perplexityKey = Deno.env.get("PERPLEXITY_API_KEY");
    if (!perplexityKey) {
      return errorResponse(cors, 500, "Service unavailable");
    }

    const userPrompt = `Analyze the top 20 news stories about the Iran-US/Israel conflict from the past 7 days. For each story, classify its NARRATIVE — not the outlet, but what the story itself supports:

- LEFT (US/Israel side): Stories that frame US/Israel actions as justified, defensive, or necessary. Stories critical of Iran's actions, nuclear program, or proxies. Stories emphasizing Iranian aggression or threats.

- CENTER (Neutral/International): Stories from Gulf States, UN, EU, or international bodies calling for de-escalation. Stories presenting both sides equally. Humanitarian-focused coverage. Diplomatic coverage without taking sides.

- RIGHT (Iran side): Stories that frame Iran's actions as defensive or justified. Stories critical of US sanctions, military presence, or Israeli actions. Stories emphasizing civilian casualties from US/Israel strikes. Stories sympathetic to Iranian sovereignty arguments.

Count how many of the 20 stories fall into each category. Calculate the percentage for each.

Return ONLY this JSON:

{"total_stories":20,"left_count":number,"center_count":number,"right_count":number,"left_pct":number,"center_pct":number,"right_pct":number,"summary":"2-3 sentences explaining the current narrative landscape — what is dominating the conversation and which direction coverage is leaning","top_left_story":"headline of strongest US/Israel-sympathetic story","top_center_story":"headline of most neutral story","top_right_story":"headline of strongest Iran-sympathetic story","last_updated":"ISO 8601 UTC timestamp"}`;

    logCost({ panel: PANEL, provider: "perplexity", model: "sonar-pro", costUsd: PRICES.perplexity_sonar_pro });
    const aiRes = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${perplexityKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "sonar-pro",
        messages: [
          {
            role: "system",
            content:
              "You are a media narrative analyst. Return ONLY valid JSON, no prose, no markdown fences. Timestamps must be ISO 8601 UTC.",
          },
          { role: "user", content: userPrompt },
        ],
        search_recency_filter: "week",
      }),
    });

    if (!aiRes.ok) {
      console.error("Perplexity call failed:", aiRes.status, await aiRes.text().catch(() => ""));
      return errorResponse(cors, 502, "Upstream analysis failed");
    }

    const aiData = await aiRes.json();
    const content = aiData.choices?.[0]?.message?.content || "{}";
    let parsed: Partial<BiasResult> = {};
    try {
      parsed = JSON.parse(content);
    } catch {
      const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (fenced) {
        try { parsed = JSON.parse(fenced[1]); } catch { /* ignore */ }
      }
      if (!parsed.total_stories) {
        const obj = content.match(/\{[\s\S]*\}/);
        if (obj) {
          try { parsed = JSON.parse(obj[0]); } catch { /* ignore */ }
        }
      }
    }

    const num = (v: unknown, d = 0): number => {
      const n = typeof v === "number" ? v : Number(v);
      return Number.isFinite(n) ? n : d;
    };
    const str = (v: unknown, d = ""): string =>
      typeof v === "string" ? v : d;

    const result: BiasResult = {
      total_stories: num(parsed.total_stories, 20),
      left_count: num(parsed.left_count),
      center_count: num(parsed.center_count),
      right_count: num(parsed.right_count),
      left_pct: num(parsed.left_pct),
      center_pct: num(parsed.center_pct),
      right_pct: num(parsed.right_pct),
      summary: str(parsed.summary),
      top_left_story: str(parsed.top_left_story),
      top_center_story: str(parsed.top_center_story),
      top_right_story: str(parsed.top_right_story),
      last_updated: str(parsed.last_updated, new Date().toISOString()),
    };

    // Validate that we got something usable before caching
    const hasContent =
      result.summary.length > 0 &&
      (result.left_count + result.center_count + result.right_count) > 0;

    if (hasContent) {
      await setCachedWithTimestamp(result);
    } else {
      console.warn("bias-tracker: empty/invalid result, skipping cache. Raw:", content.slice(0, 500));
    }

    return new Response(JSON.stringify(result), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error in bias-tracker:", error);
    return errorResponse(cors, 500, "Internal error", error);
  }
});
