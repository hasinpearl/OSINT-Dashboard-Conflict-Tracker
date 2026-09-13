import type { Context } from "hono";
import { FORCE_MIN_AGE_MS, getCached, setCache } from "../cache";
import { logCacheHit } from "../costs";
import { getConflictConfig, readConflict } from "../conflicts";
import { envKey } from "../env";
import { readForceRefresh, readJsonBody } from "../request";
import { AppError } from "../errors";
import {
  deriveSummary,
  deriveTitle,
  fetchItems,
  isoOrNull,
  legacySeverity,
  outletName,
  type ServingRow,
} from "../serving";

const CACHE_KEY_BASE = "ai-summarize";
const PANEL = "hot-topics";

//TUNE: Control the (timeline size). TIMELINE_MAX_EVENTS=topics returned per response.
const MAX_EVENTS = Number(envKey("TIMELINE_MAX_EVENTS") || 40);

//TUNE: Control the (timeline candidate pool). Rows scanned before clustering down to MAX_EVENTS.
const CANDIDATE_LIMIT = 300;

//TUNE: Control the (timeline cache ttl). How long a served timeline stays reusable before the DB is read again.
const CACHE_TTL_MS = 5 * 60 * 1000;

//TUNE: Control the (topic merge threshold). Shared significant words before two reports count as one topic.
const MERGE_MIN_SHARED_WORDS = 4;

//TUNE: Control the (topic merge window). Hours apart two reports may still merge into one topic.
const MERGE_WINDOW_HOURS = 36;

const SEVERITY_RANK: Record<string, number> = {
  info: 0,
  verified: 1,
  developing: 2,
  high: 3,
  critical: 4,
};

interface Cluster {
  lead: ServingRow;
  words: Set<string>;
  sources: Set<string>;
  mentions: number;
  severity: string;
  latest: Date | null;
}

function significantWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const word of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (word.length > 3) out.add(word);
  }
  return out;
}

function sharedCount(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared;
}

function hoursApart(a: Date | null, b: Date | null): number {
  if (!a || !b) return Number.POSITIVE_INFINITY;
  return Math.abs(a.getTime() - b.getTime()) / 3_600_000;
}

// Rows arrive newest first, so the first row of a cluster is its lead and the
// cluster timestamp stays the lead's own published_at.
function cluster(rows: ServingRow[]): Cluster[] {
  const clusters: Cluster[] = [];

  for (const row of rows) {
    const title = deriveTitle(row);
    if (!title) continue;
    const words = significantWords(title);
    const severity = legacySeverity(row.severity);

    const match = clusters.find(
      (cl) =>
        hoursApart(cl.latest, row.published_at) <= MERGE_WINDOW_HOURS &&
        sharedCount(cl.words, words) >= MERGE_MIN_SHARED_WORDS,
    );

    if (match) {
      match.mentions++;
      match.sources.add(outletName(row));
      if (SEVERITY_RANK[severity] > SEVERITY_RANK[match.severity]) {
        match.severity = severity;
      }
      continue;
    }

    clusters.push({
      lead: row,
      words,
      sources: new Set([outletName(row)]),
      mentions: 1,
      severity,
      latest: row.published_at,
    });
  }

  return clusters;
}

export async function hotTopicsRoute(c: Context) {
  const body = await readJsonBody(c);
  const forceRefresh = readForceRefresh(c, body);
  const config = getConflictConfig(readConflict(body));
  const CACHE_KEY = `${CACHE_KEY_BASE}:${config.key}`;

  const cached = await getCached(CACHE_KEY, forceRefresh ? FORCE_MIN_AGE_MS : CACHE_TTL_MS);
  if (cached) {
    logCacheHit(PANEL, "database");
    return c.json(cached);
  }

  try {
    // A timeline is the significant developments, not the whole feed, so
    // off-domain and purely informational rows are left out.
    let rows = await fetchItems({
      conflict: config.key,
      limit: CANDIDATE_LIMIT,
      excludeInformational: true,
      requireText: true,
    });

    // A quiet window in a single conflict can hold nothing but informational
    // rows. Showing the plain feed beats showing an empty timeline.
    if (rows.length === 0) {
      rows = await fetchItems({
        conflict: config.key,
        limit: CANDIDATE_LIMIT,
        requireText: true,
      });
    }

    const topics = cluster(rows)
      .slice(0, MAX_EVENTS)
      .map((cl) => ({
        title: deriveTitle(cl.lead),
        summary: deriveSummary(cl.lead),
        severity: cl.severity,
        mentions: cl.mentions,
        source: Array.from(cl.sources).slice(0, 3).join(", "),
        timestamp: isoOrNull(cl.lead.published_at),
      }));

    const result = { topics };
    await setCache(CACHE_KEY, result);
    return c.json(result);
  } catch (e) {
    console.error("ai-summarize read failed:", e instanceof Error ? e.message : e);
    throw new AppError("internal_error", "Failed to read the timeline");
  }
}
