import { pool } from "./db";
import { enabledConflictKeys, isConflictEnabled, type ConflictKey } from "./conflicts";
import { sourcesForTypes, sourceTypeOf, type SourceType } from "./sourceTypes";

// Panel serving layer. Every panel route reads the items table through here, so
// the mapping from ingested rows onto the legacy response shapes lives in one
// place. No upstream fetch, no model call, no api_cache origin.
//
// Two invariants are enforced HERE rather than in the routes, because a route
// is one caller among several and the frontend is not a security boundary at
// all: an endpoint can be curled directly.
//
// 1. Source isolation. Every query names the source types it is allowed to
//    read and the SQL filters on them. sourceTypes is a required field, so a
//    new call site cannot inherit "whatever the pool holds" by omission, which
//    is exactly how one shared pool came to feed every panel.
//
// 2. Backend-only content. Rows assigned to no followed conflict, and rows the
//    classifier marked informational, are reference material for the backend.
//    The dashboard audience excludes both unconditionally. The predicate is
//    additive and cannot be switched off by a caller: reaching them requires
//    asking for the backend audience by name.

//TUNE: Control the (title fallback length). Characters of content used as a title when the row has none.
const TITLE_MAX_CHARS = 120;

//TUNE: Control the (summary length). Characters of content returned in a panel summary field.
const SUMMARY_MAX_CHARS = 280;

//TUNE: Control the (affiliation length). Characters of a feed label kept as an outlet name.
const OUTLET_LABEL_MAX_CHARS = 60;

// The classifier writes low|medium|high|critical. The panels have always read
// critical|high|developing|verified|info, so the classifier scale is folded onto
// that vocabulary here. A row with no severity still renders as info.
const LEGACY_SEVERITY = new Set(["critical", "high", "developing", "verified", "info"]);
const CLASSIFIER_SEVERITY_MAP: Record<string, string> = {
  critical: "critical",
  high: "high",
  medium: "developing",
  low: "info",
};

const LEGACY_CONFIDENCE = new Set(["verified", "unverified", "developing"]);

// Conflict assignment is stored, not derived here. conflictAssign.ts assigns
// items.conflicts at write time and the backfill fills every existing row, so a
// conflict tab filters on an indexed array overlap rather than running a keyword
// regex over title and content on every load.
//
// The keyword lists that used to live in this file are gone on purpose. A
// query-time list had to be broad enough not to miss real items and narrow
// enough not to leak, so it did neither: it put a North Korean missile launch
// and a UK air-traffic item on the china-taiwan tab. Worse, correcting a term
// changed what a query returned but never corrected the stored data, so there
// was nothing to audit. The terms now live in conflictAssign.ts, where they are
// applied once per row on write and leave a reason trail in conflict_assign.

export interface ServingRow {
  id: string;
  source: string;
  source_uid: string | null;
  external_id: string;
  title: string | null;
  url: string | null;
  content: string | null;
  author: string | null;
  severity: string | null;
  confidence: string | null;
  event_type: string | null;
  is_breaking: boolean;
  lang: string | null;
  published_at: Date | null;
  ingested_at: Date;
  outlet_label: string | null;
  conflicts: string[];
}

export function legacySeverity(value: string | null): string {
  const v = (value ?? "").toLowerCase();
  if (LEGACY_SEVERITY.has(v)) return v;
  return CLASSIFIER_SEVERITY_MAP[v] ?? "info";
}

