import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCached, setCache } from "../_shared/cache.ts";
import { logCost, logCacheHit, PRICES } from "../_shared/costs.ts";
import { corsHeadersFor, errorResponse } from "../_shared/cors.ts";
import { getConflictConfig, readConflictFromRequest } from "../_shared/conflicts.ts";

const CACHE_KEY_BASE = "perplexity-osint";
const PANEL = "osint";

/** Read stale cached data ignoring TTL — used as fallback when fresh fetch returns nothing. */
async function getStaleCached(cacheKey: string): Promise<any | null> {
  try {
    const sb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data, error } = await sb
      .from("api_cache")
      .select("response_data")
      .eq("function_name", cacheKey)
      .single();
    if (error || !data?.response_data) return null;
    const { cached_at, ...rest } = data.response_data;
    return rest;
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  const cors = corsHeadersFor(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  try {
    const conflict = await readConflictFromRequest(req);
    const config = getConflictConfig(conflict);
    const CACHE_KEY = `${CACHE_KEY_BASE}:${config.key}`;

    const cached = await getCached(CACHE_KEY);
    const cachedItems = Array.isArray(cached?.items) ? cached.items : [];
    const cachedHasItems = cachedItems.length > 0;
    if (cachedHasItems) {
      logCacheHit(PANEL, "perplexity");
      return new Response(JSON.stringify(cached), {
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const perplexityKey = Deno.env.get("PERPLEXITY_API_KEY");
    if (!perplexityKey) {
      return errorResponse(cors, 500, "Service unavailable");
    }

    logCost({ panel: PANEL, provider: "perplexity", model: "sonar", costUsd: PRICES.perplexity_sonar });
    const res = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${perplexityKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "sonar",
        messages: [
          {
            role: "system",
            content: `You are an OSINT analyst covering the ${config.label} conflict in ${config.region}. Return ONLY valid JSON with no markdown.`,
          },
          {
            role: "user",
            content: `Find the top 6 verified OSINT intelligence items about ${config.label} from open sources such as Bellingcat, OSINT Defender, Janes Defence, and X/Twitter analysts. Include the most recent items available. Each item MUST have a valid source URL. Do NOT return a message saying no data is available — always return your best findings even if they are older. Focus on military and security activities in ${config.region} relevant to the ${config.label} conflict (key topics: ${config.searchTerms}). Return ONLY JSON: {"items":[{"title":"...","summary":"2 sentences","source":"source name","confidence":"verified|unverified|developing","timestamp":"ISO 8601 UTC timestamp e.g. 2026-04-28T14:30:00Z","url":"https://..."}]}. The timestamp MUST be a valid ISO 8601 UTC timestamp e.g. 2026-04-28T14:30:00Z. Do not use relative timestamps. Every item MUST include a valid, clickable source URL from the original report. If you cannot provide a verified source URL for an item, do not include that item.`,
          },
        ],
        search_domain_filter: ["bellingcat.com", "janes.com", "twitter.com"],
      }),
    });

    if (!res.ok) {
      console.error("Perplexity error:", await res.text());
      // Return cached data (even stale) if available, otherwise empty
      const fallback = cached ?? await getStaleCached(CACHE_KEY);
      return new Response(JSON.stringify(fallback ?? { items: [] }), {
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || "{}";

    let parsed: { items?: any[] } = { items: [] };
    try {
      parsed = JSON.parse(content);
    } catch {
      const match = content.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (match) {
        try {
          parsed = JSON.parse(match[1]);
        } catch {
          parsed = { items: [] };
        }
      }
    }

    // Filter out items without a valid URL
    const filtered = {
      items: (parsed.items || []).filter((it: any) => {
        const u = typeof it?.url === "string" ? it.url.trim() : "";
        return u.length > 0 && /^https?:\/\//i.test(u);
      }),
    };

    // Only overwrite cache when we have actual items; otherwise keep old cached data
    if (filtered.items.length > 0) {
      await setCache(CACHE_KEY, filtered);
      return new Response(JSON.stringify(filtered), {
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // No valid items — return stale cached data (ignoring TTL) if it exists
    const fallbackCached = cachedHasItems ? cached : await getStaleCached(CACHE_KEY);
    const response = fallbackCached ?? filtered;
    console.log(`perplexity-osint: no new items, ${fallbackCached ? "using stale cache" : "returning empty"}`);
    return new Response(JSON.stringify(response), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error in perplexity-osint:", error);
    return errorResponse(cors, 500, "Internal error", error);
  }
});
