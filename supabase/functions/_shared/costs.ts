import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Per-call price estimates in USD. Update as pricing evolves.
// These are rough averages; actual cost depends on token usage.
export const PRICES = {
  firecrawl_scrape: 0.0015,        // ~$1.50 per 1k Firecrawl scrapes (Standard plan)
  perplexity_sonar: 0.005,         // ~$5/1M tokens, ~1k tokens/call avg
  perplexity_sonar_pro: 0.015,     // ~$15/1M tokens, ~1k tokens/call avg
  google_ai_gemini_flash: 0.0008, // gemini-2.5-flash, ~1.5k tokens/call avg
} as const;

export type Provider = "firecrawl" | "perplexity" | "google_ai";

interface LogParams {
  panel: string;
  provider: Provider;
  model?: string;
  units?: number;
  unitType?: string;
  costUsd: number;
  cacheHit?: boolean;
}

function admin() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
}

/** Fire-and-forget: log a single API call with its estimated cost. */
export function logCost(params: LogParams): void {
  // Don't await — never block the response on telemetry.
  admin()
    .from("api_cost_log")
    .insert({
      panel: params.panel,
      provider: params.provider,
      model: params.model ?? null,
      units: params.units ?? 1,
      unit_type: params.unitType ?? "request",
      cost_usd: params.costUsd,
      cache_hit: params.cacheHit ?? false,
    })
    .then(({ error }) => {
      if (error) console.error("logCost failed:", error.message);
    });
}

/** Convenience: log a cache hit (zero cost). */
export function logCacheHit(panel: string, provider: Provider) {
  logCost({ panel, provider, costUsd: 0, cacheHit: true });
}
