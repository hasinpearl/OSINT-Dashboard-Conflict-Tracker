import { envKey } from "../env";
import { PlaceEntry, PlaceKind } from "../geo";

//TUNE: Control the (nominatim host). NOMINATIM_URL=geocoding endpoint, defaults to the public OSM instance.
const NOMINATIM_URL = envKey("NOMINATIM_URL") || "https://nominatim.openstreetmap.org/search";

// OSM's usage policy requires an identifying User-Agent and a maximum of one
// request per second. A generic agent gets blocked outright.
//TUNE: Control the (nominatim user agent). GEOCODE_USER_AGENT=contact string sent to OSM, required by their policy.
const GEOCODE_USER_AGENT =
  envKey("GEOCODE_USER_AGENT") ||
  "OSINT-Dashboard-Conflict-Tracker/1.0 (+https://hessaa.net)";

//TUNE: Control the (nominatim rate limit). GEOCODE_MIN_INTERVAL_MS=minimum gap between requests, 1000 is OSM's stated floor.
const GEOCODE_MIN_INTERVAL_MS = Math.max(
  1000,
  Number(envKey("GEOCODE_MIN_INTERVAL_MS") || 1100),
);

//TUNE: Control the (geocode request timeout). Milliseconds before a single lookup is abandoned.
const GEOCODE_TIMEOUT_MS = 20000;

//TUNE: Control the (geocode retries). Attempts per place before it is treated as unresolvable this pass.
const GEOCODE_MAX_ATTEMPTS = 3;

//TUNE: Control the (geocode retry backoff). Milliseconds multiplied by attempt number after a failed lookup.
const GEOCODE_RETRY_BACKOFF_MS = 2000;

export interface GeocodeResult {
  lat: number;
  lng: number;
  country: string | null;
  region: string | null;
  precision: "exact" | "approximate";
  confidence: number;
  normalized: string;
  osm_type: string;
  osm_id: number;
  place_rank: number;
  source: "nominatim";
}

interface NominatimHit {
  lat?: string;
  lon?: string;
  name?: string;
  display_name?: string;
  addresstype?: string;
  category?: string;
  type?: string;
  place_rank?: number;
  importance?: number;
  osm_type?: string;
  osm_id?: number;
  boundingbox?: string[];
  address?: Record<string, string>;
  namedetails?: Record<string, string>;
}

// Serialised globally: every caller in this process queues behind the same
// promise chain so concurrency can never exceed OSM's one-per-second rule.
let rateGate: Promise<void> = Promise.resolve();
let lastRequestAt = 0;

export interface RateReport {
  requests: number;
  minGapMs: number | null;
  gaps: number[];
}

const rateReport: RateReport = { requests: 0, minGapMs: null, gaps: [] };

export function getRateReport(): RateReport {
  return { ...rateReport, gaps: [...rateReport.gaps] };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function pacedFetch(url: string): Promise<NominatimHit[]> {
  const turn = rateGate.then(async () => {
    const waitFor = lastRequestAt === 0
      ? 0
      : GEOCODE_MIN_INTERVAL_MS - (Date.now() - lastRequestAt);
    if (waitFor > 0) await sleep(waitFor);
    const now = Date.now();
    if (lastRequestAt !== 0) {
      const gap = now - lastRequestAt;
      rateReport.gaps.push(gap);
      rateReport.minGapMs = rateReport.minGapMs === null ? gap : Math.min(rateReport.minGapMs, gap);
    }
    lastRequestAt = now;
    rateReport.requests += 1;
  });
  rateGate = turn.catch(() => undefined);
  await turn;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEOCODE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": GEOCODE_USER_AGENT,
        "Accept": "application/json",
        "Accept-Language": "en",
      },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`nominatim ${res.status}`);
    const body = await res.json();
    return Array.isArray(body) ? (body as NominatimHit[]) : [];
  } finally {
    clearTimeout(timer);
  }
}

// place_rank is Nominatim's own specificity scale: low is continent-sized, high
// is a single building. A pin is only "exact" when the feature is a settlement
// or tighter, otherwise the map has to show it as an area.
//TUNE: Control the (exact precision cutoff). Nominatim place_rank at or above which a pin is drawn as an exact point.
const EXACT_PLACE_RANK = 14;

//TUNE: Control the (bounding box cutoff). Degrees of span above which a hit is treated as approximate no matter its rank.
const APPROXIMATE_SPAN_DEGREES = 0.6;

function precisionFor(hit: NominatimHit, kind: PlaceKind): "exact" | "approximate" {
  if (kind === "country" || kind === "admin" || kind === "water") return "approximate";
  const box = hit.boundingbox;
  if (box && box.length === 4) {
    const latSpan = Math.abs(Number(box[1]) - Number(box[0]));
    const lonSpan = Math.abs(Number(box[3]) - Number(box[2]));
    if (latSpan > APPROXIMATE_SPAN_DEGREES || lonSpan > APPROXIMATE_SPAN_DEGREES) {
      return "approximate";
    }
  }
  return (hit.place_rank ?? 0) >= EXACT_PLACE_RANK ? "exact" : "approximate";
}

