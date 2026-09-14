import { pool } from "./db";
import { classify } from "./enrich";
import { ASSIGNABLE_CONFLICTS, assignConflicts, type AssignedConflict } from "./conflictAssign";

export type Severity = "critical" | "high" | "developing" | "verified" | "info";

const SEVERITY_RANK: Record<string, number> = {
  info: 0,
  verified: 1,
  developing: 2,
  high: 3,
  critical: 4,
};

//TUNE: Control the fuzzy-match date window (days) for merging duplicate events
const FUZZY_WINDOW_DAYS = 3;

//TUNE: Control the minimum shared significant words for fuzzy-match dedup
const FUZZY_MIN_SHARED = 4;

export interface TimelineEventInput {
  conflict: string;
  title: string;
  summary?: string;
  severity?: string;
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

export function eventKeyFor(eventDate: string, title: string): string {
  const tokens = Array.from(new Set(significantWords(title))).sort().slice(0, 8);
  return `${eventDate}|${tokens.join("-")}`;
}

function normSeverity(s: string | undefined): Severity {
  const v = (s ?? "").toLowerCase();
  return v in SEVERITY_RANK ? (v as Severity) : "developing";
}

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

export async function getTimeline(conflict: string, limit = 40): Promise<TimelineEvent[]> {
  try {
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

export async function getRecentItems(
  conflict: string,
  panel: string,
  limit = 6,
): Promise<any[]> {
  try {
    const { rows } = await pool.query(
      `SELECT source, external_id, title, url, content, severity, confidence,
              published_at, conflicts, raw
       FROM items
       WHERE conflicts && $1::text[] AND panel = $2
       ORDER BY published_at DESC NULLS LAST, id DESC
       LIMIT $3`,
      [[conflict], panel, limit],
    );
    return rows;
  } catch (e) {
    console.error("getRecentItems failed:", e instanceof Error ? e.message : e);
    return [];
  }
}

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

export async function storeItems(items: NewItem[]): Promise<number> {
  if (items.length === 0) return 0;

  const byKey = new Map<string, NewItem>();
  for (const i of items) {
    if (i.source && i.externalId) byKey.set(`${i.source}\u0000${i.externalId}`, i);
  }
  const rows = [...byKey.values()];
  if (rows.length === 0) return 0;

  const COLS_PER_ROW = 18;
  const values: unknown[] = [];
  const tuples = rows.map((it, n) => {
    const enriched = classify({
      title: it.title,
      content: it.content,
      publishedAt: it.publishedAt,
    });
    // Panel-written rows go through the same assigner as the ingest paths, so
    // conflicts is populated whatever wrote the row. A caller-supplied conflict
    // is honoured when it names a real theatre, because a panel route knows
    // which tab it collected for; anything else is ignored and the text decides.
    const assigned = assignConflicts({
      title: it.title,
      content: it.content,
      source: it.source,
    });
    const caller = (it.conflict ?? "").trim() as AssignedConflict;
    const conflicts =
      ASSIGNABLE_CONFLICTS.includes(caller) && !assigned.conflicts.includes(caller)
        ? [caller, ...assigned.conflicts]
        : assigned.conflicts;
    values.push(
      it.source,
      it.externalId,
      // Derived from the array, never set independently. One source of truth.
      conflicts[0] ?? null,
      conflicts,
      it.panel ?? null,
      it.author ?? null,
      it.title ?? null,
      it.url ?? null,
      it.content ?? "",
      // Panel routes carry the legacy severity vocabulary the frontend reads.
      // Only fall back to the classifier when they supplied nothing.
      it.severity ?? enriched.severity,
      it.confidence ?? null,
      safeIso(it.publishedAt),
      it.raw ? JSON.stringify(it.raw) : null,
      enriched.event_type,
      enriched.is_breaking,
      enriched.lang,
      JSON.stringify(enriched.enrichment),
      JSON.stringify(assigned.reason),
    );
    const base = n * COLS_PER_ROW;
    const ph = Array.from({ length: COLS_PER_ROW }, (_, k) => `$${base + k + 1}`);
    return `(${ph.join(", ")})`;
  });

  try {
    const { rowCount } = await pool.query(
      `INSERT INTO items
         (source, external_id, conflict, conflicts, panel, author, title, url, content,
          severity, confidence, published_at, raw,
          event_type, is_breaking, lang, enrichment, conflict_assign)
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
