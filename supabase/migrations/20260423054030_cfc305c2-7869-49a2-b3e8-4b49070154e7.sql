CREATE TABLE public.api_cost_log (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  panel TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT,
  units NUMERIC NOT NULL DEFAULT 1,
  unit_type TEXT NOT NULL DEFAULT 'request',
  cost_usd NUMERIC NOT NULL DEFAULT 0,
  cache_hit BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX idx_api_cost_log_created_at ON public.api_cost_log (created_at DESC);
CREATE INDEX idx_api_cost_log_panel ON public.api_cost_log (panel);

ALTER TABLE public.api_cost_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read cost log"
ON public.api_cost_log
FOR SELECT
USING (true);

CREATE OR REPLACE VIEW public.api_cost_summary_24h AS
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