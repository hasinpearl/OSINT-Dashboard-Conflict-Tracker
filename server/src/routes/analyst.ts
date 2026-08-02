import type { Context } from "hono";
import { FORCE_MIN_AGE_MS, getCached, setCache } from "../cache";
import { logCost, logCacheHit, PRICES } from "../costs";
import { getConflictConfig, readConflict, type Expert } from "../conflicts";
import { envKey } from "../env";
import { extractJson, readForceRefresh, readJsonBody } from "../request";

// New cache key base on purpose: old "perplexity-analyst" entries hold
// random commentators and must age out as orphans, not poison this panel.
const CACHE_KEY_BASE = "analyst-curated";
const PANEL = "analyst";

interface AnalystComment {
  analyst: string;
  affiliation: string;
  comment: string;
  topic: string;
  timestamp: string;
  url?: string;
}

function normName(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function rosterSection(experts: Expert[], kind: Expert["kind"], heading: string): string {
  const rows = experts
    .filter((e) => e.kind === kind)
    .map((e) => `- ${e.name} (${e.title})`)
    .join("\n");
  return `${heading}:\n${rows}`;
}

// Never trust the model to obey the roster — filter server-side. Two-way
// includes handles "Secretary of State Marco Rubio" vs "Marco Rubio" vs "Rubio".
function filterToRoster(comments: AnalystComment[], experts: Expert[]): AnalystComment[] {
  const allowed = experts.map((e) => ({ ...e, norm: normName(e.name) }));
  const kept: AnalystComment[] = [];
  for (const cmt of comments) {
    const n = normName(String(cmt?.analyst ?? ""));
    if (!n) continue;
    const match = allowed.find((a) => n.includes(a.norm) || a.norm.includes(n));
    if (!match) {
      console.log(`analyst-curated: dropping off-roster commentator "${cmt.analyst}"`);
      continue;
    }
    kept.push({ ...cmt, analyst: match.name, affiliation: match.title });
  }
  return kept;
}

export async function analystRoute(c: Context) {
  const body = await readJsonBody(c);
  const forceRefresh = readForceRefresh(c, body);
  const config = getConflictConfig(readConflict(body));
  const CACHE_KEY = `${CACHE_KEY_BASE}:${config.key}`;

  const cached = await getCached(CACHE_KEY, forceRefresh ? FORCE_MIN_AGE_MS : undefined);
  if (cached) {
    logCacheHit(PANEL, "perplexity");
    return c.json(cached);
  }

  const perplexityKey = envKey("PERPLEXITY_API_KEY");
  if (!perplexityKey) {
    return c.json({ error: "Service unavailable" }, 500);
  }

  const roster = `${rosterSection(config.experts, "official", "OFFICIALS")}\n\n${rosterSection(config.experts, "analyst", "EXPERT ANALYSTS")}`;

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
          content: `You are a geopolitical research assistant focused on the ${config.label} conflict in ${config.region}. You report ONLY real, recent public statements from a fixed list of approved officials and analysts. Return ONLY valid JSON with no markdown.`,
        },
        {
          role: "user",
          content: `Find the most recent public statements and analysis about the ${config.label} conflict (key topics: ${config.searchTerms}) from the people below.

${roster}

STRICT RULES:
- ONLY include people from the list above. Do not include anyone else, no matter how relevant their commentary seems.
- Only include a person if you find a real, recent statement or analysis from them - prefer the past 2 weeks, at most 1 month old.
- NEVER invent, embellish, or fabricate quotes. If you cannot find a real statement from someone, leave them out.
- Use the person's affiliation EXACTLY as given in the list above.
- Return each person's name EXACTLY as it is written in the list above.

Return JSON: {"comments":[{"analyst":"name exactly as listed","affiliation":"affiliation exactly as listed","comment":"their key quote or analysis, 2-3 sentences","topic":"brief topic","timestamp":"ISO 8601 UTC timestamp e.g. 2026-04-28T14:30:00Z","url":"source url if available"}]}. The timestamp MUST be a valid ISO 8601 UTC timestamp. Do not use relative timestamps. Include as many people from the list as you can find real recent statements for.`,
        },
      ],
      search_recency_filter: "month",
    }),
  });

  if (!res.ok) {
    console.error("Perplexity error status:", res.status, "body:", await res.text().catch(() => ""));
    return c.json({ comments: [] });
  }

  const data: any = await res.json();
  const content = data.choices?.[0]?.message?.content || "{}";
  const parsed = extractJson(content) ?? { comments: [] };

  const filtered = {
    comments: filterToRoster(
      Array.isArray(parsed?.comments) ? parsed.comments : [],
      config.experts,
    ),
  };

  await setCache(CACHE_KEY, filtered);

  return c.json(filtered);
}
