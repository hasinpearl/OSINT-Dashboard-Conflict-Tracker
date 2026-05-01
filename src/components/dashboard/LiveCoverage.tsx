import { useState } from "react";
import { Tv, Volume2, VolumeX } from "lucide-react";
import { useLanguage } from "@/i18n/LanguageContext";
import { ExpandablePanel } from "./ExpandablePanel";

interface Channel {
  id: string;
  name: string;
  // Direct YouTube live video ID — more reliable than the live_stream channel pattern,
  // which is blocked or stale for several broadcasters. Update periodically if a stream rotates.
  videoId: string;
  lang: "en" | "ar";
  color: string;
}

// All channel buttons share the brand teal when active to keep the dashboard identity cohesive.
const BRAND_TEAL = "#00A7B5";
const CHANNELS: Channel[] = [
  // English
  { id: "bloomberg", name: "BLOOMBERG", videoId: "iEpJwprxDdk", lang: "en", color: BRAND_TEAL },
  { id: "skynews", name: "SKY NEWS", videoId: "6tk_lb7Jy6M", lang: "en", color: BRAND_TEAL },
  { id: "dw", name: "DW", videoId: "LuKwFajn37U", lang: "en", color: BRAND_TEAL },
  // Arabic
  { id: "skynews-arabia", name: "SKY NEWS ARABIA", videoId: "ymYr5ze2XeA", lang: "ar", color: BRAND_TEAL },
  { id: "aljazeera", name: "AL JAZEERA", videoId: "N8xxOD0nT1Y", lang: "ar", color: BRAND_TEAL },
  { id: "alarabiya", name: "AL ARABIYA", videoId: "n7eQejkXbnM", lang: "ar", color: BRAND_TEAL },
];

type LayoutMode = 1 | 2 | 4;

const buildEmbedUrl = (videoId: string, muted: boolean) =>
  `https://www.youtube.com/embed/${videoId}?autoplay=1&mute=${muted ? 1 : 0}&playsinline=1`;

export const LiveCoverage = () => {
  const { t } = useLanguage();
  const [activeIds, setActiveIds] = useState<string[]>(["bloomberg"]);
  const [layout, setLayout] = useState<LayoutMode>(1);
  const [muted, setMuted] = useState(true);

  const handleChannelClick = (id: string) => {
    if (layout === 1) {
      setActiveIds([id]);
      return;
    }
    // Multi mode: toggle, but cap at layout size
    setActiveIds((prev) => {
      if (prev.includes(id)) {
        const next = prev.filter((x) => x !== id);
        return next.length === 0 ? [id] : next;
      }
      if (prev.length >= layout) {
        // Replace oldest
        return [...prev.slice(1), id];
      }
      return [...prev, id];
    });
  };

  const setLayoutMode = (mode: LayoutMode) => {
    setLayout(mode);
    setActiveIds((prev) => {
      if (mode === 1) return prev.slice(0, 1);
      if (prev.length >= mode) return prev.slice(0, mode);
      // Pad with default channels
      const fillers = CHANNELS.filter((c) => !prev.includes(c.id)).slice(0, mode - prev.length);
      return [...prev, ...fillers.map((c) => c.id)];
    });
  };

  return (
    <ExpandablePanel>
      <LiveCoverageInner
        t={t}
        activeIds={activeIds}
        layout={layout}
        muted={muted}
        onChannelClick={handleChannelClick}
        onLayoutChange={setLayoutMode}
        onMuteToggle={() => setMuted((m) => !m)}
      />
    </ExpandablePanel>
  );
};

interface InnerProps {
  t: (k: string) => string;
  activeIds: string[];
  layout: LayoutMode;
  muted: boolean;
  onChannelClick: (id: string) => void;
  onLayoutChange: (mode: LayoutMode) => void;
  onMuteToggle: () => void;
}

