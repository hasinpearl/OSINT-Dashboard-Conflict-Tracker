// Cooperative stop flag for the collector loops. Deliberately dependency free:
// every loop imports it, so anything heavier here would make those imports
// circular.

let stopRequested = false;

export function requestCollectorStop(): void {
  stopRequested = true;
}

export function clearCollectorStop(): void {
  stopRequested = false;
}

export function collectorsShouldStop(): boolean {
  return stopRequested;
}

//TUNE: Control the (stop responsiveness). Seconds a sleeping loop waits before re-reading the stop flag.
const STOP_CHECK_SECONDS = 1;

// A loop asleep for its whole poll interval would keep collecting for minutes
// after a stand-down, so sleeps are chunked and the flag is read between chunks.
export async function sleepUnlessStopped(seconds: number): Promise<void> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline && !stopRequested) {
    const left = Math.min(STOP_CHECK_SECONDS * 1000, deadline - Date.now());
    await new Promise((r) => setTimeout(r, left));
  }
}
