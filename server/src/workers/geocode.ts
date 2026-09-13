import { pool } from "../db";
import { choosePrimaryPlace, findNamedPlaces, PlaceEntry, placeById } from "../geo";
import { geocodePlace, GeocodeResult, getRateReport, RateReport } from "./nominatim";

//TUNE: Control the (geocode version). Bump when the gazetteer or validation changes so a backfill can target stale rows.
export const GEOCODE_VERSION = 1;

//TUNE: Control the (geocode batch size). Rows pulled from Postgres per pass.
const GEOCODE_BATCH_SIZE = 200;

export interface GeocodeRunResult {
  scanned: number;
  located: number;
  leftNull: number;
  noPlaceNamed: number;
  unresolvable: number;
  errors: number;
  rate: RateReport;
}

interface Row {
  id: string;
  title: string | null;
  content: string | null;
}

// One place resolves to one coordinate no matter how many items name it, so the
// lookup is cached for the life of the process. This is what keeps a 100-item
// pass down to a handful of requests instead of one per row.
const resolved = new Map<string, GeocodeResult | null>();

async function resolveEntry(entry: PlaceEntry): Promise<{ result: GeocodeResult | null; error: string | null }> {
  if (resolved.has(entry.id)) {
    return { result: resolved.get(entry.id) ?? null, error: null };
  }
  const outcome = await geocodePlace(entry);
  if (outcome.error) {
    // A transport failure is not evidence the place is unresolvable, so it is
    // not cached. The row stays pending and the next pass retries it.
    return { result: null, error: outcome.error };
  }
  if (!outcome.result && outcome.rejections.length > 0) {
    console.log(
      `geocode rejected ${entry.id}: ${outcome.rejections
        .slice(0, 3)
        .map((r) => `${r.reason} (${r.detail})`)
        .join("; ")}`,
    );
  }
  resolved.set(entry.id, outcome.result);
  return { result: outcome.result, error: null };
}

async function markNoLocation(id: string, reason: string): Promise<void> {
  await pool.query(
    `UPDATE items
     SET primary_location = NULL,
         location_precision = NULL,
         location_confidence = NULL,
         geocoded_at = now(),
         geocode_version = $2
     WHERE id = $1::bigint`,
    [id, GEOCODE_VERSION],
  );
  console.log(`geocode item ${id}: no pin (${reason})`);
}

async function storeLocation(
  id: string,
  entry: PlaceEntry,
  surface: string,
  result: GeocodeResult,
): Promise<void> {
  const location = {
    lat: result.lat,
    lng: result.lng,
    country: result.country,
    region: result.region,
    precision: result.precision,
    confidence: result.confidence,
    normalized: result.normalized,
    matched_name: surface,
    place_id: entry.id,
    place_kind: entry.kind,
    osm_type: result.osm_type,
    osm_id: result.osm_id,
    place_rank: result.place_rank,
    geocoder: result.source,
  };

  await pool.query(
    `UPDATE items
     SET primary_location = $2::jsonb,
         location_precision = $3,
         location_confidence = $4,
         geocoded_at = now(),
         geocode_version = $5
     WHERE id = $1::bigint`,
    [id, JSON.stringify(location), result.precision, result.confidence, GEOCODE_VERSION],
  );
}

export async function geocodePending(limit?: number): Promise<GeocodeRunResult> {
  let scanned = 0;
  let located = 0;
  let noPlaceNamed = 0;
  let unresolvable = 0;
  let errors = 0;

  for (;;) {
    const remaining = limit === undefined ? GEOCODE_BATCH_SIZE : limit - scanned;
    if (remaining <= 0) break;
    const batchSize = Math.min(GEOCODE_BATCH_SIZE, remaining);

    // geocoded_at is the resume marker: a row is only revisited once, whether
    // or not it produced a pin, so an interrupted pass picks up where it left
    // off instead of re-querying OSM for places it already resolved.
    const { rows } = await pool.query<Row>(
      `SELECT id, title, content
       FROM items
       WHERE geocoded_at IS NULL
       ORDER BY published_at DESC NULLS LAST, id DESC
       LIMIT $1`,
      [batchSize],
    );

    if (rows.length === 0) break;

    for (const row of rows) {
      scanned += 1;
      const hits = findNamedPlaces(row.title, row.content);
      const primary = choosePrimaryPlace(hits);

      if (!primary) {
        noPlaceNamed += 1;
        await markNoLocation(row.id, "no place named in the text");
        continue;
      }

      const entry = placeById(primary.entry.id) || primary.entry;
      const { result, error } = await resolveEntry(entry);

      if (error) {
        errors += 1;
        console.error(`geocode item ${row.id}: lookup failed for ${entry.id}: ${error}`);
        continue;
      }
      if (!result) {
        unresolvable += 1;
        await markNoLocation(row.id, `named "${primary.surface}" but no hit survived validation`);
        continue;
      }

      await storeLocation(row.id, entry, primary.surface, result);
      located += 1;
    }

    if (rows.length < batchSize) break;
  }

  return {
    scanned,
    located,
    leftNull: noPlaceNamed + unresolvable,
    noPlaceNamed,
    unresolvable,
    errors,
    rate: getRateReport(),
  };
}
