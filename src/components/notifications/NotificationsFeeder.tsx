import { useEffect } from "react";
import { toast } from "sonner";
import { useNewsStories } from "@/hooks/usePanelData";
import { useNotifications } from "@/contexts/NotificationsContext";
import { normSeverity } from "@/utils/severity";
import { useLanguage } from "@/i18n/LanguageContext";

const MAX_TOASTS_PER_UPDATE = 3;

// Headless: watches the shared news query (no API calls of its own), pushes
// every critical story into the store, and toasts only what the store reports
// as new — the store's return value drives the toasts, so they can't disagree.
export const NotificationsFeeder = () => {
  const { data } = useNewsStories();
  const { addNotifications } = useNotifications();
  const { t } = useLanguage();

  useEffect(() => {
    const stories = data?.stories ?? [];
    const critical = stories.filter((s) => normSeverity(s.severity) === "critical");
    if (critical.length === 0) return;

    const added = addNotifications(
      critical.map((s) => ({ headline: s.headline, source: s.source, url: s.url })),
    );

    for (const n of added.slice(0, MAX_TOASTS_PER_UPDATE)) {
      toast(t("notifications.toastTitle"), {
        description: n.headline,
        duration: 8000,
      });
    }
  }, [data, addNotifications, t]);

  return null;
};
