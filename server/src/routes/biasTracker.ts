import type { Context } from "hono";
import { getCached, setCache } from "../cache";
import { logCacheHit } from "../costs";
import { conflictConfigFor, enabledConflictKeys, getConflictConfig, readConflict, type ConflictConfig } from "../conflicts";
import { readForceRefresh, readJsonBody } from "../request";
import { AppError } from "../errors";
import { assessBias, EDITORIAL_MODEL, toCandidates, type Bloc } from "../editorial";
import { deriveTitle, fetchItems, isoOrNull, outletName, type ServingRow } from "../serving";

const CACHE_KEY_BASE = "bias-tracker";
const PANEL = "bias-tracker";

//TUNE: Control the (bias cache ttl). How long a computed spectrum stays reusable before it is recomputed.
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

//TUNE: Control the (bias force ttl). Min age a force refresh will accept before recomputing.
const FORCE_TTL_MS = 5 * 60 * 1000;

//TUNE: Control the (bias sample size). Stored rows offered to the assessment per conflict.
const SAMPLE_LIMIT = 60;

//TUNE: Control the (bias window). Hours of coverage the spectrum is computed over.
const WINDOW_HOURS = 7 * 24;

const BLOCS: Bloc[] = ["left", "center", "right"];

interface BiasData {
  total_stories: number;
  left_count: number;
  center_count: number;
  right_count: number;
  left_pct: number;
  center_pct: number;
  right_pct: number;
  summary: string;
  top_left_story: string;
  top_center_story: string;
  top_right_story: string;
  left_framing: string;
  center_framing: string;
  right_framing: string;
  outlets_present: string[];
  outlets_by_bloc: Record<Bloc, string[]>;
  silent_blocs: string[];
  last_updated: string | null;
  left_label: string;
  center_label: string;
  right_label: string;
  assessed_by: string;
}

interface SingleResponse extends BiasData {
  mode: "single";
  conflict: string;
  label: string;
}

interface AllResponse {
  mode: "all";
  conflicts: Array<BiasData & { conflict: string; label: string }>;
  last_updated: string | null;
  assessed_by: string;
}

function pct(part: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((part / total) * 1000) / 10;
}

// Silence is a finding. A side with no coverage in the window is named, and so
// are the outlets in the corpus that did not carry that side's narrative, so
// the reader can see which desks were quiet rather than a blank bar.
function describeSilence(
  config: ConflictConfig,
  labels: Record<Bloc, string>,
  counts: Record<Bloc, number>,
  outletsByBloc: Record<Bloc, string[]>,
  outletsPresent: string[],
  total: number,
): { summarySuffix: string; silent: string[] } {
  const windowDays = Math.round(WINDOW_HOURS / 24);
  if (total === 0) {
    return {
      summarySuffix: `No stored coverage of ${config.label} in the last ${windowDays} days, so there is no spectrum to report.`,
      silent: BLOCS.map((b) => labels[b]),
    };
  }

  const silentBlocs = BLOCS.filter((b) => counts[b] === 0);
  if (silentBlocs.length === 0) return { summarySuffix: "", silent: [] };

  const carried = new Set(BLOCS.flatMap((b) => outletsByBloc[b]));
  const notCarrying = outletsPresent.filter((o) => !carried.has(o));

  const parts = silentBlocs.map(
    (b) => `No report in this window carried the ${labels[b]} narrative.`,
  );
  if (notCarrying.length > 0) {
    parts.push(
      `Present in the window but carrying none of the absent narratives: ${notCarrying.join(", ")}.`,
    );
  }
  return { summarySuffix: parts.join(" "), silent: silentBlocs.map((b) => labels[b]) };
}

