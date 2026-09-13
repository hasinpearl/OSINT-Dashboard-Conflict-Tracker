import "../env";
import { initDb, pool } from "../db";
import { enrichAll, enrichPending } from "./enrich";

// Usage: tsx src/workers/enrich-cli.ts [--all]
// Default classifies only rows that are unclassified or on an older ruleset.
async function main() {
  await initDb();
  const all = process.argv.includes("--all");
  const started = Date.now();
  const result = all ? await enrichAll() : await enrichPending();
  const seconds = ((Date.now() - started) / 1000).toFixed(2);
  console.log(
    JSON.stringify({
      mode: all ? "all" : "pending",
      scanned: result.scanned,
      updated: result.updated,
      seconds: Number(seconds),
    }),
  );
  await pool.end();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