const ADDRESS_TYPES_BY_KIND: Record<PlaceKind, string[]> = {
  settlement: [
    "city", "town", "village", "municipality", "suburb", "borough",
    "island", "county", "state_district", "hamlet",
  ],
  admin: [
    "state", "state_district", "region", "province", "county", "district",
    "city", "territory", "municipality",
  ],
  country: ["country"],
  water: ["sea", "strait", "bay", "water", "ocean", "channel"],
};

// Confidence is evidence about the hit, not a guess about the item. It starts
// from Nominatim's own importance and is only raised when the returned feature
// is the kind of thing the gazetteer expected.
function confidenceFor(hit: NominatimHit, entry: PlaceEntry, typeMatches: boolean): number {
  const importance = Number(hit.importance ?? 0);
  let score = Math.min(Math.max(importance, 0), 1) * 0.7;
  if (typeMatches) score += 0.25;
  if (entry.kind === "settlement" || entry.kind === "admin") score += 0.05;
  return Math.round(Math.min(Math.max(score, 0.05), 0.99) * 100) / 100;
}

export interface RejectedHit {
  reason: string;
  detail: string;
}

// The whole point of this function. Nominatim answers q="Gaza City" with a
// village in Tibet and q="Rafah" with a village in Syria, so a hit is only
// accepted when it lands in the country the gazetteer expects AND the feature
// type is the kind of place that was asked for. Anything else is a different
// place that happens to share a name, and pinning it would be a lie.
function validate(
  hit: NominatimHit,
  entry: PlaceEntry,
): { ok: true; typeMatches: boolean } | { ok: false; rejection: RejectedHit } {
  const lat = Number(hit.lat);
  const lng = Number(hit.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { ok: false, rejection: { reason: "no_coordinates", detail: String(hit.display_name ?? "") } };
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return { ok: false, rejection: { reason: "coordinates_out_of_range", detail: `${lat},${lng}` } };
  }

  const cc = (hit.address?.country_code || "").toLowerCase();
  if (entry.cc) {
    if (!cc) {
      return { ok: false, rejection: { reason: "missing_country", detail: `expected ${entry.cc}` } };
    }
    if (cc !== entry.cc) {
      return {
        ok: false,
        rejection: {
          reason: "country_mismatch",
          detail: `expected ${entry.cc}, got ${cc} (${hit.display_name ?? ""})`,
        },
      };
    }
  }

  const addressType = (hit.addresstype || hit.type || "").toLowerCase();
  const allowed = ADDRESS_TYPES_BY_KIND[entry.kind];
  const typeMatches = allowed.includes(addressType);
  if (!typeMatches && entry.kind !== "water") {
    // A road, a cemetery or a shop named after a city is not the city.
    return {
      ok: false,
      rejection: {
        reason: "feature_type_mismatch",
        detail: `expected one of ${allowed.join("|")}, got ${addressType || "unknown"}`,
      },
    };
  }

  return { ok: true, typeMatches };
}

export interface GeocodeOutcome {
  result: GeocodeResult | null;
  rejections: RejectedHit[];
  error: string | null;
}

//TUNE: Control the (candidates per lookup). Nominatim results examined before a place is given up on.
const GEOCODE_CANDIDATE_LIMIT = 5;

export async function geocodePlace(entry: PlaceEntry): Promise<GeocodeOutcome> {
  const query = entry.names[0];
  const params = new URLSearchParams({
    q: query,
    format: "jsonv2",
    limit: String(GEOCODE_CANDIDATE_LIMIT),
    addressdetails: "1",
    namedetails: "1",
  });
  if (entry.kind === "country") params.set("featureType", "country");

  const rejections: RejectedHit[] = [];
  let lastError: string | null = null;

  for (let attempt = 1; attempt <= GEOCODE_MAX_ATTEMPTS; attempt += 1) {
    let hits: NominatimHit[];
    try {
      hits = await pacedFetch(`${NOMINATIM_URL}?${params.toString()}`);
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      if (attempt < GEOCODE_MAX_ATTEMPTS) {
        await sleep(GEOCODE_RETRY_BACKOFF_MS * attempt);
        continue;
      }
      return { result: null, rejections, error: lastError };
    }

    for (const hit of hits) {
      const checked = validate(hit, entry);
      if (!checked.ok) {
        rejections.push(checked.rejection);
        continue;
      }
      const addr = hit.address || {};
      const region =
        entry.region ||
        addr.state ||
        addr.region ||
        addr.state_district ||
        addr.county ||
        null;
      return {
        result: {
          lat: Number(hit.lat),
          lng: Number(hit.lon),
          country: (addr.country_code || "").toUpperCase() || null,
          region,
          precision: precisionFor(hit, entry.kind),
          confidence: confidenceFor(hit, entry, checked.typeMatches),
          normalized: hit.namedetails?.["name:en"] || hit.name || query,
          osm_type: hit.osm_type || "unknown",
          osm_id: Number(hit.osm_id ?? 0),
          place_rank: Number(hit.place_rank ?? 0),
          source: "nominatim",
        },
        rejections,
        error: null,
      };
    }

    // A clean response with nothing acceptable in it is an answer, not a
    // failure. Retrying would just spend another request on the same reply.
    return { result: null, rejections, error: null };
  }

  return { result: null, rejections, error: lastError };
}
