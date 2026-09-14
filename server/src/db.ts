import pg from "pg";
import { envKey } from "./env";

const connectionString =
  envKey("DATABASE_URL") || "postgres://osint:osint@localhost:5432/osint";

export const pool = new pg.Pool({ connectionString });

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
  conflicts text[] NOT NULL DEFAULT '{}',
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
  source_uid text,
  lang text,
  has_media boolean NOT NULL DEFAULT false,
  event_type text,
  is_breaking boolean NOT NULL DEFAULT false,
  primary_location jsonb,
  enrichment jsonb,
  UNIQUE (source, external_id)
);

-- Every column the serving and enrichment code relies on must be added here,
-- not only declared in CREATE TABLE above. CREATE TABLE IF NOT EXISTS is a
-- no-op on a database that already has the table, so an index or query that
-- names a column added only above fails with 42703 on any existing install.
--
-- story_id, noise and panel were in exactly that state: each is named by an
-- index below but neither had its own ALTER, so the schema batch could only
-- ever succeed on a database whose items table was created by this same
-- version. Found by applying SCHEMA_SQL to a pre-upgrade items shape.
ALTER TABLE items ADD COLUMN IF NOT EXISTS story_id bigint REFERENCES stories(id) ON DELETE SET NULL;
ALTER TABLE items ADD COLUMN IF NOT EXISTS noise boolean NOT NULL DEFAULT false;
ALTER TABLE items ADD COLUMN IF NOT EXISTS panel text;
ALTER TABLE items ADD COLUMN IF NOT EXISTS conflict text;
ALTER TABLE items ADD COLUMN IF NOT EXISTS source_uid text;
ALTER TABLE items ADD COLUMN IF NOT EXISTS lang text;
ALTER TABLE items ADD COLUMN IF NOT EXISTS has_media boolean NOT NULL DEFAULT false;
ALTER TABLE items ADD COLUMN IF NOT EXISTS event_type text;
ALTER TABLE items ADD COLUMN IF NOT EXISTS is_breaking boolean NOT NULL DEFAULT false;
ALTER TABLE items ADD COLUMN IF NOT EXISTS primary_location jsonb;
ALTER TABLE items ADD COLUMN IF NOT EXISTS enrichment jsonb;
ALTER TABLE items ADD COLUMN IF NOT EXISTS location_precision text;
ALTER TABLE items ADD COLUMN IF NOT EXISTS location_confidence real;
ALTER TABLE items ADD COLUMN IF NOT EXISTS geocoded_at timestamptz;
ALTER TABLE items ADD COLUMN IF NOT EXISTS geocode_version smallint;

-- The authoritative conflict assignment, written at ingest. An item genuinely
-- belongs to more than one theatre (a Russia-Iran sanctions bill, an Iran-China
-- satellite report), so a single text value is lossy and this is an array.
-- items.conflict above is the legacy single value: it is now DERIVED from this
-- array by the same write, never set independently, so the two cannot drift.
-- This ALTER must stay above the GIN index below, because CREATE TABLE IF NOT
-- EXISTS is a no-op on an existing database and an index naming a column that
-- only the CREATE TABLE declares fails with 42703 on every existing install.
ALTER TABLE items ADD COLUMN IF NOT EXISTS conflicts text[] NOT NULL DEFAULT '{}';
ALTER TABLE items ADD COLUMN IF NOT EXISTS conflict_assign jsonb;

