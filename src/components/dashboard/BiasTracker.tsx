import { useQuery } from "@tanstack/react-query";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { supabase } from "@/integrations/supabase/client";
import { BarChart3 } from "lucide-react";
import { useLanguage } from "@/i18n/LanguageContext";
import { useTranslatedData } from "@/hooks/useTranslatedData";
import { ExpandablePanel } from "./ExpandablePanel";

interface BiasData {
  total_stories: number;
  left_count: number;
  center_count: number;
  right_count: number;
  left_pct: number;
  center_pct: number;
  right_pct: number;
  summary: string;
  top_left_story: string;
  top_center_story: string;
  top_right_story: string;
  last_updated: string;
}

const SpectrumBar = ({ left, center, right }: { left: number; center: number; right: number }) => {
  const total = Math.max(left + center + right, 0.0001);
  const l = (left / total) * 100;
  const c = (center / total) * 100;
  const r = (right / total) * 100;
  return (
    <div className="flex h-3 w-full rounded-sm overflow-hidden bg-muted border border-border">
      {l > 0 && <div className="bg-blue-600" style={{ width: `${l}%` }} title={`U.S./Israel ${l.toFixed(0)}%`} />}
      {c > 0 && <div className="bg-gray-400" style={{ width: `${c}%` }} title={`Neutral ${c.toFixed(0)}%`} />}
      {r > 0 && <div className="bg-red-600" style={{ width: `${r}%` }} title={`Iran ${r.toFixed(0)}%`} />}
    </div>
  );
};

export const BiasTracker = () => {
  const { t } = useLanguage();

  const { data, isLoading, error } = useQuery({
    queryKey: ["bias-tracker"],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke("bias-tracker");
      if (error) throw error;
      return data as BiasData;
    },
    staleTime: 12 * 60 * 60 * 1000,
    refetchInterval: 12 * 60 * 60 * 1000,
  });

  const { data: translated, isTranslating } = useTranslatedData(data, "bias-tracker");
  const view = (translated ?? data) as BiasData | undefined;

  const lastAnalyzed = view?.last_updated
    ? new Date(view.last_updated).toLocaleString()
    : null;

  return (
    <ExpandablePanel>
      <div className="flex flex-col h-full bg-card/80 backdrop-blur-md rounded-sm border border-border overflow-hidden">
        <div className="panel-header">
          <div className="flex items-center gap-2">
            <BarChart3 className="h-3.5 w-3.5" />
            <span>{t("bias.title")}</span>
          </div>
          <span className="text-[10px] opacity-60">{t("bias.subtitle")}</span>
        </div>
        <ScrollArea className="flex-1 p-3">
          {(isLoading || isTranslating) && (
            <div className="space-y-3">
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          )}
          {error && !isLoading && (
            <div className="text-sm text-muted-foreground p-4 text-center">
              <p className="text-severity-critical font-mono text-xs">{t("bias.offline")}</p>
            </div>
          )}
          {view && !isLoading && !isTranslating && (
            <div className="space-y-4">
              {/* Spectrum bar with side labels */}
              <div className="space-y-1.5">
                <div className="flex justify-between text-[10px] font-mono text-muted-foreground uppercase">
                  <span>U.S. / Israel</span>
                  <span>Neutral / Intl</span>
                  <span>Iran</span>
                </div>
                <SpectrumBar
                  left={view.left_pct}
                  center={view.center_pct}
                  right={view.right_pct}
                />
                <div className="flex justify-between text-[11px] font-mono">
                  <span className="text-blue-500">U.S./Israel: {Math.round(view.left_pct)}%</span>
                  <span className="text-muted-foreground">Neutral: {Math.round(view.center_pct)}%</span>
                  <span className="text-red-500">Iran: {Math.round(view.right_pct)}%</span>
                </div>
              </div>

              {/* Summary */}
              {view.summary && (
                <p className="text-xs text-foreground/90 leading-relaxed">{view.summary}</p>
              )}

              {/* Example headlines */}
              <div className="space-y-2 pt-2 border-t border-border">
                {view.top_left_story && (
                  <div>
                    <div className="text-[10px] font-mono uppercase text-blue-500 mb-0.5">
                      Pro-US/Israel Narrative
                    </div>
                    <p className="text-xs text-foreground/90 leading-snug">{view.top_left_story}</p>
                  </div>
                )}
                {view.top_center_story && (
                  <div>
                    <div className="text-[10px] font-mono uppercase text-muted-foreground mb-0.5">
                      Neutral Narrative
                    </div>
                    <p className="text-xs text-foreground/90 leading-snug">{view.top_center_story}</p>
                  </div>
                )}
                {view.top_right_story && (
                  <div>
                    <div className="text-[10px] font-mono uppercase text-red-500 mb-0.5">
                      Pro-Iran Narrative
                    </div>
                    <p className="text-xs text-foreground/90 leading-snug">{view.top_right_story}</p>
                  </div>
                )}
              </div>

              {lastAnalyzed && (
                <div className="text-[10px] font-mono text-muted-foreground pt-2 border-t border-border">
                  Last analyzed: {lastAnalyzed}
                </div>
              )}
            </div>
          )}
        </ScrollArea>
      </div>
    </ExpandablePanel>
  );
};
