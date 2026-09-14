import { runRssWorker } from "./rss";
import { startTelegramWorker } from "./telegram";
import { runTelegramPreviewWorker } from "./telegramPreview";
import { runEnrichWorker } from "./enrich-loop";
import { runGeocodeWorker } from "./geocode-loop";
import { envKey } from "../env";
import { sourceStatusUpdate } from "./source-status";
import { clearCollectorStop, requestCollectorStop } from "./collector-stop";
import { acquireCollectorLease, releaseCollectorLease } from "./collector-lease";

// The standalone workers container and the API's in-process fallback have to run
// the exact same set of loops, so the selection lives here and both entrypoints
// call it. No collector is reimplemented, only started.

export type CollectorRuntime = "standalone" | "in-api";

// Two ids, not one shared marker. The API has to tell "a separate workers
// container is alive" apart from "this row is my own previous run", and a single
// id cannot express that.
export const RUNTIME_HEARTBEAT_IDS: Record<CollectorRuntime, string> = {
  standalone: "worker_runtime:standalone",
  "in-api": "worker_runtime:in-api",
};

//TUNE: Control the (runtime heartbeat rate). Seconds between refreshes of the marker row saying which runtime owns collection.
export const RUNTIME_HEARTBEAT_SECONDS = 30;

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let running = false;
let finished: Promise<void> | null = null;

async function writeRuntimeHeartbeat(runtime: CollectorRuntime): Promise<void> {
  await sourceStatusUpdate({
    id: RUNTIME_HEARTBEAT_IDS[runtime],
    source: "worker",
    label: `${runtime} collectors`,
    ok: true,
    detail: `pid ${process.pid}`,
    failures: 0,
    last_ok: new Date(),
    updated_at: new Date(),
  });
}

export function collectorsRunning(): boolean {
  return running;
}

// Resolves when every loop has settled. The collector process awaits this so a
// set of loops that all quietly returned ends the process instead of leaving it
// idling with nothing collecting and nothing in the logs.
export function collectorsFinished(): Promise<void> {
  return finished ?? Promise.resolve();
}

// Returns false when another process already holds the lease, which is the
// caller's signal to stand down rather than poll the same feeds twice.
export async function startCollectorLoops(runtime: CollectorRuntime): Promise<boolean> {
  if (running) return true;

  if (!(await acquireCollectorLease())) return false;

  clearCollectorStop();
  running = true;

  await writeRuntimeHeartbeat(runtime);
  heartbeatTimer = setInterval(() => {
    void writeRuntimeHeartbeat(runtime).catch((e) =>
      console.error(
        "[collectors] runtime heartbeat failed:",
        e instanceof Error ? e.message : e,
      ),
    );
  }, RUNTIME_HEARTBEAT_SECONDS * 1000);
  heartbeatTimer.unref?.();

  const loops = [runRssWorker(), runEnrichWorker(), runGeocodeWorker()];
  //TUNE: Control the (telegram collector choice). TG_API_ID set picks the MTProto worker, unset picks the public preview worker.
  loops.push(envKey("TG_API_ID") ? startTelegramWorker() : runTelegramPreviewWorker());

  void Promise.all(loops)
    .catch((e) =>
      console.error(
        "[collectors] a loop exited with an error:",
        e instanceof Error ? e.message : e,
      ),
    )
    .finally(() => {
      running = false;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      void releaseCollectorLease();
    });

  finished = Promise.allSettled(loops).then(() => undefined);

  return true;
}

export function stopCollectorLoops(): void {
  requestCollectorStop();
}
