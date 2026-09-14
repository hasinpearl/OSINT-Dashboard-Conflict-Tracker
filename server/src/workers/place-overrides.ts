import { readFileSync } from "node:fs";
import { GeocodeResult } from "./nominatim";
import { placeById } from "../geo";

// Curated coordinates for places Nominatim cannot be trusted to rank, loaded
// from data/place-overrides.json so the list is data rather than conditionals.
//
// This exists because narrowing the query by country is not always enough.
// q=Gaza City&countrycodes=ps returns a war cemetery, a commercial company and
// a chamber of commerce: three real Palestinian features, none of them the
// city. There is no query that reaches Gaza City by that name, so the only
// honest options are a curated coordinate or no pin at all.

interface OverrideFile {
  [id: string]: unknown;
}

interface PlaceOverride {
  lat: number;
  lng: number;
  cc: string | null;
  region: string | null;
  precision: "exact" | "approximate";
  normalized: string;
  osm_type: string;
  osm_id: number;
}

//TUNE: Control the (override confidence). Confidence stored on a pin that came from the curated table.
// Higher than a typical Nominatim hit on purpose: these coordinates were read
// off a named OSM object by hand, so the place identity is not in doubt.
const OVERRIDE_CONFIDENCE = 0.95;

function parseOsmRef(ref: unknown): { osm_type: string; osm_id: number } {
  if (typeof ref !== "string") return { osm_type: "unknown", osm_id: 0 };
  const [type, id] = ref.split("/");
  const parsed = Number(id);
  return {
    osm_type: type || "unknown",
    osm_id: Number.isFinite(parsed) ? parsed : 0,
  };
}

// A bad override is worse than a missing one: it would pin confidently on the
// wrong spot and never be second-guessed by the validator. So every entry is
// checked at load, and a broken one is dropped loudly instead of trusted.
function parseOverride(id: string, raw: unknown): PlaceOverride | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    console.error(`place override ${id}: not an object, ignored`);
    return null;
  }
  const o = raw as Record<string, unknown>;

  const lat = Number(o.lat);
  const lng = Number(o.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    console.error(`place override ${id}: lat/lng not numeric, ignored`);
    return null;
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    console.error(`place override ${id}: coordinates out of range, ignored`);
    return null;
  }

  const precision = o.precision === "exact" ? "exact" : o.precision === "approximate" ? "approximate" : null;
  if (!precision) {
    console.error(`place override ${id}: precision must be exact or approximate, ignored`);
    return null;
  }

  const cc = typeof o.cc === "string" ? o.cc.toLowerCase() : null;

  // The override must agree with the country the gazetteer expects, otherwise
  // the curated table could quietly smuggle in exactly the wrong-country pin
  // the validator exists to block.
  const entry = placeById(id);
  if (!entry) {
    console.error(`place override ${id}: no gazetteer entry with that id, ignored`);
    return null;
  }
  if ((entry.cc ?? null) !== cc) {
    console.error(
      `place override ${id}: cc ${cc ?? "null"} disagrees with gazetteer ${entry.cc ?? "null"}, ignored`,
    );
    return null;
  }

  const { osm_type, osm_id } = parseOsmRef(o.osm);
  return {
    lat,
    lng,
    cc,
    region: typeof o.region === "string" ? o.region : null,
    precision,
    normalized: typeof o.normalized === "string" ? o.normalized : id,
    osm_type,
    osm_id,
  };
}

function load(): Map<string, PlaceOverride> {
  const out = new Map<string, PlaceOverride>();
  let text: string;
  try {
    text = readFileSync(new URL("../data/place-overrides.json", import.meta.url), "utf8");
  } catch (e) {
    console.error(`place overrides unavailable: ${e instanceof Error ? e.message : e}`);
    return out;
  }

  let parsed: OverrideFile;
  try {
    parsed = JSON.parse(text) as OverrideFile;
  } catch (e) {
    console.error(`place overrides malformed: ${e instanceof Error ? e.message : e}`);
    return out;
  }

  for (const [id, raw] of Object.entries(parsed)) {
    if (id.startsWith("_")) continue;
    const override = parseOverride(id, raw);
    if (override) out.set(id, override);
  }
  return out;
}

const OVERRIDES = load();

export function overrideCount(): number {
  return OVERRIDES.size;
}

export function overrideIds(): string[] {
  return [...OVERRIDES.keys()].sort();
}

export function overrideFor(id: string): GeocodeResult | null {
  const o = OVERRIDES.get(id);
  if (!o) return null;
  const entry = placeById(id);
  return {
    lat: o.lat,
    lng: o.lng,
    country: o.cc ? o.cc.toUpperCase() : null,
    region: entry?.region || o.region,
    precision: o.precision,
    confidence: OVERRIDE_CONFIDENCE,
    normalized: o.normalized,
    osm_type: o.osm_type,
    osm_id: o.osm_id,
    // Nominatim's specificity scale does not apply to a hand-picked point.
    place_rank: 0,
    source: "override",
  };
}
