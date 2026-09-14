// The source taxonomy. Every panel in Rule 1 owns exactly one of these types,
// and the mapping from a stored row onto its type is total: items.source is the
// ingest channel that wrote the row, and each ingest channel belongs to one
// type and one type only. That is what makes the panels a partition of the
// corpus rather than three views over a shared pool.
//
// Measured against the real store before this file was written: items.source
// holds exactly two values, rss (518 rows) and telegram (4185). There is no
// third value, so osint_account currently resolves to zero rows. That is the
// honest state of the data, not a gap in this mapping: the model-driven OSINT
// account collection that used to write those rows was deleted in b7202c8 and
// its restoration is carded separately. An empty OSINT panel is correct until
// that collector is back; a panel padded with news or Telegram rows is not.

export type SourceType = "news_outlet" | "telegram_channel" | "osint_account";

export const SOURCE_TYPES: SourceType[] = [
  "news_outlet",
  "telegram_channel",
  "osint_account",
];

// items.source values that belong to each type. A source value absent from
// every list is served by no panel, which is the safe direction to fail: a new
// collector has to be typed here before its rows can reach the dashboard.
const SOURCES_BY_TYPE: Record<SourceType, string[]> = {
  news_outlet: ["rss"],
  telegram_channel: ["telegram"],
  osint_account: ["osint"],
};

const TYPE_BY_SOURCE = new Map<string, SourceType>(
  SOURCE_TYPES.flatMap((type) => SOURCES_BY_TYPE[type].map((s) => [s, type] as const)),
);

export function sourcesForTypes(types: SourceType[]): string[] {
  return Array.from(new Set(types.flatMap((t) => SOURCES_BY_TYPE[t])));
}

// Used by the acceptance checks and by /api/sources to report what a panel
// actually returned, so an isolation breach is a number rather than an opinion.
export function sourceTypeOf(source: string | null | undefined): SourceType | "untyped" {
  return TYPE_BY_SOURCE.get(String(source ?? "")) ?? "untyped";
}
