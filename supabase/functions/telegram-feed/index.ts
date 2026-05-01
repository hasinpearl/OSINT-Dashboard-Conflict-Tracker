import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCached, setCache } from "../_shared/cache.ts";
import { logCost, logCacheHit, PRICES } from "../_shared/costs.ts";
import { corsHeadersFor, errorResponse } from "../_shared/cors.ts";
import { getConflictConfig, readConflictFromRequest } from "../_shared/conflicts.ts";

const CACHE_KEY_BASE = "telegram-feed";
const PANEL = "telegram";
const MAX_NEWEST_POST_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours

async function clearAllTelegramCache() {
  try {
    const sb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );
    const keys = [
      `${CACHE_KEY_BASE}:all`,
      `${CACHE_KEY_BASE}:iran-us`,
      `${CACHE_KEY_BASE}:ukraine-russia`,
      `${CACHE_KEY_BASE}:china-taiwan`,
    ];
    const { error } = await sb.from("api_cache").delete().in("function_name", keys);
    if (error) console.error("Failed to clear telegram cache:", error);
    else console.log(`Cleared all telegram-feed cache rows (${keys.join(", ")})`);
  } catch (e) {
    console.error("clearAllTelegramCache error:", e);
  }
}

const CHANNELS = [
  "middleeasteye",
  "iranintl",
  "geopolitics_prime",
  "bricsnews",
  "megatron_ron",
  "DDGeopolitics",
  "thecradlemedia",
  "warmonitors",
  "CIG_telegram",
  "monitor_the_situation",
  "ukr_leaks_eng",
];

async function scrapeChannel(firecrawlKey: string, channel: string): Promise<string | null> {
  try {
    logCost({ panel: PANEL, provider: "firecrawl", model: "scrape-v1", costUsd: PRICES.firecrawl_scrape });
    const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${firecrawlKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: `https://t.me/s/${channel}`,
        formats: ["markdown"],
        onlyMainContent: true,
      }),
    });

    if (res.ok) {
      const data = await res.json();
      const markdown = data?.data?.markdown || data?.markdown || "";
      if (markdown) {
        return `@${channel}:\n${markdown.slice(-1500)}`;
      }
    }
  } catch (e) {
    console.error(`Failed to scrape ${channel}:`, e);
  }
  return null;
}

async function parseWithPerplexity(
  perplexityKey: string,
  content: string,
  conflictFilter: string,
) {
  logCost({ panel: PANEL, provider: "perplexity", model: "sonar", costUsd: PRICES.perplexity_sonar });
  const res = await fetch("https://api.perplexity.ai/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${perplexityKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "sonar",
      messages: [
        {
          role: "system",
          content: "Extract Telegram posts from scraped content. Return ONLY valid JSON, no markdown.",
        },
        {
          role: "user",
          content: `Extract individual posts from these Telegram channels.${conflictFilter} Return JSON: {"messages":[{"channel":"username","text":"post text, 1-2 sentences","timestamp":"ISO 8601 UTC timestamp in full ISO 8601 format YYYY-MM-DDTHH:mm:ssZ, e.g. 2026-04-28T14:30:00Z","message_id":number}]}. The timestamp MUST be a valid ISO 8601 UTC timestamp in full ISO 8601 format YYYY-MM-DDTHH:mm:ssZ. Do not use relative timestamps or space-separated date/time formats. Most recent first, up to 15 messages.\n\n${content}`,
        },
      ],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error("Perplexity error:", res.status, errText);
    return [];
  }

  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content || "{}";

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    try {
      parsed = match ? JSON.parse(match[1]) : { messages: [] };
    } catch {
      parsed = { messages: [] };
    }
  }

  return parsed.messages || [];
}

Deno.serve(async (req) => {
  const cors = corsHeadersFor(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  try {
    const url = new URL(req.url);
    const forceRefresh = url.searchParams.get("force_refresh") === "true";

    const conflict = await readConflictFromRequest(req);
    const config = getConflictConfig(conflict);
    const CACHE_KEY = `${CACHE_KEY_BASE}:${config.key}`;

    // Per-conflict prompt filter — keep all channels but instruct the LLM to filter by topic
    const conflictFilter =
      config.key === "all"
        ? ""
        : ` Only include posts relevant to the ${config.label} conflict (key topics: ${config.searchTerms}). Exclude posts about other conflicts or unrelated topics.`;

    // Check cache first (unless force_refresh)
    if (!forceRefresh) {
      const cached = await getCached(CACHE_KEY);
      if (cached) {
        // Hard staleness check: inspect newest post timestamp
        const messages = (cached as any)?.messages ?? [];
        const newestTs = messages
          .map((m: any) => m?.timestamp)
          .filter(Boolean)
          .sort()
          .reverse()[0];

        if (newestTs) {
          const newestAgeMs = Date.now() - new Date(newestTs).getTime();
          const ageHours = (newestAgeMs / (60 * 60 * 1000)).toFixed(2);
          console.log(`Telegram cache newest post age: ${ageHours}h (key: ${CACHE_KEY})`);

          if (isNaN(newestAgeMs) || newestAgeMs > MAX_NEWEST_POST_AGE_MS) {
            console.log(`Cache STALE (newest post >2h old) — clearing all telegram-feed cache rows`);
            await clearAllTelegramCache();
          } else {
            logCacheHit(PANEL, "firecrawl");
            return new Response(JSON.stringify(cached), {
              headers: { ...cors, "Content-Type": "application/json" },
            });
          }
        } else {
          console.log(`Telegram cache has no post timestamps — treating as stale`);
          await clearAllTelegramCache();
        }
      }
    } else {
      console.log("force_refresh=true, bypassing cache");
    }

    const firecrawlKey = Deno.env.get("FIRECRAWL_API_KEY");
    const perplexityKey = Deno.env.get("PERPLEXITY_API_KEY");

    if (!firecrawlKey || !perplexityKey) {
      return new Response(JSON.stringify({ messages: [] }), {
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // Scrape in batches of 4 to avoid overwhelming Firecrawl (11 channels → 4-4-3)
    const batch1 = await Promise.all(CHANNELS.slice(0, 4).map(c => scrapeChannel(firecrawlKey, c)));
    const batch2 = await Promise.all(CHANNELS.slice(4, 8).map(c => scrapeChannel(firecrawlKey, c)));
    const batch3 = await Promise.all(CHANNELS.slice(8).map(c => scrapeChannel(firecrawlKey, c)));

    const allContent = [...batch1, ...batch2, ...batch3].filter(Boolean) as string[];

    if (allContent.length === 0) {
      return new Response(JSON.stringify({ messages: [] }), {
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const mid = Math.ceil(allContent.length / 2);
    const [msgs1, msgs2] = await Promise.all([
      parseWithPerplexity(perplexityKey, allContent.slice(0, mid).join("\n---\n"), conflictFilter),
      allContent.length > mid
        ? parseWithPerplexity(perplexityKey, allContent.slice(mid).join("\n---\n"), conflictFilter)
        : Promise.resolve([]),
    ]);

    const messages = [...msgs1, ...msgs2]
      .sort((a: any, b: any) => (b.timestamp || "").localeCompare(a.timestamp || ""))
      .slice(0, 20);

    const result = { messages };
    await setCache(CACHE_KEY, result);

    return new Response(JSON.stringify(result), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error in telegram-feed:", error);
    return errorResponse(cors, 500, "Internal error", error);
  }
});
