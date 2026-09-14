import { RESOLVED_MODELS, searchStructured } from "./agents";
import {
  deriveSummary,
  deriveTitle,
  isoOrNull,
  outletName,
  stripLoneSurrogates,
  type ServingRow,
} from "./serving";

// The editorial layer. A model selects and assesses; it never supplies a fact.
//
// Every candidate row is handed to the model as a numbered catalogue keyed by
// its real items.id. The model answers with ids and with prose about
// significance or framing. Anything it returns that is not an id in the
// catalogue is dropped before the response is built, and every timestamp, url
// and outlet in that response is read back off the stored row, never off the
// model's answer. That is the whole contract: the model chooses which stored
// rows matter, the store remains the source of every fact.
//
// Routing goes through agents.ts on purpose, so the editorial calls land on the
// configured Perplexity Sonar tiers (search -> OPENROUTER_MID_MODEL, default
// perplexity/sonar-pro) rather than on a model this file picked.

//TUNE: Control the (editorial catalogue text). Characters of each candidate's summary shown to the model.
const CATALOGUE_SUMMARY_CHARS = 220;

//TUNE: Control the (editorial response budget). max_tokens for an editorial selection or assessment call.
const EDITORIAL_MAX_TOKENS = 3000;

export const EDITORIAL_MODEL = RESOLVED_MODELS.mid;

export interface Candidate {
  id: string;
  row: ServingRow;
}

export function toCandidates(rows: ServingRow[]): Candidate[] {
  return rows.map((row) => ({ id: row.id, row }));
}

function catalogueLine(c: Candidate): string {
  const published = isoOrNull(c.row.published_at) ?? "unknown";
  const title = deriveTitle(c.row) || "(no title)";
  // Code points, not UTF-16 units. Telegram posts end in emoji and a .slice by
  // length can cut a surrogate pair in half, which makes the request body
  // invalid and returns a bare 400 from the provider.
  const summary = Array.from(deriveSummary(c.row)).slice(0, CATALOGUE_SUMMARY_CHARS).join("");
  const type = c.row.event_type ?? "unclassified";
  return `id=${c.id} | outlet=${outletName(c.row)} | published=${published} | type=${type} | severity=${
    c.row.severity ?? "none"
  }\n  ${title}\n  ${summary}`;
}

export function catalogue(candidates: Candidate[]): string {
  return stripLoneSurrogates(candidates.map(catalogueLine).join("\n\n"));
}

