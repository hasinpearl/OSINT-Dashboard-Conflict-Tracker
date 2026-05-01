import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logCost, logCacheHit, PRICES } from "../_shared/costs.ts";
import { corsHeadersFor, errorResponse } from "../_shared/cors.ts";
import { CONFLICT_CONFIG, getConflictConfig, type ConflictConfig } from "../_shared/conflicts.ts";

const CACHE_KEY_BASE = "bias-tracker";
const PANEL = "bias-tracker";
const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

interface BiasData {
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
  // Labels travel with the data so the frontend doesn't hardcode them
  left_label: string;
  center_label: string;
  right_label: string;
}

interface SingleResponse extends BiasData {
  mode: "single";
  conflict: string;
  label: string;
}

interface AllResponse {
  mode: "all";
  conflicts: Array<BiasData & { conflict: string; label: string }>;
  last_updated: string;
}

type CachedPayload = (SingleResponse | AllResponse) & { cached_at?: string };

function getSupabaseAdmin() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

async function getCachedWithTTL(cacheKey: string): Promise<SingleResponse | AllResponse | null> {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from("api_cache")
    .select("response_data, fetched_at")
    .eq("function_name", cacheKey)
    .single();
  if (error || !data) return null;
  const cachedAt = data.response_data?.cached_at;
  if (!cachedAt) return null;
  const age = Date.now() - new Date(cachedAt).getTime();
  if (isNaN(age) || age >= CACHE_TTL_MS) {
    console.log(`bias-tracker cache EXPIRED for ${cacheKey} (age: ${Math.round(age / 1000)}s)`);
    return null;
  }
  console.log(`bias-tracker cache HIT for ${cacheKey} (age: ${Math.round(age / 1000)}s)`);
  const { cached_at, ...rest } = data.response_data as CachedPayload;
  return rest as SingleResponse | AllResponse;
}

async function setCachedWithTimestamp(cacheKey: string, payload: SingleResponse | AllResponse): Promise<void> {
  const sb = getSupabaseAdmin();
  const nowIso = new Date().toISOString();
  const { error } = await sb
    .from("api_cache")
    .upsert(
      {
        function_name: cacheKey,
        response_data: { ...payload, cached_at: nowIso },
        fetched_at: nowIso,
      },
      { onConflict: "function_name" },
    );
  if (error) console.error(`bias-tracker cache write failed for ${cacheKey}:`, error);
}

const num = (v: unknown, d = 0): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : d;
};
const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);

// Phrases that indicate Perplexity is complaining about data limitations
const LIMITATION_PHRASES = /only found|couldn'?t find|limited results|not enough|fewer than|unable to (find|retrieve|locate)|no (search )?results|could not find/i;

function cleanSummary(summary: string): string {
  if (!summary || !LIMITATION_PHRASES.test(summary)) return summary;
  // Strip sentences containing limitation language
  const cleaned = summary
    .split(/(?<=[.!?])\s+/)
    .filter((s) => !LIMITATION_PHRASES.test(s))
    .join(" ")
    .trim();
  return cleaned.length > 20 ? cleaned : summary;
}

