import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LEASE_UNAVAILABLE_EXIT_CODE } from "./collector-lease";

// Collection used to run inside the API's own event loop. Node exits on an
// unhandled rejection, so one rejection anywhere in a collector loop killed the
// API and every /api/* route answered 502. The collectors now run in a separate
// process that this module spawns and restarts. The child is allowed to die;
// the API is not affected when it does.

//TUNE: Control the (restart floor). Seconds before the first restart attempt after the collector child exits.
const RESTART_BASE_SECONDS = 2;
//TUNE: Control the (restart ceiling). Maximum seconds between restart attempts, no matter how many times the child has failed.
const RESTART_MAX_SECONDS = 300;
//TUNE: Control the (backoff reset). Seconds the child must stay up before its next exit counts as a first failure again.
const HEALTHY_UPTIME_SECONDS = 120;
//TUNE: Control the (supervisor heartbeat rate). Seconds between supervisor liveness marks, read by GET /api/sources.
const SUPERVISOR_HEARTBEAT_SECONDS = 15;
//TUNE: Control the (stderr tail). Lines of child stderr kept in memory for the restart log.
const STDERR_TAIL_LINES = 20;
//TUNE: Control the (shutdown grace). Seconds between SIGTERM and SIGKILL when stopping the collector child.
const STOP_GRACE_SECONDS = 10;

export type SupervisorPhase = "idle" | "starting" | "running" | "backoff" | "stopped";

export interface SupervisorStatus {
  enabled: boolean;
  state: SupervisorPhase;
  child_alive: boolean;
  child_pid: number | null;
  child_uptime_seconds: number | null;
  restarts: number;
  consecutive_failures: number;
  last_exit_code: number | null;
  last_exit_signal: string | null;
  last_exit_at: string | null;
  next_restart_in_seconds: number | null;
  heartbeat_at: string | null;
  heartbeat_age_seconds: number | null;
  spawn_command: string | null;
}

let phase: SupervisorPhase = "idle";
let child: ChildProcess | null = null;
let childStartedAt: number | null = null;
let consecutiveFailures = 0;
let restarts = 0;
let lastExitCode: number | null = null;
let lastExitSignal: string | null = null;
let lastExitAt: number | null = null;
let nextRestartAt: number | null = null;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let lastHeartbeatAt: number | null = null;
let stderrTail: string[] = [];
let stopping = false;
let spawnCommand: string | null = null;
let signalsHooked = false;

function log(message: string): void {
  console.log(`[supervisor] ${message}`);
}

function logError(message: string): void {
  console.error(`[supervisor] ${message}`);
}

function describe(e: unknown): string {
  return e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e);
}

// The worker entrypoint sits next to this file, so its path and its extension
// both follow from ours: running from source means a .ts sibling and a TS
// loader, a compiled build means a .js sibling that node runs directly.
// The loader is imported rather than run through the tsx CLI on purpose: the
// CLI forks its own grandchild, which a kill on the child would orphan, leaving
// a collector alive and still holding the lease.
function childCommand(): { command: string; args: string[] } {
  const here = fileURLToPath(import.meta.url);
  const ext = extname(here);
  const entry = join(dirname(here), `index${ext}`);

  if (ext !== ".ts") return { command: process.execPath, args: [entry] };

  try {
    const requireFrom = createRequire(import.meta.url);
    const loader = pathToFileURL(requireFrom.resolve("tsx")).href;
    return { command: process.execPath, args: ["--import", loader, entry] };
  } catch {
    // No resolvable tsx next to us. npx finds the one the API itself is running
    // under, at the cost of a slower start and a wrapper process, which the
    // process-group kill in stopChild still reaches.
    return { command: "npx", args: ["tsx", entry] };
  }
}

