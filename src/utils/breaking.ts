import type { NewsStory } from "@/hooks/usePanelData";
import { normSeverity } from "@/utils/severity";

// What counts as breaking, kept out of the component so it can be exercised
// directly against real endpoint responses.
//
// The feeder used to require normSeverity(story) === "critical" and nothing
// else. Two things made that never fire against a real store. The classifier
// damps severity for anything that reads as analysis and caps most event
// classes at high, so critical is rare; and the news route returned the thirty
// most recent rows by time, which on a busy feed contains no critical row at
// all. So the one criterion the feeder had was absent from the very list it was
// reading.
//
// items.is_breaking is the classifier's own breaking decision (a breaking
// marker or a critical severity, on a fresh item, off-domain suppressed). That
// flag is now carried through the news response and is the primary criterion
// here, with critical severity kept as the independent second one.

export function isBreaking(story: NewsStory): boolean {
  if (story.breaking === true) return true;
  return normSeverity(story.severity) === "critical";
}

export function breakingStories(stories: NewsStory[]): NewsStory[] {
  return stories.filter(isBreaking);
}
