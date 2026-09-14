import { useEffect } from "react";
import { toast } from "sonner";
import { useNewsStories } from "@/hooks/usePanelData";
import { useNotifications } from "@/contexts/NotificationsContext";
import { breakingStories } from "@/utils/breaking";
import { useLanguage } from "@/i18n/LanguageContext";

//TUNE: Control the (toast burst). Toasts raised at most per query update, the rest go to the bell only.
const MAX_TOASTS_PER_UPDATE = 3;

// Headless: watches the shared news query (no API calls of its own), pushes
// every breaking story into the store, and toasts only what the store reports
// as new. The store's return value drives the toasts, so they cannot disagree.
export const NotificationsFeeder = () => {
  const { data } = useNewsStories();
  const { addNotifications } = useNotifications();
  const { t } = useLanguage();

  useEffect(() => {
    const stories = data?.stories ?? [];
    const breaking = breakingStories(stories);
    if (breaking.length === 0) return;

    const added = addNotifications(
      breaking.map((s) => ({ headline: s.headline, source: s.source, url: s.url })),
    );
    if (added.length === 0) return;

    console.log(
      `notifications: ${breaking.length} breaking of ${stories.length} stories, ${added.length} new`,
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
