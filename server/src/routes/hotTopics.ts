import type { Context } from "hono";
import { FORCE_MIN_AGE_MS, getCached, setCache } from "../cache";
import { logCacheHit } from "../costs";
import { CONFLICT_CONFIG, getConflictConfig, readConflict, type ConflictConfig } from "../conflicts";
import { envKey } from "../env";
import { readForceRefresh, readJsonBody } from "../request";
import { AppError } from "../errors";
import { EDITORIAL_MODEL, selectTimeline, toCandidates } from "../editorial";
import {
  countItems,
  deriveSummary,
  deriveTitle,
  fetchItems,
  isoOrNull,
  legacySeverity,
  outletName,
} from "../serving";

const CACHE_KEY_BASE = "ai-summarize";
const PANEL = "hot-topics";

// Named so the cache layer never pins an empty answer over a filling database.
const LIST_FIELD = "topics";

// The kinetic classes. Informational is excluded outright: this panel is the
// conflict timeline, and informational is the majority of the corpus, so a
// timeline that admits it is a feed. humanitarian and diplomatic are not here
// either. They are real event types, but a statement or an aid convoy does not
// change the situation on the ground, which is the bar Hessa set for this
// panel.
//TUNE: Control the (timeline event classes). Classifier event_types eligible for the conflict timeline.
const TIMELINE_EVENT_TYPES = [
  "airstrike",
  "shelling",
  "ground_movement",
  "naval",
  "nuclear_wmd",
  "interception",
  "explosion",
  "hostile_uav",
  "rocket",
];

//TUNE: Control the (timeline size). TIMELINE_MAX_EVENTS=entries returned per response.
const MAX_EVENTS = Number(envKey("TIMELINE_MAX_EVENTS") || 40);

//TUNE: Control the (timeline candidate pool). Stored rows offered to the editorial model per conflict.
const CANDIDATE_LIMIT = 120;

//TUNE: Control the (timeline cache ttl). How long a served timeline stays reusable before it is recomputed.
const CACHE_TTL_MS = 60 * 60 * 1000;

//TUNE: Control the (timeline force ttl). Min age a force refresh will accept before recomputing.
const FORCE_TTL_MS = 5 * 60 * 1000;

//TUNE: Control the (timeline window). Hours of stored history the timeline is built from.
const WINDOW_HOURS = 14 * 24;

interface TimelineEntry {
  item_id: string;
  title: string;
  summary: string;
  significance: string;
  severity: string;
  event_type: string;
  source: string;
  timestamp: string | null;
  url?: string;
}

interface ConflictTimeline {
  conflict: string;
  label: string;
  topics: TimelineEntry[];
  candidates_considered: number;
  informational_excluded: number;
  selected_by: string;
}

// One conflict's timeline. Candidates come from the store, selection comes from
// the model, and every field of every entry is then read back off the stored
// row. The model's only contribution to an entry is the significance clause.
async function buildTimeline(config: ConflictConfig): Promise<ConflictTimeline> {
  const rows = await fetchItems({
    conflict: config.key,
    limit: CANDIDATE_LIMIT,
    eventTypes: TIMELINE_EVENT_TYPES,
    requireText: true,
    sinceHours: WINDOW_HOURS,
  });

  const informationalExcluded = await countItems({
    conflict: config.key,
    onlyInformational: true,
    requireText: true,
    sinceHours: WINDOW_HOURS,
  });

  const base = {
    conflict: config.key,
    label: config.label,
    candidates_considered: rows.length,
    informational_excluded: informationalExcluded,
    selected_by: EDITORIAL_MODEL,
  };

  if (rows.length === 0) {
    return { ...base, topics: [] };
  }

  const candidates = toCandidates(rows);
  const selection = await selectTimeline(PANEL, config.label, candidates, MAX_EVENTS);

  if (selection.rejectedIds.length > 0) {
    console.warn(
      `hot-topics(${config.key}): dropped ${selection.rejectedIds.length} ids not present in the candidate set: ${selection.rejectedIds.slice(0, 8).join(", ")}`,
    );
  }

  const topics: TimelineEntry[] = selection.entries
    .map(({ candidate, significance }) => ({
      item_id: candidate.row.id,
      title: deriveTitle(candidate.row),
      summary: deriveSummary(candidate.row),
      significance,
      severity: legacySeverity(candidate.row.severity),
      event_type: candidate.row.event_type ?? "unclassified",
      source: outletName(candidate.row),
      timestamp: isoOrNull(candidate.row.published_at),
      url: candidate.row.url ?? undefined,
    }))
    .sort((a, b) => (b.timestamp ?? "").localeCompare(a.timestamp ?? ""));

  console.log(
    `hot-topics(${config.key}): ${rows.length} candidates, ${topics.length} selected by ${EDITORIAL_MODEL}, ${informationalExcluded} informational excluded`,
  );

  return { ...base, topics };
}

export async function hotTopicsRoute(c: Context) {
  const body = await readJsonBody(c);
  const forceRefresh = readForceRefresh(c, body);
  const config = getConflictConfig(readConflict(body));
  const CACHE_KEY = `${CACHE_KEY_BASE}:${config.key}`;

  const cached = await getCached(
    CACHE_KEY,
    forceRefresh ? Math.min(FORCE_TTL_MS, FORCE_MIN_AGE_MS) : CACHE_TTL_MS,
    LIST_FIELD,
  );
  if (cached) {
    logCacheHit(PANEL, "database");
    return c.json(cached);
  }

  try {
    // The "all" tab is three timelines, not one merged feed: a development that
    // matters in Ukraine does not become a Taiwan development by sitting next
    // to one, and the model can only judge significance against a single
    // conflict. The response stays a flat topics list for the panel, with each
    // entry carrying its own conflict.
    const keys =
      config.key === "all"
        ? (["iran-us", "ukraine-russia", "china-taiwan"] as const)
        : ([config.key] as const);

    const built = await Promise.all(keys.map((k) => buildTimeline(CONFLICT_CONFIG[k])));

    const topics = built
      .flatMap((t) => t.topics.map((entry) => ({ ...entry, conflict: t.conflict })))
      .sort((a, b) => (b.timestamp ?? "").localeCompare(a.timestamp ?? ""))
      .slice(0, MAX_EVENTS);

    const result = {
      topics,
      conflicts: built.map((t) => ({
        conflict: t.conflict,
        label: t.label,
        selected: t.topics.length,
        candidates_considered: t.candidates_considered,
        informational_excluded: t.informational_excluded,
      })),
      selected_by: EDITORIAL_MODEL,
    };

    await setCache(CACHE_KEY, result, LIST_FIELD);
    return c.json(result);
  } catch (e) {
    if (e instanceof AppError) throw e;
    console.error("ai-summarize read failed:", e instanceof Error ? e.message : e);
    throw new AppError("internal_error", "Failed to build the conflict timeline");
  }
}
