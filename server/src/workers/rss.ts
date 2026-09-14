import { pool } from "../db";
import { envKey } from "../env";
import { sourceStatusUpdate } from "./source-status";
import Parser from "rss-parser";
import crypto from "crypto";
import { classify } from "../enrich";

// A deploy with no env configuration at all still has to ingest, so the feed
// list ships in the code and RSS_FEEDS only overrides it. Every URL below was
// verified live on 2026-09-13.
//TUNE: Control the (default rss feeds). Built-in list used when RSS_FEEDS is unset.
const DEFAULT_RSS_FEEDS = [
  "https://feeds.bbci.co.uk/news/world/rss.xml",
  "https://feeds.bbci.co.uk/news/business/rss.xml",
  "https://www.aljazeera.com/xml/rss/all.xml",
  "https://www.aljazeera.net/aljazeerarss",
  "https://www.france24.com/en/rss",
  "https://news.un.org/feed/subscribe/en/news/all/rss.xml",
  "https://feeds.content.dowjones.io/public/rss/mw_topstories",
  "https://techcrunch.com/category/artificial-intelligence/feed/",
  "https://arstechnica.com/ai/feed/",
  "https://www.theverge.com/rss/index.xml",
  "https://www.wired.com/feed/rss",
  "https://news.google.com/rss/headlines/section/topic/WORLD?hl=en-US&gl=US&ceid=US:en",
  "https://news.google.com/rss/headlines/section/topic/TECHNOLOGY?hl=en-AE&gl=AE&ceid=AE:en",
  "https://www.jpost.com/rss/rssfeedsfrontpage.aspx",
  "https://www.jpost.com/rss/rssfeedsarabisraeliconflict.aspx",
  "https://www.space.com/feeds/all",
];

//TUNE: Control the (rss feeds). RSS_FEEDS=comma separated feed URLs polled every round, overrides the built-in list.
const CONFIGURED_RSS_FEEDS = envKey("RSS_FEEDS")?.split(",").map(f => f.trim()).filter(f => f) || [];
const RSS_FEEDS = CONFIGURED_RSS_FEEDS.length > 0 ? CONFIGURED_RSS_FEEDS : DEFAULT_RSS_FEEDS;
const RSS_FEEDS_ORIGIN = CONFIGURED_RSS_FEEDS.length > 0 ? "RSS_FEEDS env" : "built-in default";
//TUNE: Control the (rss poll rate). RSS_POLL_SECONDS=seconds between polling rounds.
const RSS_POLL_SECONDS = parseInt(envKey("RSS_POLL_SECONDS") || "120");
//TUNE: Control the (circuit breaker). RSS_MAX_BACKOFF=most consecutive failing rounds before a feed is retried.
const RSS_MAX_BACKOFF = parseInt(envKey("RSS_MAX_BACKOFF") || "10");
//TUNE: Control the (per feed batch). Entries read from a single feed in one round.
const RSS_MAX_ENTRIES_PER_ROUND = parseInt(envKey("RSS_MAX_ENTRIES_PER_ROUND") || "50");

//TUNE: Control the (failure threshold). Rounds a feed may fail before backoff begins.
const MAX_CONSECUTIVE_FAILURES = 3;
//TUNE: Control the (backoff growth). Each extra failure multiplies the wait by this.
const BACKOFF_MULTIPLIER = 2;
//TUNE: Control the (backoff start). Seconds to wait before the first retry.
const INITIAL_BACKOFF = 60;
//TUNE: Control the (loop error backoff). Seconds the poll loop waits after an unexpected error.
const RSS_LOOP_ERROR_BACKOFF_SECONDS = 60;

// Feed health tracking
const feedFailures: Record<string, number> = {};
const feedBackoffs: Record<string, number> = {};
const feedLastOk: Record<string, number> = {};

// One key per feed URL, not per host. Two feeds from the same publisher need
// separate source_status rows or one silently overwrites the other's health and
// the /api/sources diagnostic cannot say which of them is down.
const feedKeyMap: Record<string, string> = {
  "https://feeds.bbci.co.uk/news/world/rss.xml": "bbc_world",
  "https://feeds.bbci.co.uk/news/business/rss.xml": "bbc_business",
  "https://www.aljazeera.com/xml/rss/all.xml": "aljazeera_en",
  "https://www.aljazeera.net/aljazeerarss": "aljazeera_ar",
  "https://www.france24.com/en/rss": "france24_en",
  "https://www.france24.com/ar/rss": "france24_ar",
  "https://news.un.org/feed/subscribe/en/news/all/rss.xml": "un_news",
  "https://feeds.content.dowjones.io/public/rss/mw_topstories": "wsj_topstories",
  "https://techcrunch.com/category/artificial-intelligence/feed/": "techcrunch_ai",
  "https://arstechnica.com/ai/feed/": "arstechnica_ai",
  "https://www.theverge.com/rss/index.xml": "theverge",
  "https://www.wired.com/feed/rss": "wired",
  "https://news.google.com/rss/headlines/section/topic/WORLD?hl=en-US&gl=US&ceid=US:en": "google_news_world",
  "https://news.google.com/rss/headlines/section/topic/TECHNOLOGY?hl=en-AE&gl=AE&ceid=AE:en": "google_news_tech",
  "https://www.jpost.com/rss/rssfeedsfrontpage.aspx": "jpost_front",
  "https://www.jpost.com/rss/rssfeedsarabisraeliconflict.aspx": "jpost_mideast",
  "https://www.space.com/feeds/all": "space_com",
};

