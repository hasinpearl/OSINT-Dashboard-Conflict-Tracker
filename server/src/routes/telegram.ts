import type { Context } from "hono";
import { FORCE_MIN_AGE_MS, getCached, setCache } from "../cache";
import { logCacheHit } from "../costs";
import { getConflictConfig, readConflict } from "../conflicts";
import { readForceRefresh, readJsonBody } from "../request";
import { AppError } from "../errors";
import { deriveSummary, fetchItems, isoOrNull, telegramMessageId } from "../serving";

const CACHE_KEY_BASE = "telegram-feed";
const PANEL = "telegram";

// Named so the cache layer never pins an empty answer over a filling database.
const LIST_FIELD = "messages";

//TUNE: Control the (telegram panel size). Messages returned per panel load.
const MAX_MESSAGES = 40;

//TUNE: Control the (telegram cache ttl). How long a served page stays reusable before the DB is read again.
const CACHE_TTL_MS = 2 * 60 * 1000;

export async function telegramRoute(c: Context) {
  const body = await readJsonBody(c);
  const forceRefresh = readForceRefresh(c, body);
  const config = getConflictConfig(readConflict(body));
  const CACHE_KEY = `${CACHE_KEY_BASE}:${config.key}`;

  const cached = await getCached(
    CACHE_KEY,
    forceRefresh ? FORCE_MIN_AGE_MS : CACHE_TTL_MS,
    LIST_FIELD,
  );
  if (cached) {
    logCacheHit(PANEL, "database");
    return c.json(cached);
  }

  try {
    const rows = await fetchItems({
      conflict: config.key,
      source: "telegram",
      limit: MAX_MESSAGES,
      requireText: true,
    });

    const messages = rows.map((row) => ({
      channel: row.source_uid ?? row.source,
      text: deriveSummary(row),
      timestamp: isoOrNull(row.published_at),
      message_id: telegramMessageId(row),
      url: row.url ?? undefined,
    }));

    const result = { messages };
    await setCache(CACHE_KEY, result, LIST_FIELD);
    return c.json(result);
  } catch (e) {
    console.error("telegram-feed read failed:", e instanceof Error ? e.message : e);
    throw new AppError("internal_error", "Failed to read Telegram messages");
  }
}
