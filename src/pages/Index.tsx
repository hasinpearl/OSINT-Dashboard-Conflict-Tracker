import { useState, useCallback } from "react";
import { Github } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { DashboardHeader } from "@/components/dashboard/DashboardHeader";
import { NewsFeed } from "@/components/dashboard/NewsFeed";
import { TelegramPanel } from "@/components/dashboard/TelegramPanel";
import { LiveCoverage } from "@/components/dashboard/LiveCoverage";
import { BiasTracker } from "@/components/dashboard/BiasTracker";
import { HotTopicsTimeline } from "@/components/dashboard/HotTopicsTimeline";
import { OsintPanel } from "@/components/dashboard/OsintPanel";
import { AnalystPanel } from "@/components/dashboard/AnalystPanel";
import { ConflictFilter } from "@/components/dashboard/ConflictFilter";
import { useLanguage } from "@/i18n/LanguageContext";
import { useConflictFilter } from "@/contexts/ConflictFilterContext";

const PANEL_FUNCTIONS = [
  "firecrawl-news",
  "telegram-feed",
  "ai-summarize",
  "perplexity-osint",
  "perplexity-analyst",
  "bias-tracker",
];

const Index = () => {
  const [isLoading, setIsLoading] = useState(false);
  const queryClient = useQueryClient();
  const { isRTL, t } = useLanguage();
  const { conflict } = useConflictFilter();

  const handleRefresh = useCallback(async () => {
    setIsLoading(true);
    try {
      await Promise.all(
        PANEL_FUNCTIONS.map(async (fn) => {
          const { error } = await supabase.functions.invoke(fn, {
            body: { conflict, force_refresh: true },
          });
          if (error) throw error;
        }),
      );
      await queryClient.refetchQueries({ type: "active" });
    } catch (error) {
      console.warn("[hard_refresh] one or more panels failed:", error);
      await queryClient.refetchQueries({ type: "active" });
    } finally {
      setIsLoading(false);
    }
  }, [conflict, queryClient]);

  return (
    <div className="flex flex-col h-screen overflow-hidden" dir={isRTL ? "rtl" : "ltr"}>
      <div className="relative flex-1 overflow-hidden">
        <div className="absolute inset-x-0 top-0 z-30 pointer-events-none">
          <div className="pointer-events-auto">
            <DashboardHeader onRefresh={handleRefresh} isLoading={isLoading} />
          </div>
        </div>
        <main className="h-full overflow-hidden p-2 pt-[7rem] sm:pt-[7.5rem] flex flex-col">
          <div className="shrink-0 mb-2">
            <ConflictFilter />
          </div>
          <div className="flex-1 min-h-0 overflow-auto grid grid-cols-1 lg:grid-cols-3 auto-rows-[minmax(280px,1fr)] gap-2">
            {/* Row 1 */}
            <div>
              <NewsFeed />
            </div>
            <div className="lg:row-span-2 h-full">
              <HotTopicsTimeline />
            </div>
            <div>
              <TelegramPanel />
            </div>
            {/* Row 2 */}
            <div>
              <BiasTracker />
            </div>
            <div>
              <OsintPanel />
            </div>
            {/* Row 3 */}
            <div className="lg:col-span-3">
              <LiveCoverage />
            </div>
            {/* Row 4 */}
            <div className="lg:col-span-3">
              <AnalystPanel />
            </div>
          </div>
        </main>
      </div>
      <footer className="border-t border-white/30 bg-white/10 backdrop-blur-xl backdrop-saturate-150 px-4 py-3 text-[10px] font-mono flex items-center justify-between">
        <div className="flex flex-col gap-0.5">
          <span className="text-foreground font-bold">© {new Date().getFullYear()} <a href="https://hessaa.net" target="_blank" rel="noopener noreferrer" className="underline hover:text-primary transition-colors">Hessa Al Hammadi</a>. {t("footer.copyright")}</span>
          {isRTL && (
            <span className="text-amber-600 font-bold text-[9px]">
              ⚠ الترجمات تتم تلقائيًا بواسطة الذكاء الاصطناعي وقد لا تكون دقيقة بالكامل
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 max-w-xl">
          <span className="text-muted-foreground font-bold text-end">
            {t("footer.disclaimer")}
          </span>
          <a
            href="https://github.com/hasinpearl/OSINT-Dashboard-Conflict-Tracker"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="GitHub repository"
            className="text-muted-foreground hover:text-primary transition-colors shrink-0"
          >
            <Github className="w-4 h-4" />
          </a>
        </div>
      </footer>
    </div>
  );
};

export default Index;
