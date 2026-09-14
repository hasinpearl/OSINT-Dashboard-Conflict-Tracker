import { useQuery } from "@tanstack/react-query";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { invokeFn } from "@/lib/api";
import { shouldForceRefresh } from "@/lib/freshness";
import { MessageCircle } from "lucide-react";
import { useMemo, useState } from "react";
import { useLanguage } from "@/i18n/LanguageContext";
import { useTranslatedData } from "@/hooks/useTranslatedData";
import { ExpandablePanel } from "./ExpandablePanel";
import { PanelEmptyState } from "./PanelEmptyState";
import { formatLocalDateTime } from "@/utils/formatTime";
import { useConflictFilter } from "@/contexts/ConflictFilterContext";
import { isConflictDisabled } from "@/lib/conflictDisabled";

// Hessa's curated channel roster: the same eighteen channels as
// CURATED_CHANNELS in server/src/routes/telegram.ts, in the same order, each
// with its chip label and chip colour. The two lists are kept identical by
// hand and the panel reports its own roster, so a mismatch shows up as a chip
// reading 0 forever rather than as silently dropped messages.
//
// middleeasteye and iranintl are gone: their t.me/s/ previews carry no message
// elements at all, so the collector can never read them. aljazeeraenglish
// replaces the first and iranintl_en, Iran International's own English
// channel, replaces the second, which is why it keeps the IranIntl label and
// the red chip.
//
// The legend renders THIS list, so a channel that is quiet right now still
// shows its chip. What the array does not do is decide which messages are
// allowed to render: it used to double as a visibility filter, and any channel
// the collector ingested that was not named here had every one of its messages
// dropped by a chip that did not exist. Channels are hidden only by an
// explicit click.
//TUNE: Control the (curated channel legend). Hessa's channel list: id, chip label and chip colour, in her order.
const CHANNELS = [
  { id: "aljazeeraenglish", label: "AlJazeera", color: "bg-blue-500" },
  { id: "iranintl_en", label: "IranIntl", color: "bg-red-500" },
  { id: "geopolitics_prime", label: "GeoPrime", color: "bg-emerald-500" },
  { id: "bricsnews", label: "BRICS", color: "bg-amber-500" },
  { id: "megatron_ron", label: "Megatron", color: "bg-purple-500" },
  { id: "DDGeopolitics", label: "DDGeo", color: "bg-cyan-500" },
  { id: "thecradlemedia", label: "Cradle", color: "bg-orange-500" },
  { id: "warmonitors", label: "WarMon", color: "bg-rose-500" },
  { id: "CIG_telegram", label: "CIG", color: "bg-sky-500" },
  { id: "monitor_the_situation", label: "Monitor", color: "bg-lime-500" },
  { id: "ukr_leaks_eng", label: "UkrLeaks", color: "bg-yellow-500" },
  { id: "RocketAlert", label: "RocketAlert", color: "bg-violet-500" },
  { id: "GeoPWatch", label: "GeoWatch", color: "bg-teal-500" },
  { id: "rnintel", label: "RNIntel", color: "bg-fuchsia-500" },
  { id: "intelslava", label: "IntelSlava", color: "bg-green-500" },
  { id: "OSINTdefender", label: "OSINTDef", color: "bg-indigo-500" },
  { id: "BellumActaNews", label: "BellumActa", color: "bg-pink-500" },
  { id: "idkunim_il", label: "Idkunim", color: "bg-slate-500" },
];

interface TelegramMessage {
  channel: string;
  text: string;
  timestamp: string;
  message_id: number;
}

interface TelegramResponse {
  messages: TelegramMessage[];
  matching_in_store?: number;
  returned?: number;
  /** Set by the API when the requested conflict is switched off. */
  conflict_disabled?: boolean;
}

