import { pool } from "./db";

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
