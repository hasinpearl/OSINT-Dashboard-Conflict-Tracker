import { useQuery } from "@tanstack/react-query";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { supabase } from "@/integrations/supabase/client";
import { BarChart3 } from "lucide-react";
import { useLanguage } from "@/i18n/LanguageContext";
import { useTranslatedData } from "@/hooks/useTranslatedData";
import { ExpandablePanel } from "./ExpandablePanel";
import { useConflictFilter } from "@/contexts/ConflictFilterContext";

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
  left_label: string;
  center_label: string;
  right_label: string;
}

interface SingleResponse extends BiasData {
  mode: "single";
  conflict: string;
  label: string;
}

interface AllResponse {
  mode: "all";
  conflicts: Array<BiasData & { conflict: string; label: string }>;
  last_updated: string;
}

type BiasResponse = SingleResponse | AllResponse;

const SpectrumBar = ({
  left,
  center,
  right,
  leftLabel,
  centerLabel,
  rightLabel,
}: {
  left: number;
  center: number;
  right: number;
  leftLabel: string;
  centerLabel: string;
  rightLabel: string;
}) => {
  const total = Math.max(left + center + right, 0.0001);
  const l = (left / total) * 100;
  const c = (center / total) * 100;
  const r = (right / total) * 100;
  return (
    <div className="flex h-3 w-full rounded-sm overflow-hidden bg-muted border border-border">
      {l > 0 && (
        <div className="bg-[#3B82F6]" style={{ width: `${l}%` }} title={`${leftLabel} ${l.toFixed(0)}%`} />
      )}
      {c > 0 && (
        <div className="bg-[#DBDBDB] dark:bg-[#6B7280]" style={{ width: `${c}%` }} title={`${centerLabel} ${c.toFixed(0)}%`} />
      )}
      {r > 0 && (
        <div className="bg-[#EF4444]" style={{ width: `${r}%` }} title={`${rightLabel} ${r.toFixed(0)}%`} />
      )}
    </div>
  );
};

const ConflictBar = ({
  data,
  showTitle,
  title,
}: {
  data: BiasData;
  showTitle?: boolean;
  title?: string;
}) => (
  <div className="space-y-1.5">
    {showTitle && title && (
      <div className="text-[11px] font-mono uppercase tracking-wide text-foreground/80">
        {title}
      </div>
    )}
    <div className="flex justify-between text-[10px] font-mono text-muted-foreground uppercase">
      <span>{data.left_label}</span>
      <span>{data.center_label}</span>
      <span>{data.right_label}</span>
    </div>
    <SpectrumBar
      left={data.left_pct}
      center={data.center_pct}
      right={data.right_pct}
      leftLabel={data.left_label}
      centerLabel={data.center_label}
      rightLabel={data.right_label}
    />
    <div className="flex justify-between text-[11px] font-mono">
      <span className="text-[#3B82F6]">{Math.round(data.left_pct)}%</span>
      <span className="text-[#DBDBDB] dark:text-[#9CA3AF]">{Math.round(data.center_pct)}%</span>
      <span className="text-[#EF4444]">{Math.round(data.right_pct)}%</span>
    </div>
  </div>
);

// Track which conflicts have already been force-refreshed this session,
// so we bypass any stale cache from the old (un-suffixed) bias-tracker key
// exactly once per conflict.
const refreshedConflicts = new Set<string>();

export const BiasTracker = () => {
  const { t } = useLanguage();
  const { conflict } = useConflictFilter();

  const { data, isLoading, error } = useQuery({
    queryKey: ["bias-tracker", conflict],
    queryFn: async () => {
      const force_refresh = !refreshedConflicts.has(conflict);
      const { data, error } = await supabase.functions.invoke("bias-tracker", {
        body: { conflict, force_refresh },
      });
      if (error) throw error;
      refreshedConflicts.add(conflict);
      return data as BiasResponse;
    },
    staleTime: 12 * 60 * 60 * 1000,
    refetchInterval: 12 * 60 * 60 * 1000,
  });

  const { data: translated } = useTranslatedData(data, "bias-tracker");
  const view = (translated ?? data) as BiasResponse | undefined;

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
          {isLoading && (
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

          {view && view.mode === "all" && !isLoading && (
            <div className="space-y-4">
              <div className="space-y-4">
                {view.conflicts.map((c) => (
                  <ConflictBar key={c.conflict} data={c} showTitle title={c.label} />
                ))}
              </div>

              {/* Combined summary across all conflicts */}
              <div className="pt-2 border-t border-border space-y-2">
                {view.conflicts.map(
                  (c) =>
                    c.summary && (
                      <div key={`sum-${c.conflict}`}>
                        <div className="text-[10px] font-mono uppercase text-muted-foreground mb-0.5">
                          {c.label}
                        </div>
                        <p className="text-xs text-foreground/90 leading-relaxed">{c.summary}</p>
                      </div>
                    ),
                )}
              </div>

              {lastAnalyzed && (
                <div className="text-[10px] font-mono text-muted-foreground pt-2 border-t border-border">
                  Last analyzed: {lastAnalyzed}
                </div>
              )}
            </div>
          )}

          {view && view.mode === "single" && !isLoading && (
            <div className="space-y-4">
              <ConflictBar data={view} />

              {view.summary && (
                <p className="text-xs text-foreground/90 leading-relaxed">{view.summary}</p>
              )}

              {/* Example headlines */}
              <div className="space-y-2 pt-2 border-t border-border">
                {view.top_left_story && (
                  <div>
                    <div className="text-[10px] font-mono uppercase text-[#3B82F6] mb-0.5">
                      {view.left_label}
                    </div>
                    <p className="text-xs text-foreground/90 leading-snug">{view.top_left_story}</p>
                  </div>
                )}
                {view.top_center_story && (
                  <div>
                    <div className="text-[10px] font-mono uppercase text-muted-foreground mb-0.5">
                      {view.center_label}
                    </div>
                    <p className="text-xs text-foreground/90 leading-snug">{view.top_center_story}</p>
                  </div>
                )}
                {view.top_right_story && (
                  <div>
                    <div className="text-[10px] font-mono uppercase text-[#EF4444] mb-0.5">
                      {view.right_label}
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
