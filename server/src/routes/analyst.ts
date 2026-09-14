import type { Context } from "hono";
import { FORCE_MIN_AGE_MS, getCached, setCache } from "../cache";
import { logCacheHit } from "../costs";
import { getConflictConfig, readConflict, type Expert } from "../conflicts";
import { searchStructured } from "../agents";
import { readForceRefresh, readJsonBody } from "../request";
import { catalogue, EDITORIAL_MODEL, toCandidates } from "../editorial";
import { fetchItems } from "../serving";

const CACHE_KEY_BASE = "analyst-curated";
const PANEL = "analyst";

// Named so the cache layer never pins an empty answer over a filling database.
const LIST_FIELD = "comments";

//TUNE: Control the (analyst grounding pool). Stored reports shown to the model as the current reporting picture.
const GROUNDING_LIMIT = 40;

//TUNE: Control the (analyst grounding window). Hours of stored coverage the commentary is grounded in.
const GROUNDING_WINDOW_HOURS = 14 * 24;

//TUNE: Control the (analyst cache ttl). How long a served page stays reusable before it is recomputed.
const CACHE_TTL_MS = 10 * 60 * 1000;

// Rule 4. The roster is Hessa's, it lives in conflicts.ts as ConflictConfig
// experts, and this panel reads it. Nothing here adds a name to it.
//
// The panel is curated commentary from that roster, grounded in the reporting
// the store actually holds. It is NOT a feed of who published what: there is no
// fallback to an outlet name and no fallback to a channel handle, because an
// attribution that is not a roster person is not an attribution this panel can
// defend. An off-roster name is dropped, never relabelled, and an empty roster
// or a model that finds nothing real yields an empty panel, which is correct.
export interface AnalystComment {
  analyst: string;
  affiliation: string;
  comment: string;
  topic: string;
  timestamp: string;
  url?: string;
}