//TUNE: Control the (fallback key length). Characters kept from a host+path slug when a feed is not in feedKeyMap.
const FALLBACK_KEY_MAX_CHARS = 40;

function getFeedKey(url: string): string {
  const mapped = feedKeyMap[url.trim()];
  if (mapped) return mapped;

  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "").replace(/^feeds?\./, "");
    // The path is what separates two feeds on the same host, so it belongs in
    // the key. Feed-format filename noise does not.
    const path = parsed.pathname
      .replace(/\.(xml|rss|aspx|json)$/i, "")
      .replace(/\b(rss|feed|feeds|index|all)\b/gi, " ");
    return `${host} ${path}`
      .replace(/[^a-zA-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .toLowerCase()
      .substring(0, FALLBACK_KEY_MAX_CHARS) || "unknown_feed";
  } catch {
    return "unknown_feed";
  }
}

// An unparseable date is not a date. NaN compares false against everything, so
// without this check an Invalid Date passes a truthiness guard and reaches the
// INSERT.
function parseEventTs(entry: { isoDate?: string; pubDate?: string }): Date | null {
  for (const raw of [entry.isoDate, entry.pubDate]) {
    if (!raw) continue;
    const parsed = new Date(raw);
    if (Number.isFinite(parsed.getTime())) return parsed;
  }
  return null;
}

function clampFutureTimestamp(date: Date | null): Date | null {
  if (!date) return null;
  const now = new Date();
  return date > now ? now : date;
}

function generateGuidHash(guid: string, link: string): string {
  const input = guid || link || "";
  return crypto.createHash("md5").update(input).digest("hex");
}

//TUNE: Control the (feed fetch timeout). RSS_FETCH_TIMEOUT_MS=milliseconds a single feed request may take.
const RSS_FETCH_TIMEOUT_MS = parseInt(envKey("RSS_FETCH_TIMEOUT_MS") || "20000");

//TUNE: Control the (feed user agent). RSS_USER_AGENT=identity sent to publishers, some reject a blank or generic one.
const RSS_USER_AGENT = envKey("RSS_USER_AGENT")
  || "OSINT-Dashboard-Conflict-Tracker/1.0 (+https://hessaa.net)";

