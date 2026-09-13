import { pool } from "../db";
import { classify, ENRICH_VERSION } from "../enrich";

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
}

// Rows worth touching: never classified, or classified by an older ruleset.
const STALE_PREDICATE = `
  event_type IS NULL
  OR severity IS NULL
  OR enrichment IS NULL
  OR coalesce((enrichment->>'version')::int, -1) < $1
`;

async function writeBatch(rows: Row[]): Promise<number> {
  if (rows.length === 0) return 0;

  const ids: string[] = [];
  const eventTypes: string[] = [];
  const severities: string[] = [];
  const breaking: boolean[] = [];
  const langs: string[] = [];
  const enrichments: string[] = [];

  for (const row of rows) {
    const result = classify({
      title: row.title,
      content: row.content,
      publishedAt: row.published_at,
    });
    ids.push(row.id);
    eventTypes.push(result.event_type);
    severities.push(result.severity);
    breaking.push(result.is_breaking);
    langs.push(result.lang);
    enrichments.push(JSON.stringify(result.enrichment));
  }

  const res = await pool.query(
    `UPDATE items AS i SET
       event_type  = u.event_type,
       severity    = u.severity,
       is_breaking = u.is_breaking,
       lang        = coalesce(i.lang, u.lang),
       enrichment  = u.enrichment
     FROM (
       SELECT * FROM unnest(
         $1::bigint[], $2::text[], $3::text[], $4::boolean[], $5::text[], $6::jsonb[]
       ) AS t(id, event_type, severity, is_breaking, lang, enrichment)
     ) AS u
     WHERE i.id = u.id`,
    [ids, eventTypes, severities, breaking, langs, enrichments],
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
      `SELECT id, title, content, published_at
       FROM items
       WHERE ${STALE_PREDICATE}
       ORDER BY published_at DESC NULLS LAST, id DESC
       LIMIT $2`,
      [ENRICH_VERSION, batchSize],
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
      `SELECT id, title, content, published_at
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
    `SELECT id, title, content, published_at
     FROM items
     WHERE id = ANY($1::bigint[])`,
    [ids.map(String)],
  );

  const updated = await writeBatch(rows);
  return { scanned: rows.length, updated };
}