function normName(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Whether an attribution names a roster person.
//
// The original matcher compared normalised names with a raw substring test in
// both directions, and that is a hole rather than a convenience: measured
// against this corpus the outlet abbreviation "AI" (from the stored feed label
// "AI News & Artificial Intelligence") satisfied "esmail baghaei".includes("ai")
// and was RELABELLED as Esmail Baghaei of the Iranian Foreign Ministry. Rule 4
// says an off-roster name is dropped, never relabelled, so a test that can
// promote an outlet into a named official cannot be the test.
//
// Whole tokens, and the surname must be one of them. That still accepts the
// shortenings a model really returns (a surname alone, a name with a dropped
// middle name) and rejects a fragment that merely occurs inside a real name.
function namesSamePerson(candidate: string, rosterName: string): boolean {
  const cand = candidate.split(" ").filter(Boolean);
  const person = rosterName.split(" ").filter(Boolean);
  if (cand.length === 0 || person.length === 0) return false;

  const surname = person[person.length - 1];
  if (!cand.includes(surname)) return false;

  const candSet = new Set(cand);
  const personSet = new Set(person);
  const candInPerson = cand.every((t) => personSet.has(t));
  const personInCand = person.every((t) => candSet.has(t));
  return candInPerson || personInCand;
}

function rosterSection(experts: Expert[], kind: Expert["kind"], heading: string): string {
  const rows = experts
    .filter((e) => e.kind === kind)
    .map((e) => `- ${e.name} (${e.title})`)
    .join("\n");
  return `${heading}:\n${rows}`;
}

// Parsed once per comparison candidate so an unparseable or missing timestamp
// scores below every real one instead of throwing the comparison off.
function timestampMs(cmt: AnalystComment): number {
  const t = Date.parse(String(cmt?.timestamp ?? ""));
  return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
}

// Which of two comments by the SAME roster person the panel keeps. Both rules
// are stated here rather than left to the model's output order or to the order
// the array happened to arrive in, so two runs over the same answer pick the
// same comment.
//
// Length first: the panel is curated commentary, and the longer of two real
// statements is the more substantive one. Recency only breaks a tie, because a
// one-line newer remark is not an improvement on a fuller older one.
function moreSubstantive(candidate: AnalystComment, incumbent: AnalystComment): boolean {
  const candLen = String(candidate?.comment ?? "").length;
  const heldLen = String(incumbent?.comment ?? "").length;
  if (candLen !== heldLen) return candLen > heldLen;
  return timestampMs(candidate) > timestampMs(incumbent);
}

// The roster gate. A comment survives only when its attribution resolves to a
// roster person, and the displayed name and affiliation are then taken from the
// roster rather than from the model's answer, so the panel cannot show a name
// or a title Hessa did not supply.
//
// One entry per person. The model returns several statements by the same
// official under several spellings of their name, and the panel was showing
// every one of them: measured on this corpus, Putin appeared three times on the
// ukraine-russia tab and Lai Ching-te twice on china-taiwan. Dedupe is keyed on
// the RESOLVED roster name, after matching, so "Zelensky" and "Volodymyr
// Zelensky" collapse to the one entry rather than surviving as two.
//
// Exported so the acceptance check drives this exact function rather than a
// second copy of it: the proof that a channel handle is dropped has to test
// the code the route runs.
export function filterToRoster(comments: AnalystComment[], experts: Expert[]): AnalystComment[] {
  const allowed = experts.map((e) => ({ ...e, norm: normName(e.name) }));
  const byPerson = new Map<string, AnalystComment>();

  for (const cmt of comments) {
    const n = normName(String(cmt?.analyst ?? ""));
    if (!n) continue;
    const match = allowed.find((a) => namesSamePerson(n, a.norm));
    if (!match) {
      console.log(`analyst-curated: dropping off-roster commentator "${cmt.analyst}"`);
      continue;
    }

    const resolved = { ...cmt, analyst: match.name, affiliation: match.title };
    const incumbent = byPerson.get(match.name);
    if (!incumbent) {
      byPerson.set(match.name, resolved);
      continue;
    }
    const winner = moreSubstantive(resolved, incumbent) ? resolved : incumbent;
    console.log(
      `analyst-curated: collapsing a second comment for "${match.name}", keeping the ${String(winner.comment ?? "").length}-char one over the ${String((winner === resolved ? incumbent : resolved).comment ?? "").length}-char one`,
    );
    byPerson.set(match.name, winner);
  }

  return Array.from(byPerson.values());
}

export async function analystRoute(c: Context) {
  const body = await readJsonBody(c);
  const forceRefresh = readForceRefresh(c, body);
  const config = getConflictConfig(readConflict(body));
  const CACHE_KEY = `${CACHE_KEY_BASE}:${config.key}`;

  const cached = await getCached(
    CACHE_KEY,
    forceRefresh ? FORCE_MIN_AGE_MS : CACHE_TTL_MS,
    LIST_FIELD,
  );
  if (cached) {
    logCacheHit(PANEL, "openrouter");
    return c.json(cached);
  }

  // An empty roster is a real configuration and its answer is an empty panel.
  // Asking the model first would spend a call to discard everything it returns.
  if (config.experts.length === 0) {
    console.log(`analyst-curated(${config.key}): roster is empty, returning no commentary`);
    return c.json({ comments: [], roster_size: 0, model_used: EDITORIAL_MODEL });
  }

  const roster = `${rosterSection(config.experts, "official", "OFFICIALS")}\n\n${rosterSection(
    config.experts,
    "analyst",
    "EXPERT ANALYSTS",
  )}`;

  // Query-time grounding. The stored reports are the current reporting picture
  // this conflict's commentary has to sit against, so the model is shown what
  // the store holds instead of searching in a vacuum. They are news-outlet rows
  // on the dashboard audience, so the grounding itself carries no Telegram or
  // informational content.
  const grounding = await fetchItems({
    conflict: config.key,
    sourceTypes: ["news_outlet"],
    limit: GROUNDING_LIMIT,
    requireText: true,
    sinceHours: GROUNDING_WINDOW_HOURS,
  });

  const groundingSection =
    grounding.length > 0
      ? `\n\nCURRENT REPORTING IN THE STORE. Use this as the situation the commentary must address. Do NOT attribute any of these reports to a person: they are context, and the outlets below are not commentators.\n\n${catalogue(
          toCandidates(grounding),
        )}`
      : "";

  const parsed = await searchStructured<{ comments?: AnalystComment[] }>(
    PANEL,
    `You are a geopolitical research assistant focused on the ${config.label} conflict in ${config.region}. You report ONLY real, recent public statements from a fixed list of approved officials and analysts. Return ONLY valid JSON with no markdown.`,
    `Find the most recent public statements and analysis about the ${config.label} conflict (key topics: ${config.searchTerms}) from the people below.

${roster}

STRICT RULES:
- ONLY include people from the list above. Do not include anyone else, no matter how relevant their commentary seems.
- Only include a person if you find a real, recent statement or analysis from them - prefer the past 2 weeks, at most 1 month old.
- NEVER invent, embellish, or fabricate quotes. If you cannot find a real statement from someone, leave them out.
- Use the person's affiliation EXACTLY as given in the list above.
- Return each person's name EXACTLY as it is written in the list above.
- NEVER return an outlet, a publication, a newsroom or a Telegram channel in the "analyst" field. That field is a person's name from the list above and nothing else.

Return JSON: {"comments":[{"analyst":"name exactly as listed","affiliation":"affiliation exactly as listed","comment":"their key quote or analysis, 2-3 sentences","topic":"brief topic","timestamp":"ISO 8601 UTC timestamp e.g. 2026-04-28T14:30:00Z","url":"source url if available"}]}. The timestamp MUST be a valid ISO 8601 UTC timestamp. Do not use relative timestamps. Include as many people from the list as you can find real recent statements for.${groundingSection}`,
    { comments: [] },
  ).catch((e) => {
    console.error("OpenRouter error (analyst):", e instanceof Error ? e.message : e);
    return { comments: [] };
  });

  const returned = Array.isArray(parsed?.comments) ? parsed.comments : [];
  const comments = filterToRoster(returned, config.experts);

  console.log(
    `analyst-curated(${config.key}): ${returned.length} returned, ${comments.length} on roster after one-per-person dedupe, ${grounding.length} stored reports grounding the call`,
  );

  const result = {
    comments,
    roster_size: config.experts.length,
    grounded_in: grounding.length,
    model_used: EDITORIAL_MODEL,
  };
  await setCache(CACHE_KEY, result, LIST_FIELD);
  return c.json(result);
}
