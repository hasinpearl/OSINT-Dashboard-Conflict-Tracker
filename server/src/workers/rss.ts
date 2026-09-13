import { pool } from "../db";
import { envKey } from "../env";
import { sourceStatusUpdate } from "./source-status";
import Parser from "rss-parser";
import https from "https";
import crypto from "crypto";
import { Item, SourceStatus } from "../types";

//TUNE: Control the (rss feeds). RSS_FEEDS=comma separated feed URLs polled every round.
const RSS_FEEDS = envKey("RSS_FEEDS")?.split(",").map(f => f.trim()).filter(f => f) || [];
//TUNE: Control the (rss poll rate). RSS_POLL_SECONDS=seconds between polling rounds.
const RSS_POLL_SECONDS = parseInt(envKey("RSS_POLL_SECONDS") || "120");
//TUNE: Control the (circuit breaker). RSS_MAX_BACKOFF=most consecutive failing rounds before a feed is retried.
const RSS_MAX_BACKOFF = parseInt(envKey("RSS_MAX_BACKOFF") || "10");

//TUNE: Control the (failure threshold). Rounds a feed may fail before backoff begins.
const MAX_CONSECUTIVE_FAILURES = 3;
//TUNE: Control the (backoff growth). Each extra failure multiplies the wait by this.
const BACKOFF_MULTIPLIER = 2;
//TUNE: Control the (backoff start). Seconds to wait before the first retry.
const INITIAL_BACKOFF = 60;

// Feed health tracking
const feedFailures: Record<string, number> = {};
const feedBackoffs: Record<string, number> = {};
const feedLastOk: Record<string, number> = {};

// Feed key mapping for readable identifiers
const feedKeyMap: Record<string, string> = {
  "feeds.bbci.co.uk": "bbc",
  "aljazeera.com": "aljazeera",
  "france24.com": "france24",
  "news.un.org": "un_news",
  "news.google.com": "google_news",
  "techcrunch.com": "techcrunch",
  "arstechnica.com": "arstechnica",
  "theverge.com": "theverge",
  "wired.com": "wired",
  "feeds.content.dowjones.io": "wsj",
  "jpost.com": "jpost",
  "space.com": "space_com"
};

function getFeedKey(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '');
    
    // Check if we have a specific key for this host
    for (const [domain, key] of Object.entries(feedKeyMap)) {
      if (host.includes(domain)) {
        return key;
      }
    }
    
    // Fallback to a slug of the host
    return host.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 20);
  } catch (e) {
    return "unknown_feed";
  }
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
    const result = await pool.query(
      `INSERT INTO items (
        source, 
        external_id, 
        url, 
        title, 
        content, 
        author, 
        event_ts, 
        source_uid,
        raw
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
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
        item.raw
      ]
    );
    
    return result?.rowCount !== null && result?.rowCount > 0;
  } catch (e) {
    console.error("Error inserting item:", e);
    return false;
  }
}

async function processFeed(url: string): Promise<void> {
  const feedKey = getFeedKey(url);
  
  // Check if feed is under backoff
  if (feedBackoffs[feedKey]) {
    const backoffUntil = feedBackoffs[feedKey];
    if (Date.now() < backoffUntil) {
      console.log(`Skipping ${feedKey} due to backoff until ${new Date(backoffUntil).toISOString()}`);
      return;
    }
  }
  
  let feedLabel = feedKey;
  try {
    // Custom https agent to handle self-signed certificates
    const agent = new https.Agent({  
      rejectUnauthorized: false
    });
    
    const parser: Parser = new Parser({
      customFields: {
        item: ['media:content', 'media:description']
      }
    });
    
    // Fetch and parse feed
    const feed = await parser.parseURL(url);
    feedLabel = feed.title || feedKey;
    
    // Process entries
    let processedCount = 0;
    const maxEntries = 50; // Limit per feed cycle
    
    for (const entry of feed.items) {
      if (processedCount >= maxEntries) break;
      
      // Extract timestamp
      let eventTs: Date | null = null;
      if (entry.pubDate) {
        eventTs = new Date(entry.pubDate);
      } else if (entry.isoDate) {
        eventTs = new Date(entry.isoDate);
      }
      
      eventTs = clampFutureTimestamp(eventTs);
      
      // Skip if no parseable date
      if (!eventTs) {
        console.warn(`Skipping entry with no parseable date: ${entry.title}`);
        continue;
      }
      
      // External ID
      const guid = entry.guid || entry.id || "";
      const link = entry.link || "";
      const externalId = `${feedKey}:${generateGuidHash(guid, link)}`;
      
      // Content
      let content = "";
      if (entry["content:encoded"]) {
        content = entry["content:encoded"];
      } else if (entry.content) {
        content = entry.content;
      } else if (entry.contentSnippet) {
        content = entry.contentSnippet;
      }
      
      // Strip HTML tags for content
      content = content.replace(/<[^>]*>/g, "");
      
      // Title
      const title = entry.title || "";
      
      // Author
      const author = entry.creator || entry.author || "";
      
      // URL
      const url = entry.link || "";
      
      // Insert into database
      const inserted = await insertItem({
        source: "rss",
        externalId,
        url,
        title,
        content,
        author,
        eventTs,
        feedKey,
        raw: {
          original: entry,
          feedUrl: url,
          feedKey: feedKey
        }
      });
      
      if (inserted) {
        console.log(`Inserted RSS item: ${title.substring(0, 50)}...`);
      }
      
      processedCount++;
    }
    
    // Reset failure tracking
    feedFailures[feedKey] = 0;
    feedLastOk[feedKey] = Date.now();
    if (feedBackoffs[feedKey]) {
      delete feedBackoffs[feedKey];
    }
    
    console.log(`Feed ${feedKey} processed successfully with ${processedCount} items`);
    
    // Update source status
    await sourceStatusUpdate({
      id: feedKey,
      source: "rss",
      label: feedLabel,
      ok: true,
      detail: `Processed ${processedCount} items`,
      failures: 0,
      last_ok: new Date(),
      updated_at: new Date()
    });
    
  } catch (e) {
    // Handle failure
    feedFailures[feedKey] = (feedFailures[feedKey] || 0) + 1;
    const errorMessage = e instanceof Error ? e.message : String(e);
    console.error(`Error processing feed ${feedKey}:`, errorMessage);
    
    // Update source status with failure
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
      console.warn(`Backing off feed ${feedKey} for ${backoffTime/1000} seconds`);
    }
  }
}

export async function runRssWorker(): Promise<void> {
  if (RSS_FEEDS.length === 0) {
    console.error("No RSS feeds configured");
    return;
  }
  
  console.log(`Starting RSS worker with ${RSS_FEEDS.length} feeds`);
  
  while (true) {
    try {
      console.log("Polling RSS feeds...");
      
      // Process all feeds concurrently
      await Promise.all(RSS_FEEDS.map(url => processFeed(url)));
      
      console.log(`Sleeping for ${RSS_POLL_SECONDS} seconds`);
      await new Promise(resolve => setTimeout(resolve, RSS_POLL_SECONDS * 1000));
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      console.error("Unexpected error in RSS worker loop:", errorMessage);
      await new Promise(resolve => setTimeout(resolve, 60 * 1000)); // Wait 1 minute before retrying
    }
  }
}