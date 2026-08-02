import type { Context } from "hono";
import { deleteCacheKeys, getCacheRows } from "../cache";
import { pool } from "../db";

// "analyst-curated" replaced "perplexity-analyst" — the old base is
// intentionally absent so its stale cache rows get cleaned as orphans.
const KNOWN_FUNCTIONS = [
  "firecrawl-news",
  "analyst-curated",
  "perplexity-osint",
  "telegram-feed",
  "ai-summarize",
  "bias-tracker",
];
const CONFLICT_SUFFIXES = ["all", "iran-us", "ukraine-russia", "china-taiwan"];

function isKnownFunctionName(name: string): boolean {
  if (KNOWN_FUNCTIONS.includes(name)) return true;
  const idx = name.indexOf(":");
  if (idx === -1) return false;
  const base = name.slice(0, idx);
  const suffix = name.slice(idx + 1);
  return KNOWN_FUNCTIONS.includes(base) && CONFLICT_SUFFIXES.includes(suffix);
}

function extractItems(payload: any): { items: any[]; container: "items" | "data" | "array" | "none" } {
  if (!payload) return { items: [], container: "none" };
  if (Array.isArray(payload)) return { items: payload, container: "array" };
  if (Array.isArray(payload?.items)) return { items: payload.items, container: "items" };
  if (Array.isArray(payload?.data)) return { items: payload.data, container: "data" };
  return { items: [], container: "none" };
}

function rebuildPayload(original: any, cleanedItems: any[], container: string): any {
  if (container === "array") return cleanedItems;
  if (container === "items") return { ...original, items: cleanedItems };
  if (container === "data") return { ...original, data: cleanedItems };
  return original;
}

function cleanItems(payload: any): { before: number; after: number; cleanedPayload: any } | null {
  const { items, container } = extractItems(payload);
  if (container === "none" || items.length === 0) return null;
  const cutoff = Date.now() - 48 * 60 * 60 * 1000;
  const seen = new Set<string>();
  const cleaned = items.filter((item) => {
    const timestamp = Date.parse(String(item?.timestamp ?? item?.published_at ?? ""));
    if (Number.isFinite(timestamp) && timestamp < cutoff) return false;
    const identity = String(item?.url ?? item?.headline ?? item?.title ?? item?.text ?? "")
      .trim().toLowerCase().replace(/\s+/g, " ");
    if (identity && seen.has(identity)) return false;
    if (identity) seen.add(identity);
    return true;
  });
  return { before: items.length, after: cleaned.length, cleanedPayload: rebuildPayload(payload, cleaned, container) };
}

export async function auditRefreshRoute(c: Context) {
  const auditableBases = ["firecrawl-news", "analyst-curated", "perplexity-osint", "telegram-feed", "ai-summarize"];
  const candidateKeys = auditableBases.flatMap((b) => [b, ...CONFLICT_SUFFIXES.map((s) => `${b}:${s}`)]);

  const rows = await getCacheRows(candidateKeys);

  const audited: string[] = [];
  let itemsBefore = 0;
  let itemsAfter = 0;

  for (const row of rows) {
    const result = cleanItems(row.response_data);
    if (!result) continue;

    itemsBefore += result.before;
    itemsAfter += result.after;
    audited.push(row.function_name);

    const originalCachedAt = row.response_data?.cached_at;
    const newPayload =
      result.cleanedPayload && typeof result.cleanedPayload === "object" && !Array.isArray(result.cleanedPayload)
        ? { ...result.cleanedPayload, cached_at: originalCachedAt ?? new Date().toISOString() }
        : { data: result.cleanedPayload, cached_at: originalCachedAt ?? new Date().toISOString() };

    try {
      await pool.query(
        `INSERT INTO api_cache (function_name, response_data, fetched_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (function_name)
         DO UPDATE SET response_data = EXCLUDED.response_data, fetched_at = EXCLUDED.fetched_at`,
        [row.function_name, JSON.stringify(newPayload), row.fetched_at],
      );
    } catch (e) {
      console.error(`Audit write failed for ${row.function_name}:`, e);
    }
  }

  const allRows = await getCacheRows();

  let deletedStale = 0;
  let deletedOrphaned = 0;
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;

  const toDelete: string[] = [];
  for (const r of allRows) {
    const cachedAt = r.response_data?.cached_at;
    const ts = cachedAt ? new Date(cachedAt).getTime() : NaN;
    const stale = !cachedAt || isNaN(ts) || ts < cutoff;
    const orphaned = !isKnownFunctionName(r.function_name);
    if (stale || orphaned) {
      toDelete.push(r.function_name);
      if (orphaned) deletedOrphaned++;
      else if (stale) deletedStale++;
    }
  }
  if (toDelete.length > 0) {
    await deleteCacheKeys(toDelete);
  }

  return c.json({
    audited,
    items_before: itemsBefore,
    items_after: itemsAfter,
    removed: itemsBefore - itemsAfter,
    cache_cleaned: {
      deleted_stale: deletedStale,
      deleted_orphaned: deletedOrphaned,
    },
  });
}
