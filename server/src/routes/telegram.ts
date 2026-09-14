import type { Context } from "hono";
import { FORCE_MIN_AGE_MS, getCached, setCache } from "../cache";
import { logCacheHit } from "../costs";
import { getConflictConfig, readConflict } from "../conflicts";
import { readForceRefresh, readJsonBody } from "../request";
import { AppError } from "../errors";
import { countItems, deriveSummary, fetchItems, isoOrNull, telegramMessageId } from "../serving";

const CACHE_KEY_BASE = "telegram-feed";
const PANEL = "telegram";

// Named so the cache layer never pins an empty answer over a filling database.
const LIST_FIELD = "messages";

// The collector holds over nine hundred posts, and the panel used to show one
// of them. Forty was never the reason: the conflict filter was, so it is fixed
// in serving.ts and the panel size is raised to something worth scrolling.
//TUNE: Control the (telegram panel size). Messages returned per panel load.
const MAX_MESSAGES = 200;

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

    // The panel says how many messages match the tab in the whole store, not
    // just how many fit on a page. A feed showing 200 of 383 and a feed holding
    // exactly 200 are different situations and the panel has to be able to tell
    // the reader which one it is in.
    const matching = await countItems({
      conflict: config.key,
      source: "telegram",
      requireText: true,
    });

    const messages = rows.map((row) => ({
      channel: row.source_uid ?? row.source,
      text: deriveSummary(row),
      timestamp: isoOrNull(row.published_at),
      message_id: telegramMessageId(row),
      url: row.url ?? undefined,
      // The row's own stored assignment, so what a tab returns can be checked
      // against what the database holds without a second query.
      conflicts: row.conflicts,
    }));

    const result = { messages, matching_in_store: matching, returned: messages.length };
    await setCache(CACHE_KEY, result, LIST_FIELD);
    return c.json(result);
  } catch (e) {
    console.error("telegram-feed read failed:", e instanceof Error ? e.message : e);
    throw new AppError("internal_error", "Failed to read Telegram messages");
  }
}
