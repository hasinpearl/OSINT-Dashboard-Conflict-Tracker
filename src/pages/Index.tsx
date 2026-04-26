import { useState, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { DashboardHeader } from "@/components/dashboard/DashboardHeader";
import { NewsFeed } from "@/components/dashboard/NewsFeed";
import { TelegramPanel } from "@/components/dashboard/TelegramPanel";
import { LiveCoverage } from "@/components/dashboard/LiveCoverage";
import { BiasTracker } from "@/components/dashboard/BiasTracker";
import { HotTopicsTimeline } from "@/components/dashboard/HotTopicsTimeline";
import { OsintPanel } from "@/components/dashboard/OsintPanel";
import { AnalystPanel } from "@/components/dashboard/AnalystPanel";
import { useLanguage } from "@/i18n/LanguageContext";

const Index = () => {
  const [isLoading, setIsLoading] = useState(false);
  const queryClient = useQueryClient();
  const { isRTL, t } = useLanguage();

  const handleRefresh = useCallback(() => {
    setIsLoading(true);
    queryClient.refetchQueries({ stale: true });
    setTimeout(() => setIsLoading(false), 3000);
  }, [queryClient]);

  return (
    <div className="flex flex-col h-screen overflow-hidden" dir={isRTL ? "rtl" : "ltr"}>
      <div className="relative flex-1 overflow-hidden">
        <div className="absolute inset-x-0 top-0 z-30 pointer-events-none">
          <div className="pointer-events-auto">
            <DashboardHeader onRefresh={handleRefresh} isLoading={isLoading} />
          </div>
        </div>
        <main className="h-full overflow-auto p-2 gap-2 grid grid-cols-1 lg:grid-cols-3 auto-rows-[minmax(280px,1fr)] pt-[5.5rem] sm:pt-[6rem]">
        {/* Row 1 */}
        <div className="lg:col-span-2">
          <NewsFeed />
        </div>
        <div>
          <TelegramPanel />
        </div>

        {/* Row 2 */}
        <div className="lg:col-span-2">
          <LiveCoverage />
        </div>
        <div>
          <BiasTracker />
        </div>

        {/* Row 3 */}
        <div>
          <HotTopicsTimeline />
        </div>
        <div className="lg:col-span-2">
          <OsintPanel />
        </div>

        {/* Row 4 - full width */}
        <div className="lg:col-span-3">
          <AnalystPanel />
        </div>
      </main>
      </div>
      <footer className="border-t border-white/30 bg-white/10 backdrop-blur-xl backdrop-saturate-150 px-4 py-3 text-[10px] font-mono flex items-center justify-between">
        <div className="flex flex-col gap-0.5">
          <span className="text-foreground font-bold">© {new Date().getFullYear()} Hessa Alhammadi. {t("footer.copyright")}</span>
          {isRTL && (
            <span className="text-amber-600 font-bold text-[9px]">
              ⚠ الترجمات تتم تلقائيًا بواسطة الذكاء الاصطناعي وقد لا تكون دقيقة بالكامل
            </span>
          )}
        </div>
        <span className="text-muted-foreground font-bold max-w-xl text-end">
          {t("footer.disclaimer")}
        </span>
      </footer>
    </div>
  );
};

export default Index;
