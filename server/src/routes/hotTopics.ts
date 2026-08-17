/**
 * PROPOSED — awaiting Hessa's review before any commit.
 *
 * Hot-topics timeline. Two changes vs. the current version:
 *
 *  1. AI calls go through the OpenRouter gateway (agents.ts), not Perplexity.
 *     This panel extracts structure from text we already scraped, so it uses
 *     the cheap `light` tier — no web grounding needed. Same tier private-demo
 *     already uses for this exact panel.
 *
 *  2. The timeline is READ FROM STORAGE and only ever APPENDED TO. Previously
 *     the response was re-derived from whatever the day's four front-page
 *     scrapes happened to mention, then written over the single api_cache blob
 *     — so any event missing from today's scrape vanished. Now:
 *       collect → upsertTimelineEvents() (merge by conflict+event) → re-read
 *     A failed scrape or a failed AI call degrades to "timeline unchanged",
 *     never to "timeline empty".
 */
import type { Context } from "hono";
import { extractStructured } from "../agents";
import { logCost, logCacheHit, PRICES } from "../costs";
import { getConflictConfig, readConflict } from "../conflicts";
import { envKey } from "../env";
import { readForceRefresh, readJsonBody } from "../request";
import {
  collectionAgeMs,
  getTimeline,
  markCollected,
  storeItems,
  toDateOnly,
  upsertTimelineEvents,
  type TimelineEvent,
} from "../timeline";

const PANEL = "hot-topics";

// How long a collection pass stays "fresh enough" to skip re-collecting.
const COLLECT_TTL_MS = 60 * 60 * 1000; // 60 minutes, matches the old cache TTL
// Hard refreshes shrink the window instead of bypassing it, so F5-spam cannot
// multiply paid upstream calls. Same guard the old cache layer had.
const FORCE_MIN_COLLECT_AGE_MS = 5 * 60 * 1000;

// The dashboard renders a scrollable timeline and the Arabic translation route
// caps its input at 50 KB, so the response is capped rather than unbounded.
// The full history stays in Postgres regardless of this number.
const MAX_EVENTS = Number(envKey("TIMELINE_MAX_EVENTS") || 40);

interface RawTopic {
  title?: string;
  summary?: string;
  severity?: string;
  timestamp?: string;
  source?: string;
}

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
    const data: any = await res.json();
    const md = data?.data?.markdown ?? data?.markdown ?? "";
    return typeof md === "string" ? md.slice(0, 3000) : "";
  } catch (e) {
    console.error(`Firecrawl error for ${url}:`, e);
    return "";
  }
}

/** Storage rows → the response shape the frontend already consumes. */
function toResponse(events: TimelineEvent[]) {
  return {
    topics: events.map((e) => ({
      title: e.title,
      summary: e.summary,
      severity: e.severity,
      timestamp: e.event_date,
      source: e.sources?.length ? e.sources.join(", ") : undefined,
      // Extra, additive fields — safe for the existing UI to ignore.
      first_seen_at: e.first_seen_at,
      sighting_count: e.sighting_count,
    })),
  };
}

