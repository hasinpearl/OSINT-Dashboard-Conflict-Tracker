import { useConflictFilter, ConflictFilter as Filter } from "@/contexts/ConflictFilterContext";
import { useLanguage } from "@/i18n/LanguageContext";

const OPTIONS: { value: Filter; tKey: string }[] = [
  { value: "all", tKey: "conflict.all" },
  { value: "iran-us", tKey: "conflict.iran-us" },
  { value: "ukraine-russia", tKey: "conflict.ukraine-russia" },
  { value: "china-taiwan", tKey: "conflict.china-taiwan" },
];

export const ConflictFilter = () => {
  const { conflict, setConflict } = useConflictFilter();
  const { t } = useLanguage();

  return (
    <div className="flex items-center gap-1 px-2 py-1.5 bg-card/80 backdrop-blur-md border border-border rounded-sm overflow-x-auto">
      <span className="text-[9px] font-mono uppercase text-muted-foreground tracking-wider mr-1 shrink-0">
        {t("conflict.label")}
      </span>
      {OPTIONS.map((opt) => {
        const active = conflict === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => setConflict(opt.value)}
            className={`text-[10px] sm:text-[11px] font-mono px-2 py-1 rounded-sm border transition-colors shrink-0 ${
              active
                ? "bg-secondary text-secondary-foreground border-secondary"
                : "bg-transparent text-muted-foreground border-border hover:text-foreground hover:border-secondary/50"
            }`}
          >
            {t(opt.tKey)}
          </button>
        );
      })}
    </div>
  );
};
