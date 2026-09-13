import "../env";
import { initDb, pool } from "../db";

// Applies SCHEMA_SQL, which is idempotent, then exits. Used to roll out index
// changes without booting the API.
async function main() {
  await initDb();
  const { rows } = await pool.query(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'items' ORDER BY indexname`,
  );
  console.log(rows.map((r) => r.indexname).join("\n"));
  await pool.end();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
