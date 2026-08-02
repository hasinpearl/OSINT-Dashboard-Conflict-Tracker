import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Bell, Trash2 } from "lucide-react";
import { useNotifications } from "@/contexts/NotificationsContext";
import { useLanguage } from "@/i18n/LanguageContext";
import { formatLocalDateTime } from "@/utils/formatTime";

const PANEL_WIDTH = 320;
const EDGE_MARGIN = 8;

export const NotificationBell = () => {
  const { notifications, unreadCount, markAllRead, clearAll } = useNotifications();
  const { t, isRTL } = useLanguage();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // The glass header uses backdrop-filter, which creates a containing block —
  // a dropdown positioned inside it would be clipped even with position:fixed.
  // Render through a portal to document.body and place it from the bell's rect,
  // clamping horizontally (in RTL the bell sits near the screen edge).
  const toggle = useCallback(() => {
    if (!open && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      const left = Math.min(
        Math.max(EDGE_MARGIN, rect.right - PANEL_WIDTH),
        Math.max(EDGE_MARGIN, window.innerWidth - PANEL_WIDTH - EDGE_MARGIN),
      );
      setPos({ top: rect.bottom + 8, left });
    }
    setOpen((o) => !o);
  }, [open]);

  // Opening marks everything read.
  useEffect(() => {
    if (open) markAllRead();
  }, [open, markAllRead]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target)) return;
      if (buttonRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={toggle}
        aria-label={t("notifications.aria")}
        className="relative inline-flex h-7 w-7 items-center justify-center rounded-full text-foreground/80 hover:text-foreground hover:bg-white/20 transition-colors"
      >
        <Bell className="h-4 w-4" />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] px-0.5 rounded-full bg-red-500 text-white text-[9px] font-bold leading-[14px] text-center">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            dir={isRTL ? "rtl" : "ltr"}
            style={{ position: "fixed", top: pos.top, left: pos.left, width: PANEL_WIDTH }}
            className="z-[100] rounded-lg border border-border bg-popover text-popover-foreground shadow-xl overflow-hidden"
          >
            <div className="flex items-center justify-between px-3 py-2 border-b border-border">
              <span className="text-xs font-mono font-bold uppercase">{t("notifications.title")}</span>
              {notifications.length > 0 && (
                <button
                  type="button"
                  onClick={clearAll}
                  className="inline-flex items-center gap-1 text-[10px] font-mono text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Trash2 className="h-3 w-3" />
                  {t("notifications.clear")}
                </button>
              )}
            </div>
            <div className="max-h-80 overflow-y-auto">
              {notifications.length === 0 && (
                <p className="text-xs text-muted-foreground text-center py-6 font-mono">
                  {t("notifications.empty")}
                </p>
              )}
              {notifications.map((n) => (
                <div key={n.id} className="px-3 py-2 border-b border-border last:border-0">
                  <div className="flex items-start gap-2">
                    {!n.read && (
                      <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-red-500 shrink-0" />
                    )}
                    {n.url ? (
                      <a
                        href={n.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        dir="auto"
                        className="text-xs font-semibold leading-snug hover:underline"
                      >
                        {n.headline}
                      </a>
                    ) : (
                      <p dir="auto" className="text-xs font-semibold leading-snug">
                        {n.headline}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 mt-1">
                    {n.source && (
                      <span className="text-[10px] font-mono text-muted-foreground">{n.source}</span>
                    )}
                    <span className="text-[9px] font-mono text-muted-foreground/60 ms-auto">
                      {formatLocalDateTime(n.addedAt)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
};
