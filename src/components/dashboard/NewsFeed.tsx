import { useQuery } from "@tanstack/react-query";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { supabase } from "@/integrations/supabase/client";
import { Newspaper, ExternalLink } from "lucide-react";
import { useLanguage } from "@/i18n/LanguageContext";
import { useTranslatedData } from "@/hooks/useTranslatedData";
import { ExpandablePanel } from "./ExpandablePanel";
import { formatLocalDateTime } from "@/utils/formatTime";

interface NewsItem {
  headline: string;
  summary: string;
  source: string;
  severity: "critical" | "high" | "developing" | "verified" | "info";
  timestamp: string;
  url?: string;
}

export const NewsFeed = () => {
  const { t } = useLanguage();

  const { data, isLoading, error } = useQuery({
    queryKey: ["news-feed"],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke("firecrawl-news");
      if (error) throw error;
      return data as { stories: NewsItem[] };
    },
    staleTime: 5 * 60 * 1000,
    refetchInterval: 60 * 60 * 1000,
  });

  const { data: translated, isTranslating } = useTranslatedData(data, "news-feed");

  return (
    <ExpandablePanel>
      <div className="flex flex-col h-full bg-card/80 backdrop-blur-md rounded-sm border border-border overflow-hidden">
        <div className="panel-header">
          <div className="flex items-center gap-2">
            <Newspaper className="h-3.5 w-3.5" />
            <span>{t("news.title")}</span>
          </div>
          <span className="text-[10px] opacity-60">{t("news.subtitle")}</span>
        </div>
        <ScrollArea className="flex-1 p-3">
          {(isLoading || isTranslating) && (
            <div className="space-y-3">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="space-y-2 pb-3 border-b border-border last:border-0">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-3 w-full" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
              ))}
            </div>
          )}
          {error && (
            <div className="text-sm text-muted-foreground p-4 text-center">
              <p className="text-severity-critical font-mono text-xs">{t("news.offline")}</p>
              <p className="mt-1 text-xs">{t("news.error")}</p>
            </div>
          )}
          {translated?.stories && !isTranslating && (
            <div className="space-y-3">
              {translated.stories.map((item, i) => (
                <article key={i} className="pb-3 border-b border-border last:border-0">
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="text-sm font-semibold leading-tight">{item.headline}</h3>
                    {item.url && (
                      <a href={item.url} target="_blank" rel="noopener noreferrer" className="shrink-0">
                        <ExternalLink className="h-3 w-3 text-muted-foreground hover:text-foreground" />
                      </a>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{item.summary}</p>
                  <div className="flex items-center gap-2 mt-2">
                    <span className={`severity-badge severity-${item.severity}`}>
                      {t(`severity.${item.severity}`)}
                    </span>
                    <span className="text-[10px] font-mono text-muted-foreground">{item.source}</span>
                    <span className="text-[10px] font-mono text-muted-foreground/60 ml-auto">{formatLocalDateTime(item.timestamp)}</span>
                  </div>
                </article>
              ))}
            </div>
          )}
        </ScrollArea>
      </div>
    </ExpandablePanel>
  );
};
