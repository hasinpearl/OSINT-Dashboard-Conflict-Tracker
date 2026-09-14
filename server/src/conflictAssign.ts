import { buildMatcher, normalize } from "./enrich";
import type { ConflictKey } from "./conflicts";

// Rules-only conflict assignment. No network, no model, no cost: this runs
// synchronously per row on every write path and over the whole table during a
// backfill, exactly like the event-type classifier it borrows its matcher from.
//
// This replaces a query-time regex over title and content. That regex had to be
// broad enough not to miss real items and narrow enough not to leak, so it did
// neither: measured against the stored corpus it put a North Korean missile
// launch and a South Korean ADIZ scramble on the China/Taiwan tab, because
// "north korea" and "adiz" were listed as China terms, and it matched "plan" as
// an abbreviation of PLA Navy against an insurance plan and an AI policy plan.
//
// The fix is not a longer term list. It is a shape: a theatre is claimed by the
// unambiguous proper nouns of its own parties (ANCHORS), and everything that is
// only meaningful next to one of those (SUPPORTING) cannot claim a theatre on
// its own. That is what stops one ambiguous token from owning a row.

export type AssignedConflict = Exclude<ConflictKey, "all">;

//TUNE: Control the (assignment version). Bump when the lexicon or the anchor rules change so a backfill can target stale rows.
export const CONFLICT_ASSIGN_VERSION = 2;

//TUNE: Control the (assignment text budget). Characters of title+content the assigner reads, keeps cost flat on long articles.
const MAX_SCAN_CHARS = 4000;

// An emoji flag is the dateline of a terse telegram post: a channel that posts
// "🇮🇷❌🇮🇱" and four words is reporting that theatre and carries no word to
// match. In long prose a flag is not a dateline, it is decoration or one entry
// in a list, and taking it as an anchor there is a measured leak: a 9-11 victim
// demographics table listing 🇨🇳 among a dozen flags was assigned to
// China/Taiwan. So a flag anchors only a short post, and longer text has to
// name its theatre in words.
//TUNE: Control the (flag dateline length). Characters below which an emoji flag alone can assign a conflict.
const FLAG_DATELINE_MAX_CHARS = 300;

