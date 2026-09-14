import type { Context, Next } from "hono";
import { isConflictEnabled, isConflictKey } from "./conflicts";

// A disabled conflict is invisible everywhere, and "everywhere" includes its
// own tab.
//
// readConflict in conflicts.ts answers a request naming a disabled conflict
// with the "all" tab. That is the right answer for the conflict LIST and for
// the aggregate feed, and it is the wrong answer for a panel asked for one
// theatre BY NAME. Measured on this tree with china-taiwan switched off, POST
// /api/telegram-feed {conflict: "china-taiwan"} returned 40 messages: 13
// carried iran-us, 27 carried ukraine-russia and none carried china-taiwan. No
// disabled row leaked, but another theatre's rows were served under the
// disabled key, which on the dashboard reads as a live China/Taiwan feed.
//
// The query layer is already correct about this: buildWhere overlaps against
// the enabled set on every dashboard read, which is why zero china-taiwan rows
// appeared. The hole is upstream of it, in the key rewrite, so by the time
// fetchItems runs the requested conflict is no longer knowable. That is why the
// refusal lives here, at the request boundary, and not in serving.ts.
//
// Applied ONCE as middleware over every panel route rather than repeated in
// each of the six, so a route cannot be added that forgets it and the enabled
// path below is reached completely untouched.

//TUNE: Control the (disabled panel marker). Response field set to true when the requested conflict is switched off. The frontend keys its disabled state on this exact name.
export const DISABLED_MARKER = "conflict_disabled";

// Which response field carries each panel's list, so a refusal has the shape
// that panel's caller already reads and an empty list is an empty list rather
// than a missing field. A path absent from this table is not a per-conflict
// panel and is passed through untouched.
const PANEL_LIST_FIELD: Record<string, string> = {
  "/api/firecrawl-news": "stories",
  "/api/analyst": "comments",
  "/api/telegram-feed": "messages",
  "/api/ai-summarize": "topics",
  "/api/bias-tracker": "conflicts",
  "/api/osint": "items",
};

export async function conflictGate(c: Context, next: Next) {
  const listField = PANEL_LIST_FIELD[c.req.path];
  if (!listField || c.req.method !== "POST") return next();

  // hono caches the request body on first read, so the route's own
  // readJsonBody call downstream gets the same body instead of an already
  // consumed stream.
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const requested = (body as Record<string, unknown>)?.conflict;

  // Only a conflict the registry KNOWS and currently has switched off is
  // refused. "all", a missing value and an unknown string all keep the meaning
  // they already have, which readConflict resolves to the "all" tab.
  if (!isConflictKey(requested) || isConflictEnabled(requested)) return next();

  console.log(
    `${c.req.path}: ${requested} is disabled, serving an empty panel rather than the all tab`,
  );

  // No fallback to "all" and no fallback to another conflict: an empty list,
  // the requested key echoed back, and the marker the UI renders its disabled
  // state from. Nothing is read from the store and nothing is cached, so a
  // toggle back on serves the stored rows again on the next request.
  return c.json({
    conflict: requested,
    [DISABLED_MARKER]: true,
    [listField]: [],
    returned: 0,
  });
}
