import { initDb } from "../db";
import { startCollectorLoops } from "./loops";

// The standalone workers container. The collector selection and the lease both
// live in loops.ts so this entrypoint and the API's in-process fallback cannot
// drift apart.
async function main() {
  await initDb();
  const started = await startCollectorLoops("standalone");
  if (!started) {
    console.error(
      "[collectors] another process holds the collector lease, this workers container has nothing to do",
    );
    return;
  }
  console.log("[collectors] standalone collectors started");
}

main().catch(console.error);
