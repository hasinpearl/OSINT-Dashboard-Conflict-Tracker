const ALLOWED_ORIGINS = [
  "https://d1.hessa.space",
  "https://usiris.hessa.space",
];

const ALLOWED_ORIGIN_PATTERNS = [
  /^http:\/\/localhost(:\d+)?$/,
];

function isAllowed(origin: string | null): boolean {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  return ALLOWED_ORIGIN_PATTERNS.some((p) => p.test(origin));
}

export function corsHeadersFor(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const allowed = isAllowed(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Max-Age": "86400",
  };
}

export function errorResponse(
  cors: Record<string, string>,
  status: number,
  publicMsg: string,
  internalErr?: unknown,
): Response {
  if (internalErr) console.error(publicMsg, internalErr);
  return new Response(JSON.stringify({ error: publicMsg }), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}
