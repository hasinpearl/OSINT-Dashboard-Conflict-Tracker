import { useQuery } from "@tanstack/react-query";
import { invokeFn } from "@/lib/api";
import { shouldForceRefresh } from "@/lib/freshness";
import { useConflictFilter } from "@/contexts/ConflictFilterContext";

export interface NewsStory {
  headline: string;
  summary: string;
  source: string;
  severity: "critical" | "high" | "developing" | "verified" | "info";
  timestamp: string;
  url?: string;
}

// Shared news query: NewsFeed, the breaking-news bar, and the notifications
// feeder all use this hook. The queryKey and options match exactly, so React
// Query serves every consumer from one cache entry — zero extra API calls.
export function useNewsStories() {
  const { conflict } = useConflictFilter();

  return useQuery({
    queryKey: ["news-feed", conflict],
    queryFn: () =>
      invokeFn<{ stories: NewsStory[] }>("firecrawl-news", {
        conflict,
        ...(shouldForceRefresh(`news-feed:${conflict}`) ? { force_refresh: true } : {}),
      }),
    staleTime: 5 * 60 * 1000,
    refetchInterval: 15 * 60 * 1000,
  });
}