function forward(stream: NodeJS.ReadableStream | null, sink: "out" | "err"): void {
  if (!stream) return;
  let buffered = "";
  stream.setEncoding?.("utf8");
  stream.on("data", (chunk: string) => {
    try {
      buffered += chunk;
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (sink === "err") {
          // Blank lines would pad the tail out and push the real error off it.
          if (line.trim()) {
            stderrTail.push(line);
            if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
          }
          console.error(`[collectors] ${line}`);
        } else {
          console.log(`[collectors] ${line}`);
        }
      }
    } catch (e) {
      logError(`forwarding child output failed: ${describe(e)}`);
    }
  });
  stream.on("error", (e: unknown) => logError(`child stream error: ${describe(e)}`));
}

// Signals the child's whole process group when it has one, so a wrapper cannot
// shield the real collector. Falls back to the pid alone if the group is gone,
// which happens when the child exits between the check and the kill.
function signalChild(proc: ChildProcess, signal: NodeJS.Signals): void {
  const pid = proc.pid;
  if (!pid) return;
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    /* no process group, fall through to the pid */
  }
  try {
    proc.kill(signal);
  } catch (e) {
    logError(`${signal} to the collector child failed: ${describe(e)}`);
  }
}

function backoffSeconds(): number {
  // A lease-unavailable exit is not a fault, it is another process legitimately
  // collecting. Retrying at the floor would respawn every couple of seconds
  // against a healthy holder, so it goes straight to the ceiling.
  if (lastExitCode === LEASE_UNAVAILABLE_EXIT_CODE) return RESTART_MAX_SECONDS;
  const raw = RESTART_BASE_SECONDS * 2 ** Math.max(0, consecutiveFailures - 1);
  return Math.min(RESTART_MAX_SECONDS, raw);
}

function scheduleRestart(): void {
  if (stopping) {
    phase = "stopped";
    return;
  }
  const delay = backoffSeconds();
  phase = "backoff";
  nextRestartAt = Date.now() + delay * 1000;
  log(`restarting the collector child in ${delay}s (failure ${consecutiveFailures})`);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    nextRestartAt = null;
    // Nothing inside spawnChild is allowed to escape: an exception here would
    // end the supervision chain and leave collection dead until a redeploy.
    try {
      spawnChild();
    } catch (e) {
      logError(`spawning the collector child failed: ${describe(e)}`);
      consecutiveFailures += 1;
      scheduleRestart();
    }
  }, delay * 1000);
  restartTimer.unref?.();
}

function onChildGone(code: number | null, signal: NodeJS.Signals | null): void {
  const uptime = childStartedAt ? Math.round((Date.now() - childStartedAt) / 1000) : 0;
  child = null;
  childStartedAt = null;
  lastExitCode = code;
  lastExitSignal = signal ?? null;
  lastExitAt = Date.now();

  if (uptime >= HEALTHY_UPTIME_SECONDS) consecutiveFailures = 0;
  consecutiveFailures += 1;

  const tail = stderrTail.length ? `\n  ${stderrTail.join("\n  ")}` : " (no stderr captured)";
  logError(
    `collector child exited code=${code ?? "null"} signal=${signal ?? "null"} after ${uptime}s. Last stderr:${tail}`,
  );

  if (stopping) {
    phase = "stopped";
    log("stop was requested, not restarting the collector child");
    return;
  }
  scheduleRestart();
}

function spawnChild(): void {
  if (stopping || child) return;

  const { command, args } = childCommand();
  spawnCommand = [command, ...args].join(" ");
  phase = "starting";
  stderrTail = [];

  const proc = spawn(command, args, {
    // Inherits DATABASE_URL and every provider key. COLLECTOR_RUNTIME makes the
    // child write the in-api heartbeat id, so the API's takeover watcher still
    // only ever sees a real standalone workers container.
    env: { ...process.env, COLLECTOR_RUNTIME: "in-api", WORKERS_IN_API: "false" },
    stdio: ["ignore", "pipe", "pipe"],
    // Its own process group, so a stop reaches any wrapper the command needs
    // instead of leaving a grandchild alive still holding the collector lease.
    detached: true,
  });

  child = proc;
  childStartedAt = Date.now();
  restarts += 1;
  forward(proc.stdout, "out");
  forward(proc.stderr, "err");
  log(`collector child started pid=${proc.pid} via ${spawnCommand}`);
  phase = "running";

  let settled = false;
  const settle = (code: number | null, signal: NodeJS.Signals | null) => {
    if (settled) return;
    settled = true;
    try {
      onChildGone(code, signal);
    } catch (e) {
      logError(`handling the child exit failed: ${describe(e)}`);
      consecutiveFailures += 1;
      try {
        scheduleRestart();
      } catch (inner) {
        logError(`rescheduling after a failed exit handler failed: ${describe(inner)}`);
      }
    }
  };

  proc.on("error", (e) => {
    logError(`collector child could not be spawned: ${describe(e)}`);
    settle(null, null);
  });
  proc.on("exit", (code, signal) => settle(code, signal));
}

