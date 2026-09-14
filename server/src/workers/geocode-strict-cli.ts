import "../env";
import { geocodePlace } from "./nominatim";
import { PlaceEntry } from "../geo";

// Proves the country check is still strict after the best-candidate rework: no
// hit may ever be accepted whose country disagrees with the expected one.
// A wrong pin is worse than no pin.
//
// Picking traps is subtler than it looks. "Cairo expected in Brazil" is not a
// trap: there is a real Cairo in Bahia, so a BR pin there is correct, not a
// leak. So the assertion is not "must return nothing", it is the actual
// contract: whatever comes back must sit in the expected country.
async function main() {
  const traps: PlaceEntry[] = [
    { id: "trap_paris_jp", names: ["Paris"], cc: "jp", kind: "settlement" },
    { id: "trap_cairo_br", names: ["Cairo"], cc: "br", kind: "settlement" },
    { id: "trap_moscow_eg", names: ["Moscow"], cc: "eg", kind: "settlement" },
    { id: "trap_gaza_city_cn", names: ["Gaza City"], cc: "cn", kind: "settlement" },
    { id: "trap_kharkiv_ru", names: ["Kharkiv"], cc: "ru", kind: "settlement" },
  ];

  let leaked = 0;
  for (const entry of traps) {
    const out = await geocodePlace(entry);
    if (out.result) {
      const got = out.result.country?.toLowerCase() ?? null;
      if (got !== entry.cc) {
        leaked += 1;
        console.log(
          `LEAK ${entry.id}: expected ${entry.cc} but accepted a pin in ` +
            `${got ?? "null"} at ${out.result.lat},${out.result.lng}`,
        );
      } else {
        console.log(
          `OK   ${entry.id}: pinned inside the expected country ${got} ` +
            `at ${out.result.lat},${out.result.lng} ("${out.result.normalized}")`,
        );
      }
    } else {
      const reasons = [...new Set(out.rejections.map((r) => r.reason))].join(",") || "no hits";
      console.log(`OK   ${entry.id}: no pin (${out.error ?? reasons})`);
    }
  }

  console.log(leaked === 0 ? "\nstrict rejection holds" : `\n${leaked} wrong-country pins leaked`);
  if (leaked > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
