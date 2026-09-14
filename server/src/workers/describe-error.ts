// Every collector logged `e instanceof Error ? e.message : String(e)`, which
// prints an empty string for the errors Node actually throws on a failed
// connection. A dual-stack connect failure rejects with an AggregateError whose
// message is "" and whose real ECONNREFUSED / ETIMEDOUT entries live in
// .errors, so the log read "Error processing channel X:" with nothing after the
// colon. This describes an error by everything it carries, not just .message.

//TUNE: Control the (error text length). Characters kept from a described error before it is truncated.
const MAX_DESCRIPTION_CHARS = 500;
//TUNE: Control the (cause depth). Nested cause and aggregate levels walked before describing stops.
const MAX_CAUSE_DEPTH = 3;
//TUNE: Control the (nested error count). Entries of an AggregateError.errors array included in the description.
const MAX_NESTED_ERRORS = 4;

const ERRNO_KEYS = ["code", "errno", "syscall", "address", "port", "status", "statusCode"] as const;

export function truncateForLog(text: string, max: number = MAX_DESCRIPTION_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}... (${flat.length} chars)` : flat;
}

function errnoDetail(e: unknown): string {
  const bag = e as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ERRNO_KEYS) {
    const value = bag[key];
    if (value === undefined || value === null || value === "") continue;
    if (typeof value === "object") continue;
    parts.push(`${key}=${String(value)}`);
  }
  return parts.join(" ");
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

export function describeError(e: unknown, depth = 0): string {
  if (e === undefined) return "undefined was thrown, no error object";
  if (e === null) return "null was thrown, no error object";

  if (!(e instanceof Error)) {
    const text = typeof e === "object" ? safeJson(e) : String(e);
    return text.trim()
      ? truncateForLog(`${typeof e} ${text}`)
      : `${typeof e} was thrown with no readable value`;
  }

  const pieces: string[] = [];
  const message = (e.message || "").trim();
  if (message) pieces.push(message);

  const errno = errnoDetail(e);
  if (errno) pieces.push(errno);

  const nested = (e as AggregateError).errors;
  if (Array.isArray(nested) && nested.length > 0 && depth < MAX_CAUSE_DEPTH) {
    const shown = nested
      .slice(0, MAX_NESTED_ERRORS)
      .map((inner) => describeError(inner, depth + 1))
      .join("; ");
    const omitted = nested.length - Math.min(nested.length, MAX_NESTED_ERRORS);
    pieces.push(
      `${nested.length} nested [${shown}${omitted > 0 ? `; +${omitted} more` : ""}]`,
    );
  }

  const cause = (e as { cause?: unknown }).cause;
  if (cause !== undefined && cause !== null && depth < MAX_CAUSE_DEPTH) {
    pieces.push(`caused by ${describeError(cause, depth + 1)}`);
  }

  const name = e.name || "Error";
  const body = pieces.join(" ");
  return truncateForLog(body ? `${name}: ${body}` : `${name} carrying no message or code`);
}
