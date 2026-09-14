import { envKey } from "../env";
import { geocodePending } from "./geocode";
import { sourceStatusUpdate } from "./source-status";
import { collectorsShouldStop, sleepUnlessStopped } from "./collector-stop";

//TUNE: Control the (geocode sweep rate). GEOCODE_POLL_SECONDS=seconds between passes over rows with no location yet.
const GEOCODE_POLL_SECONDS = parseInt(envKey("GEOCODE_POLL_SECONDS") || "120");
//TUNE: Control the (geocode error backoff). Seconds the sweep waits after a failed pass.
const GEOCODE_ERROR_BACKOFF_SECONDS = 120;

export async function runGeocodeWorker(): Promise<void> {
  console.log("Starting geocode worker");

  for (;;) {
    if (collectorsShouldStop()) {
      console.log("Geocode worker stopped");
      return;
    }
    try {
      const run = await geocodePending();
      if (run.scanned > 0) {
        console.log(
          `Geocoded ${run.located} of ${run.scanned} items, ${run.leftNull} left null ` +
            `(${run.noPlaceNamed} named no place, ${run.unresolvable} unresolvable), ` +
            `${run.viaOverride} via override, ${run.viaNominatim} via nominatim, ` +
            `${run.rate.requests} OSM requests, min gap ${run.rate.minGapMs ?? "n/a"}ms`,
        );
      }
      await sourceStatusUpdate({
        id: "geocode",
        source: "geocode",
        label: "nominatim geocoder",
        ok: true,
        detail: `scanned ${run.scanned}, located ${run.located} (${run.viaOverride} override, ${run.viaNominatim} nominatim), null ${run.leftNull}`,
        failures: 0,
        last_ok: new Date(),
        updated_at: new Date(),
      });
      await sleepUnlessStopped(GEOCODE_POLL_SECONDS);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error("Geocode sweep failed:", message);
      await sourceStatusUpdate({
        id: "geocode",
        source: "geocode",
        label: "nominatim geocoder",
        ok: false,
        detail: message,
        failures: 1,
        updated_at: new Date(),
      });
      await sleepUnlessStopped(GEOCODE_ERROR_BACKOFF_SECONDS);
    }
  }
}
