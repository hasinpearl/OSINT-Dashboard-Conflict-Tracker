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
  type ServingRow,
} from "../serving";

const CACHE_KEY_BASE = "firecrawl-news";
const PANEL = "news-feed";

// Named so the cache layer can tell an empty answer from a real one. Caching
// "no stories" is what pinned the breaking bar empty against a full database.
const LIST_FIELD = "stories";

//TUNE: Control the (news panel size). Recent stories returned per panel load.
const MAX_STORIES = 30;

// The recent slice is ordered purely by time, so a breaking or critical report
// published a few hours before thirty quieter ones falls off the end of it. The
// notifications feeder reads this same list, so when that happened the alert
// had nothing to fire on. This slice guarantees the breaking-eligible rows are
// in the response regardless of how much ordinary traffic sits above them.
//TUNE: Control the (breaking slice size). Breaking or severe stories guaranteed a place in the response.
const MAX_BREAKING = 15;

//TUNE: Control the (breaking slice window). Hours back the guaranteed breaking slice reaches.
const BREAKING_WINDOW_HOURS = 48;

//TUNE: Control the (news cache ttl). How long a served page stays reusable before the DB is read again.
const CACHE_TTL_MS = 5 * 60 * 1000;

export async function newsRoute(c: Context) {
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
    // Newest first, every severity, no age bound. This list is shared by the
    // news panel, the breaking ticker and the notifications feeder, so it must
    // stay the full recent feed: the ticker ranks it into its own tiers
    // client-side rather than have this route narrow what the panel sees.
    const [recent, breaking] = await Promise.all([
      fetchItems({
        conflict: config.key,
        source: "rss",
        limit: MAX_STORIES,
        requireText: true,
      }),
      fetchItems({
        conflict: config.key,
        source: "rss",
        limit: MAX_BREAKING,
        requireText: true,
        breakingOrSevere: true,
        sinceHours: BREAKING_WINDOW_HOURS,
      }),
    ]);

    const byId = new Map<string, ServingRow>();
    for (const row of [...recent, ...breaking]) byId.set(row.id, row);

    const stories = Array.from(byId.values())
      .sort((a, b) => {
        const at = a.published_at?.getTime() ?? Number.NEGATIVE_INFINITY;
        const bt = b.published_at?.getTime() ?? Number.NEGATIVE_INFINITY;
        return bt - at;
      })
      .map((row) => ({
        item_id: row.id,
        headline: deriveTitle(row),
        summary: deriveSummary(row),
        source: outletName(row),
        severity: legacySeverity(row.severity),
        // The classifier's own breaking flag, carried through so the
        // notifications feeder can fire on it. Without this the feeder had only
        // the damped severity scale to work from and could not tell a breaking
        // report from an ordinary one.
        breaking: row.is_breaking,
        timestamp: isoOrNull(row.published_at),
        url: row.url ?? undefined,
      }));

    const result = { stories };
    await setCache(CACHE_KEY, result, LIST_FIELD);
    return c.json(result);
  } catch (e) {
    console.error("firecrawl-news read failed:", e instanceof Error ? e.message : e);
    throw new AppError("internal_error", "Failed to read news stories");
  }
}
