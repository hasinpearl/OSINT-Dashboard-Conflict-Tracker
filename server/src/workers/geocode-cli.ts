import "../env";
import { initDb, pool } from "../db";
import { geocodePending } from "./geocode";

// Usage: tsx src/workers/geocode-cli.ts [--limit N]
// Walks rows that have never been attempted and pins only the places their text
// actually names. Resumable: rerunning picks up where the last pass stopped.
async function main() {
  await initDb();
  const limitArg = process.argv.indexOf("--limit");
  const limit = limitArg >= 0 ? Number(process.argv[limitArg + 1]) : undefined;
  const started = Date.now();
  const result = await geocodePending(Number.isFinite(limit as number) ? limit : undefined);
  const seconds = ((Date.now() - started) / 1000).toFixed(2);
  console.log(
    JSON.stringify(
      {
        scanned: result.scanned,
        located: result.located,
        left_null: result.leftNull,
        no_place_named: result.noPlaceNamed,
        unresolvable: result.unresolvable,
        errors: result.errors,
        osm_requests: result.rate.requests,
        min_request_gap_ms: result.rate.minGapMs,
        seconds: Number(seconds),
      },
      null,
      2,
    ),
  );
  await pool.end();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
