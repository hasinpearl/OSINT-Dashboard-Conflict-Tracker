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
  legacyConfidence,
  outletName,
} from "../serving";

const CACHE_KEY_BASE = "osint";
const PANEL = "osint";

//TUNE: Control the (osint panel size). Items returned per panel load.
const MAX_ITEMS = 12;

//TUNE: Control the (osint cache ttl). How long a served page stays reusable before the DB is read again.
const CACHE_TTL_MS = 5 * 60 * 1000;

export async function osintRoute(c: Context) {
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
    // This panel is the kinetic and security picture, so it takes the
    // classified rows with a resolvable source link.
    let rows = await fetchItems({
      conflict: config.key,
      limit: MAX_ITEMS,
      excludeInformational: true,
      requireUrl: true,
      requireText: true,
    });

    if (rows.length === 0) {
      rows = await fetchItems({
        conflict: config.key,
        limit: MAX_ITEMS,
        requireUrl: true,
        requireText: true,
      });
    }

    const items = rows.map((row) => ({
      title: deriveTitle(row),
      summary: deriveSummary(row),
      source: outletName(row),
      confidence: legacyConfidence(row),
      timestamp: isoOrNull(row.published_at),
      url: row.url ?? undefined,
    }));

    const result = { items };
    await setCache(CACHE_KEY, result);
    return c.json(result);
  } catch (e) {
    console.error("osint read failed:", e instanceof Error ? e.message : e);
    throw new AppError("internal_error", "Failed to read OSINT items");
  }
}
