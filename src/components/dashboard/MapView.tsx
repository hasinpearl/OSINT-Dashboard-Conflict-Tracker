import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Map, { Marker, Popup, NavigationControl } from "react-map-gl/mapbox";
import { MapPin, ExternalLink } from "lucide-react";
import "mapbox-gl/dist/mapbox-gl.css";
import { Skeleton } from "@/components/ui/skeleton";
import { useLanguage } from "@/i18n/LanguageContext";
import { ExpandablePanel } from "./ExpandablePanel";
import { formatLocalDateTime } from "@/utils/formatTime";

//TUNE: Control the (mapbox style). VITE_MAPBOX_STYLE=style URL the map renders.
const MAPBOX_STYLE = (import.meta.env.VITE_MAPBOX_STYLE as string | undefined)?.trim();
//TUNE: Control the (mapbox token). VITE_MAPBOX_TOKEN=public pk. token, private .env only.
const MAPBOX_TOKEN = (import.meta.env.VITE_MAPBOX_TOKEN as string | undefined)?.trim();

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";

//TUNE: Control the (pin count). Pins requested from /api/events/pins per refresh.
const PIN_LIMIT = 200;
//TUNE: Control the (pin refresh rate). Milliseconds between pin refetches.
const PIN_REFETCH_MS = 5 * 60 * 1000;
//TUNE: Control the (pin stale window). Milliseconds before cached pins are refetched on focus.
const PIN_STALE_MS = 2 * 60 * 1000;

//TUNE: Control the (initial view). Starting centre and zoom, framed on the covered conflict regions.
const INITIAL_VIEW = { longitude: 35, latitude: 24, zoom: 1.6 };

const BRAND_NAVY = "#20264C";
const BRAND_TEAL = "#00A7B5";

// Same tokens the severity badges use, so a pin reads the same as the panels.
const SEVERITY_COLORS: Record<string, string> = {
  critical: "hsl(var(--severity-critical))",
  high: "hsl(var(--severity-high))",
  medium: "hsl(var(--severity-developing))",
  low: BRAND_TEAL,
};

interface PrimaryLocation {
  lat: number;
  lng: number;
  country: string | null;
  region: string | null;
  precision: "exact" | "approximate";
  confidence: number;
  normalized: string;
}

interface PinEvent {
  event_id: number;
  source: string;
  source_uid: string | null;
  source_url: string | null;
  original_text: string | null;
  published_at: string | null;
  severity: string | null;
  event_type: string | null;
  primary_location: PrimaryLocation | null;
}

interface PinsResponse {
  events: PinEvent[];
  count: number;
}

