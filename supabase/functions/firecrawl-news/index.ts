import { getCached, setCache } from "../_shared/cache.ts";
import { logCost, logCacheHit, PRICES } from "../_shared/costs.ts";
import { corsHeadersFor, errorResponse } from "../_shared/cors.ts";
import { getConflictConfig, readConflictFromRequest } from "../_shared/conflicts.ts";

const CACHE_KEY_BASE = "firecrawl-news";
const PANEL = "news-feed";

Deno.serve(async (req) => {
  const cors = corsHeadersFor(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  try {
    const conflict = await readConflictFromRequest(req);
    const config = getConflictConfig(conflict);
    const CACHE_KEY = `${CACHE_KEY_BASE}:${config.key}`;

    // Check cache first
    const cached = await getCached(CACHE_KEY);
    if (cached) {
      logCacheHit(PANEL, "firecrawl");
      return new Response(JSON.stringify(cached), {
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const firecrawlKey = Deno.env.get("FIRECRAWL_API_KEY");
    if (!firecrawlKey) {
      return errorResponse(cors, 500, "Service unavailable");
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
          const data = await res.json();
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
      return new Response(JSON.stringify({ stories: [] }), {
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const perplexityKey = Deno.env.get("PERPLEXITY_API_KEY");
    if (!perplexityKey) {
      return errorResponse(cors, 500, "Service unavailable");
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
            content: `From these scraped news sources, extract the top 8 most important stories relevant to the ${config.label} conflict (key topics: ${config.searchTerms}). Return JSON: {"stories":[{"headline":"...","summary":"2 sentences max","source":"source name","severity":"critical|high|developing|verified|info","timestamp":"ISO 8601 UTC timestamp e.g. 2026-04-28T14:30:00Z","url":""}]}. The timestamp MUST be a valid ISO 8601 UTC timestamp e.g. 2026-04-28T14:30:00Z. Do not use relative timestamps.\n\n${scrapedContent.join("\n\n---\n\n")}`,
          },
        ],
      }),
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      console.error("AI error:", errText);
      return new Response(JSON.stringify({ stories: [] }), {
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const aiData = await aiRes.json();
    const content = aiData.choices?.[0]?.message?.content || "{}";
    let parsed;
    try { parsed = JSON.parse(content); } catch {
      const m = content.match(/```(?:json)?\s*([\s\S]*?)```/);
      parsed = m ? JSON.parse(m[1]) : {};
    }

    // Save to cache
    await setCache(CACHE_KEY, parsed);

    return new Response(JSON.stringify(parsed), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error in firecrawl-news:", error);
    return errorResponse(cors, 500, "Internal error", error);
  }
});
