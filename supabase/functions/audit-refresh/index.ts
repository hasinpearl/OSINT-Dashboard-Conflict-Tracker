import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeadersFor, errorResponse } from "../_shared/cors.ts";

const KNOWN_FUNCTIONS = [
  "firecrawl-news",
  "perplexity-analyst",
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

function admin() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

async function requireAdmin(req: Request): Promise<boolean> {
  const token = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return false;
  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: `Bearer ${token}` } } },
  );
  const { data: userData } = await sb.auth.getUser(token);
  if (!userData.user) return false;
  const { data: role } = await sb
    .from("user_roles")
    .select("role")
    .eq("user_id", userData.user.id)
    .eq("role", "admin")
    .maybeSingle();
  return !!role;
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

Deno.serve(async (req) => {
  const cors = corsHeadersFor(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    if (!(await requireAdmin(req))) return errorResponse(cors, 401, "Admin authentication required");
    const sb = admin();
    const auditableBases = ["firecrawl-news", "perplexity-analyst", "perplexity-osint", "telegram-feed", "ai-summarize"];
    const candidateKeys = auditableBases.flatMap((b) => [b, ...CONFLICT_SUFFIXES.map((s) => `${b}:${s}`)]);

    const { data: rows, error: readErr } = await sb
      .from("api_cache")
      .select("function_name, response_data, fetched_at")
      .in("function_name", candidateKeys);

    if (readErr) return errorResponse(cors, 500, "Cache read failed", readErr);

    const audited: string[] = [];
    let itemsBefore = 0;
    let itemsAfter = 0;

    for (const row of rows ?? []) {
      const result = cleanItems(row.response_data);
      if (!result) continue;

      itemsBefore += result.before;
      itemsAfter += result.after;
      audited.push(row.function_name);

      const originalCachedAt = (row.response_data as any)?.cached_at;
      const newPayload =
        result.cleanedPayload && typeof result.cleanedPayload === "object" && !Array.isArray(result.cleanedPayload)
          ? { ...result.cleanedPayload, cached_at: originalCachedAt ?? new Date().toISOString() }
          : { data: result.cleanedPayload, cached_at: originalCachedAt ?? new Date().toISOString() };

      const { error: writeErr } = await sb
        .from("api_cache")
        .upsert(
          { function_name: row.function_name, response_data: newPayload, fetched_at: row.fetched_at },
          { onConflict: "function_name" },
        );
      if (writeErr) console.error(`Audit write failed for ${row.function_name}:`, writeErr);
    }

    const { data: allRows, error: allErr } = await sb
      .from("api_cache")
      .select("function_name, response_data");

    let deletedStale = 0;
    let deletedOrphaned = 0;
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;

    if (!allErr && allRows) {
      const toDelete: string[] = [];
      for (const r of allRows) {
        const cachedAt = (r.response_data as any)?.cached_at;
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
        const { error: delErr } = await sb
          .from("api_cache")
          .delete()
          .in("function_name", toDelete);
        if (delErr) console.error("Cache cleanup delete failed:", delErr);
      }
    }

    const summary = {
      audited,
      items_before: itemsBefore,
      items_after: itemsAfter,
      removed: itemsBefore - itemsAfter,
      cache_cleaned: {
        deleted_stale: deletedStale,
        deleted_orphaned: deletedOrphaned,
      },
    };

    return new Response(JSON.stringify(summary), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error in audit-refresh:", error);
    return errorResponse(cors, 500, "Internal error", error);
  }
});
