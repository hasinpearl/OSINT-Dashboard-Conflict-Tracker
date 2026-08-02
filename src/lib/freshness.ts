// Per-page-load force tracker: each panel forces one refresh per
// panel×conflict per session. A hard refresh resets the module, so the
// first fetch after F5 always asks the server for fresh (≤5 min old) data.
const forced = new Set<string>();

export function shouldForceRefresh(key: string): boolean {
  if (forced.has(key)) return false;
  forced.add(key);
  return true;
}

// Used by the header REFRESH button: clearing the set makes every panel's
// next queryFn send force_refresh again.
export function resetForced(): void {
  forced.clear();
}
