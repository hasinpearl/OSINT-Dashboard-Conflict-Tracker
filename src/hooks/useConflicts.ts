import { useQuery } from "@tanstack/react-query";

// Which conflicts the API reveals, read from the unauthenticated
// /api/conflicts. The tab bar renders THIS rather than a hardcoded list, so a
// conflict Hessa disables loses its tab without a frontend redeploy, and one
// she enables gains a tab the same way.

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";

//TUNE: Control the (conflict registry refresh). Milliseconds between /api/conflicts polls, which bounds how long a stale tab bar survives a toggle.
const CONFLICTS_REFETCH_MS = 60 * 1000;
//TUNE: Control the (conflict registry stale window). Milliseconds before the cached conflict list is refetched.
const CONFLICTS_STALE_MS = 30 * 1000;

export interface ConflictEntry {
  key: string;
  label: string;
  region: string;
}

interface ConflictsResponse {
  conflicts: ConflictEntry[];
}

async function fetchConflicts(): Promise<ConflictsResponse> {
  const res = await fetch(`${API_BASE}/api/conflicts`, { credentials: "include" });
  if (!res.ok) throw new Error(`conflicts request failed with status ${res.status}`);
  return (await res.json()) as ConflictsResponse;
}

export function useConflicts() {
  return useQuery({
    queryKey: ["conflicts"],
    queryFn: fetchConflicts,
    staleTime: CONFLICTS_STALE_MS,
    refetchInterval: CONFLICTS_REFETCH_MS,
    retry: 1,
  });
}