const LiveCoverageInner = ({
  t,
  activeIds,
  layout,
  muted,
  onChannelClick,
  onLayoutChange,
  onMuteToggle,
}: InnerProps) => {
  // Detect if we're in expanded fullscreen mode by checking parent. ExpandablePanel uses fixed inset-0.
  // We'll show the layout selector always but only allow >1 layouts visually when there's room.
  const englishChannels = CHANNELS.filter((c) => c.lang === "en");
  const arabicChannels = CHANNELS.filter((c) => c.lang === "ar");

  const gridCols =
    layout === 1 ? "grid-cols-1" : layout === 2 ? "grid-cols-2" : "grid-cols-2";
  const gridRows = layout === 4 ? "grid-rows-2" : "grid-rows-1";

  return (
    <div className="flex flex-col h-full bg-card/80 backdrop-blur-md rounded-sm border border-border overflow-hidden">
      {/* Top bar: LIVE NEWS label + controls */}
      <div className="panel-header">
        <div className="flex items-center gap-2">
          <Tv className="h-3.5 w-3.5" />
          <span>{t("live.title")}</span>
          <span className="flex items-center gap-1 text-[10px]">
            <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
            <span className="text-red-300 font-bold">LIVE</span>
          </span>
        </div>
        {/* extra right padding so the panel's expand button doesn't overlap these controls */}
        <div className="flex items-center gap-3 pr-16">
          {/* Layout selector */}
          <div className="flex items-center gap-1 border border-primary/20 rounded-sm p-0.5 bg-white/40">
            {([1, 2, 4] as LayoutMode[]).map((m) => (
              <button
                key={m}
                onClick={() => onLayoutChange(m)}
                className={`px-2 py-0.5 text-[10px] font-bold rounded-sm transition-colors ${
                  layout === m ? "bg-white text-[hsl(var(--panel-header))]" : "text-primary/70 hover:text-primary"
                }`}
                title={`${m}x view`}
              >
                {m === 1 ? "1×" : m === 2 ? "2×" : "4×"}
              </button>
            ))}
          </div>
          <button
            onClick={onMuteToggle}
            className="text-primary/70 hover:text-primary"
            title={muted ? "Unmute" : "Mute"}
          >
            {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {/* Channel buttons */}
      <div className="flex items-center gap-1 bg-white/30 backdrop-blur-xl px-2 py-1.5 overflow-x-auto border-b border-border">
        {[...englishChannels, ...arabicChannels].map((ch) => {
          const isActive = activeIds.includes(ch.id);
          return (
            <button
              key={ch.id}
              onClick={() => onChannelClick(ch.id)}
              className={`shrink-0 px-2.5 py-1 text-[10px] font-mono font-bold tracking-wider rounded-sm border transition-all ${
                isActive
                  ? "text-white border-transparent"
                  : "text-muted-foreground border-border hover:text-foreground hover:border-foreground/40"
              }`}
              style={isActive ? { backgroundColor: ch.color } : undefined}
              title={ch.name}
            >
              {ch.name}
            </button>
          );
        })}
      </div>

      {/* Stream grid */}
      <div className={`flex-1 grid ${gridCols} ${gridRows} gap-px bg-black min-h-[250px]`}>
        {activeIds.slice(0, layout).map((id, idx) => {
          const ch = CHANNELS.find((c) => c.id === id);
          if (!ch) return null;
          return (
            <div key={`${id}-${idx}`} className="relative bg-black overflow-hidden">
              <iframe
                src={buildEmbedUrl(ch.videoId, muted)}
                title={ch.name}
                className="w-full h-full"
                allow="autoplay; encrypted-media; picture-in-picture"
                allowFullScreen
                frameBorder="0"
              />
              {layout > 1 && (
                <div
                  className="absolute top-1.5 left-1.5 px-1.5 py-0.5 text-[9px] font-mono font-bold text-white rounded-sm pointer-events-none"
                  style={{ backgroundColor: ch.color }}
                >
                  {ch.name}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
