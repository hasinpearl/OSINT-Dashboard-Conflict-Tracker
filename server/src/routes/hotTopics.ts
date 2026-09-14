import type { Context } from "hono";
import { FORCE_MIN_AGE_MS, getCached, setCache } from "../cache";
import { logCacheHit } from "../costs";
import { conflictConfigFor, enabledConflictKeys, getConflictConfig, readConflict, type ConflictConfig } from "../conflicts";
import { envKey } from "../env";
import { readForceRefresh, readJsonBody } from "../request";
import { AppError } from "../errors";
import { EDITORIAL_MODEL, selectTimeline, toCandidates } from "../editorial";
import { developmentStatement, cleanSignificance } from "../developments";
import { pool } from "../db";
import {
  countItems,
  fetchItems,
  isoOrNull,
  legacySeverity,
  outletName,
  SERVING_SELECT_COLUMNS,
  type ServingRow,
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
  /**
   * Rule 5: the entry's stable identity. It is the underlying stored item's
   * own id, so re-running the panel updates the same entry rather than
   * creating a new one, and a client can key on it across loads.
   */
  id: string;
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
  unclean_excluded: number;
  selected_by: string;
}

// Rule 5. Order by event time then id, both read off the stored row, so the
// sequence is a function of the data and not of selection order or model
// output order. Null timestamps sort last rather than being given a time they
// never had, and the id tiebreak makes the order total: two rows sharing a
// timestamp cannot swap places between two calls.
function byEventTimeThenId(a: TimelineEntry, b: TimelineEntry): number {
  const at = a.timestamp ?? "";
  const bt = b.timestamp ?? "";
  if (at !== bt) {
    if (!at) return 1;
    if (!bt) return -1;
    return bt.localeCompare(at);
  }
  return Number(b.id) - Number(a.id);
}

// Rule 3's preferred headline. A news-outlet row covering the same development
// supplies its own headline for a Telegram post, which is what Hessa asked for.
//
// The pairing must be strict, because a wrong pairing is worse than no pairing:
// it prints a headline the stored item never said. Measured with a 5-shared-word
// test over title plus content, a post reporting "IRGC Says It Intercepts Drone
// Over Strait of Hormuz" was paired with "Oil Jumps as Shutdown of Saudi
// Pipeline Deepens Energy Crisis" purely because both mention Hormuz, Saudi and
// the strait. Two different developments in one theatre share that vocabulary
// easily, so an absolute count of shared words cannot separate them.
//
// So the comparison is between the two CLEANED STATEMENTS, not the full bodies,
// and the test is a ratio: most of the shorter statement's meaningful words must
// appear in the longer one. That is a claim the two are wordings of one
// development rather than two reports from one region.
//TUNE: Control the (headline pairing strictness). Fraction of the shorter statement's words that must be shared before two reports are treated as one development.
const HEADLINE_MIN_OVERLAP = 0.6;

//TUNE: Control the (headline pairing floor). Shared words required regardless of ratio, so two three-word fragments cannot pair.
const HEADLINE_MIN_SHARED = 4;

//TUNE: Control the (headline pairing window). Hours between two reports still treated as the same development.
const HEADLINE_WINDOW_HOURS = 24;

