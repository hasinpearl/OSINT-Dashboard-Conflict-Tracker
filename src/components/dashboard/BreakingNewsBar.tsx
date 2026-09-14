import type { CSSProperties } from "react";
import { useNewsStories, type NewsStory } from "@/hooks/usePanelData";
import { useTranslatedData } from "@/hooks/useTranslatedData";
import { useLanguage } from "@/i18n/LanguageContext";
import { normSeverity } from "@/utils/severity";
import { resolveTier } from "@/utils/tickerTiers";
import { useSourceStatus } from "@/hooks/useSourceStatus";
import { isConflictDisabled } from "@/lib/conflictDisabled";

//TUNE: Control the (ticker minimum track length). Items the scroll track is padded to so it stays wider than the viewport.
const MIN_TRACK_ITEMS = 6;

//TUNE: Control the (ticker scroll pace). Seconds of scroll added per item, and the floor for a short list.
const SECONDS_PER_ITEM = 7;
const MIN_SCROLL_SECONDS = 30;

// Pure consumer of the shared news query — zero additional API calls.
export const BreakingNewsBar = () => {
  const { data, isLoading, error } = useNewsStories();
  // Same scoped key as NewsFeed's translation, so this reuses its cache entry.
  const { data: translated } = useTranslatedData(data, "news-feed");
  const { t } = useLanguage();
  const { data: status } = useSourceStatus();

  const stories = translated?.stories ?? data?.stories ?? [];
  const resolved = resolveTier(stories);

  // A switched-off conflict has no ticker, and saying so is not the same as
  // saying nothing was collected. Checked before resolveTier's empty branch so
  // the bar never blames the collectors for a hidden theatre.
  if (isConflictDisabled(data)) {
    return (
      <TickerShell label={t("state.conflictDisabled")}>
        <span className="px-4 text-[10px] font-mono text-muted-foreground truncate">
          {t("state.conflictDisabledHint")}
        </span>
      </TickerShell>
    );
  }

  // Only a genuinely empty store reaches this branch, and what it says is
  // diagnostic rather than reassuring: nothing has been collected yet, here is
  // where to look. Returning null would be worse still, since a missing bar is
  // indistinguishable from a broken one.
  if (!resolved) {
    const failing = (status?.sources ?? []).filter((s) => s.source === "rss" && !s.ok);
    const headline = error ? t("ticker.offline") : t("ticker.awaitingCollection");
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

  const items = resolved.items;

  // Pad short lists so the track is always wider than the viewport.
  const padded: NewsStory[] = [...items];
  while (padded.length < MIN_TRACK_ITEMS) padded.push(...items);

  const duration = Math.max(MIN_SCROLL_SECONDS, padded.length * SECONDS_PER_ITEM);

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
