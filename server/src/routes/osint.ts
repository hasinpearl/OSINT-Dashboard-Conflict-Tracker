import type { Context } from "hono";
import { searchStructured } from "../agents";
import { logCacheHit } from "../costs";
import { getConflictConfig, readConflict } from "../conflicts";
import { envKey } from "../env";
import { readForceRefresh, readJsonBody } from "../request";
import { collectionAgeMs, getRecentItems, markCollected, storeItems } from "../timeline";
import { AppError } from "../errors";
import { extractArticle } from "../extractor";

const PANEL = "osint";
//TUNE: Control how long a collection pass stays fresh before re-collecting
const COLLECT_TTL_MS = 60 * 60 * 1000;
//TUNE: Control the min age a force refresh will accept before re-collecting
const FORCE_MIN_COLLECT_AGE_MS = 5 * 60 * 1000;
//TUNE: Control how many items are returned per panel load
const MAX_ITEMS = 6;

const ALLOWED_HOSTS = ["bellingcat.com", "janes.com", "twitter.com", "x.com"];

interface RawOsintItem {
  title?: string;
  summary?: string;
  source?: string;
  confidence?: string;
  timestamp?: string;
  url?: string;
}

function hasHttpUrl(u: unknown): u is string {
  return typeof u === "string" && /^https?:\/\//i.test(u.trim());
}

function toResponse(rows: any[]) {
  return {
    items: rows.map((r) => ({
      title: r.title ?? "",
      summary: r.content ?? "",
      source: r.source,
      confidence: r.confidence ?? "developing",
      timestamp: r.published_at ?? r.ingested_at,
      url: r.url ?? undefined,
    })),
  };
}

export async function osintRoute(c: Context) {
  const body = await readJsonBody(c);
  const forceRefresh = readForceRefresh(c, body);
  const config = getConflictConfig(readConflict(body));

  const stored = await getRecentItems(config.key, PANEL, MAX_ITEMS);

  const age = await collectionAgeMs(PANEL, config.key);
  const threshold = forceRefresh ? FORCE_MIN_COLLECT_AGE_MS : COLLECT_TTL_MS;
  if (age < threshold && stored.length > 0) {
    logCacheHit(PANEL, "openrouter");
    return c.json(toResponse(stored));
  }

  if (!envKey("AI_GATEWAY_KEY")) {
    if (stored.length > 0) return c.json(toResponse(stored));
    throw new AppError("gateway_not_configured");
  }

  let parsed: { items?: RawOsintItem[] };
  try {
    parsed = await searchStructured<{ items: RawOsintItem[] }>(
      PANEL,
      `You are an OSINT analyst covering the ${config.label} conflict in ${config.region}. Return ONLY valid JSON with no markdown.`,
      `Find the top ${MAX_ITEMS} verified OSINT intelligence items about ${config.label} from open sources. STRONGLY PREFER these domains: ${ALLOWED_HOSTS.join(
        ", ",
      )} (Bellingcat, Janes Defence, OSINT analysts on X/Twitter). Include the most recent items available. Each item MUST have a valid source URL. Do NOT return a message saying no data is available - always return your best findings even if they are older. Focus on military and security activities in ${config.region} relevant to the ${config.label} conflict (key topics: ${config.searchTerms}). Return ONLY JSON: {"items":[{"title":"...","summary":"2 sentences","source":"source name","confidence":"verified|unverified|developing","url":"https://..."}]}. Do not include a timestamp field. Every item MUST include a valid, clickable source URL from the original report. If you cannot provide a verified source URL for an item, do not include that item.`,
      { items: [] },
    );
  } catch (e) {
    console.error("osint: search agent failed:", e);
    return c.json(toResponse(stored));
  }

  // Map to store real timestamps from source metadata
  const timestampMap: Record<string, string | null> = {};

  const fresh = (parsed.items || []).filter((it) => hasHttpUrl(it?.url));

  // Collect real timestamps from source metadata
  const timestampPromises = fresh.map(async (it) => {
    if (it.url) {
      try {
        const article = await extractArticle(it.url);
        timestampMap[it.url] = article.publishedAt || null;
      } catch (e) {
        console.error(`Failed to extract timestamp for ${it.url}:`, e);
        timestampMap[it.url] = null;
      }
    }
  });

  await Promise.all(timestampPromises);

  if (fresh.length > 0) {
    const inserted = await storeItems(
      fresh.map((it) => ({
        source: String(it.source || "osint"),
        externalId: String(it.url).trim(),
        conflict: config.key,
        panel: PANEL,
        title: it.title ? String(it.title) : undefined,
        url: String(it.url).trim(),
        content: String(it.summary ?? ""),
        confidence: it.confidence ? String(it.confidence) : "developing",
        publishedAt: timestampMap[it.url!] || undefined,
        raw: { collected_by: "osint-search" },
      })),
    );
    console.log(`osint(${config.key}): ${fresh.length} returned, ${inserted} new stored`);
  } else {
    console.log(`osint(${config.key}): no usable items this pass, storage unchanged`);
  }

  await markCollected(PANEL, config.key);

  const refreshed = await getRecentItems(config.key, PANEL, MAX_ITEMS);
  return c.json(toResponse(refreshed.length > 0 ? refreshed : stored));
}
