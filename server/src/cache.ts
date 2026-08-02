import { pool } from "./db";

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 60 minutes

// Hard refreshes shrink the acceptable cache age to 5 minutes instead of
// bypassing the cache entirely, so F5-spam can't multiply paid upstream calls.
export const FORCE_MIN_AGE_MS = 5 * 60 * 1000;

export async function getCached(
  functionName: string,
  maxAgeMs: number = DEFAULT_TTL_MS,
): Promise<any | null> {
  try {
    const { rows } = await pool.query(
      "SELECT response_data FROM api_cache WHERE function_name = $1",
      [functionName],
    );
    const payload = rows[0]?.response_data;
    if (!payload) return null;

    const cachedAt = payload?.cached_at;
    if (!cachedAt) {
      console.log(`Cache missing cached_at for ${functionName}, treating as expired`);
      return null;
    }
    const age = Date.now() - new Date(cachedAt).getTime();
    if (isNaN(age)) {
      console.log(`Cache INVALID timestamp for ${functionName}, treating as expired`);
      return null;
    }
    if (age >= maxAgeMs) {
      console.log(`Cache EXPIRED for ${functionName} (age: ${Math.round(age / 1000)}s)`);
      return null;
    }
    console.log(`Cache HIT for ${functionName} (age: ${Math.round(age / 1000)}s)`);
    const { cached_at: _omit, ...rest } = payload;
    return rest;
  } catch (e) {
    console.error(`Cache read failed for ${functionName}:`, e instanceof Error ? e.message : e);
    return null;
  }
}

// Ignores age entirely — fallback for when the upstream provider fails.
export async function getStaleCached(functionName: string): Promise<any | null> {
  try {
    const { rows } = await pool.query(
      "SELECT response_data FROM api_cache WHERE function_name = $1",
      [functionName],
    );
    const payload = rows[0]?.response_data;
    if (!payload) return null;
    const { cached_at: _omit, ...rest } = payload;
    return rest;
  } catch {
    return null;
  }
}

export async function setCache(functionName: string, responseData: any): Promise<void> {
  const nowIso = new Date().toISOString();
  const payload =
    responseData && typeof responseData === "object" && !Array.isArray(responseData)
      ? { ...responseData, cached_at: nowIso }
      : { data: responseData, cached_at: nowIso };
  try {
    await pool.query(
      `INSERT INTO api_cache (function_name, response_data, fetched_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (function_name)
       DO UPDATE SET response_data = EXCLUDED.response_data, fetched_at = EXCLUDED.fetched_at`,
      [functionName, JSON.stringify(payload), nowIso],
    );
    console.log(`Cache WRITE for ${functionName}`);
  } catch (e) {
    console.error(`Cache WRITE failed for ${functionName}:`, e instanceof Error ? e.message : e);
  }
}

export async function deleteCacheKeys(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  try {
    await pool.query("DELETE FROM api_cache WHERE function_name = ANY($1)", [keys]);
  } catch (e) {
    console.error("Cache delete failed:", e instanceof Error ? e.message : e);
  }
}

export interface CacheRow {
  function_name: string;
  response_data: any;
  fetched_at: string;
}

// keys === undefined returns every row (used by the audit job's cleanup pass).
export async function getCacheRows(keys?: string[]): Promise<CacheRow[]> {
  try {
    const { rows } = keys
      ? await pool.query(
          "SELECT function_name, response_data, fetched_at FROM api_cache WHERE function_name = ANY($1)",
          [keys],
        )
      : await pool.query("SELECT function_name, response_data, fetched_at FROM api_cache");
    return rows;
  } catch (e) {
    console.error("Cache rows read failed:", e instanceof Error ? e.message : e);
    return [];
  }
}
