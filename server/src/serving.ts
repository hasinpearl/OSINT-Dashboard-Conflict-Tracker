import { pool } from "./db";
import type { ConflictKey } from "./conflicts";

// Panel serving layer. Every panel route reads the items table through here, so
// the mapping from ingested rows onto the legacy response shapes lives in one
// place. No upstream fetch, no model call, no api_cache origin.

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

export interface ItemQuery {
  conflict: ConflictKey;
  limit: number;
  source?: "rss" | "telegram";
  /** Classifier severity values to keep. Omit for every severity. */
  severities?: string[];
  eventTypes?: string[];
  excludeInformational?: boolean;
  onlyInformational?: boolean;
  requireUrl?: boolean;
  requireText?: boolean;
  requireByline?: boolean;
  breakingOrSevere?: boolean;
  sinceHours?: number;
}

const SELECT_COLUMNS = `
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

  if (q.source) {
    params.push(q.source);
    where.push(`i.source = $${params.length}`);
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

  if (q.excludeInformational) {
    where.push(`i.event_type IS NOT NULL AND i.event_type <> 'informational'`);
  }

  if (q.onlyInformational) {
    where.push(`(i.event_type IS NULL OR i.event_type = 'informational')`);
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
    where.push(`(coalesce(i.author, '') <> '' OR coalesce(i.source_uid, '') <> '')`);
  }

  if (q.sinceHours) {
    params.push(String(q.sinceHours));
    where.push(`i.published_at >= NOW() - ($${params.length} || ' hours')::interval`);
  }

  return { where, params };
}

export async function fetchItems(q: ItemQuery): Promise<ServingRow[]> {
  const { where, params } = buildWhere(q);
  params.push(q.limit);

  const { rows } = await pool.query(
    `SELECT ${SELECT_COLUMNS}
     FROM items i
     LEFT JOIN source_status s ON s.id = i.source_uid
     WHERE ${where.join(" AND ")}
     ORDER BY i.published_at DESC NULLS LAST, i.id DESC
     LIMIT $${params.length}`,
    params,
  );

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

// Per-conflict stored counts, so the assignment is inspectable rather than
// trusted. Reported by GET /api/sources.
export interface ConflictAssignmentCount {
  conflict: string;
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
    assigned: byConflict.rows as ConflictAssignmentCount[],
    unassigned: totals.rows[0]?.unassigned ?? 0,
    total: totals.rows[0]?.total ?? 0,
  };
}