CREATE INDEX IF NOT EXISTS items_published_at_idx ON items (published_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS items_panel_idx ON items (panel);
CREATE INDEX IF NOT EXISTS items_story_id_idx ON items (story_id);
CREATE INDEX IF NOT EXISTS items_content_fts_idx ON items
  USING GIN (to_tsvector('simple', content));
CREATE INDEX IF NOT EXISTS items_event_type_idx ON items (event_type);
CREATE INDEX IF NOT EXISTS items_source_idx ON items (source);

-- The panel filter is now an array overlap (conflicts && ARRAY['iran-us']), so
-- GIN is the index that serves it. This replaced a regex scan over title and
-- content on every panel load.
CREATE INDEX IF NOT EXISTS items_conflicts_gin_idx ON items USING GIN (conflicts);

-- Carries any pre-existing single value into the array before the assigner
-- runs, so a database that had the legacy column populated does not lose it.
-- Idempotent: only rows with a value and an empty array are touched.
UPDATE items SET conflicts = ARRAY[conflict]
  WHERE conflict IS NOT NULL AND conflict <> '' AND conflict <> 'all'
    AND (conflicts IS NULL OR cardinality(conflicts) = 0);

-- Serving indexes. /api/events always filters noise = false and orders by
-- published_at DESC, so the partial index is what keeps the feed off a seq scan.
CREATE INDEX IF NOT EXISTS items_live_feed_idx
  ON items (published_at DESC NULLS LAST, id DESC) WHERE noise = false;
CREATE INDEX IF NOT EXISTS items_event_type_published_at_idx
  ON items (event_type, published_at DESC NULLS LAST) WHERE noise = false;
CREATE INDEX IF NOT EXISTS items_severity_published_at_idx
  ON items (severity, published_at DESC NULLS LAST) WHERE noise = false;
CREATE INDEX IF NOT EXISTS items_source_uid_published_at_idx
  ON items (source_uid, published_at DESC NULLS LAST) WHERE noise = false;
CREATE INDEX IF NOT EXISTS items_breaking_idx
  ON items (published_at DESC NULLS LAST) WHERE is_breaking AND noise = false;
CREATE INDEX IF NOT EXISTS items_enrichment_version_idx
  ON items (((enrichment->>'version')::int))
  WHERE noise = false;

-- The geocoder walks rows it has never attempted, newest first. The partial
-- index keeps that scan off the full table once items grows.
CREATE INDEX IF NOT EXISTS items_geocode_pending_idx
  ON items (published_at DESC NULLS LAST, id DESC)
  WHERE geocoded_at IS NULL;
CREATE INDEX IF NOT EXISTS items_pins_idx
  ON items (published_at DESC NULLS LAST)
  WHERE primary_location IS NOT NULL AND noise = false;

CREATE TABLE IF NOT EXISTS collection_runs (
  panel text NOT NULL,
  conflict text NOT NULL,
  ran_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (panel, conflict)
);

-- Rule 5: the timeline is updated, not rebuilt. The editorial selection is
-- persisted per conflict and keyed on the stored item it came from, so a later
-- run updates the same entry instead of producing a fresh list. Without this
-- the panel's membership was whatever the last model call happened to return,
-- and an entry could vanish and reappear between loads while the development
-- it described was still current.
--
-- item_id cascades: if the underlying item is ever deleted the development has
-- no source left, and an entry with no stored row behind it is exactly what
-- this panel must never show.
CREATE TABLE IF NOT EXISTS timeline_selections (
  conflict text NOT NULL,
  item_id bigint NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  significance text NOT NULL DEFAULT '',
  first_selected_at timestamptz NOT NULL DEFAULT now(),
  last_selected_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conflict, item_id)
);

CREATE INDEX IF NOT EXISTS timeline_selections_conflict_idx
  ON timeline_selections (conflict, last_selected_at DESC);

CREATE TABLE IF NOT EXISTS source_status (
  id text PRIMARY KEY,
  source text NOT NULL,
  label text,
  ok boolean NOT NULL DEFAULT true,
  detail text,
  failures integer NOT NULL DEFAULT 0,
  last_ok timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
`;

let ready = false;
let initPromise: Promise<void> | null = null;

export function isDbReady(): boolean {
  return ready;
}

//TUNE: Control the (db retry). DB_INIT_RETRY_MS=wait between schema attempts while Postgres is still starting.
const DB_INIT_RETRY_MS = 5000;

export function initDb(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
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
          await new Promise((r) => setTimeout(r, DB_INIT_RETRY_MS));
        }
      }
    })();
  }
  return initPromise;
}
