#!/usr/bin/env node
// PROPOSED, awaiting Hessa's review before any commit. NOT RUN by the audit.
//
// One-shot backfill: lifts timeline/OSINT history from api_cache blobs into
// the stories/items tables so migration does not start the timeline at zero.
// Idempotent (all writes are ON CONFLICT merges), read-only on api_cache.
//
// Usage (from repo root, after npm --prefix server install):
//   DATABASE_URL=postgres://... node scripts/migrate-cache-to-timeline.mjs --dry-run
//   DATABASE_URL=postgres://... node scripts/migrate-cache-to-timeline.mjs
//
// Requires the new schema to exist already: start the API once with the
// updated db.ts (initDb applies it), or apply the CREATE TABLE block by hand.
import pg from "pg";

const DRY_RUN = process.argv.includes("--dry-run");
const connectionString =
  process.env.DATABASE_URL || "postgres://osint:osint@localhost:5432/osint";

const pool = new pg.Pool({ connectionString });

const SEVERITY_RANK = { info: 0, verified: 1, developing: 2, high: 3, critical: 4 };

function significantWords(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3);
}

function eventKeyFor(dateOnly, title) {
  const tokens = Array.from(new Set(significantWords(title))).sort().slice(0, 8);
  return `${dateOnly}|${tokens.join("-")}`;
}

function toDateOnly(v) {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

function toIso(v) {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function conflictFromKey(functionName) {
  const idx = functionName.indexOf(":");
  return idx === -1 ? "all" : functionName.slice(idx + 1);
}

async function main() {
  const { rows } = await pool.query(
    "SELECT function_name, response_data, fetched_at FROM api_cache ORDER BY function_name",
  );
  console.log(`Found ${rows.length} api_cache rows.`);

  let storyWrites = 0;
  let itemWrites = 0;

  for (const row of rows) {
    const name = row.function_name;
    const conflict = conflictFromKey(name);
    const payload = row.response_data || {};

    // ── hot-topics timeline blobs → stories ──────────────────────────────────
    if (name.startsWith("ai-summarize") && Array.isArray(payload.topics)) {
      for (const t of payload.topics) {
        const date = toDateOnly(t?.timestamp);
        const title = typeof t?.title === "string" ? t.title.trim() : "";
        if (!date || !title) continue;

        const severity = String(t?.severity ?? "developing").toLowerCase();
        const rank = SEVERITY_RANK[severity] ?? 2;
        const sources = t?.source ? [String(t.source)] : [];
        // first_seen_at: best available evidence is when that blob was cached.
        const firstSeen = toIso(payload.cached_at) || toIso(row.fetched_at) || new Date().toISOString();

        if (DRY_RUN) {
          console.log(`[dry-run] story ${conflict} ${date} :: ${title}`);
          storyWrites++;
          continue;
        }

        await pool.query(
          `INSERT INTO stories
             (conflict, event_key, title, summary, severity, severity_rank,
              event_date, sources, first_seen_at, last_seen_at)
           VALUES ($1,$2,$3,$4,$5,$6::int,$7::date,$8::text[],$9,$9)
           ON CONFLICT (conflict, event_key) DO UPDATE SET
             summary       = CASE WHEN length(EXCLUDED.summary) > length(stories.summary)
                                  THEN EXCLUDED.summary ELSE stories.summary END,
             severity      = CASE WHEN EXCLUDED.severity_rank > stories.severity_rank
                                  THEN EXCLUDED.severity ELSE stories.severity END,
             severity_rank = GREATEST(stories.severity_rank, EXCLUDED.severity_rank),
             sources       = ARRAY(SELECT DISTINCT s
                                   FROM unnest(stories.sources || EXCLUDED.sources) AS s
                                   WHERE s IS NOT NULL AND s <> ''),
             first_seen_at = LEAST(stories.first_seen_at, EXCLUDED.first_seen_at)`,
          [
            conflict,
            eventKeyFor(date, title),
            title,
            String(t?.summary ?? ""),
            severity,
            rank,
            date,
            sources,
            firstSeen,
          ],
        );
        storyWrites++;
      }
      continue;
    }

    // ── item-shaped blobs → items ────────────────────────────────────────────
    // perplexity-osint: {items:[...]}   firecrawl-news: {stories:[...]}
    const list = Array.isArray(payload.items)
      ? payload.items
      : Array.isArray(payload.stories)
        ? payload.stories
        : null;
    if (!list) continue;

    const panel = name.startsWith("perplexity-osint")
      ? "osint"
      : name.startsWith("firecrawl-news")
        ? "news-feed"
        : name.split(":")[0];

    for (const it of list) {
      const title = it?.title ?? it?.headline;
      const url = typeof it?.url === "string" && /^https?:\/\//i.test(it.url) ? it.url.trim() : null;
      if (!title && !url) continue;
      const source = String(it?.source || panel);
      const externalId = url || `${panel}|${conflict}|${String(title).slice(0, 120)}`;

      if (DRY_RUN) {
        console.log(`[dry-run] item ${panel} ${conflict} :: ${String(title).slice(0, 60)}`);
        itemWrites++;
        continue;
      }

      await pool.query(
        `INSERT INTO items
           (source, external_id, conflict, panel, title, url, content,
            severity, confidence, published_at, raw)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (source, external_id) DO NOTHING`,
        [
          source,
          externalId,
          conflict,
          panel,
          title ? String(title) : null,
          url,
          String(it?.summary ?? ""),
          it?.severity ? String(it.severity) : null,
          it?.confidence ? String(it.confidence) : null,
          toIso(it?.timestamp),
          JSON.stringify({ collected_by: "cache-migration", cache_key: name }),
        ],
      );
      itemWrites++;
    }
  }

  console.log(
    `${DRY_RUN ? "[dry-run] would write" : "wrote"} ${storyWrites} story rows, ${itemWrites} item rows.`,
  );
  console.log("api_cache was NOT modified.");
  await pool.end();
}

main().catch((e) => {
  console.error("migration failed:", e);
  process.exit(1);
});
