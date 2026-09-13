import type { Context, Next } from "hono";
import { isDbReady, pool } from "../db";
import { envKey } from "../env";

export async function requireAdmin(c: Context, next: Next) {
  const configured = envKey("ADMIN_TOKEN");
  const supplied = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!configured || supplied !== configured) {
    return c.json({ error: "Admin authentication required" }, 401);
  }
  await next();
}

export function healthRoute(c: Context) {
  return c.json({
    ok: true,
    db: isDbReady(),
    keys: {
      // We've removed Firecrawl as a required dependency, so we no longer check its health here
      // firecrawl: envKey("FIRECRAWL_API_KEY").length > 0,
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

export async function diagnosticsRoute(c: Context) {
  // We've removed Firecrawl as a required dependency, so we no longer check its health here
  // const firecrawlKey = envKey("FIRECRAWL_API_KEY");
  const firecrawlKey = envKey("FIRECRAWL_API_KEY"); // Kept for backward compatibility, but not required
  const gatewayKey = envKey("AI_GATEWAY_KEY");
  const gatewayUrl = envKey("AI_GATEWAY_URL") || "https://openrouter.ai/api/v1/chat/completions";
  //TUNE: Control which model the gateway diagnostics probe uses
  const probeModel = envKey("OPENROUTER_LIGHT_MODEL") || "perplexity/sonar";

  const [firecrawl, aiGateway] = await Promise.all([
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
      : Promise.resolve({ configured: false, ok: true } as ProviderCheck), // Firecrawl is now optional
    gatewayKey
      ? checkProvider(() =>
          fetch(gatewayUrl, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${gatewayKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: probeModel,
              messages: [{ role: "user", content: "ping" }],
              max_tokens: 1,
            }),
          }),
        )
      : Promise.resolve({ configured: false } as ProviderCheck),
  ]);

  return c.json({
    db: isDbReady(),
    providers: { firecrawl, ai_gateway: aiGateway },
  });
}

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
