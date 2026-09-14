import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { invokeFn } from "@/lib/api";
import { shouldForceRefresh } from "@/lib/freshness";
import { TrendingUp, RefreshCw } from "lucide-react";
import { useLanguage } from "@/i18n/LanguageContext";
import { useTranslatedData } from "@/hooks/useTranslatedData";
import { ExpandablePanel } from "./ExpandablePanel";
import { PanelEmptyState } from "./PanelEmptyState";
import { formatLocalDate } from "@/utils/formatTime";
import { useConflictFilter } from "@/contexts/ConflictFilterContext";
import { normSeverity } from "@/utils/severity";
import { isConflictDisabled } from "@/lib/conflictDisabled";

interface HotTopic {
  item_id?: string;
  title: string;
  summary: string;
  significance?: string;
  severity: "critical" | "high" | "developing" | "verified" | "info";
  event_type?: string;
  conflict?: string;
  source?: string;
  timestamp: string;
  url?: string;
}

interface ConflictRollup {
  conflict: string;
  label: string;
  selected: number;
  candidates_considered: number;
  informational_excluded: number;
}

interface HotTopicsResponse {
  topics: HotTopic[];
  conflicts?: ConflictRollup[];
  selected_by?: string;
  /** Set by the API when the requested conflict is switched off. */
  conflict_disabled?: boolean;
}

export const HotTopicsTimeline = () => {
  const { t } = useLanguage();
  const queryClient = useQueryClient();
  const { conflict } = useConflictFilter();
  const forceNextRef = useRef(false);
  const [isManualRefreshing, setIsManualRefreshing] = useState(false);

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["hot-topics", conflict],
    queryFn: async () => {
      const shouldForce =
        forceNextRef.current || shouldForceRefresh(`hot-topics:${conflict}`);
      forceNextRef.current = false;

      return invokeFn<HotTopicsResponse>("ai-summarize", {
        conflict,
        ...(shouldForce ? { force_refresh: true } : {}),
      });
    },
    staleTime: 5 * 60 * 1000,
    refetchInterval: 15 * 60 * 1000,
  });

  const { data: translated } = useTranslatedData(data, "hot-topics");

  const topics = translated?.topics ?? data?.topics ?? [];
  const rollups = data?.conflicts ?? [];
  const disabled = isConflictDisabled(data);

  // An empty timeline is a real answer when nothing in the window materially
  // changed the situation, so the panel says that rather than implying the
  // store is empty. The numbers behind it come from the response.
  const considered = rollups.reduce((n, r) => n + r.candidates_considered, 0);
  const excluded = rollups.reduce((n, r) => n + r.informational_excluded, 0);

  const handleManualRefresh = async () => {
    if (isManualRefreshing || isFetching) return;
    setIsManualRefreshing(true);
    forceNextRef.current = true;
    try {
      await queryClient.invalidateQueries({ queryKey: ["hot-topics"] });
      await refetch();
    } finally {
      setIsManualRefreshing(false);
    }
  };

  const refreshing = isManualRefreshing || isFetching;

  return (
    <ExpandablePanel>
      <div className="flex flex-col h-full bg-card/80 backdrop-blur-md rounded-sm border border-border overflow-hidden">
        <div className="panel-header">
          <div className="flex items-center gap-2">
            <TrendingUp className="h-3.5 w-3.5" />
            <span>{t("topics.title")}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] opacity-60">{t("topics.subtitle")}</span>
            <button
              type="button"
              onClick={handleManualRefresh}
              disabled={refreshing}
              aria-label="Refresh"
              className="opacity-60 hover:opacity-100 transition-opacity disabled:opacity-30"
            >
              <RefreshCw className={`h-3 w-3 ${refreshing ? "animate-spin" : ""}`} />
            </button>
          </div>
        </div>
        <ScrollArea className="flex-1 p-3">
          {isLoading && (
            <div className="space-y-3">
              {[...Array(4)].map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          )}
          {!isLoading && disabled && <PanelEmptyState kind="disabled" />}
          {!isLoading && !disabled && error && (
            <PanelEmptyState kind="error" errorMessage={t("topics.offline")} />
          )}
          {!error && !isLoading && !disabled && topics.length === 0 && (
            <PanelEmptyState
              kind="empty"
              emptyMessage={
                considered > 0
                  ? `${t("state.noTopics")} ${t("topics.quietWindow")} (${considered} / ${excluded})`
                  : t("state.noTopics")
              }
            />
          )}
          {!error && !isLoading && !disabled && topics.length > 0 && (
            <div className="relative">
              <div className="absolute left-2 top-0 bottom-0 w-px bg-border rtl:left-auto rtl:right-2" />
              <div className="space-y-4 pl-6 rtl:pl-0 rtl:pr-6">
                {[...topics].sort((a, b) => 
                  (b.timestamp || "").localeCompare(a.timestamp || "")
                ).map((topic, i) => (
                  <div key={topic.item_id ?? i} className="relative">
                    <div className={`absolute -left-[18px] top-1 w-2.5 h-2.5 rounded-full border-2 border-card rtl:left-auto rtl:-right-[18px]`}
                      style={{
                        backgroundColor: normSeverity(topic.severity) === "critical" ? "hsl(var(--severity-critical))" :
                          normSeverity(topic.severity) === "high" ? "hsl(var(--severity-high))" :
                          normSeverity(topic.severity) === "developing" ? "hsl(var(--severity-developing))" :
                          "hsl(var(--severity-verified))"
                      }}
                    />
                    {topic.url ? (
                      <a
                        href={topic.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm font-semibold leading-tight hover:underline"
                      >
                        {topic.title}
                      </a>
                    ) : (
                      <h4 className="text-sm font-semibold leading-tight">{topic.title}</h4>
                    )}
                    <p className="text-xs text-muted-foreground mt-0.5">{topic.summary}</p>
                    {topic.significance && (
                      <p className="text-[11px] text-foreground/80 mt-1 italic">{topic.significance}</p>
                    )}
                    <div className="flex items-center gap-2 mt-1 flex-wrap">
                      <span className={`severity-badge severity-${normSeverity(topic.severity)}`}>{t(`severity.${normSeverity(topic.severity)}`)}</span>
                      {topic.event_type && (
                        <span className="text-[9px] font-mono uppercase text-muted-foreground/70">
                          {topic.event_type.replace(/_/g, " ")}
                        </span>
                      )}
                      {topic.source && (
                        <span className="text-[10px] font-mono text-muted-foreground">{topic.source}</span>
                      )}
                      {/* The stored row id, so any entry on this timeline can be
                          traced back to the exact item it came from. */}
                      {topic.item_id && (
                        <span className="text-[9px] font-mono text-muted-foreground/40">#{topic.item_id}</span>
                      )}
                      <span className="text-[9px] font-mono text-muted-foreground/50 ml-auto">{formatLocalDate(topic.timestamp)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </ScrollArea>
      </div>
    </ExpandablePanel>
  );
};