export async function hotTopicsRoute(c: Context) {
  const body = await readJsonBody(c);
  const forceRefresh = readForceRefresh(c, body);
  const config = getConflictConfig(readConflict(body));
  const WAR_START_DATE = config.timelineStartDate;

  // Storage is the source of truth, always read first.
  const stored = await getTimeline(config.key, MAX_EVENTS);

  const age = await collectionAgeMs(PANEL, config.key);
  const threshold = forceRefresh ? FORCE_MIN_COLLECT_AGE_MS : COLLECT_TTL_MS;
  if (age < threshold) {
    logCacheHit(PANEL, "openrouter");
    console.log(
      `hot-topics: last collection ${Math.round(age / 1000)}s ago (<${Math.round(
        threshold / 1000,
      )}s), serving ${stored.length} stored events`,
    );
    return c.json(toResponse(stored));
  }

  const firecrawlKey = envKey("FIRECRAWL_API_KEY");
  const gatewayKey = envKey("AI_GATEWAY_KEY");
  if (!gatewayKey || !firecrawlKey) {
    // Misconfiguration must not blank an existing timeline.
    if (stored.length > 0) return c.json(toResponse(stored));
    return c.json({ error: "Service unavailable" }, 500);
  }

  const today = new Date().toISOString().split("T")[0];

  const sourcesToScrape = config.newsSources.slice(0, 4);
  const scrapeResults = await Promise.all(
    sourcesToScrape.map(async (sourceUrl) => {
      logCost({
        panel: PANEL,
        provider: "firecrawl",
        model: "scrape",
        costUsd: PRICES.firecrawl_scrape,
      });
      const md = await firecrawlScrape(sourceUrl, firecrawlKey);
      return { url: sourceUrl, markdown: md };
    }),
  );

  const scrapedContent = scrapeResults
    .filter((r) => r.markdown)
    .map((r) => `=== ${r.url} ===\n${r.markdown}`)
    .join("\n\n");

  if (!scrapedContent) {
    console.error("All Firecrawl scrapes returned empty content — timeline unchanged");
    return c.json(toResponse(stored));
  }

  const userPrompt = `You are a timeline editor. From the following scraped news content, extract ONLY major developments in the ${config.label} conflict (key topics: ${config.searchTerms}) that occurred between ${WAR_START_DATE} and today (${today}).

STRICT RULES:
- ONLY use events explicitly mentioned in the scraped content below. Do NOT add events from your own knowledge.
- Each event MUST have a date that appears in the scraped text. If no date is visible, skip it.
- Each event MUST be relevant to the ${config.label} conflict. Skip unrelated stories.
- NO duplicates - if two sources mention the same event, merge them into one entry.
- Order from OLDEST to NEWEST.
- Maximum 15 entries.
- severity: critical (war-changing), high (major military/diplomatic), developing (significant but evolving)

Return ONLY this JSON:
{"topics":[{"title":"short title max 8 words","summary":"1-2 sentences with key facts","severity":"critical|high|developing","timestamp":"YYYY-MM-DD","source":"which outlet reported this"}]}

SCRAPED CONTENT:
${scrapedContent}`;

  let parsed: { topics?: RawTopic[] };
  try {
    parsed = await extractStructured<{ topics: RawTopic[] }>(
      PANEL,
      `You are a strict timeline editor for the ${config.label} conflict. You ONLY use facts from the provided scraped text. You NEVER add events from memory. Today is ${today}. Return ONLY valid JSON, no markdown.`,
      userPrompt,
      { topics: [] },
      { maxTokens: 3000 },
    );
  } catch (e) {
    console.error("hot-topics: timeline extraction failed:", e);
    // Do NOT mark collected — a provider error should be retried, not cached.
    return c.json(toResponse(stored));
  }

  const warStart = new Date(WAR_START_DATE).getTime();
  const todayMs = new Date(today + "T23:59:59Z").getTime();

  const inRange = (parsed.topics || []).filter((t) => {
    if (!t || !t.timestamp || !t.title) return false;
    const ts = new Date(t.timestamp).getTime();
    if (isNaN(ts)) return false;
    if (ts < warStart || ts > todayMs) {
      console.log(`Filtered out-of-range event: ${t.title} (${t.timestamp})`);
      return false;
    }
    return true;
  });

  // Append/merge. Cross-run and in-batch de-duplication now lives in
  // timeline.ts (deterministic event_key + fuzzy title match inside a +/-3 day
  // window), so the old in-memory isDuplicate() pass is gone.
  const { inserted, merged } = await upsertTimelineEvents(
    config.key,
    inRange.map((t) => ({
      conflict: config.key,
      title: String(t.title),
      summary: String(t.summary ?? ""),
      severity: t.severity,
      eventDate: String(t.timestamp),
      source: t.source ? String(t.source) : undefined,
    })),
  );

  // Keep the raw observation behind each event, so "which scrape first
  // reported this?" stays answerable after the fact.
  await storeItems(
    inRange.map((t) => ({
      source: String(t.source || "news"),
      externalId: `hot-topics|${config.key}|${toDateOnly(t.timestamp) ?? today}|${String(
        t.title,
      ).slice(0, 120)}`,
      conflict: config.key,
      panel: PANEL,
      title: String(t.title),
      content: `${t.title}\n\n${t.summary ?? ""}`,
      severity: t.severity,
      publishedAt: t.timestamp,
      raw: { collected_by: "hot-topics", scraped_sources: sourcesToScrape },
    })),
  );

  await markCollected(PANEL, config.key);
  console.log(
    `hot-topics(${config.key}): ${inRange.length} extracted → ${inserted} new, ${merged} merged`,
  );

  // Re-read so the response reflects the merged, permanent timeline rather than
  // only what this one pass happened to see.
  const refreshed = await getTimeline(config.key, MAX_EVENTS);
  return c.json(toResponse(refreshed.length > 0 ? refreshed : stored));
}
