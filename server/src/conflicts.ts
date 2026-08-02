export type ConflictKey = "all" | "iran-us" | "ukraine-russia" | "china-taiwan";

export interface Expert {
  name: string;
  title: string;
  kind: "official" | "analyst";
}

export interface ConflictConfig {
  key: ConflictKey;
  searchTerms: string;
  label: string;
  region: string;
  biasLeftLabel: string;
  biasRightLabel: string;
  biasCenterLabel: string;
  newsSources: string[];
  timelineStartDate: string;
  experts: Expert[];
}

export const CONFLICT_CONFIG: Record<Exclude<ConflictKey, "all">, ConflictConfig> = {
  "iran-us": {
    key: "iran-us",
    searchTerms:
      "Iran, US, Israel, Middle East conflict, Strait of Hormuz, Gulf security, IRGC, Hezbollah, Iranian nuclear program, US sanctions Iran",
    label: "Iran / U.S.",
    region: "Middle East",
    biasLeftLabel: "U.S. / Israel",
    biasRightLabel: "Iran",
    biasCenterLabel: "Neutral / International",
    newsSources: [
      "https://www.reuters.com/world/middle-east/",
      "https://www.bbc.com/news/world/middle_east",
      "https://www.aljazeera.com/middle-east/",
      "https://apnews.com/hub/middle-east",
    ],
    timelineStartDate: "2026-02-28",
    experts: [
      { name: "Rafael Grossi", title: "Director General, IAEA", kind: "official" },
      { name: "Abbas Araghchi", title: "Foreign Minister, Iran", kind: "official" },
      { name: "Marco Rubio", title: "U.S. Secretary of State", kind: "official" },
      { name: "Esmail Baghaei", title: "Spokesperson, Iranian Foreign Ministry", kind: "official" },
      { name: "Antonio Guterres", title: "Secretary-General, United Nations", kind: "official" },
      { name: "Ali Vaez", title: "Iran Project Director, International Crisis Group", kind: "analyst" },
      { name: "Karim Sadjadpour", title: "Senior Fellow, Carnegie Endowment for International Peace", kind: "analyst" },
      { name: "Vali Nasr", title: "Professor, Johns Hopkins SAIS", kind: "analyst" },
      { name: "Trita Parsi", title: "Executive Vice President, Quincy Institute", kind: "analyst" },
      { name: "Sanam Vakil", title: "Director, Middle East and North Africa Programme, Chatham House", kind: "analyst" },
    ],
  },
  "ukraine-russia": {
    key: "ukraine-russia",
    searchTerms:
      "Ukraine, Russia, Donbas, Crimea, NATO, Zelensky, Putin, Black Sea, Ukrainian counteroffensive, Russian invasion",
    label: "Ukraine / Russia",
    region: "Eastern Europe",
    biasLeftLabel: "Ukraine / West",
    biasRightLabel: "Russia",
    biasCenterLabel: "Neutral / International",
    newsSources: [
      "https://www.reuters.com/world/europe/",
      "https://www.bbc.com/news/world/europe",
      "https://apnews.com/hub/russia-ukraine",
      "https://www.aljazeera.com/europe/",
    ],
    timelineStartDate: "2022-02-24",
    experts: [
      { name: "Volodymyr Zelensky", title: "President, Ukraine", kind: "official" },
      { name: "Vladimir Putin", title: "President, Russia", kind: "official" },
      { name: "Mark Rutte", title: "Secretary General, NATO", kind: "official" },
      { name: "Sergei Lavrov", title: "Foreign Minister, Russia", kind: "official" },
      { name: "Andrii Sybiha", title: "Foreign Minister, Ukraine", kind: "official" },
      { name: "Michael Kofman", title: "Senior Fellow, Carnegie Endowment for International Peace", kind: "analyst" },
      { name: "Dara Massicot", title: "Senior Fellow, Carnegie Endowment for International Peace", kind: "analyst" },
      { name: "Lawrence Freedman", title: "Emeritus Professor of War Studies, King's College London", kind: "analyst" },
      { name: "Fiona Hill", title: "Senior Fellow, Brookings Institution", kind: "analyst" },
      { name: "Tatiana Stanovaya", title: "Senior Fellow, Carnegie Russia Eurasia Center", kind: "analyst" },
    ],
  },
  "china-taiwan": {
    key: "china-taiwan",
    searchTerms:
      "China, Taiwan, South China Sea, Xi Jinping, Taiwan Strait, PLA, AUKUS, Indo-Pacific, Chinese military, semiconductor",
    label: "China / Taiwan",
    region: "Indo-Pacific",
    biasLeftLabel: "Taiwan / West",
    biasRightLabel: "China",
    biasCenterLabel: "Neutral / International",
    newsSources: [
      "https://www.reuters.com/world/asia-pacific/",
      "https://www.bbc.com/news/world/asia",
      "https://apnews.com/hub/asia-pacific",
      "https://www.aljazeera.com/asia-pacific/",
    ],
    timelineStartDate: "2024-01-01",
    experts: [
      { name: "Lai Ching-te", title: "President, Taiwan", kind: "official" },
      { name: "Xi Jinping", title: "President, China", kind: "official" },
      { name: "Wang Yi", title: "Foreign Minister, China", kind: "official" },
      { name: "Lin Chia-lung", title: "Foreign Minister, Taiwan", kind: "official" },
      { name: "Pete Hegseth", title: "U.S. Secretary of Defense", kind: "official" },
      { name: "Bonnie Glaser", title: "Managing Director, Indo-Pacific Program, German Marshall Fund", kind: "analyst" },
      { name: "M. Taylor Fravel", title: "Professor of Political Science, MIT", kind: "analyst" },
      { name: "Oriana Skylar Mastro", title: "Center Fellow, Stanford University", kind: "analyst" },
      { name: "Amanda Hsiao", title: "Director, China, Eurasia Group", kind: "analyst" },
      { name: "Wen-Ti Sung", title: "Fellow, Atlantic Council Global China Hub", kind: "analyst" },
    ],
  },
};

export function getConflictConfig(conflict: string | undefined | null): ConflictConfig {
  const key = (conflict || "all") as ConflictKey;

  if (key !== "all" && CONFLICT_CONFIG[key]) {
    return CONFLICT_CONFIG[key];
  }

  const all = Object.values(CONFLICT_CONFIG);
  return {
    key: "all",
    searchTerms: all.map((c) => c.searchTerms).join("; "),
    label: "All Conflicts (Iran/U.S., Ukraine/Russia, China/Taiwan)",
    region: "Global (Middle East, Eastern Europe, Indo-Pacific)",
    biasLeftLabel: "Western / U.S.-aligned",
    biasRightLabel: "Anti-Western / Adversary-aligned",
    biasCenterLabel: "Neutral / International",
    newsSources: Array.from(new Set(all.flatMap((c) => c.newsSources))),
    timelineStartDate: all.map((c) => c.timelineStartDate).sort()[0],
    experts: all.flatMap((c) => c.experts),
  };
}

export function readConflict(body: any): ConflictKey {
  const c = body?.conflict;
  if (c === "iran-us" || c === "ukraine-russia" || c === "china-taiwan" || c === "all") {
    return c;
  }
  return "all";
}