// Confidence is not a classifier output. An attributable outlet permalink is
// treated as verified reporting, an open channel post as unverified.
export function legacyConfidence(row: ServingRow): string {
  const v = (row.confidence ?? "").toLowerCase();
  if (LEGACY_CONFIDENCE.has(v)) return v;
  return row.source === "rss" ? "verified" : "unverified";
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// Telegram posts are full of emoji and flags, which are surrogate pairs in a JS
// string. Slicing by .length can land between the two halves and leave a lone
// surrogate, and a lone surrogate is not valid text: Perplexity rejects the
// whole request body with a bare "invalid request body" 400, so one emoji in
// one stored row took out an entire panel. Array.from iterates code points, so
// a cut can only ever fall between whole characters.
function sliceCodePoints(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join("");
}

// Defence in depth for the same failure: a lone surrogate that reached here
// from anywhere else is dropped rather than shipped to a provider or a client.
export function stripLoneSurrogates(text: string): string {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

function truncate(text: string, max: number): string {
  if (Array.from(text).length <= max) return text;
  const cut = sliceCodePoints(text, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}...`;
}

export function deriveTitle(row: ServingRow): string {
  const title = collapse(row.title ?? "");
  if (title) return stripLoneSurrogates(title);
  const content = collapse(row.content ?? "");
  if (!content) return "";
  const firstSentence = content.split(/(?<=[.!?؟])\s/)[0] ?? content;
  return stripLoneSurrogates(truncate(firstSentence, TITLE_MAX_CHARS));
}

export function deriveSummary(row: ServingRow): string {
  return stripLoneSurrogates(truncate(collapse(row.content ?? ""), SUMMARY_MAX_CHARS));
}

// Feed titles arrive as marketing strings ("Al Jazeera - Breaking News, World
// News and Video"). Keep the publisher part.
export function outletName(row: ServingRow): string {
  const label = collapse(row.outlet_label ?? "");
  if (!label) return row.source_uid ?? row.source;
  const head = label.split(/\s+[\u2013\u2014|-]\s+/)[0] ?? label;
  return truncate(head, OUTLET_LABEL_MAX_CHARS);
}

export function isoOrNull(value: Date | null): string | null {
  if (!value) return null;
  const t = value.getTime();
  return Number.isNaN(t) ? null : value.toISOString();
}

// Telegram external ids are "<channel>:<message id>". Fall back to the row id
// rather than generating a number.
export function telegramMessageId(row: ServingRow): number {
  const tail = row.external_id.split(":").pop() ?? "";
  const parsed = Number.parseInt(tail, 10);
  return Number.isFinite(parsed) ? parsed : Number(row.id);
}

export function eventTopic(row: ServingRow): string {
  const type = (row.event_type ?? "").trim();
  if (!type) return "unclassified";
  return type.replace(/_/g, " ");
}

// The dashboard audience is what a public panel may return. The backend
// audience is Hessa's own reference view: it adds the unassigned and
// informational rows back, and only the audit route asks for it. There is no
// third option and no way to widen the dashboard audience from a route.
export type Audience = "dashboard" | "backend";

export interface ItemQuery {
  conflict: ConflictKey;
  limit: number;
  /**
   * Source types this query may read. Required: a panel declares its own type
   * and can never be served another panel's rows.
   */
  sourceTypes: SourceType[];
  /** Defaults to "dashboard". Only the audit path passes "backend". */
  audience?: Audience;
  /** Classifier severity values to keep. Omit for every severity. */
  severities?: string[];
  eventTypes?: string[];
  requireUrl?: boolean;
  requireText?: boolean;
  requireByline?: boolean;
  breakingOrSevere?: boolean;
  sinceHours?: number;
  /**
   * Which time column sinceHours filters on. Defaults to published_at, the
   * source's own event time, which is what every feed-collected row carries and
   * what a conflict tracker must order by.
   *
   * "ingested" exists for a collector that genuinely has no publication time to
   * store: the OSINT search returns a report without a parseable date, so its
   * published_at is NULL rather than invented, and a published_at window would
   * then exclude every one of its rows. Measured: it excluded all of them, and
   * the panel served nothing while holding real stored items.
   */
  sinceField?: "published" | "ingested";
}

// Exported so a caller that must join items against another table (the
// timeline's persisted selections) selects the same columns a ServingRow
// carries, instead of hand-rolling a second list that could drift from this
// one. Aliased as `i`, joined to source_status as `s`.
export const SERVING_SELECT_COLUMNS = `
  i.id::text        AS id,
  i.source          AS source,
  i.source_uid      AS source_uid,
  i.external_id     AS external_id,
  i.title           AS title,
  i.url             AS url,
  i.content         AS content,
  i.author          AS author,
  i.severity        AS severity,
  i.confidence      AS confidence,
  i.event_type      AS event_type,
  i.is_breaking     AS is_breaking,
  i.lang            AS lang,
  i.published_at    AS published_at,
  i.ingested_at     AS ingested_at,
  i.conflicts       AS conflicts,
  s.label           AS outlet_label`;

// Null published_at sorts last instead of being given a time it never had.
function buildWhere(q: ItemQuery): { where: string[]; params: unknown[] } {
  const where: string[] = ["i.noise = false"];
  const params: unknown[] = [];

  // Source isolation. An empty list is a query that can match nothing, which
  // is the correct reading of "this panel is allowed no source type" and is
  // never silently widened to everything.
  params.push(sourcesForTypes(q.sourceTypes));
  where.push(`i.source = ANY($${params.length}::text[])`);

  if ((q.audience ?? "dashboard") === "dashboard") {
    // Rule 2, as one predicate on every dashboard read. An item unrelated to
    // a followed conflict has an empty conflicts array; informational is the
    // classifier's own bucket for reference material, and a row it could not
    // classify at all is not a development either. None of the three may
    // reach a public panel through any route.
    //
    // The conflict test is an overlap against the ENABLED set rather than
    // `cardinality > 0`, which is what makes a disabled conflict invisible
    // instead of merely untabbed. A row assigned only to a disabled theatre
    // now fails this predicate on every dashboard read, including the "all"
    // tab; a row assigned to both a disabled and an enabled theatre still
    // serves on the enabled one. An empty enabled set therefore serves an
    // empty dashboard, which is the correct reading of "reveal nothing".
    //
    // Nothing here touches the stored rows. They stay in items, keep being
    // assigned as they arrive, and come back the moment the conflict is
    // re-enabled.
    params.push(enabledConflictKeys());
    where.push(`i.conflicts && $${params.length}::text[]`);
    where.push(`i.event_type IS NOT NULL AND i.event_type <> 'informational'`);
  }

  if (q.conflict !== "all") {
    // Array overlap against the stored assignment, served by
    // items_conflicts_gin_idx. Every row a tab returns therefore carries that
    // conflict in its own conflicts array by construction, which is the
    // property the old regex could not give: there is no second derivation at
    // query time that could disagree with what is stored.
    params.push([q.conflict]);
    where.push(`i.conflicts && $${params.length}::text[]`);
  }

  if (q.severities && q.severities.length > 0) {
    params.push(q.severities);
    where.push(`i.severity = ANY($${params.length}::text[])`);
  }

  if (q.eventTypes && q.eventTypes.length > 0) {
    params.push(q.eventTypes);
    where.push(`i.event_type = ANY($${params.length}::text[])`);
  }

  if (q.breakingOrSevere) {
    where.push(`(i.is_breaking = true OR i.severity IN ('high', 'critical'))`);
  }

  if (q.requireUrl) {
    where.push(`i.url IS NOT NULL AND i.url <> ''`);
  }

  if (q.requireText) {
    where.push(`(coalesce(i.title, '') <> '' OR coalesce(i.content, '') <> '')`);
  }

  if (q.requireByline) {
    where.push(`coalesce(i.author, '') <> ''`);
  }

  if (q.sinceHours) {
    const column = q.sinceField === "ingested" ? "i.ingested_at" : "i.published_at";
    params.push(String(q.sinceHours));
    where.push(`${column} >= NOW() - ($${params.length} || ' hours')::interval`);
  }

  return { where, params };
}

// Defence in depth against a future edit to buildWhere: what the SQL returned
// is checked against what the caller asked for, and a breach throws rather
// than being served. A panel returning nothing is a bad day; a panel returning
// another panel's sources is the bug this task exists to close.
function assertIsolation(rows: ServingRow[], q: ItemQuery): void {
  const allowed = new Set<string>(q.sourceTypes);
  const breached = rows.filter((r) => !allowed.has(sourceTypeOf(r.source) as SourceType));
  if (breached.length > 0) {
    const seen = Array.from(new Set(breached.map((r) => `${r.source}/${sourceTypeOf(r.source)}`)));
    throw new Error(
      `source isolation breach: ${breached.length} of ${rows.length} rows are not in [${q.sourceTypes.join(", ")}] (${seen.join(", ")})`,
    );
  }

  if ((q.audience ?? "dashboard") !== "dashboard") return;
  // The same three tests as the dashboard predicate, re-asserted on what the
  // SQL actually returned. "Assigned" means assigned to an ENABLED conflict:
  // a row carrying only a disabled theatre is backend-only, so serving one is
  // the same class of breach as serving an unassigned row.
  const revealed = new Set<string>(enabledConflictKeys());
  const leaked = rows.filter(
    (r) =>
      !(r.conflicts ?? []).some((c) => revealed.has(c)) ||
      !r.event_type ||
      r.event_type === "informational",
  );
  if (leaked.length > 0) {
    throw new Error(
      `backend-only leak: ${leaked.length} of ${rows.length} rows are unassigned, assigned only to a disabled conflict, or informational`,
    );
  }
}

export async function fetchItems(q: ItemQuery): Promise<ServingRow[]> {
  const { where, params } = buildWhere(q);
  params.push(q.limit);

  // Ordering matches the window: a caller filtering on ingested_at has rows
  // whose published_at is null by construction, and ordering those by
  // published_at leaves the sequence to the id tiebreak alone. Both branches
  // end on id DESC, so either order is total and two calls cannot reshuffle.
  const orderBy =
    q.sinceField === "ingested"
      ? "i.ingested_at DESC, i.id DESC"
      : "i.published_at DESC NULLS LAST, i.id DESC";

  const { rows } = await pool.query(
    `SELECT ${SERVING_SELECT_COLUMNS}
     FROM items i
     LEFT JOIN source_status s ON s.id = i.source_uid
     WHERE ${where.join(" AND ")}
     ORDER BY ${orderBy}
     LIMIT $${params.length}`,
    params,
  );

  assertIsolation(rows as ServingRow[], q);
  return rows as ServingRow[];
}

// Same filter, no limit, count only. The timeline reports how much
// informational chatter it dropped, and that number has to be the real one.
export async function countItems(q: Omit<ItemQuery, "limit">): Promise<number> {
  const { where, params } = buildWhere({ ...q, limit: 0 });
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM items i WHERE ${where.join(" AND ")}`,
    params,
  );
  return rows[0]?.n ?? 0;
}

// Rule 2's other half: the backend-only rows must remain queryable for audit,
// so nothing here deletes them and this is the query that proves they are
// still there. Reported by GET /api/sources alongside the per-conflict counts.
export interface BackendOnlyCounts {
  total: number;
  unassigned: number;
  /** Assigned, but only to conflicts that are currently disabled. Hidden, retained. */
  disabled_conflict_only: number;
  informational: number;
  backend_only: number;
  dashboard_eligible: number;
  by_source_type: Array<{ source_type: string; backend_only: number }>;
}

export async function backendOnlyCounts(): Promise<BackendOnlyCounts> {
  // The same enabled-overlap test the dashboard predicate uses, so these
  // counts partition the corpus exactly as the panels do. disabled_conflict_only
  // is the number Hessa needs to see after a toggle: it is the proof that the
  // rows are hidden and still stored rather than deleted.
  const enabled = enabledConflictKeys();
  const [totals, bySource] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE cardinality(conflicts) = 0)::int AS unassigned,
              COUNT(*) FILTER (WHERE cardinality(conflicts) > 0
                                 AND NOT (conflicts && $1::text[]))::int AS disabled_conflict_only,
              COUNT(*) FILTER (WHERE event_type IS NULL OR event_type = 'informational')::int AS informational,
              COUNT(*) FILTER (WHERE NOT (conflicts && $1::text[])
                                  OR event_type IS NULL
                                  OR event_type = 'informational')::int AS backend_only,
              COUNT(*) FILTER (WHERE conflicts && $1::text[]
                                 AND event_type IS NOT NULL
                                 AND event_type <> 'informational')::int AS dashboard_eligible
       FROM items WHERE noise = false`,
      [enabled],
    ),
    pool.query(
      `SELECT source, COUNT(*)::int AS backend_only
       FROM items
       WHERE noise = false
         AND (NOT (conflicts && $1::text[]) OR event_type IS NULL OR event_type = 'informational')
       GROUP BY source ORDER BY 2 DESC`,
      [enabled],
    ),
  ]);

  const row = totals.rows[0] ?? {};
  return {
    total: row.total ?? 0,
    unassigned: row.unassigned ?? 0,
    disabled_conflict_only: row.disabled_conflict_only ?? 0,
    informational: row.informational ?? 0,
    backend_only: row.backend_only ?? 0,
    dashboard_eligible: row.dashboard_eligible ?? 0,
    by_source_type: (bySource.rows as Array<{ source: string; backend_only: number }>).map((r) => ({
      source_type: sourceTypeOf(r.source),
      backend_only: r.backend_only,
    })),
  };
}

// Per-conflict stored counts, so the assignment is inspectable rather than
// trusted. Reported by GET /api/sources.
//
// This counts EVERY conflict including the disabled ones, on purpose: it is the
// audit view, and after Hessa turns a theatre off this is the query that shows
// its rows are still in Postgres. The `enabled` flag on each entry says which
// of them the panels are currently revealing.
export interface ConflictAssignmentCount {
  conflict: string;
  enabled: boolean;
  items: number;
  rss: number;
  telegram: number;
}

export async function conflictAssignmentCounts(): Promise<{
  assigned: ConflictAssignmentCount[];
  unassigned: number;
  total: number;
}> {
  const [byConflict, totals] = await Promise.all([
    pool.query(
      `SELECT c AS conflict,
              COUNT(*)::int AS items,
              COUNT(*) FILTER (WHERE source = 'rss')::int AS rss,
              COUNT(*) FILTER (WHERE source = 'telegram')::int AS telegram
       FROM items, unnest(conflicts) AS c
       WHERE noise = false
       GROUP BY c
       ORDER BY 2 DESC`,
    ),
    pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE cardinality(conflicts) = 0)::int AS unassigned
       FROM items WHERE noise = false`,
    ),
  ]);

  return {
    assigned: (byConflict.rows as Array<Omit<ConflictAssignmentCount, "enabled">>).map((r) => ({
      ...r,
      enabled: isConflictEnabled(r.conflict),
    })),
    unassigned: totals.rows[0]?.unassigned ?? 0,
    total: totals.rows[0]?.total ?? 0,
  };
}
