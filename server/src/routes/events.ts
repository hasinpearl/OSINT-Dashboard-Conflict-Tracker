import { Context } from "hono";
import { pool } from "../db";
import { AppError } from "../errors"; // Assuming we have an AppError class
import { backendOnlyCounts } from "../serving";
import { enabledConflictKeys } from "../conflicts";

// Rule 2, as a SQL fragment shared by every public read in this file. An item
// assigned to no REVEALED conflict, and anything the classifier marked
// informational, is Hessa's backend reference material and must never be
// returned to the dashboard by ANY route. These are GET endpoints that can be
// curled directly, so the predicate belongs in the query, not in a caller.
//
// "Revealed" is the enabled set, not merely non-empty: a row assigned only to a
// disabled conflict is as hidden here as an unassigned one, which is what stops
// these endpoints being the back door around a toggle. The enabled list is a
// bound parameter rather than interpolated text, and it is read per request so
// a toggle takes effect without a restart. The fragment takes the parameter
// index because each query below numbers its own placeholders.
function dashboardAudience(index: number): string {
  return `
      AND conflicts && $${index}::text[]
      AND event_type IS NOT NULL
      AND event_type <> 'informational'`;
}

/**
 * GET /api/events
 * Fetch events from the database with filtering and pagination
 */
export async function eventsRoute(c: Context) {
  const { 
    since, 
    until, 
    limit = '50', 
    cursor, 
    channel, 
    type, 
    severity,
    breaking
  } = c.req.query();
  
  // Validate limit
  //TUNE: Control the (page size). Default rows per request, and the hard ceiling on any requested limit.
  const limitNum = Math.min(Math.max(parseInt(limit) || 50, 1), 200);

  // The audience predicate's enabled list is $1, so it is bound before any
  // caller-supplied filter and the numbering below stays sequential.
  const params: any[] = [enabledConflictKeys()];
  let paramIndex = 2;

  // Build query
  let query = `
    SELECT 
      id as event_id,
      source_uid,
      source,
      url as source_url,
      content as original_text,
      content as summary,
      published_at,
      ingested_at,
      event_type,
      severity,
      is_breaking,
      lang,
      has_media,
      NULL as translated_text,
      primary_location,
      enrichment,
      conflicts,
      conflict_assign,
      raw
    FROM items
    WHERE noise = false
      ${dashboardAudience(1)}
  `;
  
  // Date filters
  if (since) {
    query += ` AND published_at >= $${paramIndex++}`;
    params.push(new Date(since));
  }
  
  if (until) {
    query += ` AND published_at <= $${paramIndex++}`;
    params.push(new Date(until));
  }
  
  // Channel filter
  if (channel) {
    query += ` AND source_uid = $${paramIndex++}`;
    params.push(channel);
  }
  
  // Type filter
  if (type) {
    query += ` AND event_type = $${paramIndex++}`;
    params.push(type);
  }
  
  // Severity filter
  if (severity) {
    query += ` AND severity = $${paramIndex++}`;
    params.push(severity);
  }
  
  // Breaking news filter
  if (breaking === 'true') {
    query += ` AND is_breaking = true`;
  } else if (breaking === 'false') {
    query += ` AND is_breaking = false`;
  }
  
  // Cursor for pagination
  if (cursor) {
    // Parse cursor - it should be a timestamp
    const cursorDate = new Date(cursor);
    if (isNaN(cursorDate.getTime())) {
      throw new AppError("not_found", "Invalid cursor");
    }
    
    query += ` AND published_at < $${paramIndex++}`;
    params.push(cursorDate);
  }
  
  // Order and limit
  query += ` ORDER BY published_at DESC NULLS LAST, id DESC LIMIT $${paramIndex++}`;
  params.push(limitNum);
  
  try {
    const result = await pool.query(query, params);
    
    // Prepare next cursor - use the timestamp of the last item
    let nextCursor = null;
    if (result.rows.length > 0) {
      const lastRow = result.rows[result.rows.length - 1];
      nextCursor = lastRow.published_at ? lastRow.published_at.toISOString() : null;
    }
    
    return c.json({
      events: result.rows,
      count: result.rows.length,
      next_cursor: nextCursor
    });
  } catch (error) {
    console.error("Error fetching events:", error);
    throw new AppError("internal_error", "Internal server error");
  }
}

/**
 * GET /api/events/pins
 * Fetch events with location data (pins)
 */
export async function eventsPinsRoute(c: Context) {
  const { since, limit = '50' } = c.req.query();
  
  // Validate limit
  //TUNE: Control the (page size). Default rows per request, and the hard ceiling on any requested limit.
  const limitNum = Math.min(Math.max(parseInt(limit) || 50, 1), 200);

  // As above: the enabled list is $1 so the caller-supplied filters follow it.
  const params: any[] = [enabledConflictKeys()];
  let paramIndex = 2;

  // Build query for events with primary_location data
  let query = `
    SELECT 
      id as event_id,
      source_uid,
      source,
      url as source_url,
      content as original_text,
      published_at,
      severity,
      event_type,
      primary_location
    FROM items
    WHERE primary_location IS NOT NULL
      AND noise = false
      ${dashboardAudience(1)}
  `;
  
  // Date filter
  if (since) {
    query += ` AND published_at >= $${paramIndex++}`;
    params.push(new Date(since));
  }
  
  // Order and limit
  query += ` ORDER BY published_at DESC NULLS LAST LIMIT $${paramIndex++}`;
  params.push(limitNum);
  
  try {
    const result = await pool.query(query, params);
    
    return c.json({
      events: result.rows,
      count: result.rows.length
    });
  } catch (error) {
    console.error("Error fetching pins:", error);
    throw new AppError("internal_error", "Internal server error");
  }
}

