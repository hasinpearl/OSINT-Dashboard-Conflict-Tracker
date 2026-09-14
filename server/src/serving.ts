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
    "south china sea", "taiwan strait", "pla", "aukus", "indo-pacific",
    "semiconductor",
    "الصين", "بكين", "تايوان", "تايبيه", "شي جين", "بحر الصين", "مضيق تايوان",
  ],
};

// Telegram is not RSS prose. Channels post two words and a flag pair, Arabic
// without the definite article, and shorthand no wire service would print, so
// the RSS keyword list matches almost none of it and the tab collapsed to a
// single row. These terms are additive: they widen telegram only, so the news,
// OSINT and bias panels keep counting exactly what they counted before.
//TUNE: Control the (telegram conflict filters). Extra terms, transliterations and flags matched only against telegram rows.
const TELEGRAM_EXTRA_KEYWORDS: Record<Exclude<ConflictKey, "all">, string[]> = {
  "iran-us": [
    "idf", "iaf", "centcom", "mossad", "knesset", "tel aviv", "haifa", "eilat",
    "west bank", "rafah", "khan younis", "jenin", "tulkarm", "ramallah",
    "hamas", "qassam", "islamic jihad", "plo", "fatah",
    "lebanon", "lebanese", "beirut", "nasrallah", "litani", "nabatieh",
    "syria", "syrian", "damascus", "aleppo", "golan", "tartus", "latakia",
    "iraq", "iraqi", "baghdad", "erbil", "sulaimaniyah", "halabja", "kataib",
    "islamic resistance", "axis of resistance", "pmf", "ain al asad",
    "sanaa", "marib", "hodeidah", "ansar allah", "red sea", "bab el mandeb",
    "saudi", "riyadh", "jazan", "najran", "abha", "khamis mushait", "aramco",
    "natanz", "fordow", "bushehr", "arak", "revolutionary guard", "basij",
    "quds force", "soleimani", "strait of hormuz", "persian gulf",
    "fifth fleet", "sixth fleet",
    "حماس", "القسام", "الجهاد الاسلامي", "الضفة", "رفح", "خان يونس", "جنين",
    "طولكرم", "رام الله", "تل ابيب", "حيفا", "الجيش الاسرائيلي", "الكنيست",
    "لبنان", "بيروت", "نصر الله", "النبطية", "الليطاني",
    "سوريا", "دمشق", "حلب", "الجولان", "طرطوس", "اللاذقية",
    "العراق", "بغداد", "اربيل", "السليمانية", "حلبجة", "كتائب", "الحشد",
    "المقاومة الاسلامية", "محور المقاومة",
    "صنعاء", "مارب", "مأرب", "الحديدة", "انصار الله", "البحر الاحمر",
    "باب المندب", "الحوثيين",
    "السعودية", "الرياض", "جيزان", "نجران", "ابها", "أبها", "خميس مشيط",
    "ارامكو", "نطنز", "فوردو", "بوشهر", "فيلق القدس", "سليماني",
    "مضيق هرمز", "الخليج الفارسي",
    "\u{1F1EE}\u{1F1F7}", "\u{1F1EE}\u{1F1F1}", "\u{1F1FE}\u{1F1EA}",
    "\u{1F1F8}\u{1F1E6}", "\u{1F1F1}\u{1F1E7}", "\u{1F1F8}\u{1F1FE}",
    "\u{1F1EE}\u{1F1F6}", "\u{1F1F5}\u{1F1F8}",
  ],
  "ukraine-russia": [
    "kharkov", "odesa", "odessa", "kherson", "mykolaiv", "zaporizhzhia",
    "zaporozhye", "bakhmut", "avdiivka", "pokrovsk", "kupyansk", "chasiv yar",
    "sumy", "chernihiv", "lviv", "dnipro", "kramatorsk", "mariupol",
    "belgorod", "kursk", "bryansk", "rostov", "sevastopol", "kerch",
    "donetsk", "luhansk", "dpr", "lpr", "azov", "wagner", "kadyrov",
    "shoigu", "gerasimov", "lavrov", "medvedev", "kremlin", "rosgvardia",
    "duma", "ldpr", "svo", "special military operation",
    "afu", "vsu", "azov brigade", "himars", "atacms", "storm shadow",
    "iskander", "kinzhal", "kalibr", "geran", "lancet", "orlan",
    "belarus", "belarusian", "minsk", "lukashenko", "kaliningrad",
    "خاركيف", "خاركوف", "اوديسا", "أوديسا", "خيرسون", "زابوريجيا", "باخموت",
    "دونيتسك", "لوغانسك", "ماريوبول", "كورسك", "بيلغورود", "سيفاستوبول",
    "الكرملين", "لافروف", "مدفيديف", "الدوما", "فاغنر", "بيلاروسيا", "مينسك",
    "لوكاشينكو", "كالينينغراد",
    "\u{1F1F7}\u{1F1FA}", "\u{1F1FA}\u{1F1E6}", "\u{1F1E7}\u{1F1FE}",
  ],
  "china-taiwan": [
    "prc", "kuomintang", "dpp", "lai ching-te", "wang yi", "tsai ing-wen",
    "kinmen", "matsu", "penghu", "pratas", "senkaku", "diaoyu", "spratly",
    "paracel", "scarborough", "second thomas shoal", "sabina shoal",
    "luzon strait", "miyako strait", "bashi channel", "median line",
    "pla navy", "plaaf", "plan", "adiz", "median line incursion",
    "first island chain", "quad", "tsmc", "hong kong", "xinjiang",
    "north korea", "pyongyang", "kim jong",
    "بكين", "تايوان", "تايبيه", "هونغ كونغ", "شينجيانغ", "كينمن",
    "سبراتلي", "سكاربورو", "مضيق لوزون", "كوريا الشمالية", "بيونغيانغ",
    "\u{1F1E8}\u{1F1F3}", "\u{1F1F9}\u{1F1FC}", "\u{1F1F0}\u{1F1F5}",
  ],
};

