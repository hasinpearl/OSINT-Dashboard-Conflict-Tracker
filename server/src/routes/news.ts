import type { Context } from "hono";
import { FORCE_MIN_AGE_MS, getCached, setCache } from "../cache";
import { logCost, logCacheHit, PRICES } from "../costs";
import { getConflictConfig, readConflict } from "../conflicts";
import { extractStructured } from "../agents";
import { envKey } from "../env";
import { readForceRefresh, readJsonBody } from "../request";
import { AppError } from "../errors";
import { extractArticle } from "../extractor";

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
    // Firecrawl is now optional, so we don't throw an error
    console.log("FIRECRAWL_API_KEY not set, using free extraction methods");
  }

  const sourcesToScrape = config.newsSources.slice(0, 4);
  const scrapedContent: string[] = [];
  //TUNE: Control the (timestamp source). Real article metadata only. The model never supplies a time.
  const realTimestamps: Record<string, string | null> = {};

  for (const sourceUrl of sourcesToScrape) {
    try {
      const article = await extractArticle(sourceUrl);
      realTimestamps[sourceUrl] = article.publishedAt ?? null;
      if (article.content) {
        scrapedContent.push(`SOURCE: ${sourceUrl}\nTITLE: ${article.title}\nTIMESTAMP: ${article.publishedAt || "NULL"}\n${article.content.slice(0, 2000)}`);
      }
    } catch (e) {
      console.error(`Failed to scrape ${sourceUrl}:`, e);
    }
  }

  if (scrapedContent.length === 0) {
    return c.json({ stories: [] });
  }

  const parsed = await extractStructured<{ stories?: any[] }>(
    PANEL,
    `You are an OSINT news analyst covering the ${config.label} conflict in ${config.region}. Extract the most important stories about: ${config.searchTerms}. Return ONLY valid JSON with no markdown formatting.`,
    `From these scraped news sources, extract the top 8 most important stories relevant to the ${config.label} conflict (key topics: ${config.searchTerms}). Return JSON: {"stories":[{"headline":"...","summary":"2 sentences max","source":"source name","severity":"critical|high|developing|verified|info","url":"the article's full http(s) URL extracted from the scraped content"}]}. Do not include a timestamp field. For "url", use the article link that appears in the scraped content for that story; if no link is present for a story, use an empty string. NEVER invent URLs.

${scrapedContent.join("\n\n---\n\n")}`,
    { stories: [] },
  ).catch((e) => {
    console.error("OpenRouter error (news):", e instanceof Error ? e.message : e);
    return { stories: [] };
  });

  const stories = (parsed.stories || []).map((story: any) => ({
    ...story,
    timestamp: realTimestamps[String(story?.url)] ?? null,
  }));

  const result = { ...parsed, stories };
  await setCache(CACHE_KEY, result);

  return c.json(result);
}