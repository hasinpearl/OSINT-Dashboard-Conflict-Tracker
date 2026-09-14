// Place extraction. Pure, offline, no network and no model, same contract as
// enrich.ts: it runs per row and must stay cheap.
//
// The geocoder is only allowed to pin a place this module actually found in the
// text. Free-text geocoding is not safe on its own: Nominatim answers
// q="Gaza City"&limit=1 with a village in Tibet, and q="Rafah" with a village
// in Syria. So every name here carries the country it is expected to resolve
// in, and the worker rejects any hit that lands somewhere else. A name that is
// not in this table produces no pin at all.

export type PlaceKind = "settlement" | "admin" | "country" | "water";

export interface PlaceEntry {
  id: string;
  // First entry is the query sent to Nominatim. The rest are surface forms
  // matched in the text, including Arabic.
  names: string[];
  // Expected ISO 3166-1 alpha-2. A hit outside it is a different place with the
  // same name, so it is discarded. null only for open water, which Nominatim
  // returns with no country.
  cc: string | null;
  kind: PlaceKind;
  // Region label stored on the pin. Only set where the text genuinely implies
  // it, never guessed from the country.
  region?: string;
  // Tested against the RAW text, before normalization. Needed where stripping
  // Arabic diacritics would merge two different places: عُمان (Oman) and
  // عمّان (Amman) both normalize to عمان. Without the raw form there is no
  // evidence which one the item means, so the entry produces no hit.
  rawRequires?: RegExp;
  // National capitals double as metonyms for their governments ("Tehran closed
  // the strait"). See demoteMetonyms.
  capital?: boolean;
}

// Specificity decides which named place becomes the pin when an item names
// several: a city outranks the country that contains it.
const KIND_SPECIFICITY: Record<PlaceKind, number> = {
  settlement: 4,
  admin: 3,
  water: 2,
  country: 1,
};

const TASHKEEL = /[\u064B-\u0652\u0653-\u0655\u0670\u0640]/g;
const ARABIC_LETTER = /[\u0621-\u064A]/;

function normalizeArabic(input: string): string {
  return input
    .replace(TASHKEEL, "")
    .replace(/[\u0622\u0623\u0625\u0627\u0671]/g, "\u0627")
    .replace(/\u0649/g, "\u064A")
    .replace(/\u0629/g, "\u0647")
    .replace(/\u0624/g, "\u0648")
    .replace(/\u0626/g, "\u064A");
}

