import type { Context } from "hono";
import { FORCE_MIN_AGE_MS, getCached, setCache } from "../cache";
import { logCost, logCacheHit, PRICES } from "../costs";
import { getConflictConfig, readConflict } from "../conflicts";
import { envKey } from "../env";
import { extractJson, readForceRefresh, readJsonBody } from "../request";

const CACHE_KEY_BASE = "firecrawl-news";
const PANEL = "news-feed";

export async function newsRoute(c: Context) {
  const body = await readJsonBody(c);
  const forceRefresh = readForceRefresh(c, body);
  const config = getConflictConfig(readConflict(body));
  const CACHE_KEY = `${CACHE_KEY_BASE}:${config.key}`;

  const cached = await getCached(CACHE_KEY, forceRefresh ? FORCE_MIN_AGE_MS : undefined);
  if (cached) {
    logCacheHit(PANEL, "firecrawl");
    return c.json(cached);
  }

  const firecrawlKey = envKey("FIRECRAWL_API_KEY");
  if (!firecrawlKey) {
    return c.json({ error: "Service unavailable" }, 500);
  }

  const sourcesToScrape = config.newsSources.slice(0, 4);
  const scrapedContent: string[] = [];

  for (const sourceUrl of sourcesToScrape) {
    try {
      const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${firecrawlKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          url: sourceUrl,
          formats: ["markdown"],
          onlyMainContent: true,
        }),
      });

      logCost({ panel: PANEL, provider: "firecrawl", model: "scrape-v1", costUsd: PRICES.firecrawl_scrape });
      if (res.ok) {
        const data: any = await res.json();
        const markdown = data?.data?.markdown || data?.markdown || "";
        if (markdown) {
          scrapedContent.push(`SOURCE: ${sourceUrl}\n${markdown.slice(0, 2000)}`);
        }
      }
    } catch (e) {
      console.error(`Failed to scrape ${sourceUrl}:`, e);
    }
  }

  if (scrapedContent.length === 0) {
    return c.json({ stories: [] });
  }

  const perplexityKey = envKey("PERPLEXITY_API_KEY");
  if (!perplexityKey) {
    return c.json({ error: "Service unavailable" }, 500);
  }

  logCost({ panel: PANEL, provider: "perplexity", model: "sonar", costUsd: PRICES.perplexity_sonar });
  const aiRes = await fetch("https://api.perplexity.ai/chat/completions", {
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
          content: `You are an OSINT news analyst covering the ${config.label} conflict in ${config.region}. Extract the most important stories about: ${config.searchTerms}. Return ONLY valid JSON with no markdown formatting.`,
        },
        {
          role: "user",
          content: `From these scraped news sources, extract the top 8 most important stories relevant to the ${config.label} conflict (key topics: ${config.searchTerms}). Return JSON: {"stories":[{"headline":"...","summary":"2 sentences max","source":"source name","severity":"critical|high|developing|verified|info","timestamp":"ISO 8601 UTC timestamp e.g. 2026-04-28T14:30:00Z","url":"the article's full http(s) URL extracted from the scraped content"}]}. The timestamp MUST be a valid ISO 8601 UTC timestamp e.g. 2026-04-28T14:30:00Z. Do not use relative timestamps. For "url", use the article link that appears in the scraped markdown for that story; if no link is present for a story, use an empty string. NEVER invent URLs.\n\n${scrapedContent.join("\n\n---\n\n")}`,
        },
      ],
    }),
  });

  if (!aiRes.ok) {
    console.error("AI error:", await aiRes.text().catch(() => ""));
    return c.json({ stories: [] });
  }

  const aiData: any = await aiRes.json();
  const content = aiData.choices?.[0]?.message?.content || "{}";
  const parsed = extractJson(content) ?? { stories: [] };

  await setCache(CACHE_KEY, parsed);

  return c.json(parsed);
}
