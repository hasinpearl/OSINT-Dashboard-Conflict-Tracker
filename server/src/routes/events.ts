import { Context } from "hono";
import { pool } from "../db";
import { AppError } from "../errors"; // Assuming we have an AppError class

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
  
  // Build query
  let query = `
    SELECT 
      id as event_id,
      source_uid,
      source,
      url as source_url,
      content as original_text,
      content as summary,
      event_ts as published_at,
      ingested_at,
      event_type,
      severity,
      is_breaking,
      lang,
      has_media,
      NULL as translated_text,
      primary_location,
      enrichment,
      raw
    FROM items
    WHERE noise = false
  `;
  
  const params: any[] = [];
  let paramIndex = 1;
  
  // Date filters
  if (since) {
    query += ` AND event_ts >= $${paramIndex++}`;
    params.push(new Date(since));
  }
  
  if (until) {
    query += ` AND event_ts <= $${paramIndex++}`;
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
    
    query += ` AND event_ts < $${paramIndex++}`;
    params.push(cursorDate);
  }
  
  // Order and limit
  query += ` ORDER BY event_ts DESC, id DESC LIMIT $${paramIndex++}`;
  params.push(limitNum);
  
  try {
    const result = await pool.query(query, params);
    
    // Prepare next cursor - use the timestamp of the last item
    let nextCursor = null;
    if (result.rows.length > 0) {
      const lastRow = result.rows[result.rows.length - 1];
      nextCursor = lastRow.published_at.toISOString();
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
  
  // Build query for events with primary_location data
  let query = `
    SELECT 
      id as event_id,
      source_uid,
      source,
      url as source_url,
      content as original_text,
      event_ts as published_at,
      primary_location
    FROM items
    WHERE primary_location IS NOT NULL
      AND noise = false
  `;
  
  const params: any[] = [];
  let paramIndex = 1;
  
  // Date filter
  if (since) {
    query += ` AND event_ts >= $${paramIndex++}`;
    params.push(new Date(since));
  }
  
  // Order and limit
  query += ` ORDER BY event_ts DESC LIMIT $${paramIndex++}`;
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
export async function statsRoute(c: Context) {
  try {
    // Total events
    const totalResult = await pool.query("SELECT COUNT(*) as total FROM items WHERE noise = false");
    const totalEvents = parseInt(totalResult.rows[0].total);
    
    // Events last hour
    const hourResult = await pool.query(`
      SELECT COUNT(*) as count FROM items 
      WHERE event_ts >= NOW() - INTERVAL '1 hour'
        AND noise = false
    `);
    const eventsLastHour = parseInt(hourResult.rows[0].count);
    
    // Events per minute (last hour)
    const minuteResult = await pool.query(`
      SELECT COUNT(*) / 60.0 as avg_per_minute FROM items 
      WHERE event_ts >= NOW() - INTERVAL '1 hour'
        AND noise = false
    `);
    const eventsPerMinute = parseFloat(minuteResult.rows[0].avg_per_minute) || 0;
    
    // Events by type
    const typeResult = await pool.query(`
      SELECT event_type, COUNT(*) as count 
      FROM items 
      WHERE event_type IS NOT NULL 
        AND noise = false
      GROUP BY event_type 
      ORDER BY count DESC
    `);
    const byType = typeResult.rows.reduce((acc, row) => {
      acc[row.event_type] = parseInt(row.count);
      return acc;
    }, {} as Record<string, number>);
    
    // Events by severity
    const severityResult = await pool.query(`
      SELECT severity, COUNT(*) as count 
      FROM items 
      WHERE severity IS NOT NULL 
        AND noise = false
      GROUP BY severity 
      ORDER BY count DESC
    `);
    const bySeverity = severityResult.rows.reduce((acc, row) => {
      acc[row.severity] = parseInt(row.count);
      return acc;
    }, {} as Record<string, number>);
    
    // Events by source
    const sourceResult = await pool.query(`
      SELECT source, COUNT(*) as count 
      FROM items 
      WHERE source IS NOT NULL 
        AND noise = false
      GROUP BY source 
      ORDER BY count DESC
    `);
    const bySource = sourceResult.rows.reduce((acc, row) => {
      acc[row.source] = parseInt(row.count);
      return acc;
    }, {} as Record<string, number>);
    
    // Top regions (primary_location)
    const regionResult = await pool.query(`
      SELECT primary_location->>'region' as region, COUNT(*) as count 
      FROM items 
      WHERE primary_location IS NOT NULL 
        AND noise = false
      GROUP BY primary_location->>'region' 
      ORDER BY count DESC 
      LIMIT 10
    `);
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
      top_regions: topRegions
    });
  } catch (error) {
    console.error("Error fetching stats:", error);
    throw new AppError("internal_error", "Internal server error");
  }
}