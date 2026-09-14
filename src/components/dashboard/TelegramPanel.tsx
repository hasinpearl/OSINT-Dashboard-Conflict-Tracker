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

// Hessa's curated channel roster, restored verbatim from 300b1cc~1: the same
// eleven channels, the same labels, the same colours, in her order. The array
// had been reduced to a bare colour lookup, which erased the legend.
//
// The legend renders THIS list, so a channel that is quiet right now still
// shows its chip. What the array no longer does is decide which messages are
// allowed to render: it used to double as a visibility filter, and any channel
// the collector ingests that is not named here had every one of its messages
// dropped by a chip that did not exist. Channels are now hidden only by an
// explicit click, and one the response carries but the roster does not gets a
// chip from the fallback palette instead of being silently discarded.
//TUNE: Control the (curated channel legend). Hessa's channel list: id, chip label and chip colour, in her order.
const CHANNELS = [
  { id: "middleeasteye", label: "MEE", color: "bg-blue-500" },
  { id: "iranintl", label: "IranIntl", color: "bg-red-500" },
  { id: "geopolitics_prime", label: "GeoPrime", color: "bg-emerald-500" },
  { id: "bricsnews", label: "BRICS", color: "bg-amber-500" },
  { id: "megatron_ron", label: "Megatron", color: "bg-purple-500" },
  { id: "DDGeopolitics", label: "DDGeo", color: "bg-cyan-500" },
  { id: "thecradlemedia", label: "Cradle", color: "bg-orange-500" },
  { id: "warmonitors", label: "WarMon", color: "bg-rose-500" },
  { id: "CIG_telegram", label: "CIG", color: "bg-sky-500" },
  { id: "monitor_the_situation", label: "Monitor", color: "bg-lime-500" },
  { id: "ukr_leaks_eng", label: "UkrLeaks", color: "bg-yellow-500" },
];

//TUNE: Control the (fallback chip palette). Colours cycled for channels the response carries that are not on the curated roster.
const FALLBACK_COLORS = [
  "bg-violet-500",
  "bg-teal-500",
  "bg-fuchsia-500",
  "bg-green-500",
  "bg-slate-500",
];

//TUNE: Control the (chip label length). Characters of an off-roster channel name shown on its chip.
const CHIP_LABEL_MAX_CHARS = 12;

function offRosterLabel(channel: string): string {
  return channel.length <= CHIP_LABEL_MAX_CHARS
    ? channel
    : `${channel.slice(0, CHIP_LABEL_MAX_CHARS - 1)}\u2026`;
}

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

  // Chips are the curated roster in Hessa's order, each carrying its own live
  // count, followed by any channel the response actually carried that is not
  // on the roster. Both halves are shown: a roster channel with no posts right
  // now is a legend entry reading 0, and an off-roster channel with real posts
  // is visible rather than silently dropped.
  const channels = useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of messages) counts.set(m.channel, (counts.get(m.channel) ?? 0) + 1);

    const roster = CHANNELS.map((ch) => ({
      id: ch.id,
      label: ch.label,
      color: ch.color,
      count: counts.get(ch.id) ?? 0,
      onRoster: true,
    }));

    const rosterIds = new Set(CHANNELS.map((c) => c.id));
    const extra = Array.from(counts.entries())
      .filter(([id]) => !rosterIds.has(id))
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([id, count], i) => ({
        id,
        label: offRosterLabel(id),
        color: FALLBACK_COLORS[i % FALLBACK_COLORS.length],
        count,
        onRoster: false,
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
        {channels.length > 0 && (
          <div className="px-2 py-1.5 border-b border-border flex flex-wrap gap-1">
            {channels.map((ch) => (
              <button
                key={ch.id}
                onClick={() => toggleFilter(ch.id)}
                title={`@${ch.id} (${ch.count})${ch.onRoster ? "" : ", not on the curated roster"}`}
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
          {error && !isLoading && (
            <PanelEmptyState kind="error" errorMessage={t("telegram.offline")} scope="telegram" />
          )}
          {!isLoading && filtered.length > 0 && (
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
          {!isLoading && !error && filtered.length === 0 && (
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
