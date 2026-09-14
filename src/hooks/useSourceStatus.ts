import { useQuery } from "@tanstack/react-query";

// Worker health, read from the unauthenticated /api/sources. Every panel's
// empty state reads this to say why it is empty, and they share one query key
// so the whole dashboard costs a single request.

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";

//TUNE: Control the (source status refresh). Milliseconds between /api/sources polls behind the empty states.
const SOURCES_REFETCH_MS = 60 * 1000;
//TUNE: Control the (source status stale window). Milliseconds before cached source status is refetched.
const SOURCES_STALE_MS = 30 * 1000;

export interface SourceStatusEntry {
  id: string;
  source: string;
  label: string | null;
  ok: boolean;
  failures: number;
  last_ok: string | null;
  detail: string | null;
  updated_at: string | null;
  stale: boolean;
}

export interface SourcesResponse {
  sources: SourceStatusEntry[];
  count: number;
  healthy: number;
  failing: number;
  workers_reported: boolean;
  stale_after_seconds: number;
}

async function fetchSources(): Promise<SourcesResponse> {
  const res = await fetch(`${API_BASE}/api/sources`, { credentials: "include" });
  if (!res.ok) throw new Error(`sources request failed with status ${res.status}`);
  return (await res.json()) as SourcesResponse;
}

export function useSourceStatus() {
  return useQuery({
    queryKey: ["source-status"],
    queryFn: fetchSources,
    staleTime: SOURCES_STALE_MS,
    refetchInterval: SOURCES_REFETCH_MS,
    retry: 1,
  });
}
