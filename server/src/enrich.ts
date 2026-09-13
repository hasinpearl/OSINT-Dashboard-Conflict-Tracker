// Rules-only classifier. No network, no model, no cost. Keep it that way:
// anything in here runs synchronously per row during ingest and during backfill.

export const EVENT_TYPES = [
  "informational",
  "airstrike",
  "hostile_uav",
  "rocket",
  "ground_movement",
  "naval",
  "nuclear_wmd",
  "interception",
  "explosion",
  "shelling",
  "humanitarian",
  "diplomatic",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export const SEVERITIES = ["low", "medium", "high", "critical"] as const;

export type Severity = (typeof SEVERITIES)[number];

//TUNE: Control the (classifier version). Bump when rules change so a backfill can target stale rows.
export const ENRICH_VERSION = 2;

export interface EnrichInput {
  title?: string | null;
  content?: string | null;
  publishedAt?: Date | string | null;
}

export interface EnrichResult {
  event_type: EventType;
  severity: Severity;
  is_breaking: boolean;
  lang: "ar" | "en";
  enrichment: {
    classifier: "rules";
    version: number;
    lang: "ar" | "en";
    event_type: EventType;
    event_type_score: number;
    severity: Severity;
    is_breaking: boolean;
    reason: {
      type_matches: string[];
      runner_up: { event_type: EventType; score: number } | null;
      severity_steps: string[];
      breaking_steps: string[];
      off_domain: boolean;
    };
  };
}

const ARABIC_RANGE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
const ARABIC_LETTER = /[\u0621-\u064A\u0660-\u0669\u06F0-\u06F9]/;
const TASHKEEL = /[\u064B-\u0652\u0653-\u0655\u0670\u0640]/g;

//TUNE: Control the (arabic detection). Share of Arabic letters in the text above which the item is treated as Arabic.
const ARABIC_LANG_RATIO = 0.15;

//TUNE: Control the (text budget). Characters of title+content the classifier reads, keeps cost flat on long articles.
const MAX_SCAN_CHARS = 4000;

//TUNE: Control the (mass casualty threshold). Casualty count at or above which severity gains a step.
const MASS_CASUALTY_COUNT = 10;

//TUNE: Control the (breaking window). Minutes after published_at that an item may still be flagged breaking.
const BREAKING_FRESH_MINUTES = 180;

//TUNE: Control the (title weight). Multiplier applied to keyword hits found in the title rather than the body.
const TITLE_WEIGHT = 2;

const EN_STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "for", "from",
  "had", "has", "have", "he", "her", "his", "in", "into", "is", "it", "its",
  "of", "on", "or", "over", "said", "says", "she", "that", "the", "their",
  "them", "there", "these", "they", "this", "to", "was", "were", "who", "will",
  "with", "you", "your", "after", "more", "than", "when", "what", "how", "new",
]);

const AR_STOPWORDS = new Set([
  "من", "في", "على", "الى", "إلى", "عن", "مع", "هذا", "هذه", "ذلك", "التي",
  "الذي", "الذين", "ما", "لا", "ان", "أن", "إن", "كان", "كانت", "قد", "بعد",
  "قبل", "بين", "عند", "كما", "او", "أو", "ثم", "حتى", "كل", "بعض", "غير",
  "هو", "هي", "هم", "نحن", "انه", "أنه", "وقال", "قال", "قالت", "الى", "لدى",
]);

function normalizeArabic(input: string): string {
  return input
    .replace(TASHKEEL, "")
    .replace(/[\u0622\u0623\u0625\u0627\u0671]/g, "\u0627")
    .replace(/\u0649/g, "\u064A")
    .replace(/\u0629/g, "\u0647")
    .replace(/\u0624/g, "\u0648")
    .replace(/\u0626/g, "\u064A");
}

