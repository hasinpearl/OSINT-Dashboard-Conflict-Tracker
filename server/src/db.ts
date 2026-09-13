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

CREATE INDEX IF NOT EXISTS items_published_at_idx ON items (published_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS items_conflict_panel_idx ON items (conflict, panel);
CREATE INDEX IF NOT EXISTS items_story_id_idx ON items (story_id);
CREATE INDEX IF NOT EXISTS items_content_fts_idx ON items
  USING GIN (to_tsvector('simple', content));
CREATE INDEX IF NOT EXISTS items_event_type_idx ON items (event_type);
CREATE INDEX IF NOT EXISTS items_source_idx ON items (source);

CREATE TABLE IF NOT EXISTS collection_runs (
  panel text NOT NULL,
  conflict text NOT NULL,
  ran_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (panel, conflict)
);

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
