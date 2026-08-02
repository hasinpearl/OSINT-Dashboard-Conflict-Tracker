import type { CSSProperties } from "react";
import { useNewsStories, type NewsStory } from "@/hooks/usePanelData";
import { useTranslatedData } from "@/hooks/useTranslatedData";
import { useLanguage } from "@/i18n/LanguageContext";
import { normSeverity } from "@/utils/severity";

// Pure consumer of the shared news query — zero additional API calls.
export const BreakingNewsBar = () => {
  const { data } = useNewsStories();
  // Same scoped key as NewsFeed's translation, so this reuses its cache entry.
  const { data: translated } = useTranslatedData(data, "news-feed");
  const { t } = useLanguage();

  const stories = translated?.stories ?? data?.stories ?? [];
  if (stories.length === 0) return null;

  const urgent = stories.filter((s) =>
    ["critical", "high"].includes(normSeverity(s.severity)),
  );
  // Never render an empty bar — fall back to all stories.
  const items = urgent.length > 0 ? urgent : stories;

  // Pad short lists so the track is always wider than the viewport.
  const padded: NewsStory[] = [...items];
  while (padded.length < 6) padded.push(...items);

  const duration = Math.max(30, padded.length * 7);

  const renderItems = (ariaHidden: boolean) => (
    <div className="inline-flex items-center" aria-hidden={ariaHidden}>
      {padded.map((story, i) => {
        const url = typeof story.url === "string" && /^https?:\/\//i.test(story.url.trim())
          ? story.url.trim()
          : null;
        const severity = normSeverity(story.severity);
        const content = (
          <>
            <span
              className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                severity === "critical" ? "bg-red-500 animate-pulse" : "bg-orange-500"
              }`}
            />
            <span dir="auto" className="text-xs font-medium whitespace-nowrap">
              {story.headline}
            </span>
            {story.source && (
              <span className="text-[10px] font-mono text-muted-foreground whitespace-nowrap">
                {story.source}
              </span>
            )}
          </>
        );
        return url ? (
          <a
            key={`${ariaHidden ? "b" : "a"}-${i}`}
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-4 hover:underline"
          >
            {content}
          </a>
        ) : (
          <span key={`${ariaHidden ? "b" : "a"}-${i}`} className="inline-flex items-center gap-2 px-4">
            {content}
          </span>
        );
      })}
    </div>
  );

  return (
    <div className="flex items-stretch rounded-sm border border-border bg-card/80 backdrop-blur-md overflow-hidden">
      <div className="flex items-center gap-1.5 px-3 bg-red-600 text-white shrink-0 z-10">
        <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
        <span className="text-[10px] font-mono font-bold tracking-wider whitespace-nowrap">
          {t("ticker.breaking")}
        </span>
      </div>
      {/* dir="ltr" keeps the scroll direction stable; each headline span is
          dir="auto" so Arabic text still renders correctly. */}
      <div className="ticker-wrap relative flex-1 overflow-hidden py-1.5" dir="ltr">
        <div
          className="ticker-track w-max inline-flex items-center"
          style={{ "--ticker-duration": `${duration}s` } as CSSProperties}
        >
          {renderItems(false)}
          {renderItems(true)}
        </div>
      </div>
    </div>
  );
};
