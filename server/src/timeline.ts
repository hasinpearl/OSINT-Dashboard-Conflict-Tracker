/**
 * PROPOSED — awaiting Hessa's review before any commit.
 *
 * Per-conflict / per-event intelligence store. Replaces the single-blob
 * `api_cache` write for the timeline panel.
 *
 * Design (adapted from osintcrawler's items+stories model):
 *   items   — raw per-source observations. Dedup key: UNIQUE (source, external_id).
 *             First observation wins; a re-scrape never overwrites a row.
 *   stories — one row per real-world EVENT, per conflict. Dedup key:
 *             UNIQUE (conflict, event_key). A re-observation MERGES into the
 *             existing row (bumps last_seen_at, sighting_count, unions sources,
 *             escalates severity, keeps the longer summary). Nothing is ever
 *             deleted or replaced.
 *
 * Clustering: osintcrawler clusters with vector embeddings. This module uses a
 * two-stage LEXICAL clustering instead — no embedding model to host:
 *   1. deterministic `event_key` (event date + alphabetically-sorted significant
 *      title tokens) catches exact and near-exact re-reports;
 *   2. a fuzzy pre-match pass (>=4 shared significant words within a +/-3 day
 *      window) catches rewordings, and merges into the already-stored event.
 * Phase 2 (optional, documented in the audit report) swaps stage 2 for pgvector
 * centroid matching without changing this module's public API.
 */
import { pool } from "./db";

export type Severity = "critical" | "high" | "developing" | "verified" | "info";

const SEVERITY_RANK: Record<string, number> = {
  info: 0,
  verified: 1,
  developing: 2,
  high: 3,
  critical: 4,
};

const RANK_SEVERITY: Severity[] = ["info", "verified", "developing", "high", "critical"];

// How far apart two sightings of "the same event" may be dated. News outlets
// routinely disagree by a day or two on when something happened.
const FUZZY_WINDOW_DAYS = 3;

// Minimum shared significant words for the fuzzy pass to call it a duplicate.
// Same threshold the old in-memory dedup in hotTopics.ts used.
const FUZZY_MIN_SHARED = 4;

export interface TimelineEventInput {
  conflict: string;
  title: string;
  summary?: string;
  severity?: string;
  /** YYYY-MM-DD — the day the event happened, not the day we scraped it. */
  eventDate: string;
  source?: string;
}

export interface TimelineEvent {
  id: number;
  conflict: string;
  event_key: string;
  title: string;
  summary: string;
  severity: Severity;
  event_date: string;
  first_seen_at: string;
  last_seen_at: string;
  sighting_count: number;
  sources: string[];
}

export interface NewItem {
  source: string;
  externalId: string;
  conflict?: string;
  panel?: string;
  author?: string;
  title?: string;
  url?: string;
  content?: string;
  severity?: string;
  confidence?: string;
  publishedAt?: string;
  raw?: Record<string, unknown>;
}

/* ── helpers ──────────────────────────────────────────────────────────────── */

function significantWords(s: string): string[] {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3);
}

function sharedWordCount(a: string, b: string): number {
  const wa = new Set(significantWords(a));
  const wb = new Set(significantWords(b));
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared;
}

/** Deterministic, order-independent identity for an event. */
export function eventKeyFor(eventDate: string, title: string): string {
  const tokens = Array.from(new Set(significantWords(title))).sort().slice(0, 8);
  return `${eventDate}|${tokens.join("-")}`;
}

function normSeverity(s: string | undefined): Severity {
  const v = (s ?? "").toLowerCase();
  return v in SEVERITY_RANK ? (v as Severity) : "developing";
}

