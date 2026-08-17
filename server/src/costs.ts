import { pool } from "./db";

export const PRICES = {
  firecrawl_scrape: 0.0015,        // ~$1.50 per 1k Firecrawl scrapes (Standard plan)
  // OpenRouter tiers — both are Perplexity Sonar models, unchanged model
  // choice from what this repo called directly before; only the gateway
  // changed. Per-call estimates at typical payload sizes (~3k in / ~1k out).
  // Verified against OpenRouter's live catalogue 2026-08-17:
  //   perplexity/sonar      $1/M in,  $1/M out
  //   perplexity/sonar-pro  $3/M in, $15/M out
  openrouter_mid: 0.018,            // sonar-pro ("search" role — replaces old sonar-pro)
  openrouter_light: 0.004,          // sonar ("light" role — replaces old sonar)
  google_ai_gemini_flash: 0.0008,
  // Legacy: no longer called directly (routed through openrouter_* above
  // instead). Kept so historical api_cost_log rows under provider:"perplexity"
  // stay readable and the admin cost view does not break on old data.
  perplexity_sonar: 0.005,
  perplexity_sonar_pro: 0.015,
} as const;

export type Provider = "firecrawl" | "openrouter" | "perplexity" | "google_ai";

interface LogParams {
  panel: string;
  provider: Provider;
  model?: string;
  units?: number;
  unitType?: string;
  costUsd: number;
  cacheHit?: boolean;
}

// Fire-and-forget: never await, never fail a request over cost logging.
export function logCost(params: LogParams): void {
  pool
    .query(
      `INSERT INTO api_cost_log (panel, provider, model, units, unit_type, cost_usd, cache_hit)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        params.panel,
        params.provider,
        params.model ?? null,
        params.units ?? 1,
        params.unitType ?? "request",
        params.costUsd,
        params.cacheHit ?? false,
      ],
    )
    .catch((e) => console.error("logCost failed:", e instanceof Error ? e.message : e));
}

export function logCacheHit(panel: string, provider: Provider): void {
  logCost({ panel, provider, costUsd: 0, cacheHit: true });
}
