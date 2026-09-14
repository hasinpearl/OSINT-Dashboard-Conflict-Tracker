import type { Context } from "hono";
import { FORCE_MIN_AGE_MS, getCached, setCache } from "../cache";
import { logCacheHit } from "../costs";
import { getConflictConfig, readConflict } from "../conflicts";
import { readForceRefresh, readJsonBody } from "../request";
import { AppError } from "../errors";
import { EXTRACTION_MODEL, shapeNewsStories, toCandidates } from "../editorial";
import { developmentStatement } from "../developments";
import {
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

//TUNE: Control the (news panel size). Stories returned per panel load.
const MAX_STORIES = 30;

//TUNE: Control the (news candidate pool). Stored news rows shaped per panel load. Must be >= MAX_STORIES: the pass shapes every candidate rather than ranking them.
const CANDIDATE_LIMIT = MAX_STORIES;

//TUNE: Control the (news window). Hours of stored coverage the feed is built from.
const WINDOW_HOURS = 48;

// The recent slice is ordered purely by time, so a breaking or critical report
// published a few hours before thirty quieter ones falls off the end of it. The
// notifications feeder reads this same list, so when that happened the alert
// had nothing to fire on. This slice guarantees the breaking-eligible rows are
// in the response regardless of how much ordinary traffic sits above them.
//TUNE: Control the (breaking slice size). Breaking or severe stories guaranteed a place in the candidate pool.
const MAX_BREAKING = 15;

//TUNE: Control the (breaking slice window). Hours back the guaranteed breaking slice reaches.
const BREAKING_WINDOW_HOURS = 48;

//TUNE: Control the (news cache ttl). How long a served page stays reusable before it is recomputed.
const CACHE_TTL_MS = 5 * 60 * 1000;

interface NewsStory {
  item_id: string;
  headline: string;
  summary: string;
  source: string;
  severity: string;
  breaking: boolean;
  timestamp: string | null;
  url?: string;
  conflicts: string[];
}

// Newest first by the source's own event time, id descending as the tiebreak.
// Both are read off the stored row, so the order is a function of the data and
// two calls cannot reshuffle it. Hessa reads this panel to see WHEN something
// broke, so the sort key is the event time and never the model's output order.
function newestFirst(a: NewsStory, b: NewsStory): number {
  const at = a.timestamp ?? "";
  const bt = b.timestamp ?? "";
  if (at !== bt) {
    if (!at) return 1;
    if (!bt) return -1;
    return bt.localeCompare(at);
  }
  return Number(b.item_id) - Number(a.item_id);
}

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
    // Candidates come from Postgres, which is both the source of fact and the
    // freshness layer: the collectors write continuously, so the newest stored
    // report is as recent as the feed that carried it. The original panel
    // scraped four newsSources at request time, which was slow and returned
    // nothing at all when a scrape failed. That path is deliberately not
    // restored; the model pass over these rows is.
    //
    // This list is shared by the news panel, the breaking ticker and the
    // notifications feeder, so the breaking-eligible rows are pulled
    // separately and merged in: a time-ordered slice alone can push a critical
    // report off the end.
    const [recent, breaking] = await Promise.all([
      fetchItems({
        conflict: config.key,
        sourceTypes: ["news_outlet"],
        limit: CANDIDATE_LIMIT,
        requireText: true,
        sinceHours: WINDOW_HOURS,
      }),
      fetchItems({
        conflict: config.key,
        sourceTypes: ["news_outlet"],
        limit: MAX_BREAKING,
        requireText: true,
        breakingOrSevere: true,
        sinceHours: BREAKING_WINDOW_HOURS,
      }),
    ]);

    const byId = new Map<string, ServingRow>();
    for (const row of [...recent, ...breaking]) byId.set(row.id, row);
    const rows = Array.from(byId.values());

    if (rows.length === 0) {
      return c.json({ stories: [], candidates_considered: 0, shaped_by: EXTRACTION_MODEL });
    }

    // The editorial pass. It writes the headline and summary for every recent
    // report and returns a severity on the legacy scale the frontend reads.
    // It does NOT choose which stories appear: the newest rows are the feed,
    // and a ranking pass here would let the newest story be dropped.
    const shaping = await shapeNewsStories(
      PANEL,
      config.label,
      config.region,
      config.searchTerms,
      toCandidates(rows),
    );

    if (shaping.rejectedIds.length > 0) {
      console.warn(
        `firecrawl-news(${config.key}): dropped ${shaping.rejectedIds.length} ids not present in the candidate set: ${shaping.rejectedIds.slice(0, 8).join(", ")}`,
      );
    }

    // Any candidate the pass did not return still belongs in a live feed, so
    // it is carried with the store's own title and summary rather than being
    // silently dropped. The panel's membership is therefore decided by the
    // data and the window, never by what the model chose to write up.
    const shapedIds = new Set(shaping.entries.map((e) => e.candidate.row.id));
    const unshaped = rows.filter((r) => !shapedIds.has(r.id));
    if (unshaped.length > 0) {
      console.log(
        `firecrawl-news(${config.key}): ${unshaped.length} candidates not shaped by the model, carried with stored text`,
      );
    }

    const shapedStories: NewsStory[] = shaping.entries.map(
      ({ candidate, headline, summary, severity }) => ({
        item_id: candidate.row.id,
        headline,
        summary,
        // Read off the store, never off the model: an outlet name, a timestamp
        // and a URL the model wrote would all be unverifiable.
        source: outletName(candidate.row),
        severity: severity ?? legacySeverity(candidate.row.severity),
        // The classifier's own breaking flag, carried through so the
        // notifications feeder can fire on it. Without this the feeder had only
        // the damped severity scale to work from and could not tell a breaking
        // report from an ordinary one.
        breaking: candidate.row.is_breaking,
        timestamp: isoOrNull(candidate.row.published_at),
        url: candidate.row.url ?? undefined,
        // The row's own stored assignment, so what a tab returns can be checked
        // against what the database holds without a second query.
        conflicts: candidate.row.conflicts,
      }),
    );

    // Carried candidates go through the same cleaner Major Developments uses,
    // so an unshaped entry is still free of the aggregator's nbsp joins and
    // outlet suffixes. One that cannot be cleaned is excluded rather than
    // shown raw, which is the same rule the timeline applies.
    const carriedStories: NewsStory[] = [];
    for (const row of unshaped) {
      const statement = developmentStatement(row, null);
      if (!statement) continue;
      carriedStories.push({
        item_id: row.id,
        headline: statement,
        summary: "",
        source: outletName(row),
        severity: legacySeverity(row.severity),
        breaking: row.is_breaking,
        timestamp: isoOrNull(row.published_at),
        url: row.url ?? undefined,
        conflicts: row.conflicts,
      });
    }

    const stories = [...shapedStories, ...carriedStories]
      .sort(newestFirst)
      .slice(0, MAX_STORIES);

    console.log(
      `firecrawl-news(${config.key}): ${rows.length} candidates, ${shaping.returned} shaped by ${shaping.modelUsed}, ${carriedStories.length} carried, ${stories.length} shown`,
    );

    const result = {
      stories,
      candidates_considered: rows.length,
      shaped: shapedStories.length,
      carried: carriedStories.length,
      shaped_by: shaping.modelUsed,
    };
    await setCache(CACHE_KEY, result, LIST_FIELD);
    return c.json(result);
  } catch (e) {
    console.error("firecrawl-news read failed:", e instanceof Error ? e.message : e);
    throw new AppError("internal_error", "Failed to read news stories");
  }
}