// rss-parser's own parseURL does not decompress the response body, and several
// publishers (news.un.org) return gzip whether or not it was requested, so the
// parser is handed a binary blob and dies on the gzip magic byte. fetch handles
// content-encoding, so the body is read here and only parsed by rss-parser.
async function fetchFeedText(feedUrl: string): Promise<string> {
  const res = await fetch(feedUrl, {
    headers: {
      "User-Agent": RSS_USER_AGENT,
      Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(RSS_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
  }
  return await res.text();
}

async function insertItem(item: {
  source: string;
  externalId: string;
  url: string;
  title: string;
  content: string;
  author: string;
  eventTs: Date;
  feedKey: string;
  raw: any;
}): Promise<boolean> {
  try {
    const enriched = classify({
      title: item.title,
      content: item.content,
      publishedAt: item.eventTs,
    });

    const result = await pool.query(
      `INSERT INTO items (
        source, 
        external_id, 
        url, 
        title, 
        content, 
        author, 
        published_at, 
        source_uid,
        raw,
        event_type,
        severity,
        is_breaking,
        lang,
        enrichment
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT (source, external_id) DO NOTHING
      RETURNING id`,
      [
        item.source,
        item.externalId,
        item.url,
        item.title,
        item.content,
        item.author,
        item.eventTs,
        item.feedKey,
        item.raw,
        enriched.event_type,
        enriched.severity,
        enriched.is_breaking,
        enriched.lang,
        JSON.stringify(enriched.enrichment)
      ]
    );
    
    return result?.rowCount !== null && result?.rowCount > 0;
  } catch (e) {
    console.error("Error inserting item:", e);
    return false;
  }
}

async function processFeed(feedUrl: string): Promise<void> {
  const feedKey = getFeedKey(feedUrl);
  
  // Check if feed is under backoff
  if (feedBackoffs[feedKey]) {
    const backoffUntil = feedBackoffs[feedKey];
    if (Date.now() < backoffUntil) {
      console.log(`[rss] ${feedKey} skipped, backoff until ${new Date(backoffUntil).toISOString()}`);
      return;
    }
  }
  
  let feedLabel = feedKey;
  try {
    const parser: Parser = new Parser({
      customFields: {
        item: ['media:content', 'media:description']
      }
    });
    
    const feed = await parser.parseString(await fetchFeedText(feedUrl));
    feedLabel = feed.title || feedKey;
    
    let readCount = 0;
    let insertedCount = 0;
    let undatedCount = 0;
    
    for (const entry of feed.items) {
      if (readCount >= RSS_MAX_ENTRIES_PER_ROUND) break;
      readCount++;
      
      const eventTs = clampFutureTimestamp(parseEventTs(entry));
      if (!eventTs) {
        undatedCount++;
        continue;
      }
      
      const guid = entry.guid || entry.id || "";
      const link = entry.link || "";
      const externalId = `${feedKey}:${generateGuidHash(guid, link)}`;
      
      let content = "";
      if (entry["content:encoded"]) {
        content = entry["content:encoded"];
      } else if (entry.content) {
        content = entry.content;
      } else if (entry.contentSnippet) {
        content = entry.contentSnippet;
      }
      content = content.replace(/<[^>]*>/g, "");
      
      const title = entry.title || "";
      const author = entry.creator || entry.author || "";
      
      const inserted = await insertItem({
        source: "rss",
        externalId,
        url: link,
        title,
        content,
        author,
        eventTs,
        feedKey,
        raw: {
          original: entry,
          feedUrl,
          feedKey,
          original_pubdate: entry.isoDate || entry.pubDate || null
        }
      });
      
      if (inserted) insertedCount++;
    }
    
    // Reset failure tracking
    feedFailures[feedKey] = 0;
    feedLastOk[feedKey] = Date.now();
    if (feedBackoffs[feedKey]) {
      delete feedBackoffs[feedKey];
    }
    
    // Undated entries are rejected, so they are counted in the detail rather
    // than disappearing: a feed that publishes nothing parseable looks
    // identical to a healthy quiet feed otherwise.
    const detail = undatedCount > 0
      ? `read ${readCount}, inserted ${insertedCount}, rejected ${undatedCount} with no parseable date`
      : `read ${readCount}, inserted ${insertedCount}`;
    
    console.log(`[rss] ${feedKey} ok: ${detail}`);
    
    await sourceStatusUpdate({
      id: feedKey,
      source: "rss",
      label: feedLabel,
      ok: true,
      detail,
      failures: 0,
      last_ok: new Date(),
      updated_at: new Date()
    });
    
  } catch (e) {
    feedFailures[feedKey] = (feedFailures[feedKey] || 0) + 1;
    const errorMessage = e instanceof Error ? e.message : String(e);
    console.error(`[rss] ${feedKey} failed (${feedFailures[feedKey]} consecutive): ${errorMessage}`);
    
    await sourceStatusUpdate({
      id: feedKey,
      source: "rss",
      label: feedLabel,
      ok: false,
      detail: errorMessage,
      failures: feedFailures[feedKey],
      last_ok: feedLastOk[feedKey] ? new Date(feedLastOk[feedKey]) : undefined,
      updated_at: new Date()
    });
    
    if (feedFailures[feedKey] >= MAX_CONSECUTIVE_FAILURES) {
      // Apply backoff
      const backoffRounds = Math.min(feedFailures[feedKey] - MAX_CONSECUTIVE_FAILURES, RSS_MAX_BACKOFF);
      const backoffTime = INITIAL_BACKOFF * Math.pow(BACKOFF_MULTIPLIER, backoffRounds) * 1000;
      feedBackoffs[feedKey] = Date.now() + backoffTime;
      console.warn(`[rss] ${feedKey} backing off for ${backoffTime / 1000}s`);
    }
  }
}

// Which list is in use is the first thing to check when a deploy ingests
// nothing, so the worker states it on every start.
function logFeedList(): void {
  console.log(`[rss] using the ${RSS_FEEDS_ORIGIN} feed list, ${RSS_FEEDS.length} feeds`);
  for (const url of RSS_FEEDS) {
    console.log(`[rss]   ${getFeedKey(url)}  ${url}`);
  }
}

// One full pass over every feed. Exported so a deploy can be verified with a
// single round instead of leaving the poll loop running.
export async function runRssRound(): Promise<void> {
  await Promise.all(RSS_FEEDS.map(url => processFeed(url)));
}

export async function runRssWorker(): Promise<void> {
  logFeedList();
  
  while (true) {
    try {
      await runRssRound();
      console.log(`[rss] round complete, sleeping ${RSS_POLL_SECONDS}s`);
      await new Promise(resolve => setTimeout(resolve, RSS_POLL_SECONDS * 1000));
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      console.error("[rss] unexpected error in the poll loop:", errorMessage);
      await new Promise(resolve => setTimeout(resolve, RSS_LOOP_ERROR_BACKOFF_SECONDS * 1000));
    }
  }
}