// A channel whose entire editorial remit is one theatre makes every one of its
// posts on-topic, including the ones too terse to carry a keyword ("All clear,
// alerts ended"). Only unambiguous single-theatre channels are listed; the
// general monitors are left to text matching so the tab keeps meaning
// something.
//TUNE: Control the (channel conflict binding). Telegram channels whose every post counts toward one conflict.
const TELEGRAM_CONFLICT_CHANNELS: Record<Exclude<ConflictKey, "all">, string[]> = {
  "iran-us": ["RocketAlert", "idkunim_il"],
  "ukraine-russia": ["ukr_leaks_eng"],
  "china-taiwan": [],
};

const LATIN_TERM = /^[\x20-\x7E]+$/;

function escapeRegex(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Latin terms get word boundaries, which is not cosmetic: as plain substrings
// "nato" matched "senator" and "china" matched "machinations", so both lists
// were quietly pulling in unrelated rows. Arabic and emoji stay substrings on
// purpose, the first because Arabic glues the article and conjunctions onto the
// stem (غزة -> وغزة), the second because a flag carries no word boundary.
function conflictRegex(terms: string[]): string {
  const latin: string[] = [];
  const raw: string[] = [];
  for (const term of terms) {
    (LATIN_TERM.test(term) ? latin : raw).push(escapeRegex(term.trim()));
  }
  const parts: string[] = [];
  if (latin.length > 0) parts.push(`\\y(?:${latin.join("|")})\\y`);
  if (raw.length > 0) parts.push(`(?:${raw.join("|")})`);
  return parts.join("|");
}

export function conflictTerms(
  conflict: Exclude<ConflictKey, "all">,
  source?: "rss" | "telegram",
): string[] {
  const base = CONFLICT_KEYWORDS[conflict];
  return source === "telegram" ? [...base, ...TELEGRAM_EXTRA_KEYWORDS[conflict]] : base;
}

export function conflictChannels(conflict: Exclude<ConflictKey, "all">): string[] {
  return TELEGRAM_CONFLICT_CHANNELS[conflict];
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

// Telegram posts are full of emoji and flags, which are surrogate pairs in a JS
// string. Slicing by .length can land between the two halves and leave a lone
// surrogate, and a lone surrogate is not valid text: Perplexity rejects the
// whole request body with a bare "invalid request body" 400, so one emoji in
// one stored row took out an entire panel. Array.from iterates code points, so
// a cut can only ever fall between whole characters.
function sliceCodePoints(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join("");
}

// Defence in depth for the same failure: a lone surrogate that reached here
// from anywhere else is dropped rather than shipped to a provider or a client.
export function stripLoneSurrogates(text: string): string {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

function truncate(text: string, max: number): string {
  if (Array.from(text).length <= max) return text;
  const cut = sliceCodePoints(text, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}...`;
}

export function deriveTitle(row: ServingRow): string {
  const title = collapse(row.title ?? "");
  if (title) return stripLoneSurrogates(title);
  const content = collapse(row.content ?? "");
  if (!content) return "";
  const firstSentence = content.split(/(?<=[.!?؟])\s/)[0] ?? content;
  return stripLoneSurrogates(truncate(firstSentence, TITLE_MAX_CHARS));
}

export function deriveSummary(row: ServingRow): string {
  return stripLoneSurrogates(truncate(collapse(row.content ?? ""), SUMMARY_MAX_CHARS));
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
  onlyInformational?: boolean;
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
function buildWhere(q: ItemQuery): { where: string[]; params: unknown[] } {
  const where: string[] = ["i.noise = false"];
  const params: unknown[] = [];

  if (q.source) {
    params.push(q.source);
    where.push(`i.source = $${params.length}`);
  }

  if (q.conflict !== "all") {
    // Regex rather than ILIKE ANY: word boundaries on Latin terms, plus the
    // channel binding for telegram, which is what turns the telegram tab from
    // one row into the real corpus.
    params.push(conflictRegex(conflictTerms(q.conflict, q.source)));
    const textMatch = `(coalesce(i.title, '') || ' ' || coalesce(i.content, '')) ~* $${params.length}`;

    const channels = q.source === "telegram" ? conflictChannels(q.conflict) : [];
    if (channels.length > 0) {
      params.push(channels);
      where.push(
        `(${textMatch} OR lower(i.source_uid) = ANY(SELECT lower(x) FROM unnest($${params.length}::text[]) x))`,
      );
    } else {
      where.push(textMatch);
    }
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

  if (q.onlyInformational) {
    where.push(`(i.event_type IS NULL OR i.event_type = 'informational')`);
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

  return { where, params };
}

export async function fetchItems(q: ItemQuery): Promise<ServingRow[]> {
  const { where, params } = buildWhere(q);
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

// Same filter, no limit, count only. The timeline reports how much
// informational chatter it dropped, and that number has to be the real one.
export async function countItems(q: Omit<ItemQuery, "limit">): Promise<number> {
  const { where, params } = buildWhere({ ...q, limit: 0 });
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM items i WHERE ${where.join(" AND ")}`,
    params,
  );
  return rows[0]?.n ?? 0;
}
