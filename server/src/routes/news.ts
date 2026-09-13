import type { Context } from "hono";
import { FORCE_MIN_AGE_MS, getCached, setCache } from "../cache";
import { logCacheHit } from "../costs";
import { getConflictConfig, readConflict } from "../conflicts";
import { readForceRefresh, readJsonBody } from "../request";
import { AppError } from "../errors";
import {
  deriveSummary,
  deriveTitle,
  fetchItems,
  isoOrNull,
  legacySeverity,
  outletName,
} from "../serving";

const CACHE_KEY_BASE = "firecrawl-news";
const PANEL = "news-feed";

//TUNE: Control the (news panel size). Stories returned per panel load.
const MAX_STORIES = 30;

//TUNE: Control the (news cache ttl). How long a served page stays reusable before the DB is read again.
const CACHE_TTL_MS = 5 * 60 * 1000;

export async function newsRoute(c: Context) {
  const body = await readJsonBody(c);
  const forceRefresh = readForceRefresh(c, body);
  const config = getConflictConfig(readConflict(body));
  const CACHE_KEY = `${CACHE_KEY_BASE}:${config.key}`;

  const cached = await getCached(CACHE_KEY, forceRefresh ? FORCE_MIN_AGE_MS : CACHE_TTL_MS);
  if (cached) {
    logCacheHit(PANEL, "database");
    return c.json(cached);
  }

  try {
    const rows = await fetchItems({
      conflict: config.key,
      source: "rss",
      limit: MAX_STORIES,
      requireText: true,
    });

    const stories = rows.map((row) => ({
      headline: deriveTitle(row),
      summary: deriveSummary(row),
      source: outletName(row),
      severity: legacySeverity(row.severity),
      timestamp: isoOrNull(row.published_at),
      url: row.url ?? undefined,
    }));

    const result = { stories };
    await setCache(CACHE_KEY, result);
    return c.json(result);
  } catch (e) {
    console.error("firecrawl-news read failed:", e instanceof Error ? e.message : e);
    throw new AppError("internal_error", "Failed to read news stories");
  }
}
