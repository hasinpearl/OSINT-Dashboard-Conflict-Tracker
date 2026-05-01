import { useQuery } from "@tanstack/react-query";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { supabase } from "@/integrations/supabase/client";
import { MessageCircle } from "lucide-react";
import { useState } from "react";
import { useLanguage } from "@/i18n/LanguageContext";
import { useTranslatedData } from "@/hooks/useTranslatedData";
import { ExpandablePanel } from "./ExpandablePanel";
import { formatLocalDateTime } from "@/utils/formatTime";
import { useConflictFilter } from "@/contexts/ConflictFilterContext";

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

interface TelegramMessage {
  channel: string;
  text: string;
  timestamp: string;
  message_id: number;
}

export const TelegramPanel = () => {
  const [activeFilters, setActiveFilters] = useState<Set<string>>(new Set(CHANNELS.map((c) => c.id)));
  const { t } = useLanguage();
  const { conflict } = useConflictFilter();

  const { data, isLoading, error } = useQuery({
    queryKey: ["telegram-feed", conflict],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke("telegram-feed", { body: { conflict } });
      if (error) throw error;
      return data as { messages: TelegramMessage[] };
    },
    staleTime: 2 * 60 * 1000,
    refetchInterval: 60 * 60 * 1000,
  });

  const { data: translated } = useTranslatedData(data, "telegram-feed");

  const toggleFilter = (channelId: string) => {
    setActiveFilters((prev) => {
      const next = new Set(prev);
      if (next.has(channelId)) next.delete(channelId);
      else next.add(channelId);
      return next;
    });
  };

  const messages = translated?.messages ?? data?.messages;
  const filtered = messages?.filter((m) => activeFilters.has(m.channel)) ?? [];
  const getChannelMeta = (id: string) => CHANNELS.find((c) => c.id === id);

  return (
    <ExpandablePanel>
      <div className="flex flex-col h-full bg-card/80 backdrop-blur-md rounded-sm border border-border overflow-hidden">
        <div className="panel-header">
          <div className="flex items-center gap-2">
            <MessageCircle className="h-3.5 w-3.5" />
            <span>{t("telegram.title")}</span>
          </div>
          <span className="text-[10px] opacity-60">{CHANNELS.length} {t("telegram.sources")}</span>
        </div>
        <div className="px-2 py-1.5 border-b border-border flex flex-wrap gap-1">
          {CHANNELS.map((ch) => (
            <button
              key={ch.id}
              onClick={() => toggleFilter(ch.id)}
              className={`text-[9px] font-mono px-1.5 py-0.5 rounded transition-all ${
                activeFilters.has(ch.id) ? `${ch.color} text-white` : "bg-muted text-muted-foreground"
              }`}
            >
              {ch.label}
            </button>
          ))}
        </div>
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
          {error && (
            <div className="text-sm text-muted-foreground p-4 text-center">
              <p className="text-severity-critical font-mono text-xs">{t("telegram.offline")}</p>
              <p className="mt-1 text-xs">{t("telegram.error")}</p>
            </div>
          )}
          {!isLoading && filtered.length > 0 && (
            <div className="space-y-2.5">
              {filtered.map((msg, i) => {
                const ch = getChannelMeta(msg.channel);
                return (
                  <div key={i} className="pb-2.5 border-b border-border last:border-0">
                    <div className="flex items-center gap-1.5 mb-1">
                      <span className={`w-1.5 h-1.5 rounded-full ${ch?.color ?? "bg-muted-foreground"}`} />
                      <span className="text-[10px] font-mono font-semibold text-muted-foreground">
                        @{msg.channel}
                      </span>
                      <span className="text-[9px] font-mono text-muted-foreground/50 ml-auto">
                        {formatLocalDateTime(msg.timestamp)}
                      </span>
                    </div>
                    <p className="text-xs leading-relaxed">{msg.text}</p>
                  </div>
                );
              })}
            </div>
          )}
          {!isLoading && !error && filtered.length === 0 && (
            <p className="text-xs text-muted-foreground text-center py-4 font-mono">{t("telegram.noMessages")}</p>
          )}
        </ScrollArea>
      </div>
    </ExpandablePanel>
  );
};
