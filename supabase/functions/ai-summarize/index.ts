import { getCached, setCache } from "../_shared/cache.ts";
import { logCost, logCacheHit, PRICES } from "../_shared/costs.ts";
import { corsHeadersFor, errorResponse } from "../_shared/cors.ts";

const CACHE_KEY = "ai-summarize";
const PANEL = "hot-topics";

// War start date: February 28, 2026
const WAR_START_DATE = "2026-02-28";

const SCRAPE_SOURCES = [
  { url: "https://www.reuters.com/world/middle-east/", name: "Reuters" },
  { url: "https://www.bbc.com/news/world/middle_east", name: "BBC" },
  { url: "https://www.aljazeera.com/middle-east/", name: "Al Jazeera" },
  { url: "https://apnews.com/hub/middle-east", name: "AP News" },
];

async function firecrawlScrape(url: string, apiKey: string): Promise<string> {
  try {
    const res = await fetch("https://api.firecrawl.dev/v2/scrape", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url,
        formats: ["markdown"],
        onlyMainContent: true,
      }),
    });
    if (!res.ok) {
      console.error(`Firecrawl scrape failed for ${url}: ${res.status}`);
      return "";
    }
    const data = await res.json();
    const md =
      data?.data?.markdown ??
      data?.markdown ??
      "";
    return typeof md === "string" ? md.slice(0, 3000) : "";
  } catch (e) {
    console.error(`Firecrawl error for ${url}:`, e);
    return "";
  }
}

function titleWords(s: string): Set<string> {
  return new Set(
    (s || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3)
  );
}

function isDuplicate(a: string, b: string): boolean {
  const wa = titleWords(a);
  const wb = titleWords(b);
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared >= 4;
}

Deno.serve(async (req) => {
  const cors = corsHeadersFor(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  try {
    const url = new URL(req.url);
    let forceRefresh = url.searchParams.get("force_refresh") === "true";
    if (!forceRefresh && (req.method === "POST" || req.method === "PUT")) {
      try {
        const body = await req.clone().json();
        if (body && body.force_refresh === true) forceRefresh = true;
      } catch {
        // ignore non-JSON bodies
      }
    }

    if (!forceRefresh) {
      const cached = await getCached(CACHE_KEY);
      if (cached) {
        logCacheHit(PANEL, "perplexity");
        return new Response(JSON.stringify(cached), {
          headers: { ...cors, "Content-Type": "application/json" },
        });
      }
    } else {
      console.log("force_refresh=true, bypassing cache");
    }

    const perplexityKey = Deno.env.get("PERPLEXITY_API_KEY");
    const firecrawlKey = Deno.env.get("FIRECRAWL_API_KEY");
    if (!perplexityKey || !firecrawlKey) {
      return errorResponse(cors, 500, "Service unavailable");
    }

    const today = new Date().toISOString().split("T")[0];

    // STEP 1: Scrape real timeline pages from journalist-maintained sources.
    const scrapeResults = await Promise.all(
      SCRAPE_SOURCES.map(async (s) => {
        logCost({
          panel: PANEL,
          provider: "firecrawl",
          model: "scrape",
          costUsd: PRICES.firecrawl_scrape,
        });
        const md = await firecrawlScrape(s.url, firecrawlKey);
        return { ...s, markdown: md };
      })
    );

    const scrapedContent = scrapeResults
      .filter((r) => r.markdown)
      .map((r) => `=== ${r.name} (${r.url}) ===\n${r.markdown}`)
      .join("\n\n");

    if (!scrapedContent) {
      console.error("All Firecrawl scrapes returned empty content");
      return new Response(JSON.stringify({ topics: [] }), {
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // STEP 2: Single Perplexity call to extract structured timeline from scraped content.
    logCost({
      panel: PANEL,
      provider: "perplexity",
      model: "sonar-pro",
      costUsd: PRICES.perplexity_sonar_pro,
    });

    const userPrompt = `You are a timeline editor. From the following scraped news content, extract ONLY major developments in the Iran-Israel/US conflict that occurred between ${WAR_START_DATE} and today (${today}).

STRICT RULES:
- ONLY use events explicitly mentioned in the scraped content below. Do NOT add events from your own knowledge.
- Each event MUST have a date that appears in the scraped text. If no date is visible, skip it.
- NO duplicates — if two sources mention the same event, merge them into one entry.
- Order from OLDEST to NEWEST.
- Maximum 15 entries.
- severity: critical (war-changing), high (major military/diplomatic), developing (significant but evolving)

Return ONLY this JSON:
{"topics":[{"title":"short title max 8 words","summary":"1-2 sentences with key facts","severity":"critical|high|developing","timestamp":"YYYY-MM-DD","source":"which outlet reported this"}]}

SCRAPED CONTENT:
${scrapedContent}`;

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
            content: `You are a strict timeline editor. You ONLY use facts from the provided scraped text. You NEVER add events from memory. Today is ${today}. Return ONLY valid JSON, no markdown.`,
          },
          { role: "user", content: userPrompt },
        ],
      }),
    });

    if (!aiRes.ok) {
      console.error("Perplexity structure call failed:", aiRes.status, await aiRes.text());
      return new Response(JSON.stringify({ topics: [] }), {
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const aiData = await aiRes.json();
    const content = aiData.choices?.[0]?.message?.content || "{}";
    let parsed: { topics?: any[] };
    try {
      parsed = JSON.parse(content);
    } catch {
      const m = content.match(/```(?:json)?\s*([\s\S]*?)```/);
      try {
        parsed = m ? JSON.parse(m[1]) : { topics: [] };
      } catch {
        parsed = { topics: [] };
      }
    }

    // STEP 3: Server-side validation — date range, sort, dedupe.
    const warStart = new Date(WAR_START_DATE).getTime();
    const todayMs = new Date(today + "T23:59:59Z").getTime();

    const inRange = (parsed.topics || []).filter((t: any) => {
      if (!t || !t.timestamp) return false;
      const ts = new Date(t.timestamp).getTime();
      if (isNaN(ts)) return false;
      if (ts < warStart || ts > todayMs) {
        console.log(`Filtered out-of-range event: ${t.title} (${t.timestamp})`);
        return false;
      }
      return true;
    });

    // Sort oldest -> newest
    inRange.sort((a: any, b: any) => (a.timestamp || "").localeCompare(b.timestamp || ""));

    // Dedupe by title similarity (4+ shared words → drop later one)
    const deduped: any[] = [];
    for (const t of inRange) {
      const dup = deduped.some((kept) => isDuplicate(kept.title || "", t.title || ""));
      if (!dup) deduped.push(t);
    }

    const validated = { topics: deduped };

    await setCache(CACHE_KEY, validated);

    return new Response(JSON.stringify(validated), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error in ai-summarize:", error);
    return errorResponse(cors, 500, "Internal error", error);
  }
});
