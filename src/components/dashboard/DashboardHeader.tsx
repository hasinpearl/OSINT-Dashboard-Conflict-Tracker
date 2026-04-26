import { useState, useEffect } from "react";
import { RefreshCw, Radio, Sun, Moon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/i18n/LanguageContext";
import { useTheme } from "@/hooks/useTheme";
import { cn } from "@/lib/utils";
import logoWhite from "@/assets/logo-hessa.png";
import flagUAE from "@/assets/flag-uae.png";
import flagUSA from "@/assets/flag-usa.png";

interface DashboardHeaderProps {
  onRefresh: () => void;
  isLoading: boolean;
}

export const DashboardHeader = ({ onRefresh, isLoading }: DashboardHeaderProps) => {
  const [time, setTime] = useState(new Date());
  const { language, setLanguage, t } = useLanguage();
  const { isDark, toggle: toggleTheme } = useTheme();

  const themeToggle = (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      className="group relative inline-flex h-6 w-12 shrink-0 items-center rounded-full border border-white/30 bg-white/20 px-1 transition-colors hover:bg-white/30 dark:border-white/10 dark:bg-white/10 dark:hover:bg-white/20"
    >
      <Sun className="absolute left-1 h-3 w-3 text-amber-500" />
      <Moon className="absolute right-1 h-3 w-3 text-slate-300" />
      <span
        className={cn(
          "relative z-10 inline-block h-4 w-4 rounded-full bg-white shadow-md ring-1 ring-black/5 transition-transform",
          isDark ? "translate-x-6" : "translate-x-0"
        )}
      />
    </button>
  );

  useEffect(() => {
    const interval = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  const utcTime = time.toISOString().slice(11, 19);
  const uaeTime = time.toLocaleTimeString("en-US", { hour12: false, timeZone: "Asia/Dubai" });

  const toggleLanguage = () => {
    setLanguage(language === "en" ? "ar" : "en");
  };

  return (
    <div className="px-3 pt-4 lg:px-6 lg:pt-5">
      <header
        className={cn(
          "relative flex flex-col gap-2 overflow-hidden rounded-2xl px-4 py-2.5 lg:px-6 lg:py-3",
          "border border-white/30 bg-white/10 backdrop-blur-xl backdrop-saturate-150",
          "shadow-[0_10px_40px_-10px_rgba(32,38,76,0.35)]"
        )}
      >
        {/* Top sheen */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-1/2 rounded-t-2xl bg-gradient-to-b from-white/40 to-transparent"
        />
        {/* Inner ring */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-2xl ring-1 ring-inset ring-white/20"
        />
        {/* Color wash */}
        <div
          aria-hidden
          className="pointer-events-none absolute -inset-1 -z-10 rounded-2xl bg-gradient-to-r from-primary/20 via-transparent to-secondary/20 blur-2xl"
        />

        {/* Top row: logo + title + desktop controls */}
        <div className="relative flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 lg:gap-5 min-w-0">
            <img src={logoWhite} alt="Logo" className="h-9 lg:h-12 w-auto shrink-0 object-contain" />
            <div className="flex items-center gap-2 min-w-0">
              <Radio className="h-3.5 w-3.5 lg:h-4 lg:w-4 text-secondary animate-pulse-dot shrink-0" />
              <h1 className="text-[11px] lg:text-sm tracking-wide font-mono uppercase leading-tight whitespace-nowrap">
                <span className="font-bold text-foreground">{t("header.title")}</span>
                {" "}
                <span className="font-normal text-foreground/70">{t("header.byline")}</span>
              </h1>
            </div>
          </div>
          {/* Desktop controls */}
          <div className="hidden lg:flex items-center gap-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={toggleLanguage}
              className="text-foreground/80 hover:text-foreground hover:bg-white/20 h-7 px-2 gap-1.5"
            >
              <img src={language === "en" ? flagUAE : flagUSA} alt={language === "en" ? "Arabic" : "English"} className="h-5 w-7 object-cover rounded-sm" />
            </Button>
            <div className="text-xs font-mono text-foreground/70 flex gap-4">
              <span>UTC {utcTime}</span>
              <span>UAE {uaeTime}</span>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={onRefresh}
              disabled={isLoading}
              className="text-foreground/80 hover:text-foreground hover:bg-white/20 h-7 px-2"
            >
              <RefreshCw className={`h-3.5 w-3.5 mr-1 ${isLoading ? "animate-spin" : ""}`} />
              <span className="text-xs font-mono">{t("header.refresh")}</span>
            </Button>
            {themeToggle}
          </div>
        </div>

        {/* Mobile controls row */}
        <div className="relative flex lg:hidden items-center justify-between border-t border-white/20 pt-2">
          <div className="text-[10px] font-mono text-foreground/70 flex gap-3">
            <span>UTC {utcTime}</span>
            <span>UAE {uaeTime}</span>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={toggleLanguage}
              className="text-foreground/80 hover:text-foreground hover:bg-white/20 h-6 px-1.5 gap-1"
            >
              <img src={language === "en" ? flagUAE : flagUSA} alt={language === "en" ? "Arabic" : "English"} className="h-4 w-6 object-cover rounded-sm" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={onRefresh}
              disabled={isLoading}
              className="text-foreground/80 hover:text-foreground hover:bg-white/20 h-6 px-1.5"
            >
              <RefreshCw className={`h-3 w-3 ${isLoading ? "animate-spin" : ""}`} />
            </Button>
            {themeToggle}
          </div>
        </div>
      </header>
    </div>
  );
};
