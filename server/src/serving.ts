import { pool } from "./db";
import type { ConflictKey } from "./conflicts";

// Panel serving layer. Every panel route reads the items table through here, so
// the mapping from ingested rows onto the legacy response shapes lives in one
// place. No upstream fetch, no model call, no api_cache origin.

//TUNE: Control the (title fallback length). Characters of content used as a title when the row has none.
const TITLE_MAX_CHARS = 120;

//TUNE: Control the (summary length). Characters of content returned in a panel summary field.
const SUMMARY_MAX_CHARS = 280;

//TUNE: Control the (affiliation length). Characters of a feed label kept as an outlet name.
const OUTLET_LABEL_MAX_CHARS = 60;

// The classifier writes low|medium|high|critical. The panels have always read
// critical|high|developing|verified|info, so the classifier scale is folded onto
// that vocabulary here. A row with no severity still renders as info.
const LEGACY_SEVERITY = new Set(["critical", "high", "developing", "verified", "info"]);
const CLASSIFIER_SEVERITY_MAP: Record<string, string> = {
  critical: "critical",
  high: "high",
  medium: "developing",
  low: "info",
};

const LEGACY_CONFIDENCE = new Set(["verified", "unverified", "developing"]);

export interface ServingRow {
  id: string;
  source: string;
  source_uid: string | null;
  external_id: string;
  title: string | null;
  url: string | null;
  content: string | null;
  author: string | null;
  severity: string | null;
  confidence: string | null;
  event_type: string | null;
  is_breaking: boolean;
  lang: string | null;
  published_at: Date | null;
  ingested_at: Date;
  outlet_label: string | null;
}

// Conflict topical filters. Ingested rows carry no conflict column, so the
// panel filter is a keyword match over title and content in both languages the
// feeds publish in.
//TUNE: Control the (conflict filters). Keywords that decide which ingested items a conflict tab shows.
const CONFLICT_KEYWORDS: Record<Exclude<ConflictKey, "all">, string[]> = {
  "iran-us": [
    "iran", "iranian", "tehran", "irgc", "khamenei", "araghchi", "hezbollah",
    "hormuz", "israel", "israeli", "netanyahu", "gaza", "houthi", "yemen",
    "ايران", "إيران", "طهران", "الحرس الثوري", "حزب الله", "هرمز",
    "اسرائيل", "إسرائيل", "غزة", "الحوثي", "اليمن",
  ],
  "ukraine-russia": [
    "ukraine", "ukrainian", "kyiv", "kharkiv", "russia", "russian", "moscow",
    "putin", "zelensky", "donbas", "crimea", "nato", "black sea",
    "أوكرانيا", "اوكرانيا", "كييف", "روسيا", "موسكو", "بوتين", "زيلينسكي",
    "الناتو", "القرم",
  ],
  "china-taiwan": [
    "china", "chinese", "beijing", "taiwan", "taipei", "xi jinping",
    "south china sea", "taiwan strait", "pla ", "aukus", "indo-pacific",
    "semiconductor",
    "الصين", "بكين", "تايوان", "تايبيه", "شي جين", "بحر الصين", "مضيق تايوان",
  ],
};

// Editorial bloc per publisher. Used by the bias panel to bucket real coverage
// counts. A publisher that is not listed counts as neutral rather than being
// assigned a side.
//TUNE: Control the (publisher blocs). Which side of the spectrum each feed key or channel counts toward.
const PUBLISHER_BLOC: Record<string, "west" | "neutral" | "rival"> = {
  bbc: "west",
  france24: "west",
  jpost: "west",
  wsj: "west",
  theverge: "west",
  wired: "west",
  arstechnica: "west",
  techcrunch: "west",
  space_com: "west",
  aljazeera: "neutral",
  un_news: "neutral",
  google_news: "neutral",
  rt: "rival",
  tass: "rival",
  sputnik: "rival",
  presstv: "rival",
  irna: "rival",
  tasnim: "rival",
  mehr: "rival",
  xinhua: "rival",
  globaltimes: "rival",
  cgtn: "rival",
  intelslava: "rival",
};

export function publisherBloc(sourceUid: string | null): "west" | "neutral" | "rival" {
  if (!sourceUid) return "neutral";
  return PUBLISHER_BLOC[sourceUid] ?? "neutral";
}

export function legacySeverity(value: string | null): string {
  const v = (value ?? "").toLowerCase();
  if (LEGACY_SEVERITY.has(v)) return v;
  return CLASSIFIER_SEVERITY_MAP[v] ?? "info";
}

