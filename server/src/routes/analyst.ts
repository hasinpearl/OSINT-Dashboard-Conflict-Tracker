import type { Context } from "hono";
import { FORCE_MIN_AGE_MS, getCached, setCache } from "../cache";
import { logCacheHit } from "../costs";
import { getConflictConfig, readConflict } from "../conflicts";
import { readForceRefresh, readJsonBody } from "../request";
import { AppError } from "../errors";
import {
  deriveSummary,
  eventTopic,
  fetchItems,
  isoOrNull,
  outletName,
  type ServingRow,
} from "../serving";

const CACHE_KEY_BASE = "analyst-curated";
const PANEL = "analyst";

//TUNE: Control the (analyst panel size). Attributed pieces returned per panel load.
const MAX_COMMENTS = 9;

//TUNE: Control the (analyst candidate pool). Rows scanned before picking one piece per byline.
const CANDIDATE_LIMIT = 200;

//TUNE: Control the (analyst cache ttl). How long a served page stays reusable before the DB is read again.
const CACHE_TTL_MS = 10 * 60 * 1000;

// The panel shows who is saying what. Nothing in items carries a quote, so the
// attribution is the real byline on the stored piece: the author when the feed
// supplied one, otherwise the publishing outlet. No roster name is ever
// attached to text that person did not write.
function attribution(row: ServingRow): { analyst: string; affiliation: string } {
  const outlet = outletName(row);
  const author = (row.author ?? "").replace(/\s+/g, " ").trim();
  if (author && author.toLowerCase() !== outlet.toLowerCase()) {
    return { analyst: author, affiliation: outlet };
  }
  return { analyst: outlet, affiliation: row.source === "telegram" ? "Telegram channel" : "Newsroom" };
}

export async function analystRoute(c: Context) {
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
    // Off-domain and purely informational rows are not commentary on the
    // conflict, so the panel takes the classified rows first and only widens
    // when a conflict has nothing classified in store.
    let rows = await fetchItems({
      conflict: config.key,
      limit: CANDIDATE_LIMIT,
      excludeInformational: true,
      requireText: true,
      requireByline: true,
    });

    if (rows.length === 0) {
      rows = await fetchItems({
        conflict: config.key,
        limit: CANDIDATE_LIMIT,
        requireText: true,
        requireByline: true,
      });
    }

    // One entry per voice, so a prolific byline cannot fill the whole panel.
    const seen = new Set<string>();
    const comments: Array<{
      analyst: string;
      affiliation: string;
      comment: string;
      topic: string;
      timestamp: string | null;
      url?: string;
    }> = [];

    for (const row of rows) {
      if (comments.length >= MAX_COMMENTS) break;
      const { analyst, affiliation } = attribution(row);
      const key = analyst.toLowerCase();
      if (seen.has(key)) continue;
      const comment = deriveSummary(row);
      if (!comment) continue;
      seen.add(key);
      comments.push({
        analyst,
        affiliation,
        comment,
        topic: eventTopic(row),
        timestamp: isoOrNull(row.published_at),
        url: row.url ?? undefined,
      });
    }

    const result = { comments };
    await setCache(CACHE_KEY, result);
    return c.json(result);
  } catch (e) {
    console.error("analyst read failed:", e instanceof Error ? e.message : e);
    throw new AppError("internal_error", "Failed to read analyst commentary");
  }
}