function normalize(input: string): string {
  const stripped = input
    .normalize("NFD")
    .replace(/[\u0300-\u036F]/g, "")
    .toLowerCase();
  return normalizeArabic(stripped)
    .replace(/[\u200B-\u200F\u202A-\u202E]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function isArabicPattern(pattern: string): boolean {
  return ARABIC_RANGE.test(pattern);
}

function detectLang(raw: string): "ar" | "en" {
  const letters = raw.match(/\p{L}/gu);
  if (!letters || letters.length === 0) return "en";
  const arabic = letters.filter((ch) => ARABIC_LETTER.test(ch)).length;
  return arabic / letters.length >= ARABIC_LANG_RATIO ? "ar" : "en";
}

function tokenize(normalized: string, lang: "ar" | "en"): Set<string> {
  const stop = lang === "ar" ? AR_STOPWORDS : EN_STOPWORDS;
  const out = new Set<string>();
  for (const tok of normalized.split(" ")) {
    if (!tok || tok.length < 2) continue;
    if (stop.has(tok) || stop.has(normalizeArabic(tok))) continue;
    out.add(tok);
  }
  return out;
}

// Latin keywords match on word boundaries with a light plural allowance. Arabic
// keywords match as substrings on purpose: Arabic glues the article and
// conjunctions onto the stem (غارة -> والغارة), and these stems are long enough
// that substring matching does not collide across classes.
function buildMatcher(pattern: string): (normalized: string) => boolean {
  const needle = normalize(pattern);
  if (!needle) return () => false;
  if (isArabicPattern(pattern)) {
    return (text: string) => text.includes(needle);
  }
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:^| )${escaped}(?:s|es)?(?: |$)`, "u");
  return (text: string) => re.test(text);
}

interface Rule {
  weight: number;
  match: (normalized: string) => boolean;
  label: string;
}

function rules(weight: number, patterns: string[]): Rule[] {
  return patterns.map((p) => ({ weight, match: buildMatcher(p), label: p }));
}

// Ordered strongest signal first. Ties break by this order, so a rocket that was
// intercepted classifies as interception, and anything nuclear outranks all.
const TYPE_RULES: Array<{ type: EventType; rules: Rule[] }> = [
  {
    type: "nuclear_wmd",
    rules: [
      ...rules(6, [
        "nuclear", "nuke", "warhead", "uranium", "centrifuge", "enriched uranium",
        "dirty bomb", "radiological", "chemical weapon", "chemical attack",
        "sarin", "nerve agent", "biological weapon", "weapons of mass destruction",
        "نووي", "نوويه", "اليورانيوم", "تخصيب", "راس حربي", "سلاح كيميائي",
        "اسلحه الدمار الشامل", "مفاعل نووي",
      ]),
      ...rules(3, ["iaea", "non proliferation", "الوكاله الدوليه للطاقه الذريه"]),
    ],
  },
  {
    type: "interception",
    rules: [
      ...rules(6, [
        "intercepted", "interception", "shot down", "shoot down", "downed",
        "iron dome", "patriot battery", "thaad", "arrow 3", "air defence",
        "air defense", "s 300", "s 400", "counter drone", "neutralised in flight",
        "اعتراض", "اعترضت", "تم اعتراض", "اسقاط", "اسقطت", "الدفاعات الجويه",
        "القبه الحديديه", "منظومه الدفاع",
      ]),
    ],
  },
  {
    type: "hostile_uav",
    rules: [
      ...rules(6, [
        "drone", "drones", "uav", "unmanned aerial", "quadcopter", "shahed",
        "loitering munition", "kamikaze drone", "suicide drone", "fpv",
        "مسيره", "مسيرات", "طائره بدون طيار", "طائرات بدون طيار", "درون",
        "طائره مسيره",
      ]),
    ],
  },
  {
    type: "rocket",
    rules: [
      ...rules(6, [
        "rocket", "missile", "ballistic", "cruise missile", "hypersonic",
        "icbm", "mlrs", "katyusha", "grad rocket", "rocket alert", "red alert",
        "rocket barrage", "projectile",
        "صاروخ", "صواريخ", "صاروخيه", "باليستي", "كاتيوشا", "راجمات",
        "قصف صاروخي", "اطلاق صواريخ",
      ]),
    ],
  },
  {
    type: "airstrike",
    rules: [
      ...rules(6, [
        "airstrike", "air strike", "air strikes", "air raid", "aerial bombardment",
        "warplane", "fighter jet", "jets struck", "bombing raid", "sortie",
        "f 16", "f 35", "attack helicopter", "gunship",
        "غاره", "غارات", "قصف جوي", "ضربه جويه", "ضربات جويه", "طائرات حربيه",
        "سلاح الجو", "الطيران الحربي",
      ]),
      // Bare "strike" is ambiguous on its own, so it scores below a named class
      // and only wins when nothing more specific matched.
      ...rules(3, ["strike", "strikes", "struck", "ضربه", "ضربات"]),
    ],
  },
  {
    type: "shelling",
    rules: [
      ...rules(6, [
        "shelling", "shelled", "artillery", "mortar", "howitzer", "barrage",
        "artillery fire", "bombardment",
        "قصف مدفعي", "مدفعيه", "هاون", "قذائف", "قصف متبادل",
      ]),
    ],
  },
  {
    type: "explosion",
    rules: [
      ...rules(6, [
        "explosion", "explosions", "blast", "detonated", "detonation",
        "car bomb", "suicide bombing", "suicide attack", "ied", "vbied",
        "improvised explosive", "booby trap",
        "انفجار", "انفجارات", "تفجير", "عبوه ناسفه", "سياره مفخخه",
        "حزام ناسف", "دوي انفجار",
      ]),
      // Fire and smoke over a struck facility, with no named munition in the
      // report. Weaker than a named class so a known munition still wins.
      ...rules(4, [
        "fires", "ablaze", "smoke columns", "smoke column", "engulfed in flames",
        "حرائق", "اعمده دخان", "النيران",
      ]),
    ],
  },
  {
    type: "naval",
    rules: [
      ...rules(6, [
        "naval", "warship", "frigate", "destroyer", "aircraft carrier",
        "submarine", "naval blockade", "maritime", "flotilla", "shipping lane",
        "port strike",
        "بحري", "بحريه", "سفينه", "سفن", "ناقله", "ناقلات", "اسطول",
        "غواصه", "فرقاطه", "حامله طائرات", "حصار بحري",
      ]),
      // A strait or a port is often named as background geography, so these
      // only decide the class when nothing stronger matched.
      ...rules(3, [
        "strait", "tanker", "vessel", "coast guard", "cargo ship", "port",
        "مضيق", "ميناء", "خفر السواحل",
      ]),
    ],
  },
  {
    type: "ground_movement",
    rules: [
      ...rules(6, [
        "ground offensive", "ground forces", "ground operation", "incursion",
        "seized", "seize", "captured", "recaptured", "retook", "advance",
        "advanced", "armoured column", "armored column", "tanks", "infantry",
        "clashes", "clash", "firefight", "front line", "frontline",
        "troop deployment", "deployed troops", "withdrawal", "mutiny",
        "looting", "looted", "mobilizing", "mobilising", "positions",
        "established control", "establishing control", "underground network",
        "underground infrastructure", "tunnel", "tunnels", "weapons depot",
        "weapons depots", "command centre", "command center", "command centers",
        "command complex",
        "قوات بريه", "عمليه بريه", "اقتحام", "سيطرت", "تقدم", "اجتياح",
        "مدرعات", "اشتباكات", "جبهه", "انسحاب", "تمشيط", "مواقع", "نهب",
        "انفاق", "نفق", "مستودع اسلحه", "غرفه عمليات", "معارك", "معركه",
        "قتال", "استهداف قاعده",
      ]),
    ],
  },
  {
    type: "humanitarian",
    rules: [
      ...rules(6, [
        "humanitarian", "aid convoy", "humanitarian aid", "refugee", "refugees",
        "displaced", "displacement", "famine", "starvation", "evacuation",
        "evacuated", "relief effort", "shelter", "unhcr", "wfp", "red cross",
        "red crescent", "search and rescue", "rescuers", "death toll",
        "capsized", "capsizes", "ferry", "sinks", "sank", "wildfire",
        "earthquake", "magnitude", "epicenter", "epicentre", "aftershock",
        "flooding", "nursing home fire",
        "انساني", "انسانيه", "مساعدات", "لاجئين", "نازحين", "اغاثه", "مجاعه",
        "اخلاء", "ضحايا مدنيين", "الهلال الاحمر", "البحث والانقاذ",
        "حصيله الضحايا", "زلزال", "حرائق", "غرق", "عباره", "فيضانات",
        "نزوح", "نزحوا", "نزح", "مخيم", "مخيمات", "الامم المتحده",
      ]),
    ],
  },
  {
    type: "diplomatic",
    rules: [
      ...rules(6, [
        "ceasefire", "cease fire", "truce", "negotiation", "negotiations",
        "peace talks", "talks", "summit", "sanctions", "treaty", "accord",
        "envoy", "ambassador", "embassy", "diplomatic", "diplomacy",
        "foreign minister", "security council", "resolution", "condemned",
        "condemnation", "joint statement", "bilateral", "delegation",
        "border crossing", "border crossings", "closed the border",
        "مفاوضات", "وقف اطلاق النار", "هدنه", "قمه", "عقوبات", "اتفاق",
        "مبعوث", "دبلوماسي", "دبلوماسيه", "سفاره", "سفير", "وزير الخارجيه",
        "مجلس الامن", "بيان مشترك", "استنكار", "معبر", "المعابر الحدوديه",
      ]),
    ],
  },
];

// Off-domain content dominates general news feeds. Without this guard sports and
// entertainment items pick up kinetic verbs ("clash", "strike") and pollute the
// panels.
const OFF_DOMAIN_RULES = rules(1, [
  "premier league", "champions league", "asia cup", "world cup", "derby",
  "match preview", "kick off", "goalkeeper", "striker scored", "cricket",
  "tennis", "roland garros", "olympic", "olympics", "nba", "fifa",
  "box office", "album", "concert", "netflix", "marvel", "starcraft",
  "video game", "gameplay", "trailer", "celebrity", "yogurt", "recipe",
  "drone display", "drone show", "light show", "memorial display",
  "دوري", "مباره", "مباريات", "هدف قاتل", "الاولمبياد", "كاس العالم",
  "حفل", "فيلم", "مسلسل", "الشعله الاولمبيه", "ريال مدريد", "برشلونه",
  "مهرجان", "جائزه", "الدوري الاسباني", "كره القدم", "المنتخب",
]);

const CASUALTY_RULES = rules(1, [
  "killed", "dead", "death", "deaths", "fatalities", "died", "casualties",
  "death toll", "massacre", "wounded", "injured", "bodies",
  "قتل", "قتلى", "قتيل", "مقتل", "وفاه", "وفيات", "ضحايا", "جرحى", "مصابين",
  "اصابات", "حصيله", "صرعى",
]);

const NO_CASUALTY_RULES = rules(1, [
  "no casualties", "no injuries", "no one was hurt", "nobody was hurt",
  "no reported casualties", "without casualties",
  "دون اصابات", "لا اصابات", "بدون خسائر بشريه", "دون وقوع اصابات",
]);

const STRATEGIC_TARGET_RULES = rules(1, [
  "oil pipeline", "pipeline", "refinery", "oil field", "power grid",
  "power plant", "nuclear plant", "airport", "air base", "airbase",
  "military base", "port", "capital city", "parliament", "presidential palace",
  "خط انابيب", "مصفاه", "حقل نفط", "شبكه الكهرباء", "محطه نوويه", "مطار",
  "قاعده جويه", "قاعده عسكريه", "ميناء", "القصر الرئاسي",
]);

const ESCALATION_RULES = rules(1, [
  "escalation", "escalated", "declared war", "state of emergency",
  "full scale war", "retaliatory strike", "retaliation", "mobilisation",
  "mobilization", "unprecedented", "all out war",
  "تصعيد", "حاله طوارئ", "اعلان الحرب", "تعبئه", "حرب شامله", "رد انتقامي",
]);

const ANALYSIS_RULES = rules(1, [
  "analysis", "opinion", "explainer", "what to know", "takeaways",
  "why it matters", "profile", "interview", "review", "newsletter",
  "تحليل", "راي", "مقابله", "قراءه في", "خلفيه",
]);

const BREAKING_MARKER_RULES = rules(1, [
  "breaking", "breaking news", "just in", "urgent", "developing story",
  "alert", "update",
  "عاجل", "خبر عاجل", "تحديث عاجل", "تنبيه",
]);

const BREAKING_GLYPHS = /[\u26A1\u{1F6A8}\u{1F534}\u203C\u2757]/u;

const SEVERITY_BASE: Record<EventType, Severity> = {
  informational: "low",
  diplomatic: "low",
  humanitarian: "medium",
  hostile_uav: "medium",
  interception: "medium",
  naval: "medium",
  ground_movement: "medium",
  airstrike: "high",
  rocket: "high",
  shelling: "high",
  explosion: "high",
  nuclear_wmd: "high",
};

function stepSeverity(current: Severity, delta: number): Severity {
  const idx = SEVERITIES.indexOf(current);
  const next = Math.min(Math.max(idx + delta, 0), SEVERITIES.length - 1);
  return SEVERITIES[next];
}

function anyMatch(ruleSet: Rule[], text: string): string[] {
  const hits: string[] = [];
  for (const rule of ruleSet) {
    if (rule.match(text)) hits.push(rule.label);
  }
  return hits;
}

function maxCasualtyCount(normalized: string, tokens: Set<string>): number {
  let max = 0;
  for (const tok of tokens) {
    if (!/^\d+$/.test(tok)) continue;
    const n = Number(tok);
    if (Number.isFinite(n) && n > max && n < 1_000_000) max = n;
  }
  if (max === 0) {
    const m = normalized.match(/\b(\d{1,6})\b/);
    if (m) max = Number(m[1]);
  }
  return max;
}

function toArabicSafeDigits(input: string): string {
  return input.replace(/[\u0660-\u0669\u06F0-\u06F9]/g, (ch) => {
    const code = ch.charCodeAt(0);
    const base = code >= 0x06f0 ? 0x06f0 : 0x0660;
    return String(code - base);
  });
}

export function classify(input: EnrichInput): EnrichResult {
  const rawTitle = (input.title || "").slice(0, MAX_SCAN_CHARS);
  const rawContent = (input.content || "").slice(0, MAX_SCAN_CHARS);
  const rawAll = `${rawTitle} ${rawContent}`;
  const lang = detectLang(rawAll);

  const title = normalize(toArabicSafeDigits(rawTitle));
  const content = normalize(toArabicSafeDigits(rawContent));
  const all = `${title} ${content}`.trim();
  const tokens = tokenize(all, lang);

  const scores: Array<{ type: EventType; score: number; matches: string[] }> = [];
  for (const group of TYPE_RULES) {
    let score = 0;
    const matches: string[] = [];
    for (const rule of group.rules) {
      const inTitle = title ? rule.match(title) : false;
      const inBody = content ? rule.match(content) : false;
      if (!inTitle && !inBody) continue;
      score += inTitle ? rule.weight * TITLE_WEIGHT : rule.weight;
      matches.push(rule.label);
    }
    if (score > 0) scores.push({ type: group.type, score, matches });
  }

  const offDomainHits = anyMatch(OFF_DOMAIN_RULES, all);
  const offDomainTitleHits = title ? anyMatch(OFF_DOMAIN_RULES, title) : [];
  const analysisHits = anyMatch(ANALYSIS_RULES, all);
  const offDomain = offDomainHits.length > 0;

  scores.sort((a, b) => b.score - a.score);
  let winner = scores[0];
  let runnerUp = scores[1] || null;

  const casualtyPresent = anyMatch(CASUALTY_RULES, all).length > 0;

  // Diplomatic language describes the frame around an event ("despite a
  // ceasefire"), so a report with casualties and a kinetic class underneath it
  // belongs in the kinetic class.
  if (
    winner &&
    winner.type === "diplomatic" &&
    casualtyPresent &&
    runnerUp &&
    runnerUp.type !== "diplomatic"
  ) {
    const demoted = winner;
    winner = runnerUp;
    runnerUp = demoted;
  }

  // A humanitarian consequence named in the title is the subject of the item,
  // even when the body explains the fighting that caused it.
  const humanitarianGroup = TYPE_RULES.find((g) => g.type === "humanitarian");
  if (
    winner &&
    winner.type !== "humanitarian" &&
    title &&
    humanitarianGroup &&
    humanitarianGroup.rules.some((r) => r.match(title))
  ) {
    const humanitarianScore = scores.find((s) => s.type === "humanitarian");
    if (humanitarianScore) {
      runnerUp = winner;
      winner = humanitarianScore;
    }
  }

  let eventType: EventType = winner ? winner.type : "informational";
  const typeMatches = winner ? winner.matches : [];

  // Off-domain in the title is the framing of the whole item and overrides any
  // kinetic vocabulary in the body. Off-domain in the body alone only overrides
  // a weak kinetic score.
  //TUNE: Control the (off domain override). Type score below which body-only off-domain keywords force informational.
  const OFF_DOMAIN_OVERRIDE_SCORE = 12;
  if (offDomainTitleHits.length > 0) {
    eventType = "informational";
  } else if (offDomain && (!winner || winner.score < OFF_DOMAIN_OVERRIDE_SCORE)) {
    eventType = "informational";
  }

  let severity = SEVERITY_BASE[eventType];
  const severitySteps: string[] = [`base:${eventType}=${severity}`];

  const casualtyHits = anyMatch(CASUALTY_RULES, all);
  const noCasualtyHits = anyMatch(NO_CASUALTY_RULES, all);
  const strategicHits = anyMatch(STRATEGIC_TARGET_RULES, all);
  const escalationHits = anyMatch(ESCALATION_RULES, all);
  const casualtyCount = casualtyHits.length > 0 ? maxCasualtyCount(all, tokens) : 0;

  if (eventType === "informational") {
    if (casualtyHits.length > 0 && !offDomain) {
      severity = stepSeverity(severity, 1);
      severitySteps.push(`casualty_language:${casualtyHits[0]}`);
    }
  } else {
    if (noCasualtyHits.length > 0) {
      severity = stepSeverity(severity, -1);
      severitySteps.push(`no_casualties:${noCasualtyHits[0]}`);
    } else if (casualtyHits.length > 0) {
      severity = stepSeverity(severity, 1);
      severitySteps.push(`casualty_language:${casualtyHits[0]}`);
      if (casualtyCount >= MASS_CASUALTY_COUNT) {
        severity = stepSeverity(severity, 1);
        severitySteps.push(`mass_casualty:${casualtyCount}`);
      }
    }
    if (strategicHits.length > 0) {
      severity = stepSeverity(severity, 1);
      severitySteps.push(`strategic_target:${strategicHits[0]}`);
    }
    if (escalationHits.length > 0) {
      severity = stepSeverity(severity, 1);
      severitySteps.push(`escalation:${escalationHits[0]}`);
    }
    if (eventType === "nuclear_wmd" && (casualtyHits.length > 0 || escalationHits.length > 0)) {
      severity = "critical";
      severitySteps.push("nuclear_with_attack_context");
    }
  }

  if (analysisHits.length > 0 && severity !== "low") {
    severity = stepSeverity(severity, -1);
    severitySteps.push(`analysis_piece:${analysisHits[0]}`);
  }

  if (offDomain && eventType === "informational") {
    severity = "low";
    severitySteps.push(`off_domain:${offDomainHits[0]}`);
  }

  const breakingSteps: string[] = [];
  const markerHits = anyMatch(BREAKING_MARKER_RULES, all);
  const glyphHit = BREAKING_GLYPHS.test(rawAll);
  const publishedAt = input.publishedAt ? new Date(input.publishedAt) : null;
  const ageMinutes =
    publishedAt && !Number.isNaN(publishedAt.getTime())
      ? (Date.now() - publishedAt.getTime()) / 60000
      : null;
  const fresh = ageMinutes === null || ageMinutes <= BREAKING_FRESH_MINUTES;

  let isBreaking = false;
  if (!offDomain && eventType !== "informational" && fresh) {
    if (markerHits.length > 0) {
      isBreaking = true;
      breakingSteps.push(`marker:${markerHits[0]}`);
    } else if (glyphHit && severity !== "low") {
      isBreaking = true;
      breakingSteps.push("glyph_marker");
    } else if (severity === "critical") {
      isBreaking = true;
      breakingSteps.push("critical_and_fresh");
    }
    if (isBreaking && ageMinutes !== null) {
      breakingSteps.push(`age_minutes:${Math.round(ageMinutes)}`);
    }
  }
  if (!isBreaking) {
    if (offDomain) breakingSteps.push("suppressed_off_domain");
    else if (eventType === "informational") breakingSteps.push("suppressed_informational");
    else if (!fresh) breakingSteps.push(`suppressed_stale:${Math.round(ageMinutes as number)}m`);
    else breakingSteps.push("no_breaking_signal");
  }

  return {
    event_type: eventType,
    severity,
    is_breaking: isBreaking,
    lang,
    enrichment: {
      classifier: "rules",
      version: ENRICH_VERSION,
      lang,
      event_type: eventType,
      event_type_score: winner ? winner.score : 0,
      severity,
      is_breaking: isBreaking,
      reason: {
        type_matches: typeMatches.slice(0, 12),
        runner_up: runnerUp ? { event_type: runnerUp.type, score: runnerUp.score } : null,
        severity_steps: severitySteps,
        breaking_steps: breakingSteps,
        off_domain: offDomain,
      },
    },
  };
}