// Terms that identify a theatre on their own. These are the names of the
// parties, their leaders, their capitals and their territory: a row that says
// "Taiwan" is about China/Taiwan whatever else it says. Emoji flags count as
// anchors because on telegram the flag pair IS the dateline, and a channel that
// posts "🇮🇷❌🇮🇱" and four words is reporting that theatre.
//TUNE: Control the (conflict anchors). Terms that alone assign a row to a conflict.
const ANCHORS: Record<AssignedConflict, string[]> = {
  "iran-us": [
    "iran", "iranian", "tehran", "irgc", "khamenei", "araghchi", "raisi",
    "pezeshkian", "hormuz", "natanz", "fordow", "bushehr", "revolutionary guard",
    "quds force", "soleimani", "basij", "artesh",
    "israel", "israeli", "netanyahu", "knesset", "mossad", "shin bet",
    "tel aviv", "jerusalem", "haifa", "eilat", "idf", "iaf",
    "gaza", "rafah", "khan younis", "hamas", "qassam", "islamic jihad",
    "west bank", "jenin", "tulkarm", "ramallah", "nablus", "hebron",
    "palestinian", "palestinians", "plo", "fatah", "ramat gan",
    "hezbollah", "nasrallah", "lebanon", "lebanese", "beirut", "nabatieh",
    "litani", "baalbek",
    "houthi", "houthis", "ansar allah", "yemen", "yemeni", "sanaa", "marib",
    "hodeidah", "bab el mandeb", "bab al mandab",
    "syria", "syrian", "damascus", "aleppo", "golan", "tartus", "latakia",
    "quneitra", "homs",
    "iraq", "iraqi", "baghdad", "erbil", "sulaimaniyah", "halabja",
    "kataib hezbollah", "ain al asad", "islamic resistance",
    "axis of resistance", "popular mobilization",
    "ايران", "طهران", "الحرس الثوري", "خامنئي", "نطنز", "فوردو", "بوشهر",
    "فيلق القدس", "سليماني", "هرمز", "مضيق هرمز", "الخليج الفارسي",
    "اسرائيل", "اسرائيلي", "نتنياهو", "الكنيست", "الموساد", "تل ابيب",
    "القدس", "حيفا", "الجيش الاسرائيلي",
    "غزه", "رفح", "خان يونس", "حماس", "القسام", "الجهاد الاسلامي",
    "الضفه", "جنين", "طولكرم", "رام الله", "نابلس", "الخليل", "فلسطين",
    "فلسطيني", "الفلسطينيه",
    "حزب الله", "نصر الله", "لبنان", "لبناني", "بيروت", "النبطيه",
    "الليطاني", "بعلبك",
    "الحوثي", "الحوثيين", "انصار الله", "اليمن", "يمني", "صنعاء", "مارب",
    "الحديده", "باب المندب",
    "سوريا", "سوري", "دمشق", "حلب", "الجولان", "طرطوس", "اللاذقيه",
    "القنيطره", "حمص",
    "العراق", "عراقي", "بغداد", "اربيل", "السليمانيه", "حلبجه",
    "كتائب حزب الله", "المقاومه الاسلاميه", "محور المقاومه", "الحشد الشعبي",
    "\u{1F1EE}\u{1F1F7}", "\u{1F1EE}\u{1F1F1}", "\u{1F1FE}\u{1F1EA}",
    "\u{1F1F1}\u{1F1E7}", "\u{1F1F8}\u{1F1FE}", "\u{1F1EE}\u{1F1F6}",
    "\u{1F1F5}\u{1F1F8}",
  ],
  "ukraine-russia": [
    "ukraine", "ukrainian", "ukrainians", "kyiv", "kiev", "zelensky",
    "zelenskyy", "kharkiv", "kharkov", "odesa", "odessa", "kherson",
    "mykolaiv", "zaporizhzhia", "zaporozhye", "bakhmut", "avdiivka",
    "pokrovsk", "kupyansk", "chasiv yar", "sumy", "chernihiv", "lviv",
    "dnipro", "kramatorsk", "mariupol", "donbas", "donetsk", "luhansk",
    "crimea", "sevastopol", "kerch", "azov brigade",
    "russia", "russian", "russians", "moscow", "kremlin", "putin", "lavrov",
    "medvedev", "shoigu", "gerasimov", "rosgvardia", "wagner", "kadyrov",
    "belgorod", "kursk", "bryansk", "rostov", "kaliningrad",
    "belarus", "belarusian", "minsk", "lukashenko",
    "special military operation",
    "اوكرانيا", "اوكراني", "كييف", "زيلينسكي", "خاركيف", "خاركوف",
    "اوديسا", "خيرسون", "نيكولايف", "زابوريجيا", "باخموت", "افدييفكا",
    "بوكروفسك", "سومي", "لفيف", "دنيبرو", "كراماتورسك", "ماريوبول",
    "دونباس", "دونيتسك", "لوغانسك", "القرم", "سيفاستوبول",
    "روسيا", "روسي", "موسكو", "الكرملين", "بوتين", "لافروف", "مدفيديف",
    "شويغو", "فاغنر", "قديروف", "بيلغورود", "كورسك", "روستوف",
    "كالينينغراد", "بيلاروسيا", "بيلاروسي", "مينسك", "لوكاشينكو",
    "\u{1F1F7}\u{1F1FA}", "\u{1F1FA}\u{1F1E6}", "\u{1F1E7}\u{1F1FE}",
  ],
  "china-taiwan": [
    "china", "chinese", "beijing", "xi jinping", "wang yi",
    "prc", "people's liberation army", "pla navy", "plaaf", "plagf",
    "communist party of china", "chinese communist party", "ccp",
    "hong kong", "xinjiang", "uyghur", "uighur", "tibet",
    "taiwan", "taiwanese", "taipei", "lai ching-te", "tsai ing-wen",
    "lin chia-lung", "kuomintang", "taiwan strait", "kinmen", "matsu",
    "penghu", "tsmc",
    "south china sea", "spratly", "paracel", "scarborough shoal",
    "second thomas shoal", "sabina shoal", "pratas", "bashi channel",
    "luzon strait", "miyako strait", "median line",
    "senkaku", "diaoyu", "first island chain",
    "الصين", "صيني", "بكين", "شي جين بينغ", "وانغ يي",
    "جيش التحرير الشعبي", "الحزب الشيوعي الصيني", "هونغ كونغ",
    "شينجيانغ", "الايغور", "التبت",
    "تايوان", "تايواني", "تايبيه", "مضيق تايوان", "كينمن",
    "بحر الصين الجنوبي", "سبراتلي", "سكاربورو", "مضيق لوزون",
    "\u{1F1E8}\u{1F1F3}", "\u{1F1F9}\u{1F1FC}",
  ],
};

