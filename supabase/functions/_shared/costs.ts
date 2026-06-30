import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export const PRICES = {
  firecrawl_scrape: 0.0015,        // ~$1.50 per 1k Firecrawl scrapes (Standard plan)
  perplexity_sonar: 0.005,         // ~$5/1M tokens, ~1k tokens/call avg
  perplexity_sonar_pro: 0.015,     // ~$15/1M tokens, ~1k tokens/call avg
  google_ai_gemini_flash: 0.0008,
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

export function logCost(params: LogParams): void {
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

export function logCacheHit(panel: string, provider: Provider) {
  logCost({ panel, provider, costUsd: 0, cacheHit: true });
}
