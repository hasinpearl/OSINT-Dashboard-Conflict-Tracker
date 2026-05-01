// Shared conflict configuration for all Edge Functions.
// The frontend passes a `conflict` value in the request body. Each function
// uses getConflictConfig() to tailor prompts, sources, and cache keys.

export type ConflictKey = "all" | "iran-us" | "ukraine-russia" | "china-taiwan";

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
  },
};

/**
 * Returns config for a specific conflict, or a merged "all" config that
 * combines search terms, news sources, and uses the earliest timeline date.
 */
export function getConflictConfig(conflict: string | undefined | null): ConflictConfig {
  const key = (conflict || "all") as ConflictKey;

  if (key !== "all" && CONFLICT_CONFIG[key]) {
    return CONFLICT_CONFIG[key];
  }

  // Merged "all" config
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
    timelineStartDate: all
      .map((c) => c.timelineStartDate)
      .sort()[0],
  };
}

/**
 * Safely parse the conflict param from a request body. Defaults to "all"
 * for GET requests, empty bodies, or invalid JSON.
 */
export async function readConflictFromRequest(req: Request): Promise<ConflictKey> {
  if (req.method !== "POST" && req.method !== "PUT") return "all";
  try {
    const body = await req.clone().json();
    const c = body?.conflict;
    if (c === "iran-us" || c === "ukraine-russia" || c === "china-taiwan" || c === "all") {
      return c;
    }
  } catch {
    // ignore — empty body or non-JSON
  }
  return "all";
}
