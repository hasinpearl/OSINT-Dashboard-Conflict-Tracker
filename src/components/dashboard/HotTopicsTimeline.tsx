import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { supabase } from "@/integrations/supabase/client";
import { TrendingUp, RefreshCw } from "lucide-react";
import { useLanguage } from "@/i18n/LanguageContext";
import { useTranslatedData } from "@/hooks/useTranslatedData";
import { ExpandablePanel } from "./ExpandablePanel";
import { formatLocalDate } from "@/utils/formatTime";

interface HotTopic {
  title: string;
  summary: string;
  severity: "critical" | "high" | "developing" | "verified" | "info";
  mentions?: number;
  source?: string;
  timestamp: string;
}

export const HotTopicsTimeline = () => {
  const { t } = useLanguage();
  const queryClient = useQueryClient();
  // Force a fresh fetch on the first request after page load.
  const initialLoadRef = useRef(true);
  const forceNextRef = useRef(false);
  const [isManualRefreshing, setIsManualRefreshing] = useState(false);

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["hot-topics"],
    queryFn: async () => {
      const shouldForce = initialLoadRef.current || forceNextRef.current;
      initialLoadRef.current = false;
      forceNextRef.current = false;

      const { data, error } = await supabase.functions.invoke("ai-summarize", {
        method: "POST",
        ...(shouldForce ? { body: { force_refresh: true } } : {}),
        ...(shouldForce
          ? { headers: {} } // ensure POST path
          : {}),
      } as any);

      if (error) throw error;
      return data as { topics: HotTopic[] };
    },
    staleTime: 5 * 60 * 1000,
    refetchInterval: 60 * 60 * 1000,
  });

  const { data: translated, isTranslating } = useTranslatedData(data, "hot-topics");

  const handleManualRefresh = async () => {
    if (isManualRefreshing || isFetching) return;
    setIsManualRefreshing(true);
    forceNextRef.current = true;
    try {
      // Invalidate to ensure refetch runs queryFn
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
          {(isLoading || isTranslating) && (
            <div className="space-y-3">
              {[...Array(4)].map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          )}
          {error && (
            <div className="text-sm text-muted-foreground p-4 text-center">
              <p className="text-severity-critical font-mono text-xs">{t("topics.offline")}</p>
            </div>
          )}
          {translated?.topics && !isTranslating && (
            <div className="relative">
              <div className="absolute left-2 top-0 bottom-0 w-px bg-border rtl:left-auto rtl:right-2" />
              <div className="space-y-4 pl-6 rtl:pl-0 rtl:pr-6">
                {[...translated.topics].sort((a, b) => 
                  (b.timestamp || "").localeCompare(a.timestamp || "")
                ).map((topic, i) => (
                  <div key={i} className="relative">
                    <div className={`absolute -left-[18px] top-1 w-2.5 h-2.5 rounded-full border-2 border-card rtl:left-auto rtl:-right-[18px]`}
                      style={{
                        backgroundColor: topic.severity === "critical" ? "hsl(var(--severity-critical))" :
                          topic.severity === "high" ? "hsl(var(--severity-high))" :
                          topic.severity === "developing" ? "hsl(var(--severity-developing))" :
                          "hsl(var(--severity-verified))"
                      }}
                    />
                    <h4 className="text-sm font-semibold leading-tight">{topic.title}</h4>
                    <p className="text-xs text-muted-foreground mt-0.5">{topic.summary}</p>
                    <div className="flex items-center gap-2 mt-1">
                      <span className={`severity-badge severity-${topic.severity}`}>{t(`severity.${topic.severity}`)}</span>
                      {topic.source && (
                        <span className="text-[10px] font-mono text-muted-foreground">{topic.source}</span>
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