/**
 * GET /api/stats
 * Fetch statistics about events
 */
//TUNE: Control the (stats window cap). Largest `since` window in hours the stats route will accept.
const STATS_MAX_WINDOW_HOURS = 24 * 90;

export async function statsRoute(c: Context) {
  const { since } = c.req.query();

  // Unbounded aggregates have to touch every row by definition. Passing
  // ?since=<hours> scopes them to the published_at index instead, which is the
  // difference between a full pass and a few milliseconds once items grows.
  let windowHours: number | null = null;
  if (since) {
    const parsed = Number(since);
    if (Number.isFinite(parsed) && parsed > 0) {
      windowHours = Math.min(parsed, STATS_MAX_WINDOW_HOURS);
    }
  }

  // The enabled list is $1 in every query below, so the optional window
  // parameter is $2. Both are bound, never interpolated.
  const windowClause = windowHours
    ? `AND published_at >= NOW() - ($2 || ' hours')::interval`
    : "";
  const queryParams: any[] = windowHours
    ? [enabledConflictKeys(), String(windowHours)]
    : [enabledConflictKeys()];
  const audience = dashboardAudience(1);

  try {
    const [
      scalarResult,
      typeResult,
      severityResult,
      sourceResult,
      regionResult,
      backendOnly,
    ] = await Promise.all([
      pool.query(
        `SELECT
           COUNT(*) AS total,
           COUNT(*) FILTER (WHERE published_at >= NOW() - INTERVAL '1 hour') AS last_hour
         FROM items
         WHERE noise = false
           ${audience}
           ${windowClause}`,
        queryParams,
      ),
      pool.query(
        `SELECT event_type, COUNT(*) as count 
         FROM items 
         WHERE event_type IS NOT NULL 
           AND noise = false
           ${audience}
           ${windowClause}
         GROUP BY event_type 
         ORDER BY count DESC`,
        queryParams,
      ),
      pool.query(
        `SELECT severity, COUNT(*) as count 
         FROM items 
         WHERE severity IS NOT NULL 
           AND noise = false
           ${audience}
           ${windowClause}
         GROUP BY severity 
         ORDER BY count DESC`,
        queryParams,
      ),
      pool.query(
        `SELECT source, COUNT(*) as count 
         FROM items 
         WHERE source IS NOT NULL 
           AND noise = false
           ${audience}
           ${windowClause}
         GROUP BY source 
         ORDER BY count DESC`,
        queryParams,
      ),
      pool.query(
        `SELECT primary_location->>'region' as region, COUNT(*) as count 
         FROM items 
         WHERE primary_location IS NOT NULL 
           AND noise = false
           ${audience}
           ${windowClause}
         GROUP BY primary_location->>'region' 
         ORDER BY count DESC 
         LIMIT 10`,
        queryParams,
      ),
      // Rule 2's audit half. The aggregates above count only what the
      // dashboard may show, so this reports how much the store holds that the
      // dashboard deliberately does not. It is counts, never content.
      backendOnlyCounts(),
    ]);

    const totalEvents = parseInt(scalarResult.rows[0].total);
    const eventsLastHour = parseInt(scalarResult.rows[0].last_hour);
    const eventsPerMinute = eventsLastHour / 60;

    const byType = typeResult.rows.reduce((acc, row) => {
      acc[row.event_type] = parseInt(row.count);
      return acc;
    }, {} as Record<string, number>);

    const bySeverity = severityResult.rows.reduce((acc, row) => {
      acc[row.severity] = parseInt(row.count);
      return acc;
    }, {} as Record<string, number>);

    const bySource = sourceResult.rows.reduce((acc, row) => {
      acc[row.source] = parseInt(row.count);
      return acc;
    }, {} as Record<string, number>);

    const topRegions = regionResult.rows.reduce((acc, row) => {
      if (row.region) {
        acc[row.region] = parseInt(row.count);
      }
      return acc;
    }, {} as Record<string, number>);

    return c.json({
      total_events: totalEvents,
      events_last_hour: eventsLastHour,
      events_per_minute: eventsPerMinute,
      by_type: byType,
      by_severity: bySeverity,
      by_source: bySource,
      top_regions: topRegions,
      // Held for Hessa in the backend and never served as content. Proof that
      // Rule 2 hides these rows rather than deleting them.
      backend_only: backendOnly,
      ...(windowHours ? { window_hours: windowHours } : {}),
    });
  } catch (error) {
    console.error("Error fetching stats:", error);
    throw new AppError("internal_error", "Internal server error");
  }
}