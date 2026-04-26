import { getCached, setCache } from "../_shared/cache.ts";
import { logCost, logCacheHit, PRICES } from "../_shared/costs.ts";
import { corsHeadersFor, errorResponse } from "../_shared/cors.ts";

const CACHE_KEY = "perplexity-osint";
const PANEL = "osint";

Deno.serve(async (req) => {
  const cors = corsHeadersFor(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  try {
    const cached = await getCached(CACHE_KEY);
    if (cached) {
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
            content: "You are an OSINT analyst. Return ONLY valid JSON with no markdown.",
          },
          {
            role: "user",
            content: `Search for the latest OSINT intelligence on Iran and Middle East military activities from sources like Bellingcat, OSINT Defender, Janes Defence. Return JSON: {"items":[{"title":"...","summary":"2 sentences","source":"source name","confidence":"verified|unverified|developing","timestamp":"ISO 8601 UTC timestamp e.g. 2026-04-28T14:30:00Z","url":"https://..."}]}. The timestamp MUST be a valid ISO 8601 UTC timestamp e.g. 2026-04-28T14:30:00Z. Do not use relative timestamps. Return the top 6 most significant items from the last 48 hours. Every item MUST include a valid, clickable source URL from the original report. If you cannot provide a verified source URL for an item, do not include that item.`,
          },
        ],
        search_domain_filter: ["bellingcat.com", "janes.com", "twitter.com"],
        search_recency_filter: "day",
      }),
    });

    if (!res.ok) {
      console.error("Perplexity error:", await res.text());
      return new Response(JSON.stringify({ items: [] }), {
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || "{}";

    let parsed: { items?: any[] };
    try {
      parsed = JSON.parse(content);
    } catch {
      const match = content.match(/```(?:json)?\s*([\s\S]*?)```/);
      parsed = match ? JSON.parse(match[1]) : { items: [] };
    }

    // Filter out items without a valid URL
    const filtered = {
      items: (parsed.items || []).filter((it: any) => {
        const u = typeof it?.url === "string" ? it.url.trim() : "";
        return u.length > 0 && /^https?:\/\//i.test(u);
      }),
    };

    if (filtered.items.length > 0) {
      await setCache(CACHE_KEY, filtered);
    }

    return new Response(JSON.stringify(filtered), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error in perplexity-osint:", error);
    return errorResponse(cors, 500, "Internal error", error);
  }
});
