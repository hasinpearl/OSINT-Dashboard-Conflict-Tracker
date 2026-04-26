/** Format timestamps with the browser's detected local timezone. */

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(input?: string | number | Date | null): Date | null {
  if (input === null || input === undefined || input === "") return null;
  if (input instanceof Date) return isNaN(input.getTime()) ? null : input;

  if (typeof input === "string" && DATE_ONLY_RE.test(input)) {
    // Treat YYYY-MM-DD as a calendar date in UTC so the displayed day doesn't shift by timezone.
    const d = new Date(`${input}T00:00:00Z`);
    return isNaN(d.getTime()) ? null : d;
  }

  const d = new Date(input);
  return isNaN(d.getTime()) ? null : d;
}

export function formatLocalDateTime(
  input?: string | number | Date | null,
  locale?: string
): string {
  const d = parseDate(input);
  if (!d) return typeof input === "string" ? input : "";
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  }).format(d);
}

export function formatLocalDate(
  input?: string | number | Date | null,
  locale?: string
): string {
  const d = parseDate(input);
  if (!d) return typeof input === "string" ? input : "";
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone,
  }).format(d);
}

