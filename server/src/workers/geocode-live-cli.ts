import "../env";
import { GAZETTEER } from "../geo";
import { geocodePlace } from "./nominatim";
import { overrideFor } from "./place-overrides";

// Live proof that the reworked Nominatim path still resolves the places that
// were already working, and that best-candidate selection did not loosen the
// country check. Anything that resolves outside its expected country is a
// failure, not a warning.
async function main() {
  const ids = process.argv.slice(2);
  const entries = ids.length
    ? GAZETTEER.filter((e) => ids.includes(e.id))
    : GAZETTEER.filter((e) => !overrideFor(e.id));

  let wrongCountry = 0;
  let pinned = 0;
  let missed = 0;

  for (const entry of entries) {
    const out = await geocodePlace(entry);
    if (!out.result) {
      missed += 1;
      console.log(`MISS ${entry.id} (${entry.kind}): ${out.error ?? (out.rejections.map((r) => r.reason).join(",") || "no hits")}`);
      continue;
    }
    const got = out.result.country?.toLowerCase() ?? null;
    const want = entry.cc ?? null;
    // cc null means the gazetteer has no country expectation for this place
    // (open water). validate() skips the country check for those by design, so
    // any country OSM attributes the feature to is acceptable.
    const ok = want === null || got === want;
    if (!ok) wrongCountry += 1;
    else pinned += 1;
    console.log(
      `${ok ? "OK  " : "WRONG"} ${entry.id} (${entry.kind}) -> ${out.result.lat},${out.result.lng} ` +
        `got=${got ?? "null"} want=${want ?? "null"} ${out.result.precision} ` +
        `rank=${out.result.place_rank} conf=${out.result.confidence} "${out.result.normalized}"`,
    );
  }

  console.log(`\npinned=${pinned} missed=${missed} wrong_country=${wrongCountry} of ${entries.length}`);
  if (wrongCountry > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
