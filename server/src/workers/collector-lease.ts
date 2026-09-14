import { pool } from "../db";

// A heartbeat row can only ever be a guess about another process. This lease is
// the hard guarantee: a Postgres session advisory lock, held on a dedicated
// client for as long as collection runs. Two processes cannot hold it at once,
// and a process that dies drops its connection so the lock frees itself with no
// cleanup path to get wrong.

//TUNE: Control the (collector lease key). Advisory lock id that serialises collection across every process on one database.
const COLLECTOR_LOCK_KEY = 728104;

let held: { release: () => Promise<void> } | null = null;

export function leaseHeld(): boolean {
  return held !== null;
}

export async function acquireCollectorLease(): Promise<boolean> {
  if (held) return true;

  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [COLLECTOR_LOCK_KEY],
    );
    if (!rows[0]?.locked) {
      client.release();
      return false;
    }
  } catch (e) {
    client.release();
    throw e;
  }

  held = {
    release: async () => {
      try {
        await client.query("SELECT pg_advisory_unlock($1)", [COLLECTOR_LOCK_KEY]);
      } finally {
        client.release();
      }
    },
  };
  return true;
}

export async function releaseCollectorLease(): Promise<void> {
  if (!held) return;
  const current = held;
  held = null;
  try {
    await current.release();
  } catch (e) {
    console.error(
      "[collectors] releasing the lease failed:",
      e instanceof Error ? e.message : e,
    );
  }
}
