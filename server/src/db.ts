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