function significantWords(s: string): Set<string> {
  return new Set(
    (s || "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3),
  );
}

function findOutletHeadline(row: ServingRow, newsRows: ServingRow[]): ServingRow | null {
  if (row.source === "rss") return null;

  // Compare what would actually be shown, so the pairing is judged on the same
  // text a reader would see rather than on a body full of boilerplate.
  const own = developmentStatement(row, null);
  if (!own) return null;
  const words = significantWords(own);
  if (words.size === 0) return null;
  const at = row.published_at?.getTime();

  let best: ServingRow | null = null;
  let bestScore = 0;

  for (const cand of newsRows) {
    const bt = cand.published_at?.getTime();
    if (at !== undefined && bt !== undefined) {
      if (Math.abs(at - bt) > HEADLINE_WINDOW_HOURS * 3_600_000) continue;
    }
    const candStatement = developmentStatement(cand, null);
    if (!candStatement) continue;
    const candWords = significantWords(candStatement);
    if (candWords.size === 0) continue;

    let shared = 0;
    for (const w of words) if (candWords.has(w)) shared++;
    if (shared < HEADLINE_MIN_SHARED) continue;

    const overlap = shared / Math.min(words.size, candWords.size);
    if (overlap >= HEADLINE_MIN_OVERLAP && overlap > bestScore) {
      best = cand;
      bestScore = overlap;
    }
  }
  return best;
}

// Rule 5's storage. An editorial selection is recorded per conflict keyed on
// the stored item, so the panel's membership survives a cache expiry and a
// later run updates an existing entry rather than replacing the list.
//
// The significance clause is only overwritten when the new run actually
// produced one: a run where the model returned an id with no clause must not
// blank a clause an earlier run had written.
async function recordSelections(
  conflict: string,
  entries: Array<{ itemId: string; significance: string }>,
): Promise<void> {
  if (entries.length === 0) return;
  try {
    await pool.query(
      `INSERT INTO timeline_selections (conflict, item_id, significance)
       SELECT $1, v.item_id::bigint, v.significance
       FROM unnest($2::bigint[], $3::text[]) AS v(item_id, significance)
       ON CONFLICT (conflict, item_id) DO UPDATE SET
         last_selected_at = now(),
         significance = CASE
           WHEN EXCLUDED.significance <> '' THEN EXCLUDED.significance
           ELSE timeline_selections.significance
         END`,
      [
        conflict,
        entries.map((e) => e.itemId),
        entries.map((e) => e.significance),
      ],
    );
  } catch (e) {
    console.error(
      `recordSelections(${conflict}) failed:`,
      e instanceof Error ? e.message : e,
    );
  }
}

// Every development already on this conflict's timeline that is still current:
// its stored row still passes the dashboard audience, still classifies as a
// kinetic event and is still inside the window. An entry that no longer meets
// those tests has aged out of the window rather than been silently dropped.
//
// This is what makes a refresh an UPDATE: the union of what is already stored
// and what the new model call selected is the new timeline, so nothing already
// shown disappears while it is still current.
async function currentSelections(
  config: ConflictConfig,
): Promise<Array<{ row: ServingRow; significance: string }>> {
  try {
    const { rows } = await pool.query(
      `SELECT ${SERVING_SELECT_COLUMNS},
              ts.significance AS significance
       FROM timeline_selections ts
       JOIN items i ON i.id = ts.item_id
       LEFT JOIN source_status s ON s.id = i.source_uid
       WHERE ts.conflict = $1
         AND i.noise = false
         AND i.conflicts && $5::text[]
         AND i.event_type = ANY($2::text[])
         AND i.published_at >= NOW() - ($3 || ' hours')::interval
       ORDER BY i.published_at DESC NULLS LAST, i.id DESC
       LIMIT $4`,
      // $5 is the enabled set. This route only ever builds a timeline for an
      // enabled conflict, so the test is defence in depth against a future
      // caller: a persisted selection whose item now carries only disabled
      // theatres must not come back through the timeline table.
      [config.key, TIMELINE_EVENT_TYPES, String(WINDOW_HOURS), MAX_EVENTS, enabledConflictKeys()],
    );
    return (rows as Array<ServingRow & { significance: string }>).map((r) => ({
      row: r,
      significance: r.significance ?? "",
    }));
  } catch (e) {
    console.error(
      `currentSelections(${config.key}) failed:`,
      e instanceof Error ? e.message : e,
    );
    return [];
  }
}

// One conflict's timeline. Candidates come from the store, selection comes from
// the model, and every field of every entry is then read back off the stored
// row. The model's only contribution to an entry is the significance clause.
async function buildTimeline(config: ConflictConfig): Promise<ConflictTimeline> {
  // Both source types are eligible: a development is a development whether a
  // channel or an outlet reported it. What Rule 1 forbids is a panel showing
  // another panel's source type as its OWN content, and this panel's content
  // is developments, not a source feed. The isolation that matters here is
  // Rule 2's, which fetchItems applies unconditionally.
  const rows = await fetchItems({
    conflict: config.key,
    sourceTypes: ["news_outlet", "telegram_channel"],
    limit: CANDIDATE_LIMIT,
    eventTypes: TIMELINE_EVENT_TYPES,
    requireText: true,
    sinceHours: WINDOW_HOURS,
  });

  // The news rows in the same window, used only to prefer an outlet's own
  // headline over raw channel text. They are not timeline candidates in their
  // own right beyond what the query above already returned.
  const newsRows = rows.filter((r) => r.source === "rss");

  // What the dashboard audience excluded, reported so an empty timeline can be
  // told apart from a broken one. Counted on the backend audience because the
  // whole point is to count what the dashboard does NOT show.
  const informationalExcluded = await countItems({
    conflict: config.key,
    sourceTypes: ["news_outlet", "telegram_channel"],
    audience: "backend",
    requireText: true,
    sinceHours: WINDOW_HOURS,
  }).then((all) => Math.max(0, all - rows.length));

  const base = {
    conflict: config.key,
    label: config.label,
    candidates_considered: rows.length,
    informational_excluded: informationalExcluded,
    selected_by: EDITORIAL_MODEL,
  };

  const existing = await currentSelections(config);

  if (rows.length === 0) {
    // No candidates does not mean no timeline: the entries already recorded
    // and still current stay on it.
    return { ...base, ...renderEntries(config, existing, newsRows) };
  }

  const candidates = toCandidates(rows);
  const selection = await selectTimeline(PANEL, config.label, candidates, MAX_EVENTS);

  if (selection.rejectedIds.length > 0) {
    console.warn(
      `hot-topics(${config.key}): dropped ${selection.rejectedIds.length} ids not present in the candidate set: ${selection.rejectedIds.slice(0, 8).join(", ")}`,
    );
  }

  await recordSelections(
    config.key,
    selection.entries.map(({ candidate, significance }) => ({
      itemId: candidate.row.id,
      significance,
    })),
  );

  // The union of what was already on the timeline and what this run selected,
  // deduplicated on the stored item id. A newly selected significance wins
  // over the recorded one; an entry only this run saw is added; an entry only
  // the store had is kept.
  const merged = new Map<string, { row: ServingRow; significance: string }>();
  for (const entry of existing) merged.set(entry.row.id, entry);
  for (const { candidate, significance } of selection.entries) {
    const prior = merged.get(candidate.row.id);
    merged.set(candidate.row.id, {
      row: candidate.row,
      significance: significance || prior?.significance || "",
    });
  }

  const rendered = renderEntries(config, Array.from(merged.values()), newsRows);

  console.log(
    `hot-topics(${config.key}): ${rows.length} candidates, ${selection.entries.length} selected by ${EDITORIAL_MODEL}, ${existing.length} already on the timeline, ${rendered.topics.length} shown, ${informationalExcluded} excluded as backend-only, ${rendered.unclean_excluded} excluded as uncleanable`,
  );

  return { ...base, ...rendered };
}

// Rule 3 applied per entry, then Rule 5's deterministic order. A selected row
// that cannot be cleaned into a factual statement is excluded rather than
// shown raw, and the count of exclusions is reported instead of being silent.
function renderEntries(
  config: ConflictConfig,
  entries: Array<{ row: ServingRow; significance: string }>,
  newsRows: ServingRow[],
): { topics: TimelineEntry[]; unclean_excluded: number } {
  let uncleanExcluded = 0;
  const topics: TimelineEntry[] = [];

  for (const { row, significance } of entries) {
    const headlineFrom = findOutletHeadline(row, newsRows);
    // The row's own cleaned statement is computed first, because it is the
    // authority on what this stored item says. An outlet headline only
    // replaces it, never supplements it: showing the paired headline as the
    // title and the row's own statement as the summary made one entry look
    // like two different developments.
    const own = developmentStatement(row, null);
    const paired = headlineFrom ? developmentStatement(headlineFrom, null) : null;
    const statement = paired ?? own;
    if (!statement) {
      uncleanExcluded++;
      console.log(
        `hot-topics(${config.key}): excluding item ${row.id}, no clean factual statement available`,
      );
      continue;
    }

    topics.push({
      id: row.id,
      item_id: row.id,
      title: statement,
      // Only carries the row's own wording when the outlet's headline replaced
      // it AND the two genuinely differ, so the entry shows the outlet's
      // phrasing with the channel's phrasing underneath rather than repeating
      // itself.
      summary: paired && own && own !== paired ? own : "",
      // Part 4: the model-written clause gets the same marker, relative-time
      // and separator strip as the title, and is dropped rather than rendered
      // when it cannot be cleaned.
      significance: cleanSignificance(significance),
      severity: legacySeverity(row.severity),
      event_type: row.event_type ?? "unclassified",
      source: outletName(headlineFrom ?? row),
      timestamp: isoOrNull(row.published_at),
      url: (headlineFrom ?? row).url ?? undefined,
    });
  }

  topics.sort(byEventTimeThenId);
  return { topics: topics.slice(0, MAX_EVENTS), unclean_excluded: uncleanExcluded };
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
    // The "all" tab is one timeline per ENABLED conflict, not one merged feed:
    // a development that matters in Ukraine does not become a Taiwan
    // development by sitting next to one, and the model can only judge
    // significance against a single conflict. The response stays a flat topics
    // list for the panel, with each entry carrying its own conflict.
    //
    // Read from the registry rather than a hardcoded triple, so a disabled
    // conflict contributes no timeline and appears in no rollup.
    const keys = config.key === "all" ? enabledConflictKeys() : [config.key];

    const built = await Promise.all(keys.map((k) => buildTimeline(conflictConfigFor(k))));

    // Rule 5 across the merged tab too: the same event-time-then-id order, so
    // merging three timelines cannot reorder entries that each timeline had
    // already ordered deterministically.
    const topics = built
      .flatMap((t) => t.topics.map((entry) => ({ ...entry, conflict: t.conflict })))
      .sort(byEventTimeThenId)
      .slice(0, MAX_EVENTS);

    const result = {
      topics,
      conflicts: built.map((t) => ({
        conflict: t.conflict,
        label: t.label,
        selected: t.topics.length,
        candidates_considered: t.candidates_considered,
        informational_excluded: t.informational_excluded,
        unclean_excluded: t.unclean_excluded,
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
