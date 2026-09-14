import type { NewsStory } from "@/hooks/usePanelData";
import { normSeverity } from "@/utils/severity";

// Tier resolution for the breaking ticker. It lives here rather than inside the
// component so it can be exercised directly against real endpoint responses.
//
// The bar takes the first tier that returns anything and never blanks while any
// story exists. A three-day-old item is still true, and its own timestamp is
// what tells the reader how old it is; claiming nothing is happening is not an
// option for a breaking-news ticker.

//TUNE: Control the (ticker capacity). Stories the bar will carry at most, per tier.
export const TICKER_CAPACITY = 30;

//TUNE: Control the (ticker recency window). Hours a story counts as recent for the two ranked tiers.
export const RECENT_HOURS = 24;

const SEVERE = ["critical", "high"];

export type Tier = "severe-recent" | "any-recent" | "any-age";

export interface Resolution {
  items: NewsStory[];
  tier: Tier;
}

export function publishedMs(story: NewsStory): number {
  const t = Date.parse(story.timestamp ?? "");
  // An unparseable or absent timestamp must not be treated as "now", which
  // would float undated rows to the top of a recency-ranked tier. It sorts last
  // and never qualifies as recent.
  return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
}

function newestFirst(a: NewsStory, b: NewsStory): number {
  return publishedMs(b) - publishedMs(a);
}

export function resolveTier(stories: NewsStory[], now: number = Date.now()): Resolution | null {
  if (stories.length === 0) return null;

  const cutoff = now - RECENT_HOURS * 60 * 60 * 1000;
  const recent = stories.filter((s) => publishedMs(s) >= cutoff);

  const severeRecent = recent.filter((s) => SEVERE.includes(normSeverity(s.severity)));
  if (severeRecent.length > 0) {
    return {
      items: severeRecent.sort(newestFirst).slice(0, TICKER_CAPACITY),
      tier: "severe-recent",
    };
  }

  if (recent.length > 0) {
    return { items: recent.sort(newestFirst).slice(0, TICKER_CAPACITY), tier: "any-recent" };
  }

  return { items: [...stories].sort(newestFirst).slice(0, TICKER_CAPACITY), tier: "any-age" };
}
