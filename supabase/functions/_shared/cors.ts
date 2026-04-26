// Centralized CORS allow-list. Edit ALLOWED_ORIGINS to add/remove sites.
const ALLOWED_ORIGINS = [
  "https://d1.hessa.space",
  "https://usiris.hessa.space",
];
// Allow localhost during development.
const ALLOWED_ORIGIN_PATTERNS = [
  /^http:\/\/localhost(:\d+)?$/,
];

export function corsHeadersFor(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  const allowed =
    ALLOWED_ORIGINS.includes(origin) ||
    ALLOWED_ORIGIN_PATTERNS.some((re) => re.test(origin));
  return {
    "Access-Control-Allow-Origin": allowed ? origin : ALLOWED_ORIGINS[0],
    "Vary": "Origin",
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  };
}

/** Sanitized error response — never leak internal error messages to clients. */
export function errorResponse(
  cors: Record<string, string>,
  status: number,
  publicMessage: string,
  internalError?: unknown,
): Response {
  if (internalError !== undefined) {
    console.error(`[${status}] ${publicMessage}:`, internalError);
  }
  return new Response(JSON.stringify({ error: publicMessage }), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}
