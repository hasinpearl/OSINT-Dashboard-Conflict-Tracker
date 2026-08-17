/**
 * PROPOSED — awaiting Hessa's review before any commit.
 *
 * Agent roles over OpenRouter — the single AI gateway for the whole system.
 * Structurally mirrors private-demo/server/src/agents.ts (envKey() instead of
 * an env object, no ".js" import suffix — this repo uses bundler resolution),
 * but the model tier is intentionally DOWNGRADED from private-demo's
 * Opus/DeepSeek stack:
 *
 *   This is a PUBLIC, unauthenticated demo dashboard used to show possible
 *   clients the product — not the paid client deliverable. Hessa's call:
 *   keep it on Perplexity's own models (same models it already runs today),
 *   just routed through the OpenRouter gateway instead of a separate
 *   PERPLEXITY_API_KEY. That gets the "one gateway, one key, for both
 *   dashboards" unification with zero model-quality change and zero cost
 *   increase — this repo never needs Opus-class reasoning.
 *
 * One credential (AI_GATEWAY_KEY) drives two tiers:
 *   search — `perplexity/sonar-pro` via OpenRouter. Sonar models search the
 *            live web themselves, so — unlike the DeepSeek/Opus tiers in
 *            private-demo — this tier does NOT attach OpenRouter's `web`
 *            plugin; that would be a redundant second search on top of
 *            Perplexity's own. Replaces the old direct `sonar-pro` calls in
 *            analyst.ts / biasTracker.ts / osint.ts.
 *   light  — `perplexity/sonar`. Bulk structuring of text this repo already
 *            scraped via Firecrawl (hotTopics.ts / news.ts / telegram.ts).
 *            Replaces the old direct `sonar` calls. Cheapest tier here.
 *
 * There is no "heavy" tier in this repo — nothing in the public dashboard
 * needs it. If a future panel does, add `OPENROUTER_HEAVY_MODEL` then.
 *
 * Every model is overridable by env var, so swapping tiers never needs a code
 * change. Model IDs must be verified against OpenRouter's live catalogue — a
 * stale id fails the call outright with a 400.
 */
import { envKey } from "./env";
import { logCost, PRICES } from "./costs";

// Pinned to exact ids from OpenRouter's /api/v1/models catalogue (verified
// 2026-08-17: perplexity/sonar $1/$1 per 1M, perplexity/sonar-pro $3/$15 per
// 1M — same models, same prices as calling Perplexity directly, just billed
// through the OpenRouter key). Re-verify before deploy in case pricing/ids
// have moved.
const MID_MODEL = envKey("OPENROUTER_MID_MODEL") || "perplexity/sonar-pro";
const LIGHT_MODEL = envKey("OPENROUTER_LIGHT_MODEL") || "perplexity/sonar";

/** Resolved ids, logged at startup so a bad override is visible immediately. */
export const RESOLVED_MODELS = {
  mid: MID_MODEL,
  light: LIGHT_MODEL,
} as const;

export type AgentRole = "light" | "search";

export interface AgentMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

function gatewayUrl(): string {
  return envKey("AI_GATEWAY_URL") || "https://openrouter.ai/api/v1/chat/completions";
}

function modelFor(role: AgentRole): string {
  if (role === "search") return MID_MODEL;
  return LIGHT_MODEL;
}

function priceFor(role: AgentRole): number {
  // Sonar models search live on their own — no separate web-plugin surcharge
  // (unlike private-demo's DeepSeek "search" tier, which bolts on
  // OpenRouter's `web` plugin and pays openrouter_web_search on top).
  if (role === "search") return PRICES.openrouter_mid;
  return PRICES.openrouter_light;
}

/**
 * One gateway call. Throws on a missing key or non-OK response so callers can
 * fall back to stored data rather than surfacing an error to the dashboard.
 */
export async function callAgent(
  panel: string,
  role: AgentRole,
  messages: AgentMessage[],
  opts: { maxTokens?: number; temperature?: number } = {},
): Promise<string> {
  const key = envKey("AI_GATEWAY_KEY");
  if (!key) throw new Error("AI_GATEWAY_KEY not configured");

  const model = modelFor(role);
  logCost({ panel, provider: "openrouter", model, costUsd: priceFor(role) });

  const res = await fetch(gatewayUrl(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "X-Title": "OSINT Conflict Tracker",
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.maxTokens ?? 2000,
      // No `plugins: [{id:"web"}]` here, unlike private-demo's DeepSeek tier —
      // perplexity/sonar-pro already searches the live web itself. Attaching
      // OpenRouter's web plugin on top would double-search and double-bill.
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    console.error(`OpenRouter error (${model}):`, res.status, errText.slice(0, 500));
    const err = new Error(`OpenRouter API error: ${res.status}`);
    (err as any).status = res.status;
    throw err;
  }

  const data: any = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}

/** Tolerant JSON extraction: direct parse → fenced block → outermost braces/brackets. */
export function extractJsonOr<T>(content: string, fallback: T): T {
  try {
    return JSON.parse(content) as T;
  } catch {
    /* fall through */
  }
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]) as T;
    } catch {
      /* fall through */
    }
  }
  for (const [open, close] of [["{", "}"], ["[", "]"]] as const) {
    const first = content.indexOf(open);
    const last = content.lastIndexOf(close);
    if (first !== -1 && last > first) {
      try {
        return JSON.parse(content.slice(first, last + 1)) as T;
      } catch {
        /* fall through */
      }
    }
  }
  return fallback;
}

/** Light extraction agent: structured JSON out of scraped or raw text. */
export async function extractStructured<T>(
  panel: string,
  system: string,
  user: string,
  fallback: T,
  opts: { maxTokens?: number } = {},
): Promise<T> {
  const content = await callAgent(
    panel,
    "light",
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    opts,
  );
  return extractJsonOr(content, fallback);
}

/**
 * Search agent: web-grounded structured answers via perplexity/sonar-pro.
 * Direct 1:1 replacement for the old direct `sonar-pro` calls — same model,
 * same live-search behavior, now billed through AI_GATEWAY_KEY.
 *
 * NOTE for migrators: Perplexity's native `search_domain_filter` /
 * `search_recency_filter` request params are NOT exposed through OpenRouter's
 * chat/completions passthrough for this model. Those constraints must be
 * restated inside the prompt text (see osint.ts / analyst.ts / biasTracker.ts
 * — their existing prompts already say "past 7 days" / "past month" etc.,
 * which is now load-bearing instead of decorative).
 */
export async function searchStructured<T>(
  panel: string,
  system: string,
  user: string,
  fallback: T,
  opts: { maxTokens?: number } = {},
): Promise<T> {
  const content = await callAgent(
    panel,
    "search",
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    { maxTokens: opts.maxTokens ?? 3000 },
  );
  return extractJsonOr(content, fallback);
}
