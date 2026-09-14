import { pool } from "../db";
import { envKey } from "../env";
import { RUNTIME_HEARTBEAT_IDS } from "./loops";
import { startCollectorSupervisor, stopCollectorSupervisor } from "./supervisor";

// Coolify deploys that never started the workers container left the dashboard
// serving only pre-existing rows, with nothing in the logs to say so. The API
// now collects by itself when nothing else is, so a single-container deploy
// still ingests.
//
// It collects in a supervised child process, never in its own event loop. An
// unhandled rejection in a collector loop used to exit the API and turn every
// /api/* route into a 502; now it only kills the child, which the supervisor
// restarts.

//TUNE: Control the (in-process collection). WORKERS_IN_API=true runs the collectors inside the API when no worker heartbeat is seen. Off by default so a serving API cannot be destabilised by collection.
const WORKERS_IN_API = envKey("WORKERS_IN_API").toLowerCase() === "true";
//TUNE: Control the (fallback grace). WORKERS_IN_API_GRACE_SECONDS=how long to wait for a worker heartbeat before starting collectors in-process.
const WORKERS_IN_API_GRACE_SECONDS = parseInt(
  envKey("WORKERS_IN_API_GRACE_SECONDS") || "90",
);
//TUNE: Control the (heartbeat freshness). Multiple of the rss poll interval a worker heartbeat stays trusted for.
const HEARTBEAT_STALE_MULTIPLIER = 3;
//TUNE: Control the (rss poll rate). RSS_POLL_SECONDS=seconds between polling rounds, read here only to age heartbeats.
const RSS_POLL_SECONDS = parseInt(envKey("RSS_POLL_SECONDS") || "120");
//TUNE: Control the (stand-down check rate). Seconds between checks for a standalone worker taking over from the in-process collectors.
const TAKEOVER_CHECK_SECONDS = 60;

// Evidence has to be newer than this process, otherwise a restarted API reads
// the rows its own previous run wrote, concludes a worker owns collection, and
// stands down permanently. A live worker keeps writing, so it clears this bar
// within the grace period; dead leftovers never can.
const processStart = new Date();

interface Probe {
  alive: boolean;
  id: string | null;
  age: number | null;
}

// Two independent signals, because neither alone covers every deploy. A row
// written since this process booted means something else is actively
// collecting, including an older workers image that writes no runtime marker.
// A fresh standalone marker covers the reverse case, a worker whose poll
// interval is longer than our grace period so it has not written since boot.
// The in-api marker is excluded from both: only this process writes it.
async function probeWorker(scope: "any" | "standalone-only"): Promise<Probe> {
  const window = RSS_POLL_SECONDS * HEARTBEAT_STALE_MULTIPLIER;
  const sql =
    scope === "standalone-only"
      ? `SELECT id, EXTRACT(EPOCH FROM (now() - updated_at)) AS age_seconds
           FROM source_status
          WHERE id = $1
            AND updated_at > now() - make_interval(secs => $2::double precision)
          LIMIT 1`
      : `SELECT id, EXTRACT(EPOCH FROM (now() - updated_at)) AS age_seconds
           FROM source_status
          WHERE id <> $1
            AND updated_at > now() - make_interval(secs => $2::double precision)
            AND (updated_at > $3 OR id = $4)
          ORDER BY updated_at DESC
          LIMIT 1`;
  const params =
    scope === "standalone-only"
      ? [RUNTIME_HEARTBEAT_IDS.standalone, window]
      : [
          RUNTIME_HEARTBEAT_IDS["in-api"],
          window,
          processStart,
          RUNTIME_HEARTBEAT_IDS.standalone,
        ];

  const { rows } = await pool.query<{ id: string; age_seconds: string }>(sql, params);
  const row = rows[0];
  if (!row) return { alive: false, id: null, age: null };
  return { alive: true, id: row.id, age: Math.round(Number(row.age_seconds)) };
}

// A workers container that comes up later writes its runtime heartbeat, and this
// watcher is what makes the supervised child stand down.
function watchForStandaloneTakeover(): void {
  const timer = setInterval(() => {
    void (async () => {
      try {
        const probe = await probeWorker("standalone-only");
        if (!probe.alive) return;
        console.log(
          `[collectors] standalone worker took over (heartbeat ${probe.age}s old), stopping the supervised collector child`,
        );
        stopCollectorSupervisor();
        clearInterval(timer);
      } catch (e) {
        console.error(
          "[collectors] takeover check failed:",
          e instanceof Error ? e.message : e,
        );
      }
    })();
  }, TAKEOVER_CHECK_SECONDS * 1000);
  timer.unref?.();
}

// The lease is no longer checked here. The child acquires it in its own process
// and exits with a distinct code when another process holds it, which the
// supervisor reads and backs off on instead of respawning into a busy lease.
function startInApi(): void {
  startCollectorSupervisor();
  watchForStandaloneTakeover();
}

export async function bootstrapCollectors(): Promise<void> {
  if (!WORKERS_IN_API) {
    console.log("[collectors] WORKERS_IN_API=false, in-process collection disabled");
    return;
  }

  console.log(
    `[collectors] waiting ${WORKERS_IN_API_GRACE_SECONDS}s for a standalone worker heartbeat`,
  );
  await new Promise((r) => setTimeout(r, WORKERS_IN_API_GRACE_SECONDS * 1000));

  let probe: Probe;
  try {
    probe = await probeWorker("any");
  } catch (e) {
    // A failed probe must not mean silence. The advisory lease still makes a
    // double run impossible, so starting is the safe direction.
    console.error(
      "[collectors] heartbeat probe failed, starting collectors in-process anyway:",
      e instanceof Error ? e.message : e,
    );
    startInApi();
    return;
  }

  if (probe.alive) {
    console.log(
      `[collectors] standalone worker detected (${probe.id} heartbeat ${probe.age}s old), not starting in-process collectors`,
    );
    return;
  }

  console.log(
    `[collectors] no worker heartbeat after ${WORKERS_IN_API_GRACE_SECONDS}s, starting collectors in-process`,
  );
  startInApi();
}
