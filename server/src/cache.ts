import { pool } from "./db";

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 60 minutes

// Hard refreshes shrink the acceptable cache age instead of bypassing the cache
// entirely, so F5-spam still cannot multiply reads. This has to stay BELOW every
// panel's own TTL or force_refresh is a no-op: at 5 minutes it was equal to the
// news TTL and larger than the telegram one, so a hard refresh could not clear a
// bad entry. Panels read Postgres rather than a paid upstream, so a floor of
// seconds is affordable.
//TUNE: Control the (forced refresh floor). Milliseconds a cache entry stays acceptable even to a force_refresh request. Keep it under the smallest panel TTL.
export const FORCE_MIN_AGE_MS = 30 * 1000;

// A panel response whose list is empty is a claim that the store holds nothing
// for this filter. Caching that claim turns a momentary gap into a lie with a
// TTL: an API answering before the first collection finished pinned an empty
// list, and every later request was served that entry instead of the rows which
// had since landed. So an empty list is never written, and an empty entry
// already in the table reads as a miss, which is what lets a database that was
// poisoned before this fix recover on its very next request.
function isEmptyList(payload: unknown, listField: string): boolean {
  if (!payload || typeof payload !== "object") return false;
  const list = (payload as Record<string, unknown>)[listField];
  return Array.isArray(list) && list.length === 0;
}

export async function getCached(
  functionName: string,
  maxAgeMs: number = DEFAULT_TTL_MS,
  /** Response field holding the panel's list, so an empty one counts as a miss. */
  listField?: string,
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
    if (listField && isEmptyList(payload, listField)) {
      console.log(
        `Cache EMPTY for ${functionName} (${listField} has no entries), re-reading the database`,
      );
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

export async function setCache(
  functionName: string,
  responseData: any,
  /** Response field holding the panel's list. An empty one is not written. */
  listField?: string,
): Promise<void> {
  if (listField && isEmptyList(responseData, listField)) {
    console.log(
      `Cache SKIP for ${functionName} (${listField} has no entries, not caching an empty answer)`,
    );
    return;
  }
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
