import { pool } from "../db";
import { classify, ENRICH_VERSION } from "../enrich";
import { CONFLICT_ASSIGN_VERSION, assignConflicts } from "../conflictAssign";

//TUNE: Control the (backfill batch size). Rows classified and written per transaction.
const ENRICH_BATCH_SIZE = 500;

export interface EnrichRunResult {
  scanned: number;
  updated: number;
}

interface Row {
  id: string;
  title: string | null;
  content: string | null;
  published_at: Date | null;
  source: string | null;
  source_uid: string | null;
}

// Rows worth touching: never classified, classified by an older ruleset, never
// assigned a conflict, or assigned by an older conflict lexicon. The conflict
// clauses matter as much as the event-type ones: without them a lexicon fix
// would never reach the rows it was written for, which is the failure the
// query-time regex had by design.
const STALE_PREDICATE = `
  event_type IS NULL
  OR severity IS NULL
  OR enrichment IS NULL
  OR coalesce((enrichment->>'version')::int, -1) < $1
  OR conflict_assign IS NULL
  OR coalesce((conflict_assign->>'version')::int, -1) < $2
`;

async function writeBatch(rows: Row[]): Promise<number> {
  if (rows.length === 0) return 0;

  const ids: string[] = [];
  const eventTypes: string[] = [];
  const severities: string[] = [];
  const breaking: boolean[] = [];
  const langs: string[] = [];
  const enrichments: string[] = [];
  const conflicts: string[] = [];
  const legacyConflict: Array<string | null> = [];
  const conflictAssign: string[] = [];

  for (const row of rows) {
    const result = classify({
      title: row.title,
      content: row.content,
      publishedAt: row.published_at,
    });
    const assigned = assignConflicts({
      title: row.title,
      content: row.content,
      sourceUid: row.source_uid,
      source: row.source,
    });
    ids.push(row.id);
    eventTypes.push(result.event_type);
    severities.push(result.severity);
    breaking.push(result.is_breaking);
    langs.push(result.lang);
    enrichments.push(JSON.stringify(result.enrichment));
    conflicts.push(JSON.stringify(assigned.conflicts));
    legacyConflict.push(assigned.conflict);
    conflictAssign.push(JSON.stringify(assigned.reason));
  }

  const res = await pool.query(
    `UPDATE items AS i SET
       event_type      = u.event_type,
       severity        = u.severity,
       is_breaking     = u.is_breaking,
       lang            = coalesce(i.lang, u.lang),
       enrichment      = u.enrichment,
       conflicts       = ARRAY(SELECT jsonb_array_elements_text(u.conflicts)),
       conflict        = u.conflict,
       conflict_assign = u.conflict_assign
     FROM (
       SELECT * FROM unnest(
         $1::bigint[], $2::text[], $3::text[], $4::boolean[], $5::text[], $6::jsonb[],
         $7::jsonb[], $8::text[], $9::jsonb[]
       ) AS t(id, event_type, severity, is_breaking, lang, enrichment,
              conflicts, conflict, conflict_assign)
     ) AS u
     WHERE i.id = u.id`,
    [
      ids,
      eventTypes,
      severities,
      breaking,
      langs,
      enrichments,
      conflicts,
      legacyConflict,
      conflictAssign,
    ],
  );

  return res.rowCount || 0;
}

export async function enrichPending(limit?: number): Promise<EnrichRunResult> {
  let scanned = 0;
  let updated = 0;

  for (;;) {
    const remaining = limit === undefined ? ENRICH_BATCH_SIZE : limit - scanned;
    if (remaining <= 0) break;
    const batchSize = Math.min(ENRICH_BATCH_SIZE, remaining);

    const { rows } = await pool.query<Row>(
      `SELECT id, title, content, published_at, source, source_uid
       FROM items
       WHERE ${STALE_PREDICATE}
       ORDER BY published_at DESC NULLS LAST, id DESC
       LIMIT $3`,
      [ENRICH_VERSION, CONFLICT_ASSIGN_VERSION, batchSize],
    );

    if (rows.length === 0) break;
    scanned += rows.length;
    updated += await writeBatch(rows);
    if (rows.length < batchSize) break;
  }

  return { scanned, updated };
}

// Re-classifies everything regardless of version. Used when rules change in a
// way that should override rows already stamped with the current version.
export async function enrichAll(): Promise<EnrichRunResult> {
  let scanned = 0;
  let updated = 0;
  let lastId = "0";

  for (;;) {
    const { rows } = await pool.query<Row>(
      `SELECT id, title, content, published_at, source, source_uid
       FROM items
       WHERE id > $1::bigint
       ORDER BY id ASC
       LIMIT $2`,
      [lastId, ENRICH_BATCH_SIZE],
    );

    if (rows.length === 0) break;
    lastId = rows[rows.length - 1].id;
    scanned += rows.length;
    updated += await writeBatch(rows);
    if (rows.length < ENRICH_BATCH_SIZE) break;
  }

  return { scanned, updated };
}

export async function enrichById(ids: Array<number | string>): Promise<EnrichRunResult> {
  if (ids.length === 0) return { scanned: 0, updated: 0 };

  const { rows } = await pool.query<Row>(
    `SELECT id, title, content, published_at, source, source_uid
     FROM items
     WHERE id = ANY($1::bigint[])`,
    [ids.map(String)],
  );

  const updated = await writeBatch(rows);
  return { scanned: rows.length, updated };
}
