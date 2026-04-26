import { getCached, setCache } from "../_shared/cache.ts";
import { logCost, logCacheHit, PRICES } from "../_shared/costs.ts";
import { corsHeadersFor, errorResponse } from "../_shared/cors.ts";
import { getConflictConfig, readConflictFromRequest } from "../_shared/conflicts.ts";

const CACHE_KEY_BASE = "perplexity-analyst";
const PANEL = "analyst";

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

    logCost({ panel: PANEL, provider: "perplexity", model: "sonar-pro", costUsd: PRICES.perplexity_sonar_pro });
    const res = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${perplexityKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "sonar-pro",
        messages: [
          {
            role: "system",
            content: `You are a geopolitical research assistant focused on the ${config.label} conflict in ${config.region}. Find real, recent expert commentary. Return ONLY valid JSON with no markdown.`,
          },
          {
            role: "user",
            content: `Search for the most recent expert analysis and commentary about the ${config.label} conflict (key topics: ${config.searchTerms}) from the past week.

Look for quotes and analysis from major think tanks (Brookings, IISS, Carnegie, CFR, RAND, Chatham House, Crisis Group, Atlantic Council), regional analysts, and outlets like Foreign Affairs, Foreign Policy, The Economist, Al Jazeera, and other reputable regional publications relevant to ${config.region}.

Return JSON: {"comments":[{"analyst":"full name","affiliation":"organization","comment":"their key quote or analysis, 2-3 sentences","topic":"brief topic","timestamp":"ISO 8601 UTC timestamp e.g. 2026-04-28T14:30:00Z","url":"source url if available"}]}. The timestamp MUST be a valid ISO 8601 UTC timestamp e.g. 2026-04-28T14:30:00Z. Do not use relative timestamps. Return 8-15 entries. Mix Western and regional analysts relevant to ${config.region}.`,
          },
        ],
        search_recency_filter: "week",
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error("Perplexity error status:", res.status, "body:", errText);
      return new Response(JSON.stringify({ comments: [] }), {
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || "{}";

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      const match = content.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (match) {
        try {
          parsed = JSON.parse(match[1]);
        } catch {
          parsed = { comments: [] };
        }
      } else {
        const jsonMatch = content.match(/\{[\s\S]*"comments"[\s\S]*\}/);
        if (jsonMatch) {
          try {
            parsed = JSON.parse(jsonMatch[0]);
          } catch {
            parsed = { comments: [] };
          }
        } else {
          parsed = { comments: [] };
        }
      }
    }

    await setCache(CACHE_KEY, parsed);

    return new Response(JSON.stringify(parsed), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error in perplexity-analyst:", error);
    return errorResponse(cors, 500, "Internal error", error);
  }
});
