import type { Context, Next } from "hono";
import { isDbReady, pool } from "../db";
import { envKey } from "../env";

// This dashboard has no user auth system; admin routes are protected by a
// static bearer token instead (set ADMIN_TOKEN in the environment).
export async function requireAdmin(c: Context, next: Next) {
  const configured = envKey("ADMIN_TOKEN");
  const supplied = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!configured || supplied !== configured) {
    return c.json({ error: "Admin authentication required" }, 401);
  }
  await next();
}

// Presence booleans only — never echo key material.
export function healthRoute(c: Context) {
  return c.json({
    ok: true,
    db: isDbReady(),
    keys: {
      perplexity: envKey("PERPLEXITY_API_KEY").length > 0,
      firecrawl: envKey("FIRECRAWL_API_KEY").length > 0,
      ai_gateway: envKey("AI_GATEWAY_KEY").length > 0,
    },
  });
}

interface ProviderCheck {
  configured: boolean;
  ok?: boolean;
  status?: number;
  error?: string;
}

async function checkProvider(fn: () => Promise<Response>): Promise<ProviderCheck> {
  try {
    const res = await fn();
    const check: ProviderCheck = { configured: true, ok: res.ok, status: res.status };
    if (!res.ok) {
      check.error = (await res.text().catch(() => "")).slice(0, 300);
    }
    return check;
  } catch (e) {
    return { configured: true, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// Live-tests each provider with a minimal real call so "all panels are down,
// why?" is a one-click answer (e.g. an invalid key shows as an upstream 401).
export async function diagnosticsRoute(c: Context) {
  const perplexityKey = envKey("PERPLEXITY_API_KEY");
  const firecrawlKey = envKey("FIRECRAWL_API_KEY");
  const gatewayKey = envKey("AI_GATEWAY_KEY");
  const gatewayUrl = envKey("AI_GATEWAY_URL") || "https://openrouter.ai/api/v1/chat/completions";

  const [perplexity, firecrawl, aiGateway] = await Promise.all([
    perplexityKey
      ? checkProvider(() =>
          fetch("https://api.perplexity.ai/chat/completions", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${perplexityKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: "sonar",
              messages: [{ role: "user", content: "ping" }],
              max_tokens: 1,
            }),
          }),
        )
      : Promise.resolve({ configured: false } as ProviderCheck),
    firecrawlKey
      ? checkProvider(() =>
          fetch("https://api.firecrawl.dev/v1/scrape", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${firecrawlKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ url: "https://example.com", formats: ["markdown"] }),
          }),
        )
      : Promise.resolve({ configured: false } as ProviderCheck),
    gatewayKey
      ? checkProvider(() =>
          fetch(gatewayUrl, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${gatewayKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: "google/gemini-2.5-flash",
              messages: [{ role: "user", content: "ping" }],
              max_tokens: 1,
            }),
          }),
        )
      : Promise.resolve({ configured: false } as ProviderCheck),
  ]);

  return c.json({
    db: isDbReady(),
    providers: { perplexity, firecrawl, ai_gateway: aiGateway },
  });
}

// The old Supabase admin "summary" view as a plain aggregate query.
// Cast ::int / ::float8 because pg returns numerics as strings.
export async function costsSummaryRoute(c: Context) {
  try {
    const { rows } = await pool.query(`
      SELECT panel,
             provider,
             COUNT(*)::int AS calls,
             COUNT(*) FILTER (WHERE cache_hit = true)::int AS cache_hits,
             COUNT(*) FILTER (WHERE cache_hit = false)::int AS cache_misses,
             COALESCE(SUM(cost_usd), 0)::float8 AS total_cost_usd
      FROM api_cost_log
      GROUP BY panel, provider
      ORDER BY total_cost_usd DESC
    `);
    const { rows: totals } = await pool.query(`
      SELECT COUNT(*)::int AS calls,
             COALESCE(SUM(cost_usd), 0)::float8 AS total_cost_usd
      FROM api_cost_log
    `);
    return c.json({ summary: rows, totals: totals[0] });
  } catch (e) {
    console.error("costs summary failed:", e);
    return c.json({ error: "Cost log unavailable" }, 503);
  }
}
