import pg from "pg";
import { envKey } from "./env";

const connectionString =
  envKey("DATABASE_URL") || "postgres://osint:osint@localhost:5432/osint";

export const pool = new pg.Pool({ connectionString });

// Idle-client errors must not crash the process.
pool.on("error", (err) => {
  console.error("pg pool idle error:", err.message);
});

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS api_cache (
  function_name text PRIMARY KEY,
  response_data jsonb NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS api_cost_log (
  id bigserial PRIMARY KEY,
  panel text NOT NULL,
  provider text NOT NULL,
  model text,
  units numeric NOT NULL DEFAULT 1,
  unit_type text NOT NULL DEFAULT 'request',
  cost_usd numeric NOT NULL DEFAULT 0,
  cache_hit boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ── OSINT intelligence store ────────────────────────────────────────────────
-- Permanent, per-conflict / per-event storage. api_cache above stays exactly as
-- it is: it remains a short-lived RESPONSE cache. It is no longer the only place
-- timeline history lives, so a cache eviction can never wipe the timeline.
--
-- 'stories' = one row per real-world event, per conflict. Merged on re-sighting,
--             never replaced and never deleted.
-- 'items'   = raw per-source observations behind those events.
-- Shape is deliberately identical to the table names used by private-demo and
-- osintcrawler so the three systems can converge on one schema.

CREATE TABLE IF NOT EXISTS stories (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conflict text NOT NULL DEFAULT 'all',
  event_key text NOT NULL,
  title text NOT NULL,
  summary text NOT NULL DEFAULT '',
  severity text NOT NULL DEFAULT 'developing',
  severity_rank smallint NOT NULL DEFAULT 2,
  event_date date,
  sources text[] NOT NULL DEFAULT '{}',
  sighting_count integer NOT NULL DEFAULT 1,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

-- Idempotent converge step: harmless on a fresh DB, and it upgrades an older
-- 'stories' table (e.g. the private-demo shape) in place without data loss.
ALTER TABLE stories ADD COLUMN IF NOT EXISTS conflict text NOT NULL DEFAULT 'all';
ALTER TABLE stories ADD COLUMN IF NOT EXISTS event_key text;
ALTER TABLE stories ADD COLUMN IF NOT EXISTS summary text NOT NULL DEFAULT '';
ALTER TABLE stories ADD COLUMN IF NOT EXISTS severity text NOT NULL DEFAULT 'developing';
ALTER TABLE stories ADD COLUMN IF NOT EXISTS severity_rank smallint NOT NULL DEFAULT 2;
ALTER TABLE stories ADD COLUMN IF NOT EXISTS event_date date;
ALTER TABLE stories ADD COLUMN IF NOT EXISTS sources text[] NOT NULL DEFAULT '{}';
ALTER TABLE stories ADD COLUMN IF NOT EXISTS sighting_count integer NOT NULL DEFAULT 1;
ALTER TABLE stories ADD COLUMN IF NOT EXISTS first_seen_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE stories ADD COLUMN IF NOT EXISTS last_seen_at timestamptz NOT NULL DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS stories_conflict_event_key_idx
  ON stories (conflict, event_key);
CREATE INDEX IF NOT EXISTS stories_conflict_date_idx
  ON stories (conflict, event_date DESC NULLS LAST);

CREATE TABLE IF NOT EXISTS items (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source text NOT NULL,
  external_id text NOT NULL,
  conflict text,
  panel text,
  author text,
  title text,
  url text,
  content text NOT NULL DEFAULT '',
  severity text,
  confidence text,
  published_at timestamptz,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  raw jsonb,
  story_id bigint REFERENCES stories(id) ON DELETE SET NULL,
  noise boolean NOT NULL DEFAULT false,
  UNIQUE (source, external_id)
);

CREATE INDEX IF NOT EXISTS items_published_at_idx ON items (published_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS items_conflict_panel_idx ON items (conflict, panel);
CREATE INDEX IF NOT EXISTS items_story_id_idx ON items (story_id);
-- 'simple' config: content is multilingual (English + Arabic); a stemmed config
-- would mangle it.
CREATE INDEX IF NOT EXISTS items_content_fts_idx ON items
  USING GIN (to_tsvector('simple', content));

-- Records that a collection pass ran, independently of whether it found
-- anything. Without this, a pass that legitimately returns zero events looks
-- identical to "never collected" and would re-hit the paid APIs every request.
CREATE TABLE IF NOT EXISTS collection_runs (
  panel text NOT NULL,
  conflict text NOT NULL,
  ran_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (panel, conflict)
);
`;

let ready = false;
export function isDbReady(): boolean {
  return ready;
}

// Never await the DB before listening: auth and upstream AI calls work
// without Postgres — only caching/cost logging pause until it connects.
export function initDb(): void {
  void (async () => {
    for (;;) {
      try {
        await pool.query(SCHEMA_SQL);
        ready = true;
        console.log("Database schema ready");
        return;
      } catch (e) {
        console.error(
          "DB init failed, retrying in 5s:",
          e instanceof Error ? e.message : e,
        );
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  })();
}
