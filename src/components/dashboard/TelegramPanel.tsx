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

// Chip colours only. The channel roster itself is whatever the response
// actually contains: this list used to be the roster, and it named eleven
// channels of which the collector ingests two, so every message from
// intelslava, GeoPWatch, OSINTdefender and the rest was filtered out of the
// panel by a chip that did not exist. Adding a channel to TG_PREVIEW_CHANNELS
// now shows it here without a code change.
//TUNE: Control the (channel chip colours). Colour per known channel, unlisted channels fall back to the palette below.
const CHANNEL_COLORS: Record<string, string> = {
  monitor_the_situation: "bg-lime-500",
  intelslava: "bg-rose-500",
  GeoPWatch: "bg-emerald-500",
  rnintel: "bg-cyan-500",
  CIG_telegram: "bg-sky-500",
  idkunim_il: "bg-blue-500",
  OSINTdefender: "bg-amber-500",
  BellumActaNews: "bg-orange-500",
  RocketAlert: "bg-red-500",
  ukr_leaks_eng: "bg-yellow-500",
  middleeasteye: "bg-indigo-500",
  iranintl: "bg-pink-500",
};

//TUNE: Control the (fallback chip palette). Colours cycled for channels not named in CHANNEL_COLORS.
const FALLBACK_COLORS = [
  "bg-violet-500",
  "bg-teal-500",
  "bg-fuchsia-500",
  "bg-green-500",
  "bg-slate-500",
];

function channelColor(channel: string, index: number): string {
  return CHANNEL_COLORS[channel] ?? FALLBACK_COLORS[index % FALLBACK_COLORS.length];
}

//TUNE: Control the (chip label length). Characters of a channel name shown on its filter chip.
const CHIP_LABEL_MAX_CHARS = 12;

function chipLabel(channel: string): string {
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

  // Chips are derived from the response, ordered by how much each channel is
  // posting, so the roster is always the real one.
  const channels = useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of messages) counts.set(m.channel, (counts.get(m.channel) ?? 0) + 1);
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([id, count], i) => ({ id, count, color: channelColor(id, i) }));
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
                title={`${ch.id} (${ch.count})`}
                className={`text-[9px] font-mono px-1.5 py-0.5 rounded transition-all ${
                  muted.has(ch.id) ? "bg-muted text-muted-foreground" : `${ch.color} text-white`
                }`}
              >
                {chipLabel(ch.id)} {ch.count}
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
