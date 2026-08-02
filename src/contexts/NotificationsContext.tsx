import { createContext, useCallback, useContext, useMemo, useRef, useState, ReactNode } from "react";

export interface NotificationItem {
  id: string;
  headline: string;
  source?: string;
  url?: string;
  addedAt: string;
  read: boolean;
}

export interface IncomingNotification {
  headline: string;
  source?: string;
  url?: string;
}

interface NotificationsContextType {
  notifications: NotificationItem[];
  unreadCount: number;
  /** Dedupes by trimmed headline against everything stored; returns ONLY the newly added items. */
  addNotifications: (items: IncomingNotification[]) => NotificationItem[];
  markAllRead: () => void;
  clearAll: () => void;
}

const STORAGE_KEY = "osint-notifications";
const MAX_ITEMS = 50;

const NotificationsContext = createContext<NotificationsContextType | undefined>(undefined);

function loadStored(): NotificationItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((n) => n && typeof n.headline === "string" && n.headline.trim().length > 0)
      .slice(0, MAX_ITEMS);
  } catch {
    return [];
  }
}

function persist(items: NotificationItem[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    // Storage full or unavailable; notifications simply won't survive refresh.
  }
}

function isValidHttpUrl(u: unknown): u is string {
  return typeof u === "string" && /^https?:\/\//i.test(u.trim());
}

export const NotificationsProvider = ({ children }: { children: ReactNode }) => {
  const [notifications, setNotifications] = useState<NotificationItem[]>(loadStored);
  // Mirror of the current list so addNotifications can dedupe and return the
  // newly added items synchronously (toasts are driven by that return value).
  const itemsRef = useRef(notifications);
  itemsRef.current = notifications;

  const addNotifications = useCallback((items: IncomingNotification[]): NotificationItem[] => {
    const seen = new Set(itemsRef.current.map((n) => n.headline.trim()));
    const added: NotificationItem[] = [];
    for (const item of items) {
      const headline = (item.headline ?? "").trim();
      if (!headline || seen.has(headline)) continue;
      seen.add(headline);
      added.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        headline,
        source: item.source,
        url: isValidHttpUrl(item.url) ? item.url.trim() : undefined,
        addedAt: new Date().toISOString(),
        read: false,
      });
    }
    if (added.length > 0) {
      const next = [...added, ...itemsRef.current].slice(0, MAX_ITEMS);
      itemsRef.current = next;
      setNotifications(next);
      persist(next);
    }
    return added;
  }, []);

  const markAllRead = useCallback(() => {
    setNotifications((prev) => {
      if (!prev.some((n) => !n.read)) return prev;
      const next = prev.map((n) => (n.read ? n : { ...n, read: true }));
      itemsRef.current = next;
      persist(next);
      return next;
    });
  }, []);

  const clearAll = useCallback(() => {
    itemsRef.current = [];
    setNotifications([]);
    persist([]);
  }, []);

  const unreadCount = useMemo(
    () => notifications.filter((n) => !n.read).length,
    [notifications],
  );

  return (
    <NotificationsContext.Provider
      value={{ notifications, unreadCount, addNotifications, markAllRead, clearAll }}
    >
      {children}
    </NotificationsContext.Provider>
  );
};

export const useNotifications = () => {
  const ctx = useContext(NotificationsContext);
  if (!ctx) throw new Error("useNotifications must be used within NotificationsProvider");
  return ctx;
};