// Terms that are real signal for a theatre but cannot claim it alone, because
// each one was measured pulling in rows from somewhere else entirely. These
// count only in a row that an anchor has already claimed, where they do no
// harm, so they are kept for the auditable reason trail rather than dropped.
//
// Every entry here is a measured leak, not a guess:
//   "north korea", "pyongyang", "kim jong" -> a DPRK missile launch and a
//     Trump/Kim meeting item landed on the China/Taiwan tab.
//   "adiz" -> a Russian aircraft in South Korea's ADIZ landed on China/Taiwan.
//   "plan" -> matched PLA Navy's abbreviation against an insurance plan, an AI
//     policy plan and a Gaza plan.
//   "semiconductor" -> a semiconductor analyst posting AI model comparisons.
//   "quad" -> matched inside Ukrainian drone-strike prose.
//   "shanghai" -> matched the Shanghai Cooperation Organisation, a multilateral
//     bloc whose summits in Bishkek and New Delhi are not this theatre.
//   "nato", "strait", "port", "red sea", "saudi", "fpv" -> generic enough to
//     appear in any theatre's reporting, or in none.
//TUNE: Control the (conflict supporting terms). Terms that add signal only to a row an anchor already claimed.
const SUPPORTING: Record<AssignedConflict, string[]> = {
  "iran-us": [
    "centcom", "fifth fleet", "sixth fleet", "strait of hormuz", "persian gulf",
    "red sea", "saudi", "riyadh", "jazan", "najran", "abha", "khamis mushait",
    "aramco", "pmf", "arak", "iaea", "nuclear deal", "snapback",
    "مضيق هرمز", "البحر الاحمر", "السعوديه", "الرياض", "ارامكو",
    "جيزان", "نجران", "ابها", "خميس مشيط",
    "\u{1F1F8}\u{1F1E6}", "\u{1F1F8}\u{1F1FE}",
  ],
  "ukraine-russia": [
    "nato", "himars", "atacms", "storm shadow", "iskander", "kinzhal",
    "kalibr", "geran", "shahed", "lancet", "orlan", "fpv", "afu", "vsu",
    "dpr", "lpr", "duma", "svo", "black sea", "counteroffensive",
    "الناتو", "البحر الاسود", "الدوما", "هيمارس", "اسكندر",
  ],
  "china-taiwan": [
    "indo-pacific", "aukus", "quad", "adiz", "semiconductor", "chip export",
    "island chain", "north korea", "pyongyang", "kim jong", "dprk",
    "south korea", "seoul", "japan", "tokyo", "philippines", "manila",
    "shanghai", "shanghai cooperation", "sco summit", "brics",
    "المحيطين الهندي والهادي", "كوريا الشماليه", "بيونغيانغ",
    "كوريا الجنوبيه", "سيول", "اليابان", "طوكيو", "الفلبين", "شنغهاي",
  ],
};

// A channel whose entire editorial remit is one theatre makes every one of its
// posts on-topic, including the ones too terse to carry any term at all ("All
// clear, alerts ended"). Only unambiguous single-theatre channels belong here;
// a general monitor must be left to the text so the tab keeps meaning
// something.
//TUNE: Control the (channel conflict binding). Telegram channels whose every post is assigned to one conflict.
const CHANNEL_BINDING: Record<AssignedConflict, string[]> = {
  "iran-us": ["RocketAlert", "idkunim_il"],
  "ukraine-russia": ["ukr_leaks_eng"],
  "china-taiwan": [],
};

export const ASSIGNABLE_CONFLICTS = Object.keys(ANCHORS) as AssignedConflict[];

interface CompiledTerm {
  label: string;
  match: (normalized: string) => boolean;
}

// A term is either a word term or a glyph term, decided by whether normalize
// leaves anything behind. Word terms are tested against the folded text through
// the classifier's own matcher, which gives Latin terms word boundaries: as a
// bare substring "china" matched "machinations" and "nato" matched "senator",
// which is the leak this module exists to stop. Glyph terms are emoji flags,
// which normalize deletes entirely, so those alone are tested as a raw
// substring. A word term is never substring-matched.
function compile(terms: string[]): { words: CompiledTerm[]; glyphs: string[] } {
  const words: CompiledTerm[] = [];
  const glyphs: string[] = [];
  for (const label of terms) {
    if (normalize(label)) words.push({ label, match: buildMatcher(label) });
    else glyphs.push(label);
  }
  return { words, glyphs };
}