export const TelegramPanel = () => {
  const [muted, setMuted] = useState<Set<string>>(new Set());
  const { t } = useLanguage();
  const { conflict } = useConflictFilter();

  const { data, isLoading, error } = useQuery({
    queryKey: ["telegram-feed", conflict],
    queryFn: () =>
      invokeFn<TelegramResponse>("telegram-feed", {
        conflict,
        ...(shouldForceRefresh(`telegram-feed:${conflict}`) ? { force_refresh: true } : {}),
      }),
    staleTime: 2 * 60 * 1000,
    refetchInterval: 15 * 60 * 1000,
  });

  const { data: translated } = useTranslatedData(data, "telegram-feed");

  const view = translated ?? data;
  const messages = useMemo(() => view?.messages ?? [], [view]);

  // Read off the raw response, not the translated view: the marker is a flag
  // the API set, and it must not depend on a translation pass having carried
  // it through.
  const disabled = isConflictDisabled(data);

  // Chips are the curated roster in Hessa's order, each carrying its own live
  // count. A roster channel with no posts in this window is a legend entry
  // reading 0 rather than a missing chip.
  //
  // Nothing is off-roster any more: every channel the collector reads is on
  // the list above. A channel the response carries that is not on it can still
  // only come from a TG_PREVIEW_CHANNELS override, so it keeps a chip and its
  // messages stay visible, but there is no "not on the curated roster" marking
  // to apply to it and no fallback palette: it takes the neutral chip.
  const channels = useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of messages) counts.set(m.channel, (counts.get(m.channel) ?? 0) + 1);

    const roster = CHANNELS.map((ch) => ({
      id: ch.id,
      label: ch.label,
      color: ch.color,
      count: counts.get(ch.id) ?? 0,
    }));

    const rosterIds = new Set(CHANNELS.map((c) => c.id));
    const extra = Array.from(counts.entries())
      .filter(([id]) => !rosterIds.has(id))
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([id, count]) => ({
        id,
        label: id,
        color: "bg-muted-foreground",
        count,
      }));

    return [...roster, ...extra];
  }, [messages]);

  // Muting rather than selecting: a channel that appears in a later refresh is
  // visible by default, where a select-set would have hidden it until clicked.
  const toggleFilter = (channelId: string) => {
    setMuted((prev) => {
      const next = new Set(prev);
      if (next.has(channelId)) next.delete(channelId);
      else next.add(channelId);
      return next;
    });
  };

  const filtered = messages.filter((m) => !muted.has(m.channel));
  const colorOf = (id: string) => channels.find((c) => c.id === id)?.color ?? "bg-muted-foreground";

  // Rows that arrived but sit outside the active channel chips are a filter
  // state, not an empty store, and saying so stops the user hunting a bug in
  // the collector.
  const hiddenByFilter = messages.length > 0 && filtered.length === 0;

  const inStore = view?.matching_in_store ?? messages.length;
  const sizeLabel =
    inStore > messages.length ? `${messages.length} / ${inStore}` : String(messages.length);

  return (
    <ExpandablePanel>
      <div className="flex flex-col h-full bg-card/80 backdrop-blur-md rounded-sm border border-border overflow-hidden">
        <div className="panel-header">
          <div className="flex items-center gap-2">
            <MessageCircle className="h-3.5 w-3.5" />
            <span>{t("telegram.title")}</span>
          </div>
          <span className="text-[10px] opacity-60">
            {sizeLabel} {t("telegram.messages")} / {channels.length} {t("telegram.sources")}
          </span>
        </div>
        {channels.length > 0 && !disabled && (
          <div className="px-2 py-1.5 border-b border-border flex flex-wrap gap-1">
            {channels.map((ch) => (
              <button
                key={ch.id}
                onClick={() => toggleFilter(ch.id)}
                title={`@${ch.id} (${ch.count})`}
                className={`text-[9px] font-mono px-1.5 py-0.5 rounded transition-all ${
                  muted.has(ch.id) ? "bg-muted text-muted-foreground" : `${ch.color} text-white`
                } ${ch.count === 0 ? "opacity-40" : ""}`}
              >
                {ch.label} {ch.count}
              </button>
            ))}
          </div>
        )}
        <ScrollArea className="flex-1 p-3">
          {isLoading && (
            <div className="space-y-3">
              {[...Array(6)].map((_, i) => (
                <div key={i} className="space-y-1">
                  <Skeleton className="h-3 w-16" />
                  <Skeleton className="h-4 w-full" />
                </div>
              ))}
            </div>
          )}
          {/* The disabled state is checked before the error and empty branches
              so a switched-off conflict never reads as a collection problem. */}
          {!isLoading && disabled && <PanelEmptyState kind="disabled" />}
          {!isLoading && !disabled && error && (
            <PanelEmptyState kind="error" errorMessage={t("telegram.offline")} scope="telegram" />
          )}
          {!isLoading && !disabled && filtered.length > 0 && (
            <div className="space-y-2.5">
              {filtered.map((msg, i) => (
                <div key={`${msg.channel}-${msg.message_id}-${i}`} className="pb-2.5 border-b border-border last:border-0">
                  <div className="flex items-center gap-1.5 mb-1">
                    <span className={`w-1.5 h-1.5 rounded-full ${colorOf(msg.channel)}`} />
                    <span className="text-[10px] font-mono font-semibold text-muted-foreground">
                      @{msg.channel}
                    </span>
                    <span className="text-[9px] font-mono text-muted-foreground/50 ml-auto">
                      {formatLocalDateTime(msg.timestamp)}
                    </span>
                  </div>
                  <p dir="auto" className="text-xs leading-relaxed">{msg.text}</p>
                </div>
              ))}
            </div>
          )}
          {!isLoading && !error && !disabled && filtered.length === 0 && (
            hiddenByFilter ? (
              <p className="text-xs text-muted-foreground text-center py-8 font-mono">
                {t("telegram.filteredOut")}
              </p>
            ) : (
              <PanelEmptyState kind="empty" emptyMessage={t("state.noMessages")} scope="telegram" />
            )
          )}
        </ScrollArea>
      </div>
    </ExpandablePanel>
  );
};
