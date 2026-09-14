import type { Context } from "hono";
import { pool } from "../db";
import { AppError } from "../errors";

// Worker health. When every panel is empty this is the endpoint that says
// whether the workers ever ran, which sources answered, and what the failures
// were. It is deliberately unauthenticated: the frontend shows it to explain an
// empty panel, and it exposes only feed keys and their error strings, no
// credentials and no content.

//TUNE: Control the (sources page size). Rows returned by /api/sources.
const MAX_SOURCES = 200;

//TUNE: Control the (stale threshold). Seconds since a source last reported before it counts as stale.
const STALE_AFTER_SECONDS = 15 * 60;

// The collector bootstrap writes marker rows into the same table to record which
// runtime owns collection. They are not sources, so they stay out of this list
// and out of its counts.
const RUNTIME_MARKER_PREFIX = "worker_runtime:";

interface SourceRow {
  id: string;
  source: string;
  label: string | null;
  ok: boolean;
  failures: number;
  last_ok: Date | null;
  detail: string | null;
  updated_at: Date;
}

function isoOrNull(value: Date | null): string | null {
  if (!value) return null;
  const t = value.getTime();
  return Number.isNaN(t) ? null : value.toISOString();
}

export async function sourcesRoute(c: Context) {
  try {
    const { rows } = await pool.query<SourceRow>(
      `SELECT id, source, label, ok, failures, last_ok, detail, updated_at
       FROM source_status
       WHERE id NOT LIKE $1
       ORDER BY ok ASC, source ASC, id ASC
       LIMIT $2`,
      [`${RUNTIME_MARKER_PREFIX}%`, MAX_SOURCES],
    );

    const now = Date.now();
    const sources = rows.map((row) => ({
      id: row.id,
      source: row.source,
      label: row.label,
      ok: row.ok,
      failures: row.failures,
      last_ok: isoOrNull(row.last_ok),
      detail: row.detail,
      updated_at: isoOrNull(row.updated_at),
      // A worker that died leaves its last row saying ok, so freshness is a
      // separate reading from the ok flag.
      stale: row.updated_at
        ? now - row.updated_at.getTime() > STALE_AFTER_SECONDS * 1000
        : true,
    }));

    // An empty table is itself the diagnosis: the workers have never written a
    // status, so they have never run against this database.
    return c.json({
      sources,
      count: sources.length,
      healthy: sources.filter((s) => s.ok && !s.stale).length,
      failing: sources.filter((s) => !s.ok).length,
      workers_reported: sources.length > 0,
      stale_after_seconds: STALE_AFTER_SECONDS,
    });
  } catch (e) {
    console.error("sources read failed:", e instanceof Error ? e.message : e);
    throw new AppError("internal_error", "Failed to read source status");
  }
}
