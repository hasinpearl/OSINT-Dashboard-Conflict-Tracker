import { useState, ReactNode } from "react";
import { Maximize2, X } from "lucide-react";
import { useLanguage } from "@/i18n/LanguageContext";

interface ExpandablePanelProps {
  children: ReactNode;
}

export const ExpandablePanel = ({ children }: ExpandablePanelProps) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const { t } = useLanguage();

  if (isExpanded) {
    return (
      <div className="fixed inset-0 bg-background flex flex-col" style={{ zIndex: 9999, isolation: "isolate" }}>
        <div className="absolute top-3 right-3 z-10 ltr:right-3 rtl:left-3">
          <button
            onClick={() => setIsExpanded(false)}
            className="p-2 rounded-sm bg-card border border-border hover:bg-muted transition-colors"
            title={t("panel.collapse")}
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex-1 overflow-hidden">{children}</div>
      </div>
    );
  }

  return (
    <div className="relative group h-full">
      <button
        onClick={() => setIsExpanded(true)}
        className="absolute top-2 right-8 z-10 opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded-sm bg-black/20 hover:bg-black/40 text-white"
        title={t("panel.expand")}
      >
        <Maximize2 className="h-3.5 w-3.5" />
      </button>
      {children}
    </div>
  );
};
