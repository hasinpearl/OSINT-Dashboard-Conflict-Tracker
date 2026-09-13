import type { Context } from "hono";
import { deleteCacheKeys, FORCE_MIN_AGE_MS, getCached, setCache } from "../cache";
import { logCost, logCacheHit, PRICES } from "../costs";
import { getConflictConfig, readConflict } from "../conflicts";
import { extractStructured } from "../agents";
import { envKey } from "../env";
import { readForceRefresh, readJsonBody } from "../request";
import { AppError } from "../errors";
import { pool } from "../db";

const CACHE_KEY_BASE = "telegram-feed";
const PANEL = "telegram";
//TUNE: Control max age of the newest cached post before forcing a re-scrape
const MAX_NEWEST_POST_AGE_MS = 2 * 60 * 60 * 1000;

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

export async function telegramRoute(c: Context) {
  const body = await readJsonBody(c);
  const forceRefresh = readForceRefresh(c, body);
  const config = getConflictConfig(readConflict(body));
  const CACHE_KEY = `${CACHE_KEY_BASE}:${config.key}`;

  // Try to get data from cache first
  const cached = await getCached(CACHE_KEY, forceRefresh ? FORCE_MIN_AGE_MS : undefined);
  if (cached) {
    logCacheHit(PANEL, "database");
    return c.json(cached);
  }

  // If not in cache, fetch from database
  try {
    // Fetch recent Telegram messages from database
    const result = await pool.query(
      `SELECT 
         id,
         source_uid,
         url,
         content,
         author,
         event_ts as timestamp,
         raw
       FROM items 
       WHERE source = 'telegram' 
         AND event_ts >= NOW() - INTERVAL '2 hours'
       ORDER BY event_ts DESC 
       LIMIT 20`
    );

    const messages = result.rows.map(row => ({
      channel: row.source_uid,
      text: row.content,
      timestamp: row.timestamp.toISOString(),
      message_id: row.id,
      url: row.url
    }));

    const resultData = { messages };
    await setCache(CACHE_KEY, resultData);

    return c.json(resultData);
  } catch (e) {
    console.error("Error fetching Telegram messages from database:", e);
    throw new AppError("internal_error", "Failed to fetch Telegram messages");
  }
}