import { initDb } from "../db";
import { envKey } from "../env";
import { LEASE_UNAVAILABLE_EXIT_CODE } from "./collector-lease";
import { requestCollectorStop } from "./collector-stop";
import { collectorsFinished, startCollectorLoops, type CollectorRuntime } from "./loops";

// The collector process. Two callers reach this entrypoint: the standalone
// workers container, and the API's supervisor, which spawns it as a child so a
// rejection in a collector loop can never take the API's event loop with it.
// The collector selection and the lease both live in loops.ts so neither caller
// can drift from the other.

function runtime(): CollectorRuntime {
  //TUNE: Control the (collector runtime label). COLLECTOR_RUNTIME=in-api marks this process as the API's supervised child, anything else marks it as the standalone workers container.
  return envKey("COLLECTOR_RUNTIME") === "in-api" ? "in-api" : "standalone";
}

// This process is expendable by design, but it still has to name its cause of
// death: its supervisor logs the exit code, and a silent exit reads as a crash
// with no reason.
process.on("unhandledRejection", (reason) => {
  console.error(
    "[collectors] unhandled rejection, exiting for a supervisor restart:",
    reason instanceof Error ? `${reason.message}\n${reason.stack ?? ""}` : reason,
  );
  process.exit(1);
});

process.on("uncaughtException", (err) => {
  console.error(
    "[collectors] uncaught exception, exiting for a supervisor restart:",
    err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : err,
  );
  process.exit(1);
});

// The supervisor stops the child with SIGTERM on a standalone takeover and on
// API shutdown. Setting the cooperative stop flag lets the loops finish their
// current round and drop the lease, instead of the connection timing out.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    console.log(`[collectors] ${signal} received, stopping the collector loops`);
    requestCollectorStop();
    //TUNE: Control the (collector stop deadline). Seconds the loops get to wind down after a stop signal before this process exits regardless.
    setTimeout(() => process.exit(0), 8000).unref?.();
  });
}

// A fault injector for verifying the supervisor, off unless the var is set. The
// real failure mode this replaces is a collector loop rejecting under upstream
// conditions that cannot be reproduced on demand.
function armCrashHook(): void {
  //TUNE: Control the (supervisor fault injection). COLLECTOR_CRASH_AFTER_SECONDS=seconds until this process raises an unhandled rejection on purpose. Leave unset outside testing.
  const seconds = parseInt(envKey("COLLECTOR_CRASH_AFTER_SECONDS") || "0");
  if (!Number.isFinite(seconds) || seconds <= 0) return;
  console.error(`[collectors] fault injection armed, rejecting in ${seconds}s`);
  setTimeout(() => {
    void Promise.reject(
      new Error(`injected collector failure after ${seconds}s (COLLECTOR_CRASH_AFTER_SECONDS)`),
    );
  }, seconds * 1000);
}

async function main() {
  const mode = runtime();
  armCrashHook();
  await initDb();
  const started = await startCollectorLoops(mode);
  if (!started) {
    console.error(
      "[collectors] another process holds the collector lease, this collector process has nothing to do",
    );
    process.exit(LEASE_UNAVAILABLE_EXIT_CODE);
  }
  console.log(`[collectors] ${mode} collectors started`);

  // Loops that all returned mean collection has silently stopped. Exiting hands
  // that to the supervisor, which restarts and logs it, rather than leaving a
  // live process that collects nothing.
  await collectorsFinished();
  console.error("[collectors] every collector loop exited, ending the process");
  process.exit(1);
}

main().catch((e) => {
  console.error("[collectors] startup failed:", e instanceof Error ? e.stack : e);
  process.exit(1);
});
