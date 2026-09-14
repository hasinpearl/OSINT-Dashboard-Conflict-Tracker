// The panel response marker the API sets when the requested conflict is
// currently switched off. The name matches DISABLED_MARKER in
// server/src/conflictGate.ts, which is the only thing that writes it.
//
// A disabled panel is not an empty one. Without this the panels showed "NO
// MESSAGES IN STORE", which reads as a collection failure and sends the reader
// hunting a bug in the collector, when the real cause is a switch Hessa threw.
export const DISABLED_MARKER = "conflict_disabled" as const;

export interface MaybeDisabled {
  conflict_disabled?: boolean;
}

export function isConflictDisabled(data: unknown): boolean {
  return Boolean((data as MaybeDisabled | undefined | null)?.conflict_disabled);
}