async function analyzeOne(perplexityKey: string, config: ConflictConfig): Promise<BiasData | null> {
  const userPrompt = `Analyze up to 20 news stories about the ${config.label} conflict (key topics: ${config.searchTerms}) from the past 7 days. If fewer than 20 stories are available, analyze however many you find — even 5-6 stories is enough for a meaningful bias breakdown. Base your percentages on whatever stories are available. Do NOT mention that you couldn't find 20 stories. Do NOT include meta-commentary about the search results or limitations. Just provide the analysis based on what is available.

Search for coverage across ALL of these source categories:
- Western outlets: Reuters, BBC, CNN, Fox News, NYT, Washington Post, AP, Bloomberg, Sky News
- Russian/Eastern European outlets: RT, TASS, Sputnik, Interfax
- Chinese/East Asian outlets: Xinhua, Global Times, CGTN, South China Morning Post
- Iranian outlets: Press TV, IRNA, Tehran Times, Mehr News, Tasnim News
- Middle Eastern/Gulf outlets: Al Jazeera, Al Arabiya, Al Mayadeen, TRT World, Middle East Eye, The National (UAE), Gulf News, Arab News
- International/multilateral: France24, DW, NHK, ABC Australia

You MUST include stories from non-Western sources in your analysis. If a story is only covered by one side, still count it. The goal is to capture the FULL global narrative spectrum, not just the Western perspective.

Important: 0% for any category is almost never accurate in a real conflict. Even if one side dominates, there is always counter-narrative coverage. If your initial analysis produces 0% for any category, search harder for regional and non-Western sources and re-analyze before returning results.

For each story, classify its NARRATIVE — not the outlet, but what the story itself supports:

- LEFT (${config.biasLeftLabel} side): Stories that frame ${config.biasLeftLabel} actions as justified, defensive, or necessary. Stories critical of ${config.biasRightLabel}'s actions. Stories emphasizing aggression or threats from ${config.biasRightLabel}.

- CENTER (${config.biasCenterLabel}): Stories from international bodies (UN, EU, regional blocs) calling for de-escalation. Stories presenting both sides equally. Humanitarian-focused coverage. Diplomatic coverage without taking sides.

- RIGHT (${config.biasRightLabel} side): Stories that frame ${config.biasRightLabel}'s actions as defensive or justified. Stories critical of ${config.biasLeftLabel}'s actions, sanctions, or military presence. Stories emphasizing civilian casualties caused by ${config.biasLeftLabel}. Stories sympathetic to ${config.biasRightLabel}'s sovereignty arguments.

Count how many stories fall into each category. Calculate the percentage for each.

Return ONLY this JSON:

{"total_stories":number,"left_count":number,"center_count":number,"right_count":number,"left_pct":number,"center_pct":number,"right_pct":number,"summary":"2-3 sentences explaining the current narrative landscape — what is dominating the conversation and which direction coverage is leaning","top_left_story":"headline of strongest ${config.biasLeftLabel}-sympathetic story","top_center_story":"headline of most neutral story","top_right_story":"headline of strongest ${config.biasRightLabel}-sympathetic story","last_updated":"ISO 8601 UTC timestamp"}`;

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
    console.error(`Perplexity call failed for ${config.key}:`, aiRes.status, await aiRes.text().catch(() => ""));
    return null;
  }

  const aiData = await aiRes.json();
  const content = aiData.choices?.[0]?.message?.content || "{}";
  let parsed: Partial<BiasData> = {};
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

  const result: BiasData = {
    total_stories: num(parsed.total_stories, 20),
    left_count: num(parsed.left_count),
    center_count: num(parsed.center_count),
    right_count: num(parsed.right_count),
    left_pct: num(parsed.left_pct),
    center_pct: num(parsed.center_pct),
    right_pct: num(parsed.right_pct),
    summary: cleanSummary(str(parsed.summary)),
    top_left_story: str(parsed.top_left_story),
    top_center_story: str(parsed.top_center_story),
    top_right_story: str(parsed.top_right_story),
    last_updated: str(parsed.last_updated, new Date().toISOString()),
    left_label: config.biasLeftLabel,
    center_label: config.biasCenterLabel,
    right_label: config.biasRightLabel,
  };

  const hasContent =
    result.summary.length > 0 &&
    (result.left_count + result.center_count + result.right_count) > 0;

  if (!hasContent) {
    console.warn(`bias-tracker (${config.key}): empty/invalid result. Raw:`, content.slice(0, 500));
    return null;
  }

  return result;
}

Deno.serve(async (req) => {
  const cors = corsHeadersFor(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  try {
    // One-time cleanup: purge legacy cache row that used the un-suffixed key.
    // Safe to run on every request — it's a no-op once the row is gone.
    try {
      const sb = getSupabaseAdmin();
      await sb.from("api_cache").delete().eq("function_name", "bias-tracker");
    } catch (e) {
      console.warn("Legacy bias-tracker cache cleanup failed (non-fatal):", e);
    }

    const url = new URL(req.url);
    let forceRefresh = url.searchParams.get("force_refresh") === "true";
    let bodyConflict: string | undefined;
    if (req.method === "POST") {
      try {
        const body = await req.clone().json();
        if (body && body.force_refresh === true) forceRefresh = true;
        if (body && typeof body.conflict === "string") bodyConflict = body.conflict;
      } catch { /* ignore */ }
    }

    const config = getConflictConfig(bodyConflict);
    const CACHE_KEY = `${CACHE_KEY_BASE}:${config.key}`;

    if (!forceRefresh) {
      const cached = await getCachedWithTTL(CACHE_KEY);
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

    if (config.key === "all") {
      // Fan out to all three conflicts in parallel
      const keys = ["iran-us", "ukraine-russia", "china-taiwan"] as const;
      const results = await Promise.all(
        keys.map((k) => analyzeOne(perplexityKey, CONFLICT_CONFIG[k])),
      );

      const conflicts = keys
        .map((k, i) => {
          const r = results[i];
          if (!r) return null;
          return {
            conflict: k,
            label: CONFLICT_CONFIG[k].label,
            ...r,
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);

      if (conflicts.length === 0) {
        return errorResponse(cors, 502, "Upstream analysis failed");
      }

      const response: AllResponse = {
        mode: "all",
        conflicts,
        last_updated: new Date().toISOString(),
      };

      await setCachedWithTimestamp(CACHE_KEY, response);

      return new Response(JSON.stringify(response), {
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // Single-conflict mode
    const single = await analyzeOne(perplexityKey, config);
    if (!single) {
      return errorResponse(cors, 502, "Upstream analysis failed");
    }

    const response: SingleResponse = {
      mode: "single",
      conflict: config.key,
      label: config.label,
      ...single,
    };

    await setCachedWithTimestamp(CACHE_KEY, response);

    return new Response(JSON.stringify(response), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error in bias-tracker:", error);
    return errorResponse(cors, 500, "Internal error", error);
  }
});