export function normalizePlaceText(input: string): string {
  const stripped = input
    .normalize("NFD")
    .replace(/[\u0300-\u036F]/g, "")
    .toLowerCase();
  return normalizeArabic(stripped)
    .replace(/[\u200B-\u200F\u202A-\u202E]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isArabic(text: string): boolean {
  return ARABIC_LETTER.test(text);
}

// Arabic glues proclitics onto the stem, so a bare substring test is needed for
// prefixes but must not run past the end of the word: إيران (Iran, a place) sits
// inside إيرانية (Iranian, a demonym). A demonym is context, not a named place,
// and pinning one would be the inference the spec forbids.
//TUNE: Control the (arabic proclitics). Prefixes allowed to precede a matched Arabic place name.
const AR_PROCLITICS = ["", "\u0627\u0644", "\u0648", "\u0648\u0627\u0644", "\u0628", "\u0628\u0627\u0644", "\u0644", "\u0644\u0644", "\u0641", "\u0643"];

function arabicMatchIndex(haystack: string, needle: string): number {
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return -1;
    const after = haystack[at + needle.length];
    const endOk = after === undefined || !ARABIC_LETTER.test(after);
    let startOk = false;
    if (endOk) {
      for (const proclitic of AR_PROCLITICS) {
        const start = at - proclitic.length;
        if (start < 0) continue;
        if (haystack.slice(start, at) !== proclitic) continue;
        const before = haystack[start - 1];
        if (before === undefined || !ARABIC_LETTER.test(before)) {
          startOk = true;
          break;
        }
      }
    }
    if (endOk && startOk) return at;
    from = at + 1;
  }
}

function latinMatchIndex(haystack: string, needle: string): number {
  const padded = ` ${haystack} `;
  const at = padded.indexOf(` ${needle} `);
  return at < 0 ? -1 : at;
}

function matchIndex(haystack: string, surface: string): number {
  const needle = normalizePlaceText(surface);
  if (!needle) return -1;
  return isArabic(needle)
    ? arabicMatchIndex(haystack, needle)
    : latinMatchIndex(haystack, needle);
}

// Names that are a place on paper but in news copy almost always refer to an
// organisation, a competition or a person. Pinning these is how a map starts
// lying, so a hit is only kept when the name appears without its decoy phrase.
const DECOYS: Array<{ place: string; phrases: string[] }> = [
  { place: "ireland", phrases: ["united ireland", "unified ireland", "irish unification", "ireland squad"] },
  { place: "new york", phrases: ["new york times", "new york mayor", "new york post"] },
  { place: "washington", phrases: ["washington post"] },
  { place: "madrid", phrases: ["real madrid", "atletico madrid", "ريال مدريد", "اتلتيكو مدريد"] },
  { place: "manchester", phrases: ["manchester united", "manchester city", "premier league"] },
  { place: "java", phrases: ["javascript"] },
  { place: "dubai", phrases: ["dubai duty free"] },
  // A political label, not a location: "Pro-China parties in Okinawa" is an
  // item about Japan.
  { place: "china", phrases: ["pro china", "anti china", "china hawk", "china policy"] },
  { place: "russia", phrases: ["pro russia", "anti russia", "russia policy"] },
  { place: "iran", phrases: ["pro iran", "iran backed", "iran aligned"] },
];

export const GAZETTEER: PlaceEntry[] = [
  // Israel and the Palestinian territories
  { id: "gaza_city", names: ["Gaza City", "مدينة غزة"], cc: "ps", kind: "settlement", region: "Gaza" },
  { id: "gaza", names: ["Gaza", "غزة", "قطاع غزة", "Gaza Strip"], cc: "ps", kind: "admin", region: "Gaza" },
  { id: "khan_younis", names: ["Khan Yunis", "Khan Younis", "خان يونس"], cc: "ps", kind: "settlement", region: "Gaza" },
  { id: "rafah", names: ["Rafah", "رفح"], cc: "ps", kind: "settlement", region: "Gaza" },
  { id: "west_bank", names: ["West Bank", "الضفة الغربية"], cc: "ps", kind: "admin", region: "West Bank" },
  { id: "ramallah", names: ["Ramallah", "رام الله"], cc: "ps", kind: "settlement", region: "West Bank" },
  { id: "jenin", names: ["Jenin", "جنين"], cc: "ps", kind: "settlement", region: "West Bank" },
  { id: "hebron", names: ["Hebron", "الخليل"], cc: "ps", kind: "settlement", region: "West Bank" },
  { id: "jerusalem", names: ["Jerusalem", "القدس"], cc: "il", kind: "settlement", capital: true },
  { id: "tel_aviv", names: ["Tel Aviv", "تل أبيب"], cc: "il", kind: "settlement" },
  { id: "haifa", names: ["Haifa", "حيفا"], cc: "il", kind: "settlement" },
  { id: "israel", names: ["Israel", "إسرائيل"], cc: "il", kind: "country" },

  // Lebanon, Syria, Jordan
  { id: "beirut", names: ["Beirut", "بيروت"], cc: "lb", kind: "settlement", capital: true },
  { id: "south_lebanon", names: ["South Lebanon", "جنوب لبنان", "الجنوب اللبناني"], cc: "lb", kind: "admin", region: "South Governorate" },
  { id: "lebanon", names: ["Lebanon", "لبنان"], cc: "lb", kind: "country" },
  { id: "damascus", names: ["Damascus", "دمشق"], cc: "sy", kind: "settlement", capital: true },
  { id: "aleppo", names: ["Aleppo", "حلب"], cc: "sy", kind: "settlement" },
  { id: "syria", names: ["Syria", "سوريا", "سورية"], cc: "sy", kind: "country" },
  { id: "amman", names: ["Amman", "عمّان"], cc: "jo", kind: "settlement", capital: true, rawRequires: /عمَّان|عمّان|\bAmman\b/i },
  { id: "jordan", names: ["Jordan", "الأردن"], cc: "jo", kind: "country" },

  // Iran and the Gulf
  { id: "tehran", names: ["Tehran", "طهران"], cc: "ir", kind: "settlement", capital: true },
  { id: "isfahan", names: ["Isfahan", "أصفهان"], cc: "ir", kind: "settlement" },
  { id: "bandar_abbas", names: ["Bandar Abbas", "بندر عباس"], cc: "ir", kind: "settlement" },
  { id: "iran", names: ["Iran", "إيران"], cc: "ir", kind: "country" },
  { id: "hormuz", names: ["Strait of Hormuz", "مضيق هرمز", "هرمز", "Hormuz"], cc: "om", kind: "water" },
  { id: "baghdad", names: ["Baghdad", "بغداد"], cc: "iq", kind: "settlement", capital: true },
  { id: "maysan", names: ["Maysan Governorate", "Maysan", "ميسان"], cc: "iq", kind: "admin" },
  { id: "iraq", names: ["Iraq", "العراق"], cc: "iq", kind: "country" },
  { id: "riyadh", names: ["Riyadh", "الرياض"], cc: "sa", kind: "settlement", capital: true },
  { id: "jeddah", names: ["Jeddah", "جدة"], cc: "sa", kind: "settlement" },
  { id: "saudi_arabia", names: ["Saudi Arabia", "السعودية", "المملكة العربية السعودية"], cc: "sa", kind: "country" },
  { id: "abu_dhabi", names: ["Abu Dhabi", "أبوظبي", "أبو ظبي"], cc: "ae", kind: "settlement", capital: true },
  { id: "dubai", names: ["Dubai", "دبي"], cc: "ae", kind: "settlement" },
  { id: "uae", names: ["United Arab Emirates", "الإمارات"], cc: "ae", kind: "country" },
  { id: "muscat", names: ["Muscat", "مسقط"], cc: "om", kind: "settlement", capital: true },
  { id: "oman", names: ["Oman", "عُمان", "سلطنة عمان", "سلطنة عُمان"], cc: "om", kind: "country" },
  { id: "doha", names: ["Doha", "الدوحة"], cc: "qa", kind: "settlement", capital: true },
  { id: "qatar", names: ["Qatar", "قطر"], cc: "qa", kind: "country" },
  { id: "bahrain", names: ["Bahrain", "البحرين"], cc: "bh", kind: "country" },
  { id: "kuwait", names: ["Kuwait", "الكويت"], cc: "kw", kind: "country" },

  // Yemen, Horn of Africa, Red Sea
  { id: "sanaa", names: ["Sana'a", "Sanaa", "صنعاء"], cc: "ye", kind: "settlement", capital: true },
  { id: "aden", names: ["Aden", "عدن"], cc: "ye", kind: "settlement" },
  { id: "hodeidah", names: ["Hodeidah", "الحديدة"], cc: "ye", kind: "settlement" },
  { id: "yemen", names: ["Yemen", "اليمن"], cc: "ye", kind: "country" },
  { id: "bab_al_mandab", names: ["Bab-el-Mandeb", "Bab al-Mandab", "Bab al-Mandeb", "باب المندب"], cc: null, kind: "water" },
  { id: "mayun", names: ["Perim", "Mayun Island", "Mayun", "جزيرة ميون", "ميون"], cc: "ye", kind: "settlement" },
  { id: "red_sea", names: ["Red Sea", "البحر الأحمر"], cc: null, kind: "water" },
  { id: "obock", names: ["Obock", "أوبوك"], cc: "dj", kind: "settlement" },
  { id: "djibouti", names: ["Djibouti", "جيبوتي"], cc: "dj", kind: "country" },
  { id: "khartoum", names: ["Khartoum", "الخرطوم"], cc: "sd", kind: "settlement", capital: true },
  { id: "sudan", names: ["Sudan", "السودان"], cc: "sd", kind: "country" },
  { id: "cairo", names: ["Cairo", "القاهرة"], cc: "eg", kind: "settlement", capital: true },
  { id: "egypt", names: ["Egypt", "مصر"], cc: "eg", kind: "country" },

  // Ukraine and Russia
  { id: "kyiv", names: ["Kyiv", "كييف"], cc: "ua", kind: "settlement", capital: true },
  { id: "odesa", names: ["Odesa", "Odessa", "أوديسا"], cc: "ua", kind: "settlement" },
  { id: "kharkiv", names: ["Kharkiv", "خاركيف"], cc: "ua", kind: "settlement" },
  { id: "ukraine", names: ["Ukraine", "أوكرانيا"], cc: "ua", kind: "country" },
  { id: "crimea", names: ["Crimea", "القرم", "شبه جزيرة القرم"], cc: "ua", kind: "admin" },
  { id: "donbas", names: ["Donbas", "Donbass", "دونباس"], cc: "ua", kind: "admin", region: "Donetsk Oblast" },
  { id: "black_sea", names: ["Black Sea", "البحر الأسود"], cc: null, kind: "water" },
  { id: "kursk", names: ["Kursk", "كورسك"], cc: "ru", kind: "settlement" },
  { id: "moscow", names: ["Moscow", "موسكو"], cc: "ru", kind: "settlement", capital: true },
  { id: "russia", names: ["Russia", "روسيا"], cc: "ru", kind: "country" },

  // Europe
  { id: "dublin", names: ["Dublin", "دبلن"], cc: "ie", kind: "settlement", capital: true },
  { id: "ireland", names: ["Ireland", "أيرلندا", "إيرلندا"], cc: "ie", kind: "country" },
  { id: "london", names: ["London", "لندن"], cc: "gb", kind: "settlement", capital: true },
  { id: "uk", names: ["United Kingdom", "بريطانيا", "المملكة المتحدة"], cc: "gb", kind: "country" },
  { id: "paris", names: ["Paris", "باريس"], cc: "fr", kind: "settlement", capital: true },
  { id: "france", names: ["France", "فرنسا"], cc: "fr", kind: "country" },
  { id: "madrid", names: ["Madrid", "مدريد"], cc: "es", kind: "settlement", capital: true },
  { id: "spain", names: ["Spain", "إسبانيا", "أسبانيا"], cc: "es", kind: "country" },
  { id: "berlin", names: ["Berlin", "برلين"], cc: "de", kind: "settlement", capital: true },
  { id: "germany", names: ["Germany", "ألمانيا"], cc: "de", kind: "country" },
  { id: "rome", names: ["Rome", "روما"], cc: "it", kind: "settlement", capital: true },
  { id: "italy", names: ["Italy", "إيطاليا"], cc: "it", kind: "country" },
  { id: "sweden", names: ["Sweden", "السويد"], cc: "se", kind: "country" },
  { id: "poland", names: ["Poland", "بولندا"], cc: "pl", kind: "country" },
  { id: "netherlands", names: ["Netherlands", "هولندا"], cc: "nl", kind: "country" },
  { id: "brac", names: ["Brac", "Brač", "براتش"], cc: "hr", kind: "settlement" },
  { id: "croatia", names: ["Croatia", "كرواتيا"], cc: "hr", kind: "country" },
  { id: "vatican", names: ["Vatican City", "Vatican", "الفاتيكان"], cc: "va", kind: "country" },
  { id: "istanbul", names: ["Istanbul", "إستانبول", "اسطنبول"], cc: "tr", kind: "settlement" },
  { id: "ankara", names: ["Ankara", "أنقرة"], cc: "tr", kind: "settlement", capital: true },
  { id: "turkey", names: ["Turkey", "تركيا"], cc: "tr", kind: "country" },

  // Americas
  { id: "washington_dc", names: ["Washington, D.C.", "Washington DC", "واشنطن"], cc: "us", kind: "settlement", capital: true },
  { id: "new_york", names: ["New York City", "New York", "نيويورك"], cc: "us", kind: "settlement" },
  { id: "united_states", names: ["United States", "الولايات المتحدة", "أميركا"], cc: "us", kind: "country" },
  { id: "buenos_aires", names: ["Buenos Aires", "بوينس آيرس"], cc: "ar", kind: "settlement", capital: true },
  { id: "argentina", names: ["Argentina", "الأرجنتين"], cc: "ar", kind: "country" },
  { id: "chile", names: ["Chile", "تشيلي"], cc: "cl", kind: "country" },
  { id: "araucania", names: ["Araucania", "Araucanía", "أراوكانيا"], cc: "cl", kind: "admin" },

  // Asia and Oceania
  { id: "new_delhi", names: ["New Delhi", "نيودلهي", "نيو دلهي"], cc: "in", kind: "settlement", capital: true },
  { id: "mumbai", names: ["Mumbai", "مومباي"], cc: "in", kind: "settlement" },
  { id: "india", names: ["India", "الهند"], cc: "in", kind: "country" },
  { id: "islamabad", names: ["Islamabad", "إسلام آباد"], cc: "pk", kind: "settlement", capital: true },
  { id: "pakistan", names: ["Pakistan", "باكستان"], cc: "pk", kind: "country" },
  { id: "kabul", names: ["Kabul", "كابول", "كابل"], cc: "af", kind: "settlement", capital: true },
  { id: "afghanistan", names: ["Afghanistan", "أفغانستان"], cc: "af", kind: "country" },
  { id: "beijing", names: ["Beijing", "بكين"], cc: "cn", kind: "settlement", capital: true },
  { id: "china", names: ["China", "الصين"], cc: "cn", kind: "country" },
  { id: "taiwan", names: ["Taiwan", "تايوان"], cc: "tw", kind: "country" },
  { id: "taiwan_strait", names: ["Taiwan Strait", "مضيق تايوان"], cc: null, kind: "water" },
  { id: "south_china_sea", names: ["South China Sea", "بحر الصين الجنوبي"], cc: null, kind: "water" },
  { id: "tokyo", names: ["Tokyo", "طوكيو"], cc: "jp", kind: "settlement", capital: true },
  { id: "japan", names: ["Japan", "اليابان"], cc: "jp", kind: "country" },
  { id: "seoul", names: ["Seoul", "سيول"], cc: "kr", kind: "settlement", capital: true },
  { id: "jakarta", names: ["Jakarta", "جاكرتا"], cc: "id", kind: "settlement", capital: true },
  { id: "indonesia", names: ["Indonesia", "إندونيسيا"], cc: "id", kind: "country" },
  { id: "java_sea", names: ["Java Sea", "بحر جاوة"], cc: null, kind: "water" },
  { id: "manila", names: ["Manila", "مانيلا"], cc: "ph", kind: "settlement", capital: true },
  { id: "philippines", names: ["Philippines", "الفلبين"], cc: "ph", kind: "country" },
  { id: "bangsamoro", names: ["Bangsamoro", "بانجسامورو"], cc: "ph", kind: "admin" },
  { id: "vanuatu", names: ["Vanuatu", "فانواتو"], cc: "vu", kind: "country" },
  { id: "sri_lanka", names: ["Sri Lanka", "سريلانكا", "سري لانكا"], cc: "lk", kind: "country" },

  // Africa
  { id: "kampala", names: ["Kampala", "كمبالا"], cc: "ug", kind: "settlement", capital: true },
  { id: "uganda", names: ["Uganda", "أوغندا"], cc: "ug", kind: "country" },
  { id: "nairobi", names: ["Nairobi", "نيروبي"], cc: "ke", kind: "settlement", capital: true },
  { id: "kenya", names: ["Kenya", "كينيا"], cc: "ke", kind: "country" },
  { id: "niamey", names: ["Niamey", "نيامي"], cc: "ne", kind: "settlement", capital: true },
  { id: "niger", names: ["Niger", "النيجر"], cc: "ne", kind: "country" },
  { id: "dakar", names: ["Dakar", "داكار"], cc: "sn", kind: "settlement", capital: true },
  { id: "senegal", names: ["Senegal", "السنغال"], cc: "sn", kind: "country" },
  { id: "rabat", names: ["Rabat", "الرباط"], cc: "ma", kind: "settlement", capital: true },
  { id: "morocco", names: ["Morocco", "المغرب"], cc: "ma", kind: "country" },
  { id: "tunis", names: ["Tunis", "تونس"], cc: "tn", kind: "settlement", capital: true },
];

const BY_ID = new Map(GAZETTEER.map((e) => [e.id, e]));

export function placeById(id: string): PlaceEntry | undefined {
  return BY_ID.get(id);
}

export interface PlaceHit {
  entry: PlaceEntry;
  surface: string;
  inTitle: boolean;
  position: number;
  // Set when the name is a capital being used for its government, so ranking
  // treats it as no more specific than the country.
  demoted?: boolean;
}

//TUNE: Control the (extraction text budget). Characters of title+content scanned for place names.
const MAX_SCAN_CHARS = 4000;

function decoyBlocks(entry: PlaceEntry, haystack: string): boolean {
  for (const decoy of DECOYS) {
    if (!entry.names.some((n) => normalizePlaceText(n) === decoy.place)) continue;
    for (const phrase of decoy.phrases) {
      if (matchIndex(haystack, phrase) >= 0) return true;
    }
  }
  return false;
}

export function findNamedPlaces(title: string | null, content: string | null): PlaceHit[] {
  const rawTitle = (title || "").slice(0, MAX_SCAN_CHARS);
  const rawContent = (content || "").slice(0, MAX_SCAN_CHARS);
  const rawBoth = `${rawTitle} ${rawContent}`;
  const normTitle = normalizePlaceText(rawTitle);
  const normContent = normalizePlaceText(rawContent);
  const both = `${normTitle} ${normContent}`.trim();

  const hits: PlaceHit[] = [];
  for (const entry of GAZETTEER) {
    if (entry.rawRequires && !entry.rawRequires.test(rawBoth)) continue;
    let best: PlaceHit | null = null;
    for (const surface of entry.names) {
      const inTitleAt = normTitle ? matchIndex(normTitle, surface) : -1;
      const inBodyAt = normContent ? matchIndex(normContent, surface) : -1;
      if (inTitleAt < 0 && inBodyAt < 0) continue;
      const candidate: PlaceHit = {
        entry,
        surface,
        inTitle: inTitleAt >= 0,
        position: inTitleAt >= 0 ? inTitleAt : inBodyAt,
      };
      if (!best || (candidate.inTitle && !best.inTitle) || candidate.position < best.position) {
        best = candidate;
      }
    }
    if (best && !decoyBlocks(entry, both)) hits.push(best);
  }
  return demoteMetonyms(hits);
}

// "Tehran closed the strait", "Washington said": a capital standing in for its
// government is not a report from that city. When the item also names its
// country, the capital loses its specificity bonus so the pin falls back to the
// country rather than claiming a street address for a policy statement.
function demoteMetonyms(hits: PlaceHit[]): PlaceHit[] {
  const countryCcs = new Set(
    hits.filter((h) => h.entry.kind === "country").map((h) => h.entry.cc),
  );
  return hits.map((hit) => {
    if (!hit.entry.capital) return hit;
    if (!hit.inTitle && countryCcs.has(hit.entry.cc)) {
      return { ...hit, demoted: true };
    }
    return hit;
  });
}

// The pin goes on the most specific place named, and a name in the title wins
// over the same specificity buried in the body. Everything else the item
// mentions stays off the map: one item, one honest pin.
export function choosePrimaryPlace(hits: PlaceHit[]): PlaceHit | null {
  if (hits.length === 0) return null;
  const specificity = (hit: PlaceHit): number =>
    hit.demoted ? KIND_SPECIFICITY.country : KIND_SPECIFICITY[hit.entry.kind];
  return [...hits].sort((a, b) => {
    const spec = specificity(b) - specificity(a);
    if (spec !== 0) return spec;
    if (a.inTitle !== b.inTitle) return a.inTitle ? -1 : 1;
    return a.position - b.position;
  })[0];
}
