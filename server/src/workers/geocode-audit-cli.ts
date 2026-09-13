import "../env";
import { initDb, pool } from "../db";
import { choosePrimaryPlace, findNamedPlaces } from "../geo";

// Offline audit of the extractor: which rows name a place, which do not, and
// which place would become the pin. No network, so it can be rerun freely.
async function main() {
  await initDb();
  const { rows } = await pool.query<{ id: string; title: string | null; content: string | null }>(
    `SELECT id, title, content FROM items ORDER BY id`,
  );

  let named = 0;
  for (const row of rows) {
    const hits = findNamedPlaces(row.title, row.content);
    const primary = choosePrimaryPlace(hits);
    const text = ((row.title || row.content || "").replace(/\s+/g, " ")).slice(0, 78);
    if (primary) {
      named += 1;
      const others = hits.filter((h) => h.entry.id !== primary.entry.id).map((h) => h.entry.id);
      console.log(
        `PIN  ${row.id} ${primary.entry.id}(${primary.entry.kind}) via "${primary.surface}"` +
          `${others.length ? ` [also: ${others.join(",")}]` : ""} :: ${text}`,
      );
    } else {
      console.log(`NULL ${row.id} :: ${text}`);
    }
  }
  console.log(`\ntotal=${rows.length} would_pin=${named} would_be_null=${rows.length - named}`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
