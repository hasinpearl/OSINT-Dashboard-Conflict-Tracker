import type { Context } from "hono";
import { deleteCacheKeys, FORCE_MIN_AGE_MS, getCached, setCache } from "../cache";
import { logCost, logCacheHit, PRICES } from "../costs";
import { getConflictConfig, readConflict } from "../conflicts";
import { envKey } from "../env";
import { extractJson, readForceRefresh, readJsonBody } from "../request";

const CACHE_KEY_BASE = "telegram-feed";
const PANEL = "telegram";
const MAX_NEWEST_POST_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours

async function clearAllTelegramCache(): Promise<void> {
  const keys = [
    `${CACHE_KEY_BASE}:all`,
    `${CACHE_KEY_BASE}:iran-us`,
    `${CACHE_KEY_BASE}:ukraine-russia`,
    `${CACHE_KEY_BASE}:china-taiwan`,
  ];
  await deleteCacheKeys(keys);
  console.log(`Cleared all telegram-feed cache rows (${keys.join(", ")})`);
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
      const data: any = await res.json();
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
): Promise<any[]> {
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
    console.error("Perplexity error:", res.status, await res.text().catch(() => ""));
    return [];
  }

  const data: any = await res.json();
  const raw = data.choices?.[0]?.message?.content || "{}";
  const parsed = extractJson(raw) ?? { messages: [] };
  return parsed.messages || [];
}

export async function telegramRoute(c: Context) {
  const body = await readJsonBody(c);
  const forceRefresh = readForceRefresh(c, body);
  const config = getConflictConfig(readConflict(body));
  const CACHE_KEY = `${CACHE_KEY_BASE}:${config.key}`;

  const conflictFilter =
    config.key === "all"
      ? ""
      : ` Only include posts relevant to the ${config.label} conflict (key topics: ${config.searchTerms}). Exclude posts about other conflicts or unrelated topics.`;

  const cached = await getCached(CACHE_KEY, forceRefresh ? FORCE_MIN_AGE_MS : undefined);
  if (cached) {
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
        console.log("Cache STALE (newest post >2h old) - clearing all telegram-feed cache rows");
        await clearAllTelegramCache();
      } else {
        logCacheHit(PANEL, "firecrawl");
        return c.json(cached);
      }
    } else {
      console.log("Telegram cache has no post timestamps - treating as stale");
      await clearAllTelegramCache();
    }
  }

  const firecrawlKey = envKey("FIRECRAWL_API_KEY");
  const perplexityKey = envKey("PERPLEXITY_API_KEY");

  if (!firecrawlKey || !perplexityKey) {
    return c.json({ messages: [] });
  }

  const batch1 = await Promise.all(CHANNELS.slice(0, 4).map((ch) => scrapeChannel(firecrawlKey, ch)));
  const batch2 = await Promise.all(CHANNELS.slice(4, 8).map((ch) => scrapeChannel(firecrawlKey, ch)));
  const batch3 = await Promise.all(CHANNELS.slice(8).map((ch) => scrapeChannel(firecrawlKey, ch)));

  const allContent = [...batch1, ...batch2, ...batch3].filter(Boolean) as string[];

  if (allContent.length === 0) {
    return c.json({ messages: [] });
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

  return c.json(result);
}