async function fetchPins(): Promise<PinsResponse> {
  const res = await fetch(`${API_BASE}/api/events/pins?limit=${PIN_LIMIT}`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error(`pins request failed with status ${res.status}`);
  return (await res.json()) as PinsResponse;
}

const severityColor = (severity: string | null): string =>
  SEVERITY_COLORS[(severity || "").toLowerCase()] ?? BRAND_NAVY;

// A pin is only drawable when the row carries real finite coordinates. Rows
// without them never had a location, and a fallback coordinate would be an
// invented one.
const isPlottable = (event: PinEvent): boolean => {
  const loc = event.primary_location;
  if (!loc) return false;
  const lat = Number(loc.lat);
  const lng = Number(loc.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return false;
  return loc.precision === "exact" || loc.precision === "approximate";
};

export const MapView = () => {
  const { t } = useLanguage();
  const [activeId, setActiveId] = useState<number | null>(null);
  const configured = Boolean(MAPBOX_STYLE && MAPBOX_TOKEN);

  const { data, isLoading, error } = useQuery({
    queryKey: ["events-pins"],
    queryFn: fetchPins,
    staleTime: PIN_STALE_MS,
    refetchInterval: PIN_REFETCH_MS,
    enabled: configured,
  });

  const pins = useMemo(() => (data?.events ?? []).filter(isPlottable), [data]);
  const active = useMemo(
    () => pins.find((p) => p.event_id === activeId) ?? null,
    [pins, activeId],
  );

  const exactCount = pins.filter((p) => p.primary_location?.precision === "exact").length;

  return (
    <ExpandablePanel>
      <div className="flex flex-col h-full bg-card/80 backdrop-blur-md rounded-sm border border-border overflow-hidden">
        <div className="panel-header">
          <div className="flex items-center gap-2">
            <MapPin className="h-3.5 w-3.5" />
            <span>{t("map.title")}</span>
          </div>
          <span className="text-[10px] opacity-60">
            {configured ? `${pins.length} ${t("map.pins")}` : t("map.subtitle")}
          </span>
        </div>

        {!configured ? (
          <MapPlaceholder t={t} />
        ) : (
          <div className="relative flex-1 min-h-0">
            {isLoading && (
              <div className="absolute inset-0 z-10 p-3 bg-card/60">
                <Skeleton className="h-full w-full" />
              </div>
            )}
            {error && (
              <div className="absolute top-2 left-2 z-10 px-2 py-1 bg-card border border-border">
                <span className="text-[10px] font-mono text-severity-critical">
                  {t("map.offline")}
                </span>
              </div>
            )}
            {/* A blank map with a 0 counter cannot be told from a broken one,
                so the reason is stated over the map rather than left implied. */}
            {!isLoading && !error && pins.length === 0 && (
              <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 z-10 flex justify-center px-4 pointer-events-none">
                <div className="bg-card/95 border border-border px-3 py-2 text-center max-w-xs">
                  <p className="text-[10px] font-mono font-bold uppercase tracking-wider">
                    {t("state.noPins")}
                  </p>
                  <p className="text-[10px] font-mono text-muted-foreground mt-0.5 leading-relaxed">
                    {t("state.noPinsHint")}
                  </p>
                </div>
              </div>
            )}
            <Map
              mapboxAccessToken={MAPBOX_TOKEN}
              mapStyle={MAPBOX_STYLE}
              initialViewState={INITIAL_VIEW}
              style={{ width: "100%", height: "100%" }}
              attributionControl={false}
              onClick={() => setActiveId(null)}
            >
              <NavigationControl position="top-right" showCompass={false} />
              {pins.map((pin) => {
                const loc = pin.primary_location as PrimaryLocation;
                const color = severityColor(pin.severity);
                const approximate = loc.precision === "approximate";
                return (
                  <Marker
                    key={pin.event_id}
                    longitude={Number(loc.lng)}
                    latitude={Number(loc.lat)}
                    anchor="center"
                    onClick={(e) => {
                      e.originalEvent.stopPropagation();
                      setActiveId(pin.event_id);
                    }}
                  >
                    {/* An approximate location is an area, so it is drawn as a
                        soft ring with no centre point. An exact one gets a
                        solid square: the two must never read alike. */}
                    {approximate ? (
                      <div
                        className="cursor-pointer"
                        style={{
                          width: 22,
                          height: 22,
                          border: `1.5px dashed ${color}`,
                          backgroundColor: `${color}26`,
                        }}
                        title={`${loc.normalized} (${t("map.approximate")})`}
                      />
                    ) : (
                      <div
                        className="cursor-pointer"
                        style={{
                          width: 10,
                          height: 10,
                          backgroundColor: color,
                          border: `1.5px solid ${BRAND_NAVY}`,
                        }}
                        title={`${loc.normalized} (${t("map.exact")})`}
                      />
                    )}
                  </Marker>
                );
              })}

              {active && active.primary_location && (
                <Popup
                  longitude={Number(active.primary_location.lng)}
                  latitude={Number(active.primary_location.lat)}
                  anchor="bottom"
                  closeButton={false}
                  maxWidth="260px"
                  onClose={() => setActiveId(null)}
                >
                  <PinDetail event={active} t={t} />
                </Popup>
              )}
            </Map>

            <MapLegend
              t={t}
              exactCount={exactCount}
              approximateCount={pins.length - exactCount}
            />
          </div>
        )}
      </div>
    </ExpandablePanel>
  );
};

const PinDetail = ({ event, t }: { event: PinEvent; t: (k: string) => string }) => {
  const loc = event.primary_location as PrimaryLocation;
  const place = [loc.normalized, loc.region, loc.country].filter(Boolean).join(", ");
  return (
    <div className="font-sans">
      <div className="flex items-center gap-1.5 mb-1">
        <span
          className="inline-block"
          style={{
            width: 8,
            height: 8,
            backgroundColor: severityColor(event.severity),
          }}
        />
        <span className="text-[10px] font-mono font-bold uppercase tracking-wider" style={{ color: BRAND_NAVY }}>
          {place}
        </span>
      </div>
      <p className="text-[11px] leading-snug text-foreground/90 mb-1">
        {(event.original_text || "").slice(0, 180)}
      </p>
      <div className="flex items-center gap-2 text-[9px] font-mono text-muted-foreground">
        <span>{loc.precision === "exact" ? t("map.exact") : t("map.approximate")}</span>
        <span>·</span>
        <span>
          {t("map.confidence")} {loc.confidence}
        </span>
        {event.published_at && (
          <>
            <span>·</span>
            <span>{formatLocalDateTime(event.published_at)}</span>
          </>
        )}
      </div>
      {event.source_url && (
        <a
          href={event.source_url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-0.5 mt-1 text-[9px] font-mono hover:underline"
          style={{ color: BRAND_TEAL }}
        >
          <ExternalLink className="h-2.5 w-2.5" />
          {t("analyst.source")}
        </a>
      )}
    </div>
  );
};

const MapLegend = ({
  t,
  exactCount,
  approximateCount,
}: {
  t: (k: string) => string;
  exactCount: number;
  approximateCount: number;
}) => (
  <div className="absolute bottom-2 left-2 bg-card/95 border border-border px-2 py-1.5 pointer-events-none">
    <div className="flex items-center gap-3 text-[9px] font-mono text-muted-foreground">
      <span className="flex items-center gap-1">
        <span
          className="inline-block"
          style={{ width: 8, height: 8, backgroundColor: BRAND_NAVY, border: `1px solid ${BRAND_NAVY}` }}
        />
        {t("map.exact")} {exactCount}
      </span>
      <span className="flex items-center gap-1">
        <span
          className="inline-block"
          style={{
            width: 12,
            height: 12,
            border: `1.5px dashed ${BRAND_NAVY}`,
            backgroundColor: `${BRAND_NAVY}20`,
          }}
        />
        {t("map.approximate")} {approximateCount}
      </span>
    </div>
  </div>
);

// Missing env vars are a configuration state, not an error. The panel says so
// and the rest of the dashboard keeps working.
const MapPlaceholder = ({ t }: { t: (k: string) => string }) => (
  <div className="flex-1 flex flex-col items-center justify-center gap-2 p-6 text-center">
    <MapPin className="h-6 w-6 text-muted-foreground/40" />
    <p className="text-xs font-semibold" style={{ color: BRAND_NAVY }}>
      {t("map.unconfigured")}
    </p>
    <p className="text-[10px] font-mono text-muted-foreground max-w-xs">
      {t("map.unconfiguredHint")}
    </p>
    <code className="text-[9px] font-mono text-muted-foreground/70">
      VITE_MAPBOX_STYLE · VITE_MAPBOX_TOKEN
    </code>
  </div>
);
