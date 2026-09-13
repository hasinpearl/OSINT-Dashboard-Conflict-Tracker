import type { Context } from "hono";
import { FORCE_MIN_AGE_MS, getCached, setCache } from "../cache";
import { logCacheHit } from "../costs";
import { CONFLICT_CONFIG, getConflictConfig, readConflict, type ConflictConfig } from "../conflicts";
import { readForceRefresh, readJsonBody } from "../request";
import { AppError } from "../errors";
import {
  deriveTitle,
  fetchItems,
  isoOrNull,
  publisherBloc,
  type ServingRow,
} from "../serving";

const CACHE_KEY_BASE = "bias-tracker";
const PANEL = "bias-tracker";

//TUNE: Control the (bias cache ttl). How long a computed spectrum stays reusable before the DB is read again.
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

//TUNE: Control the (bias force ttl). Min age a force refresh will accept before recomputing.
const FORCE_TTL_MS = 5 * 60 * 1000;

//TUNE: Control the (bias sample size). Rows counted per conflict when computing the spectrum.
const SAMPLE_LIMIT = 500;

//TUNE: Control the (bias window). Hours of coverage the spectrum is computed over.
const WINDOW_HOURS = 7 * 24;

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
  last_updated: string | null;
  left_label: string;
  center_label: string;
  right_label: string;
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
}

function pct(part: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((part / total) * 1000) / 10;
}

// The summary states what the counts show. It reports the measurement, it does
// not editorialise beyond it.
function describe(config: ConflictConfig, buckets: Record<string, ServingRow[]>, total: number): string {
  const windowDays = Math.round(WINDOW_HOURS / 24);
  if (total === 0) {
    return `No stored coverage of ${config.label} in the last ${windowDays} days, so there is no spectrum to report.`;
  }
  const ranked = (
    [
      ["left", config.biasLeftLabel],
      ["center", config.biasCenterLabel],
      ["right", config.biasRightLabel],
    ] as const
  )
    .map(([key, label]) => ({ label, count: buckets[key].length }))
    .sort((a, b) => b.count - a.count);

  const lead = ranked[0];
  const zero = ranked.filter((r) => r.count === 0).map((r) => r.label);
  const parts = [
    `${total} stories on ${config.label} in the last ${windowDays} days, counted by publisher bloc.`,
    `${lead.label} outlets account for the largest share at ${pct(lead.count, total)}%.`,
  ];
  if (zero.length > 0) {
    parts.push(`No coverage from ${zero.join(" or ")} outlets landed in this window.`);
  }
  return parts.join(" ");
}

// Counts real published coverage, not channel posts: the bloc of a Telegram
// channel is not an editorial line the panel can defend. An empty window
// returns a real zero reading rather than an error, so the panel can say there
// was no coverage instead of claiming it is offline.
async function analyzeOne(config: ConflictConfig): Promise<BiasData> {
  const rows = await fetchItems({
    conflict: config.key,
    source: "rss",
    limit: SAMPLE_LIMIT,
    requireText: true,
    sinceHours: WINDOW_HOURS,
  });

  const buckets: Record<string, ServingRow[]> = { left: [], center: [], right: [] };
  for (const row of rows) {
    const bloc = publisherBloc(row.source_uid);
    if (bloc === "west") buckets.left.push(row);
    else if (bloc === "rival") buckets.right.push(row);
    else buckets.center.push(row);
  }

  const total = rows.length;
  const headline = (key: string): string => {
    const row = buckets[key][0];
    return row ? deriveTitle(row) : "";
  };

  // Rows come back newest first, so the first row carries the newest real
  // published_at in the counted set.
  return {
    total_stories: total,
    left_count: buckets.left.length,
    center_count: buckets.center.length,
    right_count: buckets.right.length,
    left_pct: pct(buckets.left.length, total),
    center_pct: pct(buckets.center.length, total),
    right_pct: pct(buckets.right.length, total),
    summary: describe(config, buckets, total),
    top_left_story: headline("left"),
    top_center_story: headline("center"),
    top_right_story: headline("right"),
    last_updated: total > 0 ? isoOrNull(rows[0].published_at) : null,
    left_label: config.biasLeftLabel,
    center_label: config.biasCenterLabel,
    right_label: config.biasRightLabel,
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
      const keys = ["iran-us", "ukraine-russia", "china-taiwan"] as const;
      const results = await Promise.all(keys.map((k) => analyzeOne(CONFLICT_CONFIG[k])));

      const conflicts = keys.map((k, i) => ({
        conflict: k,
        label: CONFLICT_CONFIG[k].label,
        ...results[i],
      }));

      const newest = conflicts
        .map((x) => x.last_updated)
        .filter((t): t is string => Boolean(t))
        .sort()
        .pop() ?? null;

      const response: AllResponse = { mode: "all", conflicts, last_updated: newest };
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
