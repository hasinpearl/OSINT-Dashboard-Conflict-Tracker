import "../env";
import { initDb, pool } from "../db";
import { runTelegramPreviewWorker } from "./telegramPreview";
import { clearCollectorStop, requestCollectorStop } from "./collector-stop";

// Runs the real poll loop, not a reimplementation of it, then stops it and
// prints the health rows it wrote. This is how the loop's own round logging,
// backoff and backfill cooldown are proven before it is left running.

//TUNE: Control the (verification window). TG_PREVIEW_VERIFY_SECONDS=seconds the poll loop is allowed to run before it is asked to stop.
const VERIFY_SECONDS = parseInt(process.env.TG_PREVIEW_VERIFY_SECONDS || "180");

async function main() {
  await initDb();
  clearCollectorStop();

  const stop = setTimeout(() => {
    console.log(`[tg-preview-cli] ${VERIFY_SECONDS}s elapsed, requesting stop`);
    requestCollectorStop();
  }, VERIFY_SECONDS * 1000);

  await runTelegramPreviewWorker();
  clearTimeout(stop);

  const { rows: items } = await pool.query(
    `SELECT source_uid, COUNT(*)::int AS count
     FROM items
     WHERE source = 'telegram'
     GROUP BY source_uid
     ORDER BY count DESC`,
  );
  console.log(`\ntelegram items by channel:`);
  for (const row of items) console.log(`  ${row.source_uid}: ${row.count}`);

  const { rows: status } = await pool.query(
    `SELECT id, ok, failures, last_ok, detail
     FROM source_status
     WHERE source = 'telegram'
     ORDER BY id`,
  );
  console.log(`\nsource_status:`);
  for (const row of status) {
    console.log(
      `  ${row.id}  ok=${row.ok}  failures=${row.failures}  last_ok=${row.last_ok?.toISOString() ?? "null"}  detail=${row.detail ?? "null"}`,
    );
  }

  await pool.end();
}

main().catch((e) => {
  console.error(e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : e);
  process.exit(1);
});