// Confidence is not a classifier output. An attributable outlet permalink is
// treated as verified reporting, an open channel post as unverified.
export function legacyConfidence(row: ServingRow): string {
  const v = (row.confidence ?? "").toLowerCase();
  if (LEGACY_CONFIDENCE.has(v)) return v;
  return row.source === "rss" ? "verified" : "unverified";
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}...`;
}

export function deriveTitle(row: ServingRow): string {
  const title = collapse(row.title ?? "");
  if (title) return title;
  const content = collapse(row.content ?? "");
  if (!content) return "";
  const firstSentence = content.split(/(?<=[.!?؟])\s/)[0] ?? content;
  return truncate(firstSentence, TITLE_MAX_CHARS);
}

export function deriveSummary(row: ServingRow): string {
  return truncate(collapse(row.content ?? ""), SUMMARY_MAX_CHARS);
}

// Feed titles arrive as marketing strings ("Al Jazeera - Breaking News, World
// News and Video"). Keep the publisher part.
export function outletName(row: ServingRow): string {
  const label = collapse(row.outlet_label ?? "");
  if (!label) return row.source_uid ?? row.source;
  const head = label.split(/\s+[\u2013\u2014|-]\s+/)[0] ?? label;
  return truncate(head, OUTLET_LABEL_MAX_CHARS);
}

export function isoOrNull(value: Date | null): string | null {
  if (!value) return null;
  const t = value.getTime();
  return Number.isNaN(t) ? null : value.toISOString();
}

// Telegram external ids are "<channel>:<message id>". Fall back to the row id
// rather than generating a number.
export function telegramMessageId(row: ServingRow): number {
  const tail = row.external_id.split(":").pop() ?? "";
  const parsed = Number.parseInt(tail, 10);
  return Number.isFinite(parsed) ? parsed : Number(row.id);
}

export function eventTopic(row: ServingRow): string {
  const type = (row.event_type ?? "").trim();
  if (!type) return "unclassified";
  return type.replace(/_/g, " ");
}

export interface ItemQuery {
  conflict: ConflictKey;
  limit: number;
  source?: "rss" | "telegram";
  /** Classifier severity values to keep. Omit for every severity. */
  severities?: string[];
  eventTypes?: string[];
  excludeInformational?: boolean;
  requireUrl?: boolean;
  requireText?: boolean;
  requireByline?: boolean;
  breakingOrSevere?: boolean;
  sinceHours?: number;
}

const SELECT_COLUMNS = `
  i.id::text        AS id,
  i.source          AS source,
  i.source_uid      AS source_uid,
  i.external_id     AS external_id,
  i.title           AS title,
  i.url             AS url,
  i.content         AS content,
  i.author          AS author,
  i.severity        AS severity,
  i.confidence      AS confidence,
  i.event_type      AS event_type,
  i.is_breaking     AS is_breaking,
  i.lang            AS lang,
  i.published_at    AS published_at,
  i.ingested_at     AS ingested_at,
  s.label           AS outlet_label`;

// Null published_at sorts last instead of being given a time it never had.
export async function fetchItems(q: ItemQuery): Promise<ServingRow[]> {
  const where: string[] = ["i.noise = false"];
  const params: unknown[] = [];

  if (q.source) {
    params.push(q.source);
    where.push(`i.source = $${params.length}`);
  }

  if (q.conflict !== "all") {
    const patterns = CONFLICT_KEYWORDS[q.conflict].map((k) => `%${k}%`);
    params.push(patterns);
    where.push(
      `(coalesce(i.title, '') || ' ' || coalesce(i.content, '')) ILIKE ANY($${params.length}::text[])`,
    );
  }

  if (q.severities && q.severities.length > 0) {
    params.push(q.severities);
    where.push(`i.severity = ANY($${params.length}::text[])`);
  }

  if (q.eventTypes && q.eventTypes.length > 0) {
    params.push(q.eventTypes);
    where.push(`i.event_type = ANY($${params.length}::text[])`);
  }

  if (q.excludeInformational) {
    where.push(`i.event_type IS NOT NULL AND i.event_type <> 'informational'`);
  }

  if (q.breakingOrSevere) {
    where.push(`(i.is_breaking = true OR i.severity IN ('high', 'critical'))`);
  }

  if (q.requireUrl) {
    where.push(`i.url IS NOT NULL AND i.url <> ''`);
  }

  if (q.requireText) {
    where.push(`(coalesce(i.title, '') <> '' OR coalesce(i.content, '') <> '')`);
  }

  if (q.requireByline) {
    where.push(`(coalesce(i.author, '') <> '' OR coalesce(i.source_uid, '') <> '')`);
  }

  if (q.sinceHours) {
    params.push(String(q.sinceHours));
    where.push(`i.published_at >= NOW() - ($${params.length} || ' hours')::interval`);
  }

  params.push(q.limit);

  const { rows } = await pool.query(
    `SELECT ${SELECT_COLUMNS}
     FROM items i
     LEFT JOIN source_status s ON s.id = i.source_uid
     WHERE ${where.join(" AND ")}
     ORDER BY i.published_at DESC NULLS LAST, i.id DESC
     LIMIT $${params.length}`,
    params,
  );

  return rows as ServingRow[];
}
