import type { Context } from "hono";
import { deleteCacheKeys, FORCE_MIN_AGE_MS, getCached, setCache } from "../cache";
import { logCost, logCacheHit, PRICES } from "../costs";
import { CONFLICT_CONFIG, getConflictConfig, readConflict, type ConflictConfig } from "../conflicts";
import { envKey } from "../env";
import { extractJson, readForceRefresh, readJsonBody } from "../request";

const CACHE_KEY_BASE = "bias-tracker";
const PANEL = "bias-tracker";
const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours — slow-moving panel

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

const num = (v: unknown, d = 0): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : d;
};
const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);

const LIMITATION_PHRASES = /only found|couldn'?t find|limited results|not enough|fewer than|unable to (find|retrieve|locate)|no (search )?results|could not find/i;

function cleanSummary(summary: string): string {
  if (!summary || !LIMITATION_PHRASES.test(summary)) return summary;
  const cleaned = summary
    .split(/(?<=[.!?])\s+/)
    .filter((s) => !LIMITATION_PHRASES.test(s))
    .join(" ")
    .trim();
  return cleaned.length > 20 ? cleaned : summary;
}

async function analyzeOne(perplexityKey: string, config: ConflictConfig): Promise<BiasData | null> {
  const userPrompt = `Analyze up to 20 news stories about the ${config.label} conflict (key topics: ${config.searchTerms}) from the past 7 days. If fewer than 20 stories are available, analyze however many you find - even 5-6 stories is enough for a meaningful bias breakdown. Base your percentages on whatever stories are available. Do NOT mention that you couldn't find 20 stories. Do NOT include meta-commentary about the search results or limitations. Just provide the analysis based on what is available.

Search for coverage across ALL of these source categories:
- Western outlets: Reuters, BBC, CNN, Fox News, NYT, Washington Post, AP, Bloomberg, Sky News
- Russian/Eastern European outlets: RT, TASS, Sputnik, Interfax
- Chinese/East Asian outlets: Xinhua, Global Times, CGTN, South China Morning Post
- Iranian outlets: Press TV, IRNA, Tehran Times, Mehr News, Tasnim News
- Middle Eastern/Gulf outlets: Al Jazeera, Al Arabiya, Al Mayadeen, TRT World, Middle East Eye, The National (UAE), Gulf News, Arab News
- International/multilateral: France24, DW, NHK, ABC Australia

You MUST include stories from non-Western sources in your analysis. If a story is only covered by one side, still count it. The goal is to capture the FULL global narrative spectrum, not just the Western perspective.

Important: 0% for any category is almost never accurate in a real conflict. Even if one side dominates, there is always counter-narrative coverage. If your initial analysis produces 0% for any category, search harder for regional and non-Western sources and re-analyze before returning results.

For each story, classify its NARRATIVE - not the outlet, but what the story itself supports:

- LEFT (${config.biasLeftLabel} side): Stories that frame ${config.biasLeftLabel} actions as justified, defensive, or necessary. Stories critical of ${config.biasRightLabel}'s actions. Stories emphasizing aggression or threats from ${config.biasRightLabel}.

- CENTER (${config.biasCenterLabel}): Stories from international bodies (UN, EU, regional blocs) calling for de-escalation. Stories presenting both sides equally. Humanitarian-focused coverage. Diplomatic coverage without taking sides.

- RIGHT (${config.biasRightLabel} side): Stories that frame ${config.biasRightLabel}'s actions as defensive or justified. Stories critical of ${config.biasLeftLabel}'s actions, sanctions, or military presence. Stories emphasizing civilian casualties caused by ${config.biasLeftLabel}. Stories sympathetic to ${config.biasRightLabel}'s sovereignty arguments.

Count how many stories fall into each category. Calculate the percentage for each.

Return ONLY this JSON:

{"total_stories":number,"left_count":number,"center_count":number,"right_count":number,"left_pct":number,"center_pct":number,"right_pct":number,"summary":"2-3 sentences explaining the current narrative landscape - what is dominating the conversation and which direction coverage is leaning","top_left_story":"headline of strongest ${config.biasLeftLabel}-sympathetic story","top_center_story":"headline of most neutral story","top_right_story":"headline of strongest ${config.biasRightLabel}-sympathetic story","last_updated":"ISO 8601 UTC timestamp"}`;

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

  const aiData: any = await aiRes.json();
  const content = aiData.choices?.[0]?.message?.content || "{}";
  const parsed: Partial<BiasData> = extractJson(content) ?? {};

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
    result.left_count + result.center_count + result.right_count > 0;

  if (!hasContent) {
    console.warn(`bias-tracker (${config.key}): empty/invalid result. Raw:`, content.slice(0, 500));
    return null;
  }

  return result;
}

export async function biasTrackerRoute(c: Context) {
  // Legacy un-suffixed cache row from the original design; harmless to retry.
  await deleteCacheKeys(["bias-tracker"]);

  const body = await readJsonBody(c);
  const forceRefresh = readForceRefresh(c, body);
  const config = getConflictConfig(readConflict(body));
  const CACHE_KEY = `${CACHE_KEY_BASE}:${config.key}`;

  // force shrinks the acceptable age to 5 minutes instead of bypassing the
  // 12h TTL entirely — refresh-spam can't multiply sonar-pro calls.
  const cached = await getCached(CACHE_KEY, forceRefresh ? FORCE_MIN_AGE_MS : CACHE_TTL_MS);
  if (cached) {
    logCacheHit(PANEL, "perplexity");
    return c.json(cached);
  }

  const perplexityKey = envKey("PERPLEXITY_API_KEY");
  if (!perplexityKey) {
    return c.json({ error: "Service unavailable" }, 500);
  }

  if (config.key === "all") {
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
      return c.json({ error: "Upstream analysis failed" }, 502);
    }

    const response: AllResponse = {
      mode: "all",
      conflicts,
      last_updated: new Date().toISOString(),
    };

    await setCache(CACHE_KEY, response);
    return c.json(response);
  }

  const single = await analyzeOne(perplexityKey, config);
  if (!single) {
    return c.json({ error: "Upstream analysis failed" }, 502);
  }

  const response: SingleResponse = {
    mode: "single",
    conflict: config.key,
    label: config.label,
    ...single,
  };

  await setCache(CACHE_KEY, response);
  return c.json(response);
}