// Compiled once at module load. buildMatcher builds a RegExp per term, and the
// backfill calls this for every row in the table.
const COMPILED_ANCHORS = new Map(ASSIGNABLE_CONFLICTS.map((k) => [k, compile(ANCHORS[k])]));
const COMPILED_SUPPORTING = new Map(ASSIGNABLE_CONFLICTS.map((k) => [k, compile(SUPPORTING[k])]));
const CHANNEL_LOOKUP = new Map<string, AssignedConflict>();
for (const key of ASSIGNABLE_CONFLICTS) {
  for (const channel of CHANNEL_BINDING[key]) {
    CHANNEL_LOOKUP.set(channel.toLowerCase(), key);
  }
}

export interface ConflictAssignInput {
  title?: string | null;
  content?: string | null;
  /** Telegram channel id, or an RSS feed key. Only telegram channels bind. */
  sourceUid?: string | null;
  source?: string | null;
}

export interface ConflictAssignResult {
  conflicts: AssignedConflict[];
  /** The single legacy value, derived from the array so the two cannot disagree. */
  conflict: AssignedConflict | null;
  reason: {
    version: number;
    /** Anchor terms hit, per assigned conflict. This is why the row is on that tab. */
    anchors: Record<string, string[]>;
    /** Supporting terms hit in a row an anchor already claimed. */
    supporting: Record<string, string[]>;
    /** Set when a single-theatre channel assigned the row with no term hit. */
    channel: string | null;
  };
}

//TUNE: Control the (reason trail size). Matched terms recorded per conflict for the audit trail.
const MAX_REASON_TERMS = 8;

export function assignConflicts(input: ConflictAssignInput): ConflictAssignResult {
  const rawTitle = (input.title || "").slice(0, MAX_SCAN_CHARS);
  const rawContent = (input.content || "").slice(0, MAX_SCAN_CHARS);

  // Emoji flags are anchors, and normalize() strips everything that is not a
  // letter or a number, which deletes them. So the flag terms are tested
  // against the raw text and the word terms against the folded text.
  const raw = `${rawTitle} ${rawContent}`;
  const folded = normalize(raw);
  // See FLAG_DATELINE_MAX_CHARS: a flag is a dateline only on a terse post.
  const flagsCount = raw.trim().length <= FLAG_DATELINE_MAX_CHARS;

  const anchors: Record<string, string[]> = {};
  const supporting: Record<string, string[]> = {};
  const assigned: AssignedConflict[] = [];

  for (const key of ASSIGNABLE_CONFLICTS) {
    const compiled = COMPILED_ANCHORS.get(key);
    const hits: string[] = [];
    for (const term of compiled?.words ?? []) {
      if (term.match(folded)) hits.push(term.label);
    }
    if (flagsCount) {
      for (const glyph of compiled?.glyphs ?? []) {
        if (raw.includes(glyph)) hits.push(glyph);
      }
    }
    if (hits.length === 0) continue;
    assigned.push(key);
    anchors[key] = hits.slice(0, MAX_REASON_TERMS);

    const soft = COMPILED_SUPPORTING.get(key);
    const softHits: string[] = [];
    for (const term of soft?.words ?? []) {
      if (term.match(folded)) softHits.push(term.label);
    }
    for (const glyph of soft?.glyphs ?? []) {
      if (raw.includes(glyph)) softHits.push(glyph);
    }
    if (softHits.length > 0) supporting[key] = softHits.slice(0, MAX_REASON_TERMS);
  }

  // The channel binding is a fallback, not an override: a bound channel that
  // posts about another theatre keeps the theatre its text names, and only a
  // post with no term at all falls back to the channel's own remit.
  let channel: string | null = null;
  if (assigned.length === 0 && (input.source ?? "telegram") === "telegram") {
    const bound = CHANNEL_LOOKUP.get(String(input.sourceUid ?? "").toLowerCase());
    if (bound) {
      assigned.push(bound);
      channel = input.sourceUid ?? null;
    }
  }

  return {
    conflicts: assigned,
    // Derived, never stored independently. See the note on items.conflict.
    conflict: assigned[0] ?? null,
    reason: {
      version: CONFLICT_ASSIGN_VERSION,
      anchors,
      supporting,
      channel,
    },
  };
}
