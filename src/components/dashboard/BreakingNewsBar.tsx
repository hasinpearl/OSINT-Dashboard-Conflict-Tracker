import type { CSSProperties } from "react";
import { useNewsStories, type NewsStory } from "@/hooks/usePanelData";
import { useTranslatedData } from "@/hooks/useTranslatedData";
import { useLanguage } from "@/i18n/LanguageContext";
import { normSeverity } from "@/utils/severity";
import { useSourceStatus } from "@/hooks/useSourceStatus";

// Pure consumer of the shared news query — zero additional API calls.
export const BreakingNewsBar = () => {
  const { data, isLoading, error } = useNewsStories();
  // Same scoped key as NewsFeed's translation, so this reuses its cache entry.
  const { data: translated } = useTranslatedData(data, "news-feed");
  const { t } = useLanguage();
  const { data: status } = useSourceStatus();

  const stories = translated?.stories ?? data?.stories ?? [];

  // Returning null here is what made the bar disappear, which is
  // indistinguishable from the bar being broken. It now always renders and
  // states which it is.
  if (stories.length === 0) {
    const failing = (status?.sources ?? []).filter((s) => s.source === "rss" && !s.ok);
    const headline = error ? t("ticker.offline") : t("ticker.empty");
    const detail = error
      ? t("state.panelOfflineHint")
      : status && !status.workers_reported
        ? t("state.collectorsNeverRanHint")
        : failing.length > 0
          ? `${t("state.someSourcesDown")} ${failing.map((s) => s.label?.trim() || s.id).join(", ")}`
          : t("ticker.emptyHint");

    return (
      <TickerShell label={headline} critical={Boolean(error)}>
        <span className="px-4 text-[10px] font-mono text-muted-foreground truncate">
          {isLoading ? t("loading.translating") : detail}
        </span>
      </TickerShell>
    );
  }

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
    <TickerShell label={t("ticker.breaking")}>
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
    </TickerShell>
  );
};

// The chrome is shared so the empty and populated bars occupy the same space in
// the layout and the label is the only thing that changes.
const TickerShell = ({
  label,
  critical,
  children,
}: {
  label: string;
  critical?: boolean;
  children: React.ReactNode;
}) => (
  <div className="flex items-stretch rounded-sm border border-border bg-card/80 backdrop-blur-md overflow-hidden">
    <div
      className={`flex items-center gap-1.5 px-3 text-white shrink-0 z-10 ${
        critical ? "bg-severity-critical" : "bg-red-600"
      }`}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
      <span className="text-[10px] font-mono font-bold tracking-wider whitespace-nowrap">
        {label}
      </span>
    </div>
    <div className="flex-1 min-w-0 flex items-center overflow-hidden">{children}</div>
  </div>
);
