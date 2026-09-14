import "../env";
import { initDb, pool } from "../db";
import { runRssRound } from "./rss";

// One RSS round, then exit with real counts. This is how a deploy proves it
// ingests before the long-lived worker is left running.
async function main() {
  await initDb();
  await runRssRound();

  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS total,
            MIN(published_at) AS oldest,
            MAX(published_at) AS newest
     FROM items
     WHERE source = 'rss'`,
  );
  const { total, oldest, newest } = rows[0];
  console.log(`rss items: ${total}`);
  console.log(`published_at range: ${oldest?.toISOString() ?? "null"} .. ${newest?.toISOString() ?? "null"}`);

  const { rows: perFeed } = await pool.query(
    `SELECT source_uid, COUNT(*)::int AS count
     FROM items
     WHERE source = 'rss'
     GROUP BY source_uid
     ORDER BY count DESC`,
  );
  for (const row of perFeed) {
    console.log(`  ${row.source_uid}: ${row.count}`);
  }

  await pool.end();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
