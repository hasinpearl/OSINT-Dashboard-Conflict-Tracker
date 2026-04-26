import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeadersFor, errorResponse } from "../_shared/cors.ts";
import { logCost, PRICES } from "../_shared/costs.ts";

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

async function auditOne(
  perplexityKey: string,
  functionName: string,
  payload: any,
): Promise<{ before: number; after: number; cleanedPayload: any } | null> {
  const { items, container } = extractItems(payload);
  if (container === "none" || items.length === 0) return null;

  const before = items.length;

  const userPrompt = `Review this list of news items and clean it:
- Remove DUPLICATE items (same event described differently — keep the most detailed version)
- Remove items OLDER than 48 hours based on their timestamp (current time: ${new Date().toISOString()})
- Remove items SUPERSEDED by newer developments (e.g. ceasefire announced then collapsed → keep the collapse)
- Keep the same JSON object shape for each item
- Return ONLY a valid JSON array of the cleaned items, no markdown, no commentary

Items:
${JSON.stringify(items)}`;

  logCost({ panel: "audit", provider: "perplexity", model: "sonar", costUsd: PRICES.perplexity_sonar });

  const res = await fetch("https://api.perplexity.ai/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${perplexityKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "sonar",
      messages: [
        { role: "system", content: "You are a data quality auditor. Return ONLY valid JSON arrays, no markdown." },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  if (!res.ok) {
    console.error(`Audit Perplexity error for ${functionName}:`, await res.text());
    return null;
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || "[]";

  let cleaned: any[] = [];
  try {
    cleaned = JSON.parse(content);
  } catch {
    const match = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) {
      try { cleaned = JSON.parse(match[1]); } catch { cleaned = []; }
    } else {
      const arrMatch = content.match(/\[[\s\S]*\]/);
      if (arrMatch) {
        try { cleaned = JSON.parse(arrMatch[0]); } catch { cleaned = []; }
      }
    }
  }

  if (!Array.isArray(cleaned)) return null;

  const after = cleaned.length;
  // Safety: don't accept absurd shrinkage to 0 unless original was already small
  if (after === 0 && before > 2) return null;

  return {
    before,
    after,
    cleanedPayload: rebuildPayload(payload, cleaned, container),
  };
}

Deno.serve(async (req) => {
  const cors = corsHeadersFor(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const sb = admin();
    const perplexityKey = Deno.env.get("PERPLEXITY_API_KEY");
    if (!perplexityKey) return errorResponse(cors, 500, "Service unavailable");

    // Build the list of cache keys to consider
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
      const result = await auditOne(perplexityKey, row.function_name, row.response_data);
      if (!result) continue;

      itemsBefore += result.before;
      itemsAfter += result.after;
      audited.push(row.function_name);

      // Preserve cached_at from original payload so TTL is not reset
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

    // ===== Cache cleanup =====
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