/** YYYY-MM-DD from anything date-like, or null when unparseable. */
export function toDateOnly(value: string | undefined): string | null {
  if (!value) return null;
  const t = new Date(value).getTime();
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

function safeIso(value: string | undefined): string | null {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function dayShift(dateOnly: string, days: number): string {
  const d = new Date(`${dateOnly}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const STORY_COLUMNS = `id, conflict, event_key, title, summary, severity,
  to_char(event_date, 'YYYY-MM-DD') AS event_date,
  first_seen_at, last_seen_at, sighting_count, sources`;

/* ── read path ────────────────────────────────────────────────────────────── */

/**
 * The timeline, oldest → newest. Reads ONLY from storage: it never depends on
 * whether today's scrape happened to mention a given event.
 */
export async function getTimeline(conflict: string, limit = 40): Promise<TimelineEvent[]> {
  try {
    // Take the N most recent events, then flip back to ascending so the panel
    // still renders oldest → newest without paging the entire history.
    const { rows } = await pool.query(
      `SELECT * FROM (
         SELECT ${STORY_COLUMNS}
         FROM stories
         WHERE conflict = $1 AND event_date IS NOT NULL
         ORDER BY event_date DESC, id DESC
         LIMIT $2
       ) recent
       ORDER BY event_date ASC, id ASC`,
      [conflict, limit],
    );
    return rows as TimelineEvent[];
  } catch (e) {
    console.error("getTimeline failed:", e instanceof Error ? e.message : e);
    return [];
  }
}

/** Newest stored raw items for a panel/conflict — used as an accumulating floor. */
export async function getRecentItems(
  conflict: string,
  panel: string,
  limit = 6,
): Promise<any[]> {
  try {
    const { rows } = await pool.query(
      `SELECT source, external_id, title, url, content, severity, confidence,
              published_at, raw
       FROM items
       WHERE conflict = $1 AND panel = $2
       ORDER BY published_at DESC NULLS LAST, id DESC
       LIMIT $3`,
      [conflict, panel, limit],
    );
    return rows;
  } catch (e) {
    console.error("getRecentItems failed:", e instanceof Error ? e.message : e);
    return [];
  }
}

/* ── collection bookkeeping ───────────────────────────────────────────────── */

/**
 * Age of the last collection pass for a panel/conflict, in ms.
 * Returns Infinity when it has never run — so the first request collects.
 *
 * This exists because "did we collect recently?" can no longer be answered by
 * the presence of a cache blob: the timeline is now permanent, and a pass that
 * legitimately found zero new events must still count as a pass.
 */
export async function collectionAgeMs(panel: string, conflict: string): Promise<number> {
  try {
    const { rows } = await pool.query(
      "SELECT ran_at FROM collection_runs WHERE panel = $1 AND conflict = $2",
      [panel, conflict],
    );
    const ranAt = rows[0]?.ran_at;
    if (!ranAt) return Number.POSITIVE_INFINITY;
    const age = Date.now() - new Date(ranAt).getTime();
    return Number.isNaN(age) ? Number.POSITIVE_INFINITY : age;
  } catch (e) {
    // DB down: report "never collected" would hammer paid APIs, so report
    // "just collected" and serve whatever the caller already has.
    console.error("collectionAgeMs failed:", e instanceof Error ? e.message : e);
    return 0;
  }
}

export async function markCollected(panel: string, conflict: string): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO collection_runs (panel, conflict, ran_at)
       VALUES ($1, $2, now())
       ON CONFLICT (panel, conflict) DO UPDATE SET ran_at = now()`,
      [panel, conflict],
    );
  } catch (e) {
    console.error("markCollected failed:", e instanceof Error ? e.message : e);
  }
}

/* ── write path ───────────────────────────────────────────────────────────── */

/**
 * Append/merge timeline events. Never deletes, never replaces a whole timeline.
 * Returns counts so routes can log what a refresh actually changed.
 */
export async function upsertTimelineEvents(
  conflict: string,
  events: TimelineEventInput[],
): Promise<{ inserted: number; merged: number }> {
  const clean = events
    .map((e) => ({ ...e, eventDate: toDateOnly(e.eventDate) }))
    .filter(
      (e): e is TimelineEventInput & { eventDate: string } =>
        Boolean(e.eventDate) && typeof e.title === "string" && e.title.trim().length > 0,
    );
  if (clean.length === 0) return { inserted: 0, merged: 0 };

  const dates = clean.map((e) => e.eventDate).sort();
  const from = dayShift(dates[0], -FUZZY_WINDOW_DAYS);
  const to = dayShift(dates[dates.length - 1], FUZZY_WINDOW_DAYS);

  let candidates: TimelineEvent[] = [];
  try {
    const { rows } = await pool.query(
      `SELECT ${STORY_COLUMNS}
       FROM stories
       WHERE conflict = $1 AND event_date BETWEEN $2::date AND $3::date`,
      [conflict, from, to],
    );
    candidates = rows as TimelineEvent[];
  } catch (e) {
    console.error("upsertTimelineEvents candidate load failed:", e instanceof Error ? e.message : e);
    return { inserted: 0, merged: 0 };
  }

  let inserted = 0;
  let merged = 0;

  for (const ev of clean) {
    const severity = normSeverity(ev.severity);
    const rank = SEVERITY_RANK[severity];
    const summary = (ev.summary ?? "").trim();
    const source = (ev.source ?? "").trim();

    // Stage 2 (fuzzy): does a stored event within the date window describe this?
    const match = candidates.find((cand) => {
      const dayGap =
        Math.abs(
          new Date(`${cand.event_date}T00:00:00Z`).getTime() -
            new Date(`${ev.eventDate}T00:00:00Z`).getTime(),
        ) /
        86_400_000;
      if (dayGap > FUZZY_WINDOW_DAYS) return false;
      return sharedWordCount(cand.title, ev.title) >= FUZZY_MIN_SHARED;
    });

    try {
      if (match) {
        await pool.query(
          `UPDATE stories SET
             last_seen_at   = now(),
             sighting_count = sighting_count + 1,
             summary        = CASE WHEN length($2) > length(summary) THEN $2 ELSE summary END,
             severity       = CASE WHEN $3::int > severity_rank THEN $4 ELSE severity END,
             severity_rank  = GREATEST(severity_rank, $3::int),
             sources        = ARRAY(
                                SELECT DISTINCT s FROM unnest(sources || $5::text[]) AS s
                                WHERE s IS NOT NULL AND s <> ''
                              )
           WHERE id = $1`,
          [match.id, summary, rank, severity, source ? [source] : []],
        );
        merged++;
        continue;
      }

      // Stage 1 (deterministic): insert, or merge if the exact key already exists
      // outside the loaded window (e.g. a concurrent request wrote it first).
      const key = eventKeyFor(ev.eventDate, ev.title);
      const { rows } = await pool.query(
        `INSERT INTO stories
           (conflict, event_key, title, summary, severity, severity_rank, event_date, sources)
         VALUES ($1, $2, $3, $4, $5, $6::int, $7::date, $8::text[])
         ON CONFLICT (conflict, event_key) DO UPDATE SET
           last_seen_at   = now(),
           sighting_count = stories.sighting_count + 1,
           summary        = CASE WHEN length(EXCLUDED.summary) > length(stories.summary)
                                 THEN EXCLUDED.summary ELSE stories.summary END,
           severity       = CASE WHEN EXCLUDED.severity_rank > stories.severity_rank
                                 THEN EXCLUDED.severity ELSE stories.severity END,
           severity_rank  = GREATEST(stories.severity_rank, EXCLUDED.severity_rank),
           sources        = ARRAY(
                              SELECT DISTINCT s
                              FROM unnest(stories.sources || EXCLUDED.sources) AS s
                              WHERE s IS NOT NULL AND s <> ''
                            )
         RETURNING (xmax = 0) AS is_insert, ${STORY_COLUMNS}`,
        [
          conflict,
          key,
          ev.title.trim(),
          summary,
          severity,
          rank,
          ev.eventDate,
          source ? [source] : [],
        ],
      );
      const row = rows[0];
      if (row?.is_insert) inserted++;
      else merged++;
      // Keep the in-memory candidate set current so two rewordings of the same
      // event inside ONE batch collapse into one row.
      if (row) candidates.push(row as TimelineEvent);
    } catch (e) {
      console.error(
        `upsertTimelineEvents failed for "${ev.title}":`,
        e instanceof Error ? e.message : e,
      );
    }
  }

  return { inserted, merged };
}

/**
 * Store raw per-source observations. First observation wins: a re-scrape must
 * never overwrite an existing row, because a later pass that failed to parse a
 * date would blank out the published_at that ordering depends on.
 */
export async function storeItems(items: NewItem[]): Promise<number> {
  if (items.length === 0) return 0;

  // Postgres rejects an INSERT that touches the same conflict target twice in
  // one statement, so dedupe within the batch first.
  const byKey = new Map<string, NewItem>();
  for (const i of items) {
    if (i.source && i.externalId) byKey.set(`${i.source}\u0000${i.externalId}`, i);
  }
  const rows = [...byKey.values()];
  if (rows.length === 0) return 0;

  const COLS_PER_ROW = 12;
  const values: unknown[] = [];
  const tuples = rows.map((it, n) => {
    values.push(
      it.source,
      it.externalId,
      it.conflict ?? null,
      it.panel ?? null,
      it.author ?? null,
      it.title ?? null,
      it.url ?? null,
      it.content ?? "",
      it.severity ?? null,
      it.confidence ?? null,
      safeIso(it.publishedAt),
      it.raw ? JSON.stringify(it.raw) : null,
    );
    const base = n * COLS_PER_ROW;
    const ph = Array.from({ length: COLS_PER_ROW }, (_, k) => `$${base + k + 1}`);
    return `(${ph.join(", ")})`;
  });

  try {
    const { rowCount } = await pool.query(
      `INSERT INTO items
         (source, external_id, conflict, panel, author, title, url, content,
          severity, confidence, published_at, raw)
       VALUES ${tuples.join(", ")}
       ON CONFLICT (source, external_id) DO NOTHING`,
      values,
    );
    return rowCount ?? 0;
  } catch (e) {
    console.error("storeItems failed:", e instanceof Error ? e.message : e);
    return 0;
  }
}
