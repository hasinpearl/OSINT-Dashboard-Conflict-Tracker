import type { Context } from "hono";
import { FORCE_MIN_AGE_MS, getCached, getStaleCached, setCache } from "../cache";
import { logCost, logCacheHit, PRICES } from "../costs";
import { getConflictConfig, readConflict } from "../conflicts";
import { envKey } from "../env";
import { extractJson, readForceRefresh, readJsonBody } from "../request";

const CACHE_KEY_BASE = "perplexity-osint";
const PANEL = "osint";

export async function osintRoute(c: Context) {
  const body = await readJsonBody(c);
  const forceRefresh = readForceRefresh(c, body);
  const config = getConflictConfig(readConflict(body));
  const CACHE_KEY = `${CACHE_KEY_BASE}:${config.key}`;

  const cached = await getCached(CACHE_KEY, forceRefresh ? FORCE_MIN_AGE_MS : undefined);
  const cachedItems = Array.isArray(cached?.items) ? cached.items : [];
  const cachedHasItems = cachedItems.length > 0;
  if (cachedHasItems) {
    logCacheHit(PANEL, "perplexity");
    return c.json(cached);
  }

  const perplexityKey = envKey("PERPLEXITY_API_KEY");
  if (!perplexityKey) {
    return c.json({ error: "Service unavailable" }, 500);
  }

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
          content: `You are an OSINT analyst covering the ${config.label} conflict in ${config.region}. Return ONLY valid JSON with no markdown.`,
        },
        {
          role: "user",
          content: `Find the top 6 verified OSINT intelligence items about ${config.label} from open sources such as Bellingcat, OSINT Defender, Janes Defence, and X/Twitter analysts. Include the most recent items available. Each item MUST have a valid source URL. Do NOT return a message saying no data is available - always return your best findings even if they are older. Focus on military and security activities in ${config.region} relevant to the ${config.label} conflict (key topics: ${config.searchTerms}). Return ONLY JSON: {"items":[{"title":"...","summary":"2 sentences","source":"source name","confidence":"verified|unverified|developing","timestamp":"ISO 8601 UTC timestamp e.g. 2026-04-28T14:30:00Z","url":"https://..."}]}. The timestamp MUST be a valid ISO 8601 UTC timestamp e.g. 2026-04-28T14:30:00Z. Do not use relative timestamps. Every item MUST include a valid, clickable source URL from the original report. If you cannot provide a verified source URL for an item, do not include that item.`,
        },
      ],
      search_domain_filter: ["bellingcat.com", "janes.com", "twitter.com"],
    }),
  });

  if (!res.ok) {
    console.error("Perplexity error:", await res.text().catch(() => ""));
    const fallback = cached ?? (await getStaleCached(CACHE_KEY));
    return c.json(fallback ?? { items: [] });
  }

  const data: any = await res.json();
  const content = data.choices?.[0]?.message?.content || "{}";
  const parsed: { items?: any[] } = extractJson(content) ?? { items: [] };

  const filtered = {
    items: (parsed.items || []).filter((it: any) => {
      const u = typeof it?.url === "string" ? it.url.trim() : "";
      return u.length > 0 && /^https?:\/\//i.test(u);
    }),
  };

  if (filtered.items.length > 0) {
    await setCache(CACHE_KEY, filtered);
    return c.json(filtered);
  }

  const fallbackCached = cachedHasItems ? cached : await getStaleCached(CACHE_KEY);
  const response = fallbackCached ?? filtered;
  console.log(`perplexity-osint: no new items, ${fallbackCached ? "using stale cache" : "returning empty"}`);
  return c.json(response);
}
