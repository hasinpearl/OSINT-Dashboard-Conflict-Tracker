import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useLanguage } from "@/i18n/LanguageContext";
import { useConflictFilter } from "@/contexts/ConflictFilterContext";

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




/**
 * Static Arabic translations for known bias labels and conflict titles.
 * Avoids wasteful API calls for these fixed strings.
 */
const LABEL_TRANSLATIONS_AR: Record<string, string> = {
  // Conflict titles
  "Iran / U.S.": "إيران / الولايات المتحدة",
  "Ukraine / Russia": "أوكرانيا / روسيا",
  "China / Taiwan": "الصين / تايوان",
  // Bias labels
  "U.S. / Israel": "الولايات المتحدة / إسرائيل",
  "Iran": "إيران",
  "Neutral / International": "محايد / دولي",
  "Ukraine / West": "أوكرانيا / الغرب",
  "Russia": "روسيا",
  "Taiwan / West": "تايوان / الغرب",
  "China": "الصين",
  "Western / U.S.-aligned": "الغرب / حلفاء أمريكا",
  "Anti-Western / Adversary-aligned": "معادي للغرب / حلفاء الخصوم",
};

/**
 * Special-case translator for the BiasTracker payload.
 *
 * - Labels and conflict titles use hardcoded Arabic translations (no API call).
 * - Summaries and story headlines are translated via API, batched per conflict.
 * - On any failure for a field, keep the original English.
 */
async function translateBiasTracker<T>(original: T, targetLang: string): Promise<T> {
  if (!original || typeof original !== "object") return original;
  const data = original as any;

  const LABEL_FIELDS = ["left_label", "center_label", "right_label", "label"] as const;
  const API_FIELDS = ["summary", "top_left_story", "top_center_story", "top_right_story"] as const;

  const translateConflictBlock = async (block: any) => {
    if (!block || typeof block !== "object") return block;
    const out = { ...block };

    // Hardcode label translations
    for (const field of LABEL_FIELDS) {
      const val = block[field];
      if (typeof val === "string" && LABEL_TRANSLATIONS_AR[val]) {
        out[field] = LABEL_TRANSLATIONS_AR[val];
      }
    }

    // Batch-translate text fields: collect all values, send as one object
    const toTranslate: Record<string, string> = {};
    for (const field of API_FIELDS) {
      const val = block[field];
      if (typeof val === "string" && val.trim().length > 0) {
        toTranslate[field] = val;
      }
    }

    if (Object.keys(toTranslate).length > 0) {
      try {
        const { data: result, error } = await supabase.functions.invoke("translate", {
          body: { data: toTranslate, targetLang },
        });
        if (!error && result?.translated) {
          const t = result.translated as Record<string, string>;
          for (const field of API_FIELDS) {
            if (typeof t[field] === "string" && t[field].trim().length > 0) {
              out[field] = t[field];
            }
          }
        }
      } catch (e) {
        console.error("Bias block translation failed, keeping English:", e);
      }
    }

    return out;
  };

  if (data.mode === "all" && Array.isArray(data.conflicts)) {
    const translatedConflicts = await Promise.all(
      data.conflicts.map((c: any) => translateConflictBlock(c)),
    );
    return { ...data, conflicts: translatedConflicts } as T;
  }

  if (data.mode === "single") {
    const translated = await translateConflictBlock(data);
    return { ...data, ...translated } as T;
  }

  return original;
}

export function useTranslatedData<T>(
  originalData: T | undefined,
  queryKey: string
) {
  const { language } = useLanguage();
  const { conflict } = useConflictFilter();
  // Cache key includes BOTH conflict and language so each combination
  // (e.g. "bias-tracker:iran-us:ar", "bias-tracker:all:ar") gets its own entry.
  const scopedKey = `${queryKey}:${conflict}:${language}`;

  const { data: translatedData, isLoading: isTranslating } = useQuery({
    queryKey: [scopedKey, "translate"],
    queryFn: async () => {
      if (language === "en" || !originalData) return originalData;
      try {
        // Special path: BiasTracker — translate per-conflict summary fields individually,
        // skip labels, fall back to English on failure.
        if (queryKey === "bias-tracker") {
          try {
            const result = await translateBiasTracker(originalData, language);
            return result;
          } catch (e) {
            console.error("Bias tracker translation failed, using English:", e);
            return originalData;
          }
        }

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