// The supervisor's own liveness mark. A wedged event loop stops refreshing it,
// so an ageing heartbeat on GET /api/sources means the supervisor itself is the
// problem, not the collectors.
function startHeartbeat(): void {
  lastHeartbeatAt = Date.now();
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    lastHeartbeatAt = Date.now();
  }, SUPERVISOR_HEARTBEAT_SECONDS * 1000);
  heartbeatTimer.unref?.();
}

// Docker signals PID 1 only, so without this the collector child outlives a
// stopped API container and keeps holding the collector lease.
function hookShutdownSignals(): void {
  if (signalsHooked) return;
  signalsHooked = true;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      try {
        log(`${signal} received, stopping the collector child`);
        stopCollectorSupervisor();
      } catch (e) {
        logError(`shutdown failed: ${describe(e)}`);
      } finally {
        setTimeout(() => process.exit(0), STOP_GRACE_SECONDS * 1000).unref?.();
      }
    });
  }
}

export function startCollectorSupervisor(): void {
  if (child || phase === "starting" || phase === "backoff") return;
  stopping = false;
  consecutiveFailures = 0;
  startHeartbeat();
  hookShutdownSignals();
  try {
    spawnChild();
  } catch (e) {
    logError(`spawning the collector child failed: ${describe(e)}`);
    consecutiveFailures += 1;
    scheduleRestart();
  }
}

export function stopCollectorSupervisor(): void {
  stopping = true;
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  nextRestartAt = null;
  const proc = child;
  if (!proc) {
    phase = "stopped";
    return;
  }
  signalChild(proc, "SIGTERM");
  const kill = setTimeout(() => {
    try {
      if (child === proc && proc.exitCode === null && proc.signalCode === null) {
        logError(`collector child ignored SIGTERM for ${STOP_GRACE_SECONDS}s, sending SIGKILL`);
        signalChild(proc, "SIGKILL");
      }
    } catch (e) {
      logError(`SIGKILL to the collector child failed: ${describe(e)}`);
    }
  }, STOP_GRACE_SECONDS * 1000);
  kill.unref?.();
}

export function childAlive(): boolean {
  return child !== null && child.exitCode === null && child.signalCode === null;
}

// Reported by GET /api/sources. Exit codes and counters only: child stderr can
// carry feed URLs and upstream error bodies, and that endpoint is public.
export function supervisorStatus(): SupervisorStatus {
  const now = Date.now();
  return {
    enabled: phase !== "idle",
    state: phase,
    child_alive: childAlive(),
    child_pid: child?.pid ?? null,
    child_uptime_seconds: childStartedAt ? Math.round((now - childStartedAt) / 1000) : null,
    restarts,
    consecutive_failures: consecutiveFailures,
    last_exit_code: lastExitCode,
    last_exit_signal: lastExitSignal,
    last_exit_at: lastExitAt ? new Date(lastExitAt).toISOString() : null,
    next_restart_in_seconds: nextRestartAt
      ? Math.max(0, Math.round((nextRestartAt - now) / 1000))
      : null,
    heartbeat_at: lastHeartbeatAt ? new Date(lastHeartbeatAt).toISOString() : null,
    heartbeat_age_seconds: lastHeartbeatAt ? Math.round((now - lastHeartbeatAt) / 1000) : null,
    spawn_command: spawnCommand,
  };
}
