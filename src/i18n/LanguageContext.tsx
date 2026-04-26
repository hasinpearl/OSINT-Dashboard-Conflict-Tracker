import { createContext, useContext, useState, ReactNode } from "react";

export type Language = "en" | "ar";

interface LanguageContextType {
  language: Language;
  setLanguage: (lang: Language) => void;
  t: (key: string) => string;
  isRTL: boolean;
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

export const useLanguage = () => {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error("useLanguage must be used within LanguageProvider");
  return ctx;
};

const translations: Record<string, Record<Language, string>> = {
  // Header
  "header.title": { en: "Conflict Tracker", ar: "متتبع الصراعات" },
  "header.byline": { en: "by Hessa Alhammadi", ar: "من حصه الحمادي" },
  "header.refresh": { en: "REFRESH", ar: "تحديث" },

  // Panel titles
  "news.title": { en: "Live News Feed", ar: "آخر الأخبار مباشر" },
  "news.subtitle": { en: "LIVE SUMMARY", ar: "ملخص مباشر" },
  "news.offline": { en: "FEED OFFLINE", ar: "التغذية غير متصلة" },
  "news.error": { en: "Unable to fetch news data", ar: "تعذر جلب بيانات الأخبار" },

  "telegram.title": { en: "Telegram Channels", ar: "قنوات تيليغرام" },
  "telegram.sources": { en: "SOURCES", ar: "مصادر" },
  "telegram.offline": { en: "FEED OFFLINE", ar: "التغذية غير متصلة" },
  "telegram.error": { en: "Unable to fetch Telegram data", ar: "تعذر جلب بيانات تيليغرام" },
  "telegram.noMessages": { en: "NO MESSAGES", ar: "لا توجد رسائل" },

  "live.title": { en: "LIVE NEWS", ar: "البث المباشر" },

  "bias.title": { en: "Bias Tracker", ar: "متتبع التحيز" },
  "bias.subtitle": { en: "Content narrative analysis · Updated every 12h", ar: "تحليل سردية المحتوى · يُحدَّث كل ١٢ ساعة" },
  "bias.offline": { en: "FEED OFFLINE", ar: "التغذية غير متصلة" },
  "bias.left": { en: "LEFT", ar: "يسار" },
  "bias.center": { en: "CENTER", ar: "وسط" },
  "bias.right": { en: "RIGHT", ar: "يمين" },
  "bias.sources": { en: "sources", ar: "مصادر" },

  "topics.title": { en: "Major Developments", ar: "التطورات الرئيسية" },
  "topics.subtitle": { en: "TIMELINE", ar: "الجدول الزمني" },
  "topics.offline": { en: "OFFLINE", ar: "غير متصل" },
  "topics.mentions": { en: "mentions", ar: "إشارات" },

  "osint.title": { en: "OSINT Feed", ar: "تغذية الاستخبارات المفتوحة" },
  "osint.subtitle": { en: "OPEN SOURCE INTEL", ar: "استخبارات مفتوحة المصدر" },
  "osint.offline": { en: "FEED OFFLINE", ar: "التغذية غير متصلة" },

  "analyst.title": { en: "Analyst Commentary", ar: "تعليقات المحللين" },
  "analyst.subtitle": { en: "EXPERT ANALYSIS", ar: "تحليل الخبراء" },
  "analyst.offline": { en: "FEED OFFLINE", ar: "التغذية غير متصلة" },
  "analyst.source": { en: "source", ar: "المصدر" },

  // Severity labels
  "severity.critical": { en: "critical", ar: "حرج" },
  "severity.high": { en: "high", ar: "عالي" },
  "severity.developing": { en: "developing", ar: "قيد التطور" },
  "severity.verified": { en: "verified", ar: "موثق" },
  "severity.info": { en: "info", ar: "معلومات" },

  // Confidence
  "confidence.verified": { en: "verified", ar: "موثق" },
  "confidence.unverified": { en: "unverified", ar: "غير موثق" },
  "confidence.developing": { en: "developing", ar: "قيد التطور" },

  // Footer
  "footer.copyright": { en: "All rights reserved.", ar: "جميع الحقوق محفوظة." },
  "footer.disclaimer": {
    en: "Data is autonomously aggregated and may not reflect real-time conditions. Verify critical information independently.",
    ar: "يتم تجميع البيانات تلقائيًا وقد لا تعكس الظروف الآنية. تحقق من المعلومات الحرجة بشكل مستقل."
  },

  // Expand
  "panel.expand": { en: "Expand", ar: "توسيع" },
  "panel.collapse": { en: "Collapse", ar: "تصغير" },

  // Language
  "lang.switch": { en: "عربي", ar: "English" },

  // Loading
  "loading.translating": { en: "Translating...", ar: "جاري الترجمة..." },
};

export const LanguageProvider = ({ children }: { children: ReactNode }) => {
  const [language, setLanguage] = useState<Language>("en");

  const t = (key: string): string => {
    return translations[key]?.[language] ?? key;
  };

  return (
    <LanguageContext.Provider value={{ language, setLanguage, t, isRTL: language === "ar" }}>
      {children}
    </LanguageContext.Provider>
  );
};
