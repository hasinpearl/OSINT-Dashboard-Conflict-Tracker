import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useLanguage, Language } from "@/i18n/LanguageContext";

/**
 * Returns true if `translated` looks usable compared to `original`.
 * Rule: showing English is always better than showing nothing.
 *
 * - null/undefined translated → unusable
 * - if any array field on the original has items but the same field on
 *   the translated result is empty/missing → unusable
 */
function isTranslationUsable(original: unknown, translated: unknown): boolean {
  if (translated === null || translated === undefined) return false;

  if (
    original &&
    typeof original === "object" &&
    !Array.isArray(original) &&
    translated &&
    typeof translated === "object" &&
    !Array.isArray(translated)
  ) {
    const o = original as Record<string, unknown>;
    const t = translated as Record<string, unknown>;
    for (const key of Object.keys(o)) {
      const ov = o[key];
      const tv = t[key];
      if (Array.isArray(ov) && ov.length > 0) {
        if (!Array.isArray(tv) || tv.length < ov.length) {
          console.warn(
            `Translation unusable: field "${key}" has ${ov.length} items in English but ${
              Array.isArray(tv) ? tv.length : "none"
            } in translated result. Falling back to English.`
          );
          return false;
        }
      }
    }
  }

  if (Array.isArray(original) && original.length > 0) {
    if (!Array.isArray(translated) || translated.length < original.length) {
      return false;
    }
  }

  return true;
}

export function useTranslatedData<T>(
  originalData: T | undefined,
  queryKey: string
) {
  const { language } = useLanguage();

  const { data: translatedData, isLoading: isTranslating } = useQuery({
    queryKey: [queryKey, "translate", language],
    queryFn: async () => {
      if (language === "en" || !originalData) return originalData;
      try {
        const { data, error } = await supabase.functions.invoke("translate", {
          body: { data: originalData, targetLang: language },
        });
        if (error) {
          console.error("Translation error:", error);
          return originalData;
        }
        const translated = (data as { translated: T } | null)?.translated;
        if (!isTranslationUsable(originalData, translated)) {
          return originalData;
        }
        return translated;
      } catch (e) {
        console.error("Translation invocation failed:", e);
        return originalData;
      }
    },
    enabled: !!originalData && language === "ar",
    staleTime: 10 * 60 * 1000,
  });

  if (language === "en") return { data: originalData, isTranslating: false };

  // Final guard at consumption: if translated payload is missing or unusable, prefer original.
  const safeData = isTranslationUsable(originalData, translatedData)
    ? (translatedData as T | undefined)
    : originalData;

  return {
    data: safeData ?? originalData,
    isTranslating: isTranslating && language === "ar" && !!originalData,
  };
}
