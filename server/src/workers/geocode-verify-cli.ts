import "../env";
import { GAZETTEER, findNamedPlaces, choosePrimaryPlace } from "../geo";
import { overrideCount, overrideIds, overrideFor } from "./place-overrides";
import { geocodePlace } from "./nominatim";

// Offline proof that the curated override table loads, that every entry agrees
// with the gazetteer, and that the conflict locations the map cares about
// resolve. Pass --live to also send the non-overridden ones to Nominatim.
async function main() {
  console.log(`overrides loaded: ${overrideCount()}`);
  console.log(`ids: ${overrideIds().join(", ")}\n`);

  const required = [
    "gaza_city", "rafah", "khan_younis", "gaza", "west_bank", "ramallah",
    "jenin", "hebron", "tel_aviv", "jerusalem", "beirut", "south_lebanon",
    "damascus", "tehran", "hormuz", "red_sea", "black_sea", "crimea",
    "donbas", "kharkiv", "odesa", "taiwan_strait", "south_china_sea",
  ];

  let missing = 0;
  for (const id of required) {
    const entry = GAZETTEER.find((e) => e.id === id);
    if (!entry) {
      console.log(`FAIL ${id}: not in the gazetteer`);
      missing += 1;
      continue;
    }
    const o = overrideFor(id);
    if (o) {
      const ccOk = (o.country?.toLowerCase() ?? null) === (entry.cc ?? null);
      console.log(
        `${ccOk ? "OK  " : "FAIL"} ${id} override ${o.lat},${o.lng} ` +
          `country=${o.country ?? "null"} expected=${(entry.cc ?? "null").toUpperCase()} ` +
          `${o.precision} conf=${o.confidence}`,
      );
      if (!ccOk) missing += 1;
    } else {
      console.log(`--   ${id} no override, resolves via nominatim (cc=${entry.cc ?? "null"})`);
    }
  }

  // Prove the extractor still reaches these ids from real headline text, since
  // an override is useless if nothing ever names the place.
  console.log("\nextraction check:");
  const samples = [
    "Israeli strikes hit Gaza City as aid convoys stall",
    "Rafah crossing closed for a third day",
    "Heavy fighting reported in Khan Younis",
    "Explosions heard across Beirut suburbs",
    "Drone strike in the Donbas kills two",
    "Shipping reroutes away from the Red Sea",
    "غزة تشهد قصفا عنيفا",
  ];
  for (const text of samples) {
    const primary = choosePrimaryPlace(findNamedPlaces(text, null));
    const via = primary ? (overrideFor(primary.entry.id) ? "override" : "nominatim") : "none";
    console.log(`  "${text.slice(0, 50)}" -> ${primary?.entry.id ?? "NO PLACE"} (${via})`);
  }

  if (process.argv.includes("--live")) {
    console.log("\nlive nominatim check for non-overridden required ids:");
    for (const id of required) {
      if (overrideFor(id)) continue;
      const entry = GAZETTEER.find((e) => e.id === id);
      if (!entry) continue;
      const out = await geocodePlace(entry);
      if (out.result) {
        const ccOk = (out.result.country?.toLowerCase() ?? null) === (entry.cc ?? null);
        console.log(
          `  ${ccOk ? "OK  " : "FAIL"} ${id} -> ${out.result.lat},${out.result.lng} ` +
            `${out.result.country ?? "null"} ${out.result.precision} conf=${out.result.confidence}`,
        );
        if (!ccOk) missing += 1;
      } else {
        console.log(`  MISS ${id}: ${out.error ?? out.rejections.map((r) => r.reason).join(",")}`);
        missing += 1;
      }
    }
  }

  console.log(missing === 0 ? "\nall checks passed" : `\n${missing} failures`);
  if (missing > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
