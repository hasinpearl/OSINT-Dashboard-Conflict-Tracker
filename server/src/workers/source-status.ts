import { pool } from "../db";
import { SourceStatus } from "../types";

export async function sourceStatusUpdate(status: SourceStatus): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO source_status (
        id, 
        source, 
        label, 
        ok, 
        detail, 
        failures, 
        last_ok, 
        updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (id) DO UPDATE SET
        source = EXCLUDED.source,
        label = EXCLUDED.label,
        ok = EXCLUDED.ok,
        detail = EXCLUDED.detail,
        failures = EXCLUDED.failures,
        last_ok = EXCLUDED.last_ok,
        updated_at = EXCLUDED.updated_at`,
      [
        status.id,
        status.source,
        status.label || null,
        status.ok,
        status.detail || null,
        status.failures,
        status.last_ok || null,
        status.updated_at
      ]
    );
  } catch (e) {
    console.error("Error updating source status:", e);
  }
}