// A model asked for ids returns them as numbers, as strings, as "id=123", and
// occasionally with stray punctuation. All of those are the same id; anything
// that does not resolve to a row in this catalogue is not.
export function resolveIds(
  raw: unknown,
  byId: Map<string, Candidate>,
): { resolved: Candidate[]; rejected: string[] } {
  const resolved: Candidate[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();

  for (const value of Array.isArray(raw) ? raw : []) {
    const text = typeof value === "number" ? String(value) : typeof value === "string" ? value : "";
    const key = text.replace(/^\s*id\s*=\s*/i, "").replace(/[^0-9]/g, "");
    if (!key) {
      if (text.trim()) rejected.push(text.trim());
      continue;
    }
    if (seen.has(key)) continue;
    const hit = byId.get(key);
    if (!hit) {
      rejected.push(key);
      continue;
    }
    seen.add(key);
    resolved.push(hit);
  }

  return { resolved, rejected };
}

export interface EditorialPick {
  id: unknown;
  significance?: unknown;
}

export interface TimelineSelection {
  entries: Array<{ candidate: Candidate; significance: string }>;
  rejectedIds: string[];
  modelUsed: string;
}

// Selection for the conflict timeline. The model is told plainly that it is
// choosing rows, not writing them, and that a padded timeline is a worse answer
// than a short one.
export async function selectTimeline(
  panel: string,
  conflictLabel: string,
  candidates: Candidate[],
  maxEntries: number,
): Promise<TimelineSelection> {
  if (candidates.length === 0) {
    return { entries: [], rejectedIds: [], modelUsed: EDITORIAL_MODEL };
  }

  const byId = new Map(candidates.map((c) => [c.id, c]));

  const system = `You are the timeline editor for the ${conflictLabel} conflict. You select which of the supplied stored reports belong on a conflict timeline. You never write a report, a date, a link or an outlet name: those are read from the store by the caller. Return ONLY valid JSON, no markdown fences.`;

  const user = `Below is every stored report that passed the kinetic-event filter for ${conflictLabel}, each with its database id.

Select ONLY the developments that materially change the situation on the ground or the strategic picture: strikes and their effects, seizure or loss of territory, force movements that change posture, attacks on strategic infrastructure, escalation or de-escalation decisions, nuclear or WMD developments, and casualty events of consequence.

Reject: routine commentary, analysis and opinion, restatements of an earlier development, procedural or ceremonial items, and anything whose removal would not change a reader's understanding of the conflict.

Rules:
- Choose at most ${maxEntries} ids.
- Each id MUST be one of the ids listed below. Never output an id that is not listed.
- If two ids report the same development, keep only the earliest one.
- If NOTHING below materially changes the situation, return an empty array. An empty timeline is the correct answer for a quiet window. Do NOT pad.
- "significance" is one short clause saying why the development matters. Do not restate the headline, and do not state a date, a link or an outlet.

Return ONLY: {"selected":[{"id":"<id from the list>","significance":"one short clause"}]}

STORED REPORTS:
${catalogue(candidates)}`;

  const parsed = await searchStructured<{ selected?: EditorialPick[] }>(
    panel,
    system,
    user,
    { selected: [] },
    { maxTokens: EDITORIAL_MAX_TOKENS },
  );

  const picks = Array.isArray(parsed.selected) ? parsed.selected : [];
  const { resolved, rejected } = resolveIds(
    picks.map((p) => p?.id),
    byId,
  );

  const significanceById = new Map<string, string>();
  for (const pick of picks) {
    const key = String(pick?.id ?? "").replace(/^\s*id\s*=\s*/i, "").replace(/[^0-9]/g, "");
    const text = typeof pick?.significance === "string" ? pick.significance.trim() : "";
    if (key && text) significanceById.set(key, text);
  }

  return {
    entries: resolved.map((candidate) => ({
      candidate,
      significance: significanceById.get(candidate.id) ?? "",
    })),
    rejectedIds: rejected,
    modelUsed: EDITORIAL_MODEL,
  };
}

export type Bloc = "left" | "center" | "right";

const BLOCS: Bloc[] = ["left", "center", "right"];

export interface BiasAssessment {
  assigned: Map<string, Bloc>;
  framing: Record<Bloc, string>;
  summary: string;
  rejectedIds: string[];
  modelUsed: string;
}

function emptyFraming(): Record<Bloc, string> {
  return { left: "", center: "", right: "" };
}

// Framing assessment for the bias panel. The model reads the stored reports and
// says which narrative each one carries and how the sides frame the same event
// differently. The counts the panel publishes are counts of these assignments
// over real stored rows, so they stay traceable; what the model contributes is
// the judgement of lean, which is exactly what counting publisher blocs could
// not do.
export async function assessBias(
  panel: string,
  conflictLabel: string,
  labels: { left: string; center: string; right: string },
  candidates: Candidate[],
  outletsPresent: string[],
): Promise<BiasAssessment> {
  if (candidates.length === 0) {
    return {
      assigned: new Map(),
      framing: emptyFraming(),
      summary: "",
      rejectedIds: [],
      modelUsed: EDITORIAL_MODEL,
    };
  }

  const byId = new Map(candidates.map((c) => [c.id, c]));

  const system = `You are a media narrative analyst assessing coverage of the ${conflictLabel} conflict. You classify the narrative each supplied report carries and describe how the sides frame the same events. You never invent an outlet, a headline or a story: you only assess the reports supplied. Return ONLY valid JSON, no markdown fences.`;

  const user = `Below are the stored reports on ${conflictLabel} in the current window, each with its database id. These outlets are the only outlets present in the window: ${outletsPresent.join(", ")}.

Classify each report by the NARRATIVE IT CARRIES, not by the outlet that published it. An outlet commonly read as one side still publishes reports that carry another side's narrative, and that distinction is the point of this panel.

- "left" = ${labels.left}: frames ${labels.left} actions as justified, defensive or necessary, or is critical of the opposing side's conduct.
- "right" = ${labels.right}: frames ${labels.right} actions as justified or defensive, is critical of ${labels.left} conduct, sanctions or military presence, or emphasises harm caused by ${labels.left}.
- "center" = ${labels.center}: presents both sides without endorsement, or is multilateral, humanitarian or procedural coverage.

Then describe, per side, HOW that side frames the events in this window. Ground every description in the reports below. Never name an outlet that is not in the list above.

Rules:
- Every id you return MUST appear in the list below.
- Classify every report you can. Omit an id only if it carries no discernible lean either way, in which case classify it as center.
- If a side has no reports carrying its narrative in this window, leave its framing string empty. Do not invent coverage to fill it.
- "summary" is 2 to 3 sentences on what dominates the narrative landscape and which way coverage leans. State plainly if one side is absent.

Return ONLY: {"assignments":[{"id":"<id from the list>","bloc":"left|center|right"}],"framing":{"left":"...","center":"...","right":"..."},"summary":"..."}

STORED REPORTS:
${catalogue(candidates)}`;

  const parsed = await searchStructured<{
    assignments?: Array<{ id?: unknown; bloc?: unknown }>;
    framing?: Partial<Record<Bloc, unknown>>;
    summary?: unknown;
  }>(panel, system, user, {}, { maxTokens: EDITORIAL_MAX_TOKENS });

  const assigned = new Map<string, Bloc>();
  const rejected: string[] = [];

  for (const entry of Array.isArray(parsed.assignments) ? parsed.assignments : []) {
    const key = String(entry?.id ?? "").replace(/^\s*id\s*=\s*/i, "").replace(/[^0-9]/g, "");
    const bloc = String(entry?.bloc ?? "").trim().toLowerCase() as Bloc;
    if (!key || !byId.has(key)) {
      if (key) rejected.push(key);
      continue;
    }
    if (!BLOCS.includes(bloc)) continue;
    assigned.set(key, bloc);
  }

  const framing = emptyFraming();
  for (const bloc of BLOCS) {
    const value = parsed.framing?.[bloc];
    if (typeof value === "string") framing[bloc] = value.trim();
  }

  return {
    assigned,
    framing,
    summary: typeof parsed.summary === "string" ? parsed.summary.trim() : "",
    rejectedIds: rejected,
    modelUsed: EDITORIAL_MODEL,
  };
}
