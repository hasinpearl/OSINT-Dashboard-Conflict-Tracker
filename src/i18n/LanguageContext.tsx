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
  "header.title": { en: "Conflict Tracker", ar: "متتبع الصراعات" },
  "header.byline": { en: "by Hessa Alhammadi", ar: "من حصه الحمادي" },
  "header.refresh": { en: "REFRESH", ar: "تحديث" },

  "news.title": { en: "Live News Feed", ar: "آخر الأخبار مباشر" },
  "news.subtitle": { en: "LIVE SUMMARY", ar: "ملخص مباشر" },
  "news.offline": { en: "FEED OFFLINE", ar: "التغذية غير متصلة" },
  "news.error": { en: "Unable to fetch news data", ar: "تعذر جلب بيانات الأخبار" },

  "telegram.title": { en: "Telegram Channels", ar: "قنوات تيليغرام" },
  "telegram.sources": { en: "SOURCES", ar: "مصادر" },
  "telegram.offline": { en: "FEED OFFLINE", ar: "التغذية غير متصلة" },
  "telegram.error": { en: "Unable to fetch Telegram data", ar: "تعذر جلب بيانات تيليغرام" },
  "telegram.noMessages": { en: "NO MESSAGES", ar: "لا توجد رسائل" },
  "telegram.filteredOut": {
    en: "Messages are in store but every one is hidden by the channel filter above.",
    ar: "توجد رسائل في المخزن لكن مرشح القنوات أعلاه يخفيها كلها.",
  },

  "live.title": { en: "LIVE NEWS", ar: "البث المباشر" },

  "bias.title": { en: "Bias Tracker", ar: "متتبع التحيز" },
  "bias.subtitle": { en: "Content narrative analysis · Updated every 12h", ar: "تحليل سردية المحتوى · يُحدَّث كل 12 ساعة" },
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

  "map.title": { en: "Event Map", ar: "خريطة الأحداث" },
  "map.subtitle": { en: "GEOLOCATED", ar: "محدد الموقع" },
  "map.pins": { en: "pins", ar: "علامة" },
  "map.offline": { en: "PINS OFFLINE", ar: "العلامات غير متصلة" },
  "map.exact": { en: "exact", ar: "دقيق" },
  "map.approximate": { en: "approximate", ar: "تقريبي" },
  "map.confidence": { en: "confidence", ar: "الثقة" },
  "map.unconfigured": { en: "Map not configured", ar: "الخريطة غير مهيأة" },
  "map.unconfiguredHint": {
    en: "Add the Mapbox style and token to your private .env to enable the map.",
    ar: "أضف نمط ورمز ماببوكس إلى ملف .env الخاص لتشغيل الخريطة.",
  },

  "analyst.title": { en: "Analyst Commentary", ar: "تعليقات المحللين" },
  "analyst.subtitle": { en: "EXPERT ANALYSIS", ar: "تحليل الخبراء" },
  "analyst.offline": { en: "FEED OFFLINE", ar: "التغذية غير متصلة" },
  "analyst.source": { en: "source", ar: "المصدر" },

  "severity.critical": { en: "critical", ar: "حرج" },
  "severity.high": { en: "high", ar: "عالي" },
  "severity.developing": { en: "developing", ar: "قيد التطور" },
  "severity.verified": { en: "verified", ar: "موثق" },
  "severity.info": { en: "info", ar: "معلومات" },

  "confidence.verified": { en: "verified", ar: "موثق" },
  "confidence.unverified": { en: "unverified", ar: "غير موثق" },
  "confidence.developing": { en: "developing", ar: "قيد التطور" },

  "footer.copyright": { en: "All rights reserved.", ar: "جميع الحقوق محفوظة." },
  "footer.disclaimer": {
    en: "Data is autonomously aggregated and may not reflect real-time conditions. Verify critical information independently.",
    ar: "يتم تجميع البيانات تلقائيًا وقد لا تعكس الظروف الآنية. تحقق من المعلومات الحرجة بشكل مستقل."
  },

  "ticker.breaking": { en: "BREAKING", ar: "عاجل" },
  "ticker.empty": { en: "NO BREAKING ITEMS", ar: "لا أخبار عاجلة" },
  "ticker.emptyHint": {
    en: "The ticker is live. Nothing in store is flagged breaking right now.",
    ar: "الشريط يعمل. لا يوجد حاليًا ما هو مصنف كخبر عاجل.",
  },
  "ticker.offline": { en: "TICKER OFFLINE", ar: "الشريط غير متصل" },

  // Panel states. An empty panel and a broken one must never read alike, so
  // each reason gets its own wording.
  "state.panelOffline": { en: "PANEL OFFLINE", ar: "اللوحة غير متصلة" },
  "state.panelOfflineHint": {
    en: "The request to the API failed. The panel retries on its own.",
    ar: "فشل الطلب إلى الواجهة البرمجية. تعيد اللوحة المحاولة تلقائيًا.",
  },
  "state.noDataYet": { en: "NO DATA YET", ar: "لا توجد بيانات بعد" },
  "state.noDataYetHint": {
    en: "The panel is working and the store holds nothing matching this filter yet.",
    ar: "اللوحة تعمل ولا يوجد في المخزن ما يطابق هذا المرشح بعد.",
  },
  "state.collectorsNeverRan": { en: "COLLECTORS NEVER RAN", ar: "لم تعمل أدوات الجمع" },
  "state.collectorsNeverRanHint": {
    en: "No source has reported any status, so nothing has been collected into this database.",
    ar: "لم يبلغ أي مصدر عن حالته، أي أنه لم يُجمع شيء في قاعدة البيانات هذه.",
  },
  "state.allSourcesDown": { en: "ALL SOURCES UNREACHABLE", ar: "كل المصادر غير متاحة" },
  "state.someSourcesDown": { en: "Sources unreachable:", ar: "مصادر غير متاحة:" },
  "state.sourcesStale": { en: "Sources not reporting:", ar: "مصادر لا تبلغ عن حالتها:" },
  "state.statusUnknown": { en: "SOURCE STATUS UNKNOWN", ar: "حالة المصادر غير معروفة" },
  "state.statusUnknownHint": {
    en: "The store is empty and /api/sources did not answer, so the cause cannot be named.",
    ar: "المخزن فارغ ولم تستجب ‎/api/sources، لذا لا يمكن تحديد السبب.",
  },
  "state.noStories": { en: "NO STORIES IN STORE", ar: "لا توجد أخبار في المخزن" },
  "state.noMessages": { en: "NO MESSAGES IN STORE", ar: "لا توجد رسائل في المخزن" },
  "state.noOsint": { en: "NO OSINT ITEMS IN STORE", ar: "لا توجد عناصر استخبارية في المخزن" },
  "state.noTopics": { en: "NO DEVELOPMENTS IN STORE", ar: "لا توجد تطورات في المخزن" },
  "state.noCommentary": { en: "NO ATTRIBUTED PIECES IN STORE", ar: "لا توجد مواد منسوبة في المخزن" },
  "state.noCoverage": { en: "NO COVERAGE TO MEASURE", ar: "لا تغطية لقياسها" },
  "state.noCoverageHint": {
    en: "The spectrum needs stored coverage of this conflict. Nothing has been collected for it yet.",
    ar: "يحتاج التوزيع إلى تغطية مخزنة لهذا الصراع. لم يُجمع شيء له بعد.",
  },
  "state.noPins": { en: "NO GEOLOCATED EVENTS", ar: "لا أحداث محددة الموقع" },
  "state.noPinsHint": {
    en: "Stored items carry no resolved coordinates yet, so the map has nothing to plot.",
    ar: "العناصر المخزنة لا تحمل إحداثيات محددة بعد، لذا لا يوجد ما ترسمه الخريطة.",
  },

  "notifications.title": { en: "Notifications", ar: "الإشعارات" },
  "notifications.empty": { en: "No notifications yet", ar: "لا توجد إشعارات بعد" },
  "notifications.clear": { en: "Clear all", ar: "مسح الكل" },
  "notifications.aria": { en: "Notifications", ar: "الإشعارات" },
  "notifications.toastTitle": { en: "Breaking news", ar: "خبر عاجل" },

  "panel.expand": { en: "Expand", ar: "توسيع" },
  "panel.collapse": { en: "Collapse", ar: "تصغير" },

  "lang.switch": { en: "عربي", ar: "English" },

  "loading.translating": { en: "Translating...", ar: "جاري الترجمة..." },

  "conflict.label": { en: "CONFLICT", ar: "الصراع" },
  "conflict.all": { en: "All", ar: "الكل" },
  "conflict.iran-us": { en: "Iran / U.S.", ar: "إيران / الولايات المتحدة" },
  "conflict.ukraine-russia": { en: "Ukraine / Russia", ar: "أوكرانيا / روسيا" },
  "conflict.china-taiwan": { en: "China / Taiwan", ar: "الصين / تايوان" },
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
