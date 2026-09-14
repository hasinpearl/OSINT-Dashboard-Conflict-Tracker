import type { Context } from "hono";
import { FORCE_MIN_AGE_MS, getCached, setCache } from "../cache";
import { logCacheHit } from "../costs";
import { getConflictConfig, readConflict } from "../conflicts";
import { envKey } from "../env";
import { readForceRefresh, readJsonBody } from "../request";
import { AppError } from "../errors";
import { searchStructured } from "../agents";
import { collectionAgeMs, markCollected, storeItems } from "../timeline";
import {
  deriveSummary,
  deriveTitle,
  fetchItems,
  isoOrNull,
  legacyConfidence,
  outletName,
} from "../serving";

const CACHE_KEY_BASE = "osint";
const PANEL = "osint";

// Named so the cache layer never pins an empty answer over a filling database.
const LIST_FIELD = "items";

//TUNE: Control the (osint panel size). Items returned per panel load.
const MAX_ITEMS = 12;

//TUNE: Control the (osint cache ttl). How long a served page stays reusable before the DB is read again.
const CACHE_TTL_MS = 60 * 60 * 1000;

//TUNE: Control the (osint collection ttl). How long a live search pass stays fresh before re-collecting.
const COLLECT_TTL_MS = 60 * 60 * 1000;

//TUNE: Control the (osint force collect floor). Min age a force refresh will accept before re-searching.
const FORCE_MIN_COLLECT_AGE_MS = 5 * 60 * 1000;

//TUNE: Control the (osint window). Hours of collected intelligence the panel serves.
const WINDOW_HOURS = 14 * 24;

// The vetted OSINT domains. This is the original ALLOWED_HOSTS allowlist, and
// it is now enforced on what gets STORED rather than expressed as a preference
// the model could ignore: an item whose URL is not on one of these hosts is
// never written, so the panel cannot be fed by an unvetted domain.
//TUNE: Control the (osint domain allowlist). Hosts an OSINT item's source URL must be on to be stored.
const ALLOWED_HOSTS = ["bellingcat.com", "janes.com", "twitter.com", "x.com"];

interface RawOsintItem {
  title?: string;
  summary?: string;
  source?: string;
  confidence?: string;
  url?: string;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function onAllowlist(url: unknown): url is string {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url.trim())) return false;
  const host = hostOf(url.trim());
  return ALLOWED_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

// This panel keeps a LIVE search on purpose, unlike news and telegram. Those
// two serve Hessa's own continuously ingested feeds, so Postgres is already the
// fresh path and a request-time scrape would only make them slower. This panel
// is open-source intelligence from outside those feeds: there is no collector
// writing Bellingcat or Janes, so the search IS the collector. It runs at most
// once per COLLECT_TTL_MS and its results are stored, so a page load serves
// from Postgres like every other panel.
async function collectOsint(conflictKey: string, label: string, region: string, terms: string) {
  const parsed = await searchStructured<{ items?: RawOsintItem[] }>(
    PANEL,
    `You are an OSINT analyst covering the ${label} conflict in ${region}. Return ONLY valid JSON with no markdown.`,
    `Find the top ${MAX_ITEMS} verified OSINT intelligence items about ${label} from open sources. STRONGLY PREFER these domains: ${ALLOWED_HOSTS.join(
      ", ",
    )} (Bellingcat, Janes Defence, OSINT analysts on X/Twitter). Include the most recent items available. Each item MUST have a valid source URL. Do NOT return a message saying no data is available - always return your best findings even if they are older. Focus on military and security activities in ${region} relevant to the ${label} conflict (key topics: ${terms}). Return ONLY JSON: {"items":[{"title":"...","summary":"2 sentences","source":"source name","confidence":"verified|unverified|developing","url":"https://..."}]}. Do not include a timestamp field. Every item MUST include a valid, clickable source URL from the original report. If you cannot provide a verified source URL for an item, do not include that item.`,
    { items: [] },
  ).catch((e) => {
    console.error("osint: search agent failed:", e instanceof Error ? e.message : e);
    return { items: [] };
  });

  const returned = Array.isArray(parsed.items) ? parsed.items : [];
  const vetted = returned.filter((it) => onAllowlist(it?.url));
  const rejected = returned.length - vetted.length;

  if (vetted.length > 0) {
    // Stored with source 'osint', which sourceTypes.ts maps to the
    // osint_account type, so these rows can only ever surface in this panel.
    //
    // No publishedAt is supplied: the model is not asked for a timestamp and
    // would not be believed if it gave one, so published_at stays null and
    // ingested_at is the row's only real time. The panel reports that honestly
    // rather than inventing a publication time.
    const stored = await storeItems(
      vetted.map((it) => ({
        source: "osint",
        externalId: String(it.url).trim(),
        conflict: conflictKey,
        panel: PANEL,
        title: it.title ? String(it.title) : undefined,
        url: String(it.url).trim(),
        content: String(it.summary ?? ""),
        confidence: it.confidence ? String(it.confidence) : "developing",
        raw: { collected_by: "osint-search", claimed_source: it.source ?? null },
      })),
    );
    console.log(
      `osint(${conflictKey}): ${returned.length} returned, ${rejected} rejected as off-allowlist, ${stored} newly stored`,
    );
  } else {
    console.log(
      `osint(${conflictKey}): ${returned.length} returned, ${rejected} rejected as off-allowlist, storage unchanged`,
    );
  }

  await markCollected(PANEL, conflictKey);
}

export async function osintRoute(c: Context) {
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

  try {
    // Collect only when the last pass has aged out, so a page load is not a
    // paid search. A missing gateway key is not an error here: the panel still
    // serves whatever earlier passes stored.
    const age = await collectionAgeMs(PANEL, config.key);
    const threshold = forceRefresh ? FORCE_MIN_COLLECT_AGE_MS : COLLECT_TTL_MS;
    const gatewayConfigured = envKey("AI_GATEWAY_KEY").length > 0;

    if (age >= threshold && gatewayConfigured) {
      await collectOsint(config.key, config.label, config.region, config.searchTerms);
    }

    // Rule 1: OSINT ACCOUNTS only, and no widening fallback to news or
    // telegram when the panel is empty. The widening fallback is exactly how
    // news rows came to fill an OSINT panel.
    const rows = await fetchItems({
      conflict: config.key,
      sourceTypes: ["osint_account"],
      limit: MAX_ITEMS,
      requireUrl: true,
      requireText: true,
      sinceHours: WINDOW_HOURS,
      // These rows carry no publication time: the search returns a report, not
      // a dated feed entry, and inventing a date is what the whole ingest
      // rewrite existed to stop. So the window is on when the item was
      // collected. A published_at window excluded every row and served an
      // empty panel over a store that held real items.
      sinceField: "ingested",
    });

    const items = rows.map((row) => ({
      item_id: row.id,
      title: deriveTitle(row),
      summary: deriveSummary(row),
      source: outletName(row),
      confidence: legacyConfidence(row),
      // Null when the collector had no real publication time, which for a
      // search-collected item is the usual case. The panel does not invent one.
      timestamp: isoOrNull(row.published_at),
      collected_at: isoOrNull(row.ingested_at),
      url: row.url ?? undefined,
    }));

    const result = {
      items,
      returned: items.length,
      allowlist: ALLOWED_HOSTS,
      gateway_configured: gatewayConfigured,
    };
    await setCache(CACHE_KEY, result, LIST_FIELD);
    return c.json(result);
  } catch (e) {
    console.error("osint read failed:", e instanceof Error ? e.message : e);
    throw new AppError("internal_error", "Failed to read OSINT items");
  }
}
