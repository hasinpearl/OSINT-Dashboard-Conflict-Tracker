import { useEffect, useMemo } from "react";
import { useConflictFilter } from "@/contexts/ConflictFilterContext";
import { useConflicts } from "@/hooks/useConflicts";
import { useLanguage } from "@/i18n/LanguageContext";

// The tab bar is the enabled conflict registry, read from /api/conflicts. It
// is deliberately NOT a hardcoded list: a conflict Hessa disables has to lose
// its tab, and one she enables has to gain one, without a frontend redeploy.
//
// Labels come from the translation table when there is an entry for the key,
// so Hessa's Arabic labels keep working, and fall back to the API's own label
// for a conflict added after this build. That is what lets her add a theatre
// in three months and see it named correctly before any translation exists.

export const ConflictFilter = () => {
  const { conflict, setConflict } = useConflictFilter();
  const { t } = useLanguage();
  const { data } = useConflicts();

  // Memoised because the effect below depends on it: `data?.conflicts ?? []`
  // builds a new array identity on every render, which would re-run the
  // effect on every render.
  const conflicts = useMemo(() => data?.conflicts ?? [], [data]);

  // The selected conflict may have just been disabled, which would leave the
  // dashboard requesting a tab that no longer exists. The API answers such a
  // request with the "all" tab anyway, so the selection is reset to match what
  // is actually being served rather than showing a highlighted phantom tab.
  useEffect(() => {
    if (conflicts.length === 0) return;
    if (conflict === "all") return;
    if (!conflicts.some((c) => c.key === conflict)) setConflict("all");
  }, [conflicts, conflict, setConflict]);

  const options = [
    { value: "all", label: t("conflict.all") },
    ...conflicts.map((c) => {
      const key = `conflict.${c.key}`;
      const translated = t(key);
      return { value: c.key, label: translated === key ? c.label : translated };
    }),
  ];

  return (
    <div className="flex items-center gap-1 px-2 py-1.5 bg-card/80 backdrop-blur-md border border-border rounded-sm overflow-x-auto">
      <span className="text-[9px] font-mono uppercase text-muted-foreground tracking-wider mr-1 shrink-0">
        {t("conflict.label")}
      </span>
      {options.map((opt) => {
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
            {opt.label}
          </button>
        );
      })}
    </div>
  );
};