// Counts published coverage, not channel posts: the bloc of a Telegram channel
// is not an editorial line the panel can defend.
//
// The counts are counts of real stored rows. What the model decides is which
// bloc each stored row's narrative belongs to, which is the judgement counting
// publisher blocs could not make: most stored outlets are Western, so bucketing
// by publisher collapsed the whole spectrum onto one side regardless of what
// the reports actually said.
async function analyzeOne(config: ConflictConfig): Promise<BiasData> {
  const labels: Record<Bloc, string> = {
    left: config.biasLeftLabel,
    center: config.biasCenterLabel,
    right: config.biasRightLabel,
  };

  const rows = await fetchItems({
    conflict: config.key,
    sourceTypes: ["news_outlet"],
    limit: SAMPLE_LIMIT,
    requireText: true,
    sinceHours: WINDOW_HOURS,
  });

  const outletsPresent = Array.from(new Set(rows.map((r) => outletName(r)))).sort();

  const empty = (): BiasData => ({
    total_stories: 0,
    left_count: 0,
    center_count: 0,
    right_count: 0,
    left_pct: 0,
    center_pct: 0,
    right_pct: 0,
    summary: describeSilence(config, labels, { left: 0, center: 0, right: 0 }, { left: [], center: [], right: [] }, [], 0)
      .summarySuffix,
    top_left_story: "",
    top_center_story: "",
    top_right_story: "",
    left_framing: "",
    center_framing: "",
    right_framing: "",
    outlets_present: [],
    outlets_by_bloc: { left: [], center: [], right: [] },
    silent_blocs: BLOCS.map((b) => labels[b]),
    last_updated: null,
    left_label: labels.left,
    center_label: labels.center,
    right_label: labels.right,
    assessed_by: EDITORIAL_MODEL,
  });

  if (rows.length === 0) return empty();

  const candidates = toCandidates(rows);
  const assessment = await assessBias(PANEL, config.label, labels, candidates, outletsPresent);

  if (assessment.rejectedIds.length > 0) {
    console.warn(
      `bias-tracker(${config.key}): dropped ${assessment.rejectedIds.length} ids not present in the sample`,
    );
  }

  const buckets: Record<Bloc, ServingRow[]> = { left: [], center: [], right: [] };
  for (const candidate of candidates) {
    const bloc = assessment.assigned.get(candidate.id);
    if (!bloc) continue;
    buckets[bloc].push(candidate.row);
  }

  const counts: Record<Bloc, number> = {
    left: buckets.left.length,
    center: buckets.center.length,
    right: buckets.right.length,
  };
  const total = counts.left + counts.center + counts.right;

  const outletsByBloc: Record<Bloc, string[]> = {
    left: Array.from(new Set(buckets.left.map(outletName))).sort(),
    center: Array.from(new Set(buckets.center.map(outletName))).sort(),
    right: Array.from(new Set(buckets.right.map(outletName))).sort(),
  };

  if (total === 0) {
    const blank = empty();
    return { ...blank, outlets_present: outletsPresent };
  }

  const { summarySuffix, silent } = describeSilence(
    config,
    labels,
    counts,
    outletsByBloc,
    outletsPresent,
    total,
  );

  const summary = [assessment.summary, summarySuffix].filter((s) => s.length > 0).join(" ");

  // Rows come back newest first, so the first row of a bucket carries that
  // bucket's newest real published_at.
  const newest = [...rows]
    .map((r) => isoOrNull(r.published_at))
    .filter((t): t is string => Boolean(t))
    .sort()
    .pop() ?? null;

  return {
    total_stories: total,
    left_count: counts.left,
    center_count: counts.center,
    right_count: counts.right,
    left_pct: pct(counts.left, total),
    center_pct: pct(counts.center, total),
    right_pct: pct(counts.right, total),
    summary,
    top_left_story: buckets.left[0] ? deriveTitle(buckets.left[0]) : "",
    top_center_story: buckets.center[0] ? deriveTitle(buckets.center[0]) : "",
    top_right_story: buckets.right[0] ? deriveTitle(buckets.right[0]) : "",
    left_framing: assessment.framing.left,
    center_framing: assessment.framing.center,
    right_framing: assessment.framing.right,
    outlets_present: outletsPresent,
    outlets_by_bloc: outletsByBloc,
    silent_blocs: silent,
    last_updated: newest,
    left_label: labels.left,
    center_label: labels.center,
    right_label: labels.right,
    assessed_by: EDITORIAL_MODEL,
  };
}

export async function biasTrackerRoute(c: Context) {
  const body = await readJsonBody(c);
  const forceRefresh = readForceRefresh(c, body);
  const config = getConflictConfig(readConflict(body));
  const CACHE_KEY = `${CACHE_KEY_BASE}:${config.key}`;

  const cached = await getCached(CACHE_KEY, forceRefresh ? FORCE_TTL_MS : CACHE_TTL_MS);
  if (cached) {
    logCacheHit(PANEL, "database");
    return c.json(cached);
  }

  try {
    if (config.key === "all") {
      // One spectrum per ENABLED conflict, read from the registry rather than
      // a hardcoded triple, so a disabled conflict gets no bar and no entry.
      const keys = enabledConflictKeys();
      const configs = keys.map(conflictConfigFor);
      const results = await Promise.all(configs.map((cfg) => analyzeOne(cfg)));

      const conflicts = configs.map((cfg, i) => ({
        conflict: cfg.key,
        label: cfg.label,
        ...results[i],
      }));

      const newest = conflicts
        .map((x) => x.last_updated)
        .filter((t): t is string => Boolean(t))
        .sort()
        .pop() ?? null;

      const response: AllResponse = {
        mode: "all",
        conflicts,
        last_updated: newest,
        assessed_by: EDITORIAL_MODEL,
      };
      await setCache(CACHE_KEY, response);
      return c.json(response);
    }

    const response: SingleResponse = {
      mode: "single",
      conflict: config.key,
      label: config.label,
      ...(await analyzeOne(config)),
    };

    await setCache(CACHE_KEY, response);
    return c.json(response);
  } catch (e) {
    if (e instanceof AppError) throw e;
    console.error("bias-tracker read failed:", e instanceof Error ? e.message : e);
    throw new AppError("internal_error", "Failed to compute the coverage spectrum");
  }
}
