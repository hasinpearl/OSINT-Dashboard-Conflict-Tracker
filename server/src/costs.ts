import { pool } from "./db";

//TUNE: Control per-call cost estimates used in the admin cost dashboard
export const PRICES = {
  firecrawl_scrape: 0.0015,
  openrouter_mid: 0.018,
  openrouter_light: 0.004,
  google_ai_gemini_flash: 0.0008,
  perplexity_sonar: 0.005,
  perplexity_sonar_pro: 0.015,
} as const;

export type Provider = "firecrawl" | "openrouter" | "perplexity" | "google_ai" | "database";

interface LogParams {
  panel: string;
  provider: Provider;
  model?: string;
  units?: number;
  unitType?: string;
  costUsd: number;
  cacheHit?: boolean;
}

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
