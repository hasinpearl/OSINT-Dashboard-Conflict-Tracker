import { useQuery } from "@tanstack/react-query";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { supabase } from "@/integrations/supabase/client";
import { Eye, ExternalLink } from "lucide-react";
import { useLanguage } from "@/i18n/LanguageContext";
import { useTranslatedData } from "@/hooks/useTranslatedData";
import { ExpandablePanel } from "./ExpandablePanel";
import { formatLocalDateTime } from "@/utils/formatTime";
import { useConflictFilter } from "@/contexts/ConflictFilterContext";

interface OsintItem {
  title: string;
  summary: string;
  source: string;
  confidence: "verified" | "unverified" | "developing";
  timestamp: string;
  url?: string;
}

const CONFIDENCE_STYLES: Record<string, string> = {
  verified: "severity-verified",
  unverified: "severity-high",
  developing: "severity-developing",
};

export const OsintPanel = () => {
  const { t } = useLanguage();
  const { conflict } = useConflictFilter();

  const { data, isLoading, error } = useQuery({
    queryKey: ["osint", conflict],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke("perplexity-osint", { body: { conflict } });
      if (error) throw error;
      return data as { items: OsintItem[] };
    },
    staleTime: 5 * 60 * 1000,
    refetchInterval: 60 * 60 * 1000,
  });

  const { data: translated, isTranslating } = useTranslatedData(data, "osint");

  return (
    <ExpandablePanel>
      <div className="flex flex-col h-full bg-card/80 backdrop-blur-md rounded-sm border border-border overflow-hidden">
        <div className="panel-header">
          <div className="flex items-center gap-2">
            <Eye className="h-3.5 w-3.5" />
            <span>{t("osint.title")}</span>
          </div>
          <span className="text-[10px] opacity-60">{t("osint.subtitle")}</span>
        </div>
        <ScrollArea className="flex-1 p-3">
          {(isLoading || isTranslating) && (
            <div className="space-y-3">
              {[...Array(4)].map((_, i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          )}
          {error && (
            <div className="text-sm text-muted-foreground p-4 text-center">
              <p className="text-severity-critical font-mono text-xs">{t("osint.offline")}</p>
            </div>
          )}
          {translated?.items && !isTranslating && (
            <div className="space-y-3">
              {[...translated.items].sort((a, b) => {
                const at = a.timestamp ? new Date(a.timestamp).getTime() : 0;
                const bt = b.timestamp ? new Date(b.timestamp).getTime() : 0;
                return bt - at;
              }).map((item, i) => (
                <div key={i} className="pb-3 border-b border-border last:border-0">
                  <h3 className="text-sm font-semibold leading-tight">{item.title}</h3>
                  <p className="text-xs text-muted-foreground mt-1">{item.summary}</p>
                  <div className="flex items-center gap-2 mt-2">
                    <span className={`severity-badge ${CONFIDENCE_STYLES[item.confidence]}`}>
                      {t(`confidence.${item.confidence}`)}
                    </span>
                    <span className="text-[10px] font-mono text-muted-foreground">{item.source}</span>
                    {item.url && (
                      <a
                        href={item.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-0.5 text-[9px] font-mono text-primary/70 hover:text-primary hover:underline ml-auto"
                        title={item.url}
                      >
                        <ExternalLink className="h-2.5 w-2.5" />
                        {t("analyst.source")}
                      </a>
                    )}
                    <span className={`text-[9px] font-mono text-muted-foreground/50 ${item.url ? "" : "ml-auto"}`}>{formatLocalDateTime(item.timestamp)}</span>
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
