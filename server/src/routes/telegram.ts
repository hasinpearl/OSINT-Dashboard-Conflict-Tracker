import type { Context } from "hono";
import { FORCE_MIN_AGE_MS, getCached, setCache } from "../cache";
import { logCacheHit } from "../costs";
import { getConflictConfig, readConflict } from "../conflicts";
import { readForceRefresh, readJsonBody } from "../request";
import { AppError } from "../errors";
import { shapeTelegramPosts, toCandidates } from "../editorial";
import { countItems, fetchItems, isoOrNull, telegramMessageId } from "../serving";

const CACHE_KEY_BASE = "telegram-feed";
const PANEL = "telegram";

// Hessa's curated channel roster. It is the panel's legend and the collector's
// default channel set, so the list the dashboard labels and the list the
// backend ingests cannot drift apart.
//
// Order is Hessa's and is not sorted here. The frontend renders its chips in
// this order, so re-sorting would silently reorder her legend.
//
// Two of the original eleven are gone because they cannot be collected:
// middleeasteye and iranintl both serve the plain contact page on t.me/s/,
// which parses to zero .tgme_widget_message elements, so the preview collector
// can never read a post from either. They are replaced rather than dropped:
// aljazeeraenglish covers the same beat as Middle East Eye, and iranintl_en is
// Iran International's own English channel, the same organisation with a
// readable preview. Verified live: 20 and 20 messages respectively.
//
// The seven added after those already held stored rows while sitting off the
// roster, which meant real data behind no legend chip. They are official
// sources now, so they are on the list.
//
// Exported for the collector (workers/telegramPreview.ts) and for the panel
// response, which reports the roster so the legend can render a channel that
// is quiet right now instead of dropping its chip.
//TUNE: Control the (curated telegram roster). Hessa's channel list: the panel legend and the collector's default channel set.
export const CURATED_CHANNELS = [
  "aljazeeraenglish",
  "iranintl_en",
  "geopolitics_prime",
  "bricsnews",
  "megatron_ron",
  "DDGeopolitics",
  "thecradlemedia",
  "warmonitors",
  "CIG_telegram",
  "monitor_the_situation",
  "ukr_leaks_eng",
  "RocketAlert",
  "GeoPWatch",
  "rnintel",
  "intelslava",
  "OSINTdefender",
  "BellumActaNews",
  "idkunim_il",
] as const;

// Named so the cache layer never pins an empty answer over a filling database.
const LIST_FIELD = "messages";

//TUNE: Control the (telegram panel size). Messages returned per panel load.
const MAX_MESSAGES = 40;

//TUNE: Control the (telegram candidate pool). Stored posts offered to the editorial pass.
const CANDIDATE_LIMIT = 80;

//TUNE: Control the (telegram window). Hours of stored posts the feed is built from.
const WINDOW_HOURS = 48;

//TUNE: Control the (telegram cache ttl). How long a served page stays reusable before it is recomputed.
const CACHE_TTL_MS = 2 * 60 * 1000;

interface TelegramMessage {
  item_id: string;
  channel: string;
  text: string;
  timestamp: string | null;
  message_id: number;
  url?: string;
  conflicts: string[];
}

// Newest first by the post's own time, id descending as the tiebreak. Read off
// the stored row, so a refresh updates the list rather than reshuffling it.
function newestFirst(a: TelegramMessage, b: TelegramMessage): number {
  const at = a.timestamp ?? "";
  const bt = b.timestamp ?? "";
  if (at !== bt) {
    if (!at) return 1;
    if (!bt) return -1;
    return bt.localeCompare(at);
  }
  return Number(b.item_id) - Number(a.item_id);
}

export async function telegramRoute(c: Context) {
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
    logCacheHit(PANEL, "database");
    return c.json(cached);
  }

  try {
    // Candidates are the stored posts the MTProto and preview collectors have
    // already written, which is what makes this panel near-live: a post is
    // servable as soon as a collector round lands it. The original panel
    // Firecrawl-scraped t.me/s/<channel> at request time, which was slow and
    // empty whenever a scrape failed. That path is deliberately not restored.
    const rows = await fetchItems({
      conflict: config.key,
      sourceTypes: ["telegram_channel"],
      limit: CANDIDATE_LIMIT,
      requireText: true,
      sinceHours: WINDOW_HOURS,
    });

    // The panel says how many messages match the tab in the whole store, not
    // just how many fit on a page. A feed showing 40 of 383 and a feed holding
    // exactly 40 are different situations and the panel has to be able to tell
    // the reader which one it is in. The count is on the same audience as the
    // page, so it counts what the panel could show, not what the store holds.
    const matching = await countItems({
      conflict: config.key,
      sourceTypes: ["telegram_channel"],
      requireText: true,
    });

    if (rows.length === 0) {
      return c.json({
        messages: [],
        matching_in_store: matching,
        returned: 0,
        candidates_considered: 0,
        // Carried on the empty path too: an empty tab still has a roster, and
        // dropping it here would blank the legend exactly when the reader most
        // needs to see which channels were meant to be feeding it.
        channels: CURATED_CHANNELS,
      });
    }

    // The restored model pass. Its conflict filter is the part that mattered in
    // the original: posts about another theatre or about nothing relevant are
    // excluded rather than rendered, and the post text comes back as plain
    // sentences with the emoji, flags, severity dots, subscribe lines and
    // Admin Note annotations stripped. Serving raw content is exactly the
    // regression this repairs.
    const shaping = await shapeTelegramPosts(
      PANEL,
      config.label,
      config.key,
      config.searchTerms,
      toCandidates(rows),
      MAX_MESSAGES,
    );

    if (shaping.rejectedIds.length > 0) {
      console.warn(
        `telegram-feed(${config.key}): dropped ${shaping.rejectedIds.length} ids not present in the candidate set: ${shaping.rejectedIds.slice(0, 8).join(", ")}`,
      );
    }

    const messages: TelegramMessage[] = shaping.entries
      .map(({ candidate, headline }) => ({
        item_id: candidate.row.id,
        // Channel, message id, timestamp and url are read off the stored row.
        // The original parsed all four out of scraped markdown, which is how an
        // invented timestamp reached the store in the first place.
        channel: candidate.row.source_uid ?? candidate.row.source,
        text: headline,
        timestamp: isoOrNull(candidate.row.published_at),
        message_id: telegramMessageId(candidate.row),
        url: candidate.row.url ?? undefined,
        // The row's own stored assignment, so what a tab returns can be checked
        // against what the database holds without a second query.
        conflicts: candidate.row.conflicts,
      }))
      .sort(newestFirst)
      .slice(0, MAX_MESSAGES);

    console.log(
      `telegram-feed(${config.key}): ${rows.length} candidates, ${shaping.returned} kept by ${shaping.modelUsed}, ${messages.length} shown, ${matching} match the tab in store`,
    );

    const result = {
      messages,
      matching_in_store: matching,
      returned: messages.length,
      candidates_considered: rows.length,
      shaped_by: shaping.modelUsed,
      // The curated roster, so the panel's legend is Hessa's list rather than
      // whatever this page of messages happens to contain. A channel that is
      // quiet in this window keeps its chip instead of vanishing from the
      // legend, which is how the list came to look shorter than it is.
      channels: CURATED_CHANNELS,
    };
    await setCache(CACHE_KEY, result, LIST_FIELD);
    return c.json(result);
  } catch (e) {
    console.error("telegram-feed read failed:", e instanceof Error ? e.message : e);
    throw new AppError("internal_error", "Failed to read Telegram messages");
  }
}
