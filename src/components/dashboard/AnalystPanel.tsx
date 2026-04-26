import { useQuery } from "@tanstack/react-query";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { supabase } from "@/integrations/supabase/client";
import { User, Quote, ExternalLink } from "lucide-react";
import { useLanguage } from "@/i18n/LanguageContext";
import { useTranslatedData } from "@/hooks/useTranslatedData";
import { ExpandablePanel } from "./ExpandablePanel";
import { formatLocalDateTime } from "@/utils/formatTime";
import { useConflictFilter } from "@/contexts/ConflictFilterContext";

interface AnalystComment {
  analyst: string;
  affiliation: string;
  comment: string;
  topic: string;
  timestamp: string;
  url?: string;
}

export const AnalystPanel = () => {
  const { t } = useLanguage();
  const { conflict } = useConflictFilter();

  const { data, isLoading, error } = useQuery({
    queryKey: ["analyst", conflict],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke("perplexity-analyst", { body: { conflict } });
      if (error) throw error;
      return data as { comments: AnalystComment[] };
    },
    staleTime: 10 * 60 * 1000,
    refetchInterval: 60 * 60 * 1000,
  });

  const { data: translated, isTranslating } = useTranslatedData(data, "analyst");

  return (
    <ExpandablePanel>
      <div className="flex flex-col h-full bg-card/80 backdrop-blur-md rounded-sm border border-border overflow-hidden">
        <div className="panel-header">
          <div className="flex items-center gap-2">
            <User className="h-3.5 w-3.5" />
            <span>{t("analyst.title")}</span>
          </div>
          <span className="text-[10px] opacity-60">{t("analyst.subtitle")}</span>
        </div>
        <ScrollArea className="flex-1 p-3">
          {(isLoading || isTranslating) && (
            <div className="space-y-3">
              {[...Array(3)].map((_, i) => (
                <Skeleton key={i} className="h-20 w-full" />
              ))}
            </div>
          )}
          {error && (
            <div className="text-sm text-muted-foreground p-4 text-center">
              <p className="text-severity-critical font-mono text-xs">{t("analyst.offline")}</p>
            </div>
          )}
          {translated?.comments && !isTranslating && translated.comments.length === 0 && (
            <div className="text-sm text-muted-foreground p-4 text-center">
              <p className="text-xs font-mono">No analyst commentary available right now</p>
              <p className="text-[10px] mt-1">Try refreshing in a few minutes</p>
            </div>
          )}
          {translated?.comments && !isTranslating && translated.comments.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {translated.comments.map((item, i) => (
                <div key={i} className="p-3 bg-muted/50 rounded-sm border border-border">
                  <div className="flex items-center gap-2 mb-2">
                    <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center">
                      <User className="h-3.5 w-3.5 text-primary" />
                    </div>
                    <div>
                      <p className="text-xs font-semibold">{item.analyst}</p>
                      <p className="text-[10px] text-muted-foreground">{item.affiliation}</p>
                    </div>
                  </div>
                  <div className="relative pl-3 border-l-2 border-primary/20 rtl:pl-0 rtl:pr-3 rtl:border-l-0 rtl:border-r-2">
                    <Quote className="absolute -left-1.5 -top-0.5 h-3 w-3 text-primary/30 rtl:left-auto rtl:-right-1.5" />
                    <p className="text-xs leading-relaxed italic text-muted-foreground">{item.comment}</p>
                  </div>
                  <div className="flex items-center justify-between mt-2 gap-2">
                    <span className="text-[10px] font-mono text-primary/60 truncate">{item.topic}</span>
                    <div className="flex items-center gap-2 shrink-0">
                      {item.url && (
                        <a
                          href={item.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-0.5 text-[9px] font-mono text-primary/70 hover:text-primary hover:underline"
                          title={item.url}
                        >
                          <ExternalLink className="h-2.5 w-2.5" />
                          {t("analyst.source")}
                        </a>
                      )}
                      <span className="text-[9px] font-mono text-muted-foreground/50">{formatLocalDateTime(item.timestamp)}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </div>
    </ExpandablePanel>
  );
};
