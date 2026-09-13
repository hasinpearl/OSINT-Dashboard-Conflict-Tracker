import { envKey } from "../env";
import { enrichPending } from "./enrich";
import { sourceStatusUpdate } from "./source-status";

//TUNE: Control the (enrich sweep rate). ENRICH_POLL_SECONDS=seconds between backfill sweeps for rows the insert path missed.
const ENRICH_POLL_SECONDS = parseInt(envKey("ENRICH_POLL_SECONDS") || "60");
//TUNE: Control the (enrich error backoff). Seconds the sweep waits after a failed pass.
const ENRICH_ERROR_BACKOFF_SECONDS = 60;

// Inserts already classify inline. This sweep exists for rows that predate the
// classifier, rows written by a path that skipped it, and rule-version bumps.
export async function runEnrichWorker(): Promise<void> {
  console.log("Starting enrichment worker");

  for (;;) {
    try {
      const { scanned, updated } = await enrichPending();
      if (scanned > 0) {
        console.log(`Enriched ${updated} of ${scanned} pending items`);
      }
      await sourceStatusUpdate({
        id: "enrich",
        source: "enrich",
        label: "rules classifier",
        ok: true,
        detail: `scanned ${scanned}, updated ${updated}`,
        failures: 0,
        last_ok: new Date(),
        updated_at: new Date(),
      });
      await new Promise((r) => setTimeout(r, ENRICH_POLL_SECONDS * 1000));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error("Enrichment sweep failed:", message);
      await sourceStatusUpdate({
        id: "enrich",
        source: "enrich",
        label: "rules classifier",
        ok: false,
        detail: message,
        failures: 1,
        updated_at: new Date(),
      });
      await new Promise((r) => setTimeout(r, ENRICH_ERROR_BACKOFF_SECONDS * 1000));
    }
  }
}
