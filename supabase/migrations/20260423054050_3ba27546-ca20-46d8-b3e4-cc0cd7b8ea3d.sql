DROP VIEW IF EXISTS public.api_cost_summary_24h;

CREATE VIEW public.api_cost_summary_24h
WITH (security_invoker = true) AS
SELECT
  panel,
  provider,
  COUNT(*) FILTER (WHERE cache_hit = false) AS upstream_calls,
  COUNT(*) FILTER (WHERE cache_hit = true) AS cache_hits,
  COALESCE(SUM(cost_usd), 0) AS total_cost_usd
FROM public.api_cost_log
WHERE created_at > now() - INTERVAL '24 hours'
GROUP BY panel, provider
ORDER BY total_cost_usd DESC;

GRANT SELECT ON public.api_cost_summary_24h TO anon, authenticated;