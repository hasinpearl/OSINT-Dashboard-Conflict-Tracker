import { pool } from "../db";
import { envKey } from "../env";
import { sourceStatusUpdate } from "./source-status";
import { classify } from "../enrich";
import { assignConflicts } from "../conflictAssign";
import https from "https";
import http from "http";
import { JSDOM } from "jsdom";
import { collectorsShouldStop, sleepUnlessStopped } from "./collector-stop";
import { describeError, truncateForLog } from "./describe-error";
import { CURATED_CHANNELS } from "../routes/telegram";

//TUNE: Control the (telegram channels). TG_PREVIEW_CHANNELS=comma separated public channel usernames.
//
// The default IS Hessa's curated roster, imported from the panel route rather
// than restated here. Two independent lists is how the panel came to label
// eleven channels while the collector ingested a different nine: every message
// from the ingested set was then dropped by a legend chip that did not exist,
// and every chip on the legend named a channel with no data behind it. One
// exported constant makes that drift impossible.
const DEFAULT_TG_PREVIEW_CHANNELS = [...CURATED_CHANNELS];
// An empty env var must fall back to the defaults. A bare `|| default` does not:
// "".split(",") filters down to [], and [] is truthy, so the default never applies.
// docker-compose passes these as empty strings when unset, which is exactly that case.
const CONFIGURED_TG_PREVIEW_CHANNELS = envKey("TG_PREVIEW_CHANNELS")
  ?.split(",")
  .map((c) => c.trim())
  .filter((c) => c) ?? [];
const TG_PREVIEW_CHANNELS =
  CONFIGURED_TG_PREVIEW_CHANNELS.length > 0
    ? CONFIGURED_TG_PREVIEW_CHANNELS
    : DEFAULT_TG_PREVIEW_CHANNELS;
//TUNE: Control the (preview poll rate). TG_PREVIEW_POLL_SECONDS=seconds between polling rounds.
const TG_PREVIEW_POLL_SECONDS = parseInt(envKey("TG_PREVIEW_POLL_SECONDS") || "120");
//TUNE: Control the (backfill depth). TG_PREVIEW_MAX_PAGES=history pages walked per channel per run, 20 posts each.
const TG_PREVIEW_MAX_PAGES = parseInt(envKey("TG_PREVIEW_MAX_PAGES") || "10");
// Re-walking the full history every round is what made this worker issue 25
// rapid requests per channel forever. History does not change, so it is walked
// once per channel per process and later rounds read only the top pages, which
// is where new posts appear.
//TUNE: Control the (steady state depth). TG_PREVIEW_POLL_PAGES=pages read per channel on rounds after its backfill has completed.
const TG_PREVIEW_POLL_PAGES = parseInt(envKey("TG_PREVIEW_POLL_PAGES") || "1");
//TUNE: Control the (request pacing). TG_PREVIEW_DELAY_SECONDS=seconds between channel requests.
const TG_PREVIEW_DELAY_SECONDS = parseInt(envKey("TG_PREVIEW_DELAY_SECONDS") || "2");
// The 429 handling below cannot be exercised against t.me on demand, so the
// origin is overridable and a local server standing in for it proves the path.
//TUNE: Control the (preview origin). TG_PREVIEW_BASE_URL=origin serving /s/<channel>, t.me by default. Only change it to point at a mirror or a test server.
const TG_PREVIEW_BASE_URL = (envKey("TG_PREVIEW_BASE_URL") || "https://t.me").replace(/\/+$/, "");
//TUNE: Control the (redirect depth). TG_PREVIEW_MAX_REDIRECTS=hops followed before a request is abandoned.
const TG_PREVIEW_MAX_REDIRECTS = parseInt(envKey("TG_PREVIEW_MAX_REDIRECTS") || "5");
//TUNE: Control the (request timeout). TG_PREVIEW_TIMEOUT_MS=milliseconds a single page request may take before it is abandoned.
const TG_PREVIEW_TIMEOUT_MS = parseInt(envKey("TG_PREVIEW_TIMEOUT_MS") || "20000");
//TUNE: Control the (preview error backoff). Seconds the poll loop waits after an unexpected error.
const TG_PREVIEW_ERROR_BACKOFF_SECONDS = 60;

// A round that walked history pages made up to TG_PREVIEW_MAX_PAGES requests per
// channel. Going straight back into the next round from there is the pattern
// t.me throttles, so a backfilling round is followed by a longer pause than a
// steady-state one.
//TUNE: Control the (backfill cooldown). TG_PREVIEW_BACKFILL_PAUSE_SECONDS=seconds to wait after a round that walked history pages, instead of TG_PREVIEW_POLL_SECONDS.
const TG_PREVIEW_BACKFILL_PAUSE_SECONDS = parseInt(
  envKey("TG_PREVIEW_BACKFILL_PAUSE_SECONDS") || "600",
);

// Circuit breaker, identical in shape to the one in rss.ts so the two workers
// read the same way in the logs and in source_status.
//TUNE: Control the (failure threshold). Rounds a channel may fail before backoff begins.
const MAX_CONSECUTIVE_FAILURES = 3;
//TUNE: Control the (backoff growth). Each extra failure multiplies the wait by this.
const BACKOFF_MULTIPLIER = 2;
//TUNE: Control the (backoff start). Seconds to wait before the first retry of a failing channel.
const INITIAL_BACKOFF = 60;
//TUNE: Control the (circuit breaker). TG_PREVIEW_MAX_BACKOFF=most consecutive failing rounds that still grow the wait.
const TG_PREVIEW_MAX_BACKOFF = parseInt(envKey("TG_PREVIEW_MAX_BACKOFF") || "10");

// A 429 is not a broken channel, it is a channel telling us to slow down, so it
// is waited out in place instead of counting against the breaker.
//TUNE: Control the (throttle retries). TG_PREVIEW_RATE_LIMIT_RETRIES=times a throttled request is waited out and retried before the channel is failed.
const TG_PREVIEW_RATE_LIMIT_RETRIES = parseInt(envKey("TG_PREVIEW_RATE_LIMIT_RETRIES") || "3");
//TUNE: Control the (throttle wait). TG_PREVIEW_RATE_LIMIT_WAIT_SECONDS=seconds waited after a throttle with no Retry-After header, multiplied by the attempt number.
const TG_PREVIEW_RATE_LIMIT_WAIT_SECONDS = parseInt(
  envKey("TG_PREVIEW_RATE_LIMIT_WAIT_SECONDS") || "30",
);
//TUNE: Control the (throttle wait ceiling). Seconds a single Retry-After wait is capped at, however long the header asks for.
const TG_PREVIEW_RATE_LIMIT_MAX_WAIT_SECONDS = 300;
// 429 is the documented throttle. 503 from t.me behaves the same way under load,
// and Telegram's own flood-wait code leaks through as 420 on the web endpoints.
const THROTTLE_STATUSES = new Set([420, 429, 503]);

//TUNE: Control the (error body snippet). Characters of an upstream response body kept in the error text.
const ERROR_BODY_SNIPPET_CHARS = 200;

const channelFailures: Record<string, number> = {};
const channelBackoffs: Record<string, number> = {};
const channelLastOk: Record<string, number> = {};
const channelBackfilled: Record<string, boolean> = {};

function log(message: string): void {
  console.log(`[tg-preview] ${message}`);
}

function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

function clampFutureTimestamp(date: Date | null): Date | null {
  if (!date) return null;
  const now = new Date();
  return date > now ? now : date;
}

// An HTML error page is thousands of characters of layout. The first non-blank
// line is the part that names the problem ("Too Many Requests", "Not Found"),
// so that is what goes in the log.
function firstLine(body: string): string {
  const line = body
    .split(/\r?\n/)
    .map((l) => l.replace(/<[^>]*>/g, " ").trim())
    .find((l) => l.length > 0);
  return line ? truncateForLog(line, ERROR_BODY_SNIPPET_CHARS) : "";
}

class HttpStatusError extends Error {
  readonly statusCode: number;
  readonly url: string;
  readonly throttled: boolean;

  constructor(statusCode: number, url: string, body: string) {
    const snippet = firstLine(body);
    super(
      `HTTP ${statusCode} from ${url}` +
        (snippet ? `, body starts: ${snippet}` : ", empty response body"),
    );
    this.name = "HttpStatusError";
    this.statusCode = statusCode;
    this.url = url;
    this.throttled = THROTTLE_STATUSES.has(statusCode);
  }
}

interface HttpResponse {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  data: string;
  url: string;
}

// Any rejection out of here names the URL it was requesting. The bare socket
// errors Node throws do not, and a redirect chain means the failing URL is not
// necessarily the one the caller asked for.
function httpRequest(
  urlString: string,
  redirectsLeft: number = TG_PREVIEW_MAX_REDIRECTS,
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(urlString);
    } catch (e) {
      reject(new Error(`unparseable request URL ${urlString}: ${describeError(e)}`));
      return;
    }

    const lib = parsed.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: "GET",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        },
      },
      (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) {
            reject(
              new Error(
                `redirect limit of ${TG_PREVIEW_MAX_REDIRECTS} reached at ${urlString}, HTTP ${status} pointing to ${res.headers.location}`,
              ),
            );
            return;
          }
          let next: string;
          try {
            next = new URL(res.headers.location, urlString).toString();
          } catch (e) {
            reject(
              new Error(
                `HTTP ${status} from ${urlString} gave an unusable Location ${res.headers.location}: ${describeError(e)}`,
              ),
            );
            return;
          }
          resolve(httpRequest(next, redirectsLeft - 1));
          return;
        }
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (data += chunk));
        res.on("end", () => resolve({ statusCode: status, headers: res.headers, data, url: urlString }));
        res.on("error", (e) =>
          reject(new Error(`reading the response from ${urlString} failed: ${describeError(e)}`)),
        );
      },
    );

    // Without this a hung socket stalls the whole worker: there is no other
    // timeout anywhere on this path.
    req.setTimeout(TG_PREVIEW_TIMEOUT_MS, () => {
      req.destroy(
        new Error(`request to ${urlString} timed out after ${TG_PREVIEW_TIMEOUT_MS}ms`),
      );
    });
    req.on("error", (e) =>
      reject(new Error(`request to ${urlString} failed: ${describeError(e)}`)),
    );
    req.end();
  });
}

// Retry-After is either a delay in seconds or an HTTP date.
function retryAfterSeconds(headers: http.IncomingHttpHeaders): number | null {
  const raw = headers["retry-after"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;

  const asSeconds = Number(value.trim());
  if (Number.isFinite(asSeconds) && asSeconds >= 0) return asSeconds;

  const asDate = new Date(value);
  if (!Number.isFinite(asDate.getTime())) return null;
  return Math.max(0, Math.round((asDate.getTime() - Date.now()) / 1000));
}

// Resolves with the page HTML, or rejects with an error that states the status,
// the body, and the URL. A throttle is waited out here rather than surfacing as
// a channel failure.
async function fetchPage(urlString: string, channelId: string): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    const response = await httpRequest(urlString);
    if (response.statusCode === 200) return response.data;

    const error = new HttpStatusError(response.statusCode, response.url, response.data);
    if (!error.throttled || attempt > TG_PREVIEW_RATE_LIMIT_RETRIES) throw error;

    const wait = Math.min(
      retryAfterSeconds(response.headers) ?? TG_PREVIEW_RATE_LIMIT_WAIT_SECONDS * attempt,
      TG_PREVIEW_RATE_LIMIT_MAX_WAIT_SECONDS,
    );
    console.warn(
      `[tg-preview] ${channelId} throttled: ${error.message}. Waiting ${wait}s, retry ${attempt}/${TG_PREVIEW_RATE_LIMIT_RETRIES}`,
    );
    await sleepUnlessStopped(wait);
    if (collectorsShouldStop()) throw error;
  }
}

async function insertItem(item: {
  source: string;
  externalId: string;
  url: string;
  content: string;
  eventTs: Date;
  hasMedia: boolean;
  channelId: string;
  raw: any;
}): Promise<boolean> {
  try {
    const enriched = classify({
      content: item.content,
      publishedAt: item.eventTs,
    });
    const assigned = assignConflicts({
      content: item.content,
      sourceUid: item.channelId,
      source: item.source,
    });

    const result = await pool.query(
      `INSERT INTO items (
        source, 
        external_id, 
        url, 
        content, 
        published_at, 
        has_media,
        source_uid,
        raw,
        event_type,
        severity,
        is_breaking,
        lang,
        enrichment,
        conflict,
        conflicts,
        conflict_assign
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      ON CONFLICT (source, external_id) DO NOTHING
      RETURNING id`,
      [
        item.source,
        item.externalId,
        item.url,
        item.content,
        item.eventTs,
        item.hasMedia,
        item.channelId,
        item.raw,
        enriched.event_type,
        enriched.severity,
        enriched.is_breaking,
        enriched.lang,
        JSON.stringify(enriched.enrichment),
        // Derived from the array below, never set independently.
        assigned.conflict,
        assigned.conflicts,
        JSON.stringify(assigned.reason)
      ]
    );
    
    return result && result.rowCount !== null && result.rowCount > 0;
  } catch (e) {
    console.error(`[tg-preview] inserting ${item.externalId} failed: ${describeError(e)}`);
    return false;
  }
}

function extractMessagesFromHtml(html: string, channelId: string): Array<{
  messageId: number;
  eventTs: Date;
  url: string;
  content: string;
  hasMedia: boolean;
  raw: string;
}> {
  const dom = new JSDOM(html);
  const document = dom.window.document;
  const messages: Array<{
    messageId: number;
    eventTs: Date;
    url: string;
    content: string;
    hasMedia: boolean;
    raw: string;
  }> = [];
  
  const messageElements = document.querySelectorAll(".tgme_widget_message");

  messageElements.forEach((element: Element) => {
    const dataPost = element.getAttribute("data-post");
    const timeElement = element.querySelector("time.time");
    const datetime = timeElement ? timeElement.getAttribute("datetime") : null;
    
    // Skip if not a valid message element or missing timestamp
    if (!dataPost || !datetime) {
      return;
    }
    
    // Extract message ID from data-post attribute
    const postIdMatch = dataPost.match(new RegExp(`${channelId}/(\\d+)`));
    if (!postIdMatch) {
      return;
    }
    
    const messageId = parseInt(postIdMatch[1]);
    const eventTs = new Date(datetime);
    const url = `https://t.me/${dataPost}`;
    const contentElement = element.querySelector(".tgme_widget_message_text");
    const content = contentElement ? contentElement.textContent || "" : "";
    const hasMedia = element.querySelectorAll(".tgme_widget_message_photo, .tgme_widget_message_video, .tgme_widget_message_document").length > 0;
    
    messages.push({
      messageId,
      eventTs,
      url,
      content,
      hasMedia,
      raw: element.outerHTML || ""
    });
  });
  
  return messages;
}

function applyBackoff(channelId: string): void {
  if (channelFailures[channelId] < MAX_CONSECUTIVE_FAILURES) return;
  const backoffRounds = Math.min(
    channelFailures[channelId] - MAX_CONSECUTIVE_FAILURES,
    TG_PREVIEW_MAX_BACKOFF,
  );
  const backoffSeconds = INITIAL_BACKOFF * Math.pow(BACKOFF_MULTIPLIER, backoffRounds);
  channelBackoffs[channelId] = Date.now() + backoffSeconds * 1000;
  console.warn(`[tg-preview] ${channelId} backing off for ${backoffSeconds}s`);
}

// A throttled channel does not need three rounds of proof before it is left
// alone: the upstream already said so.
function applyThrottleBackoff(channelId: string): void {
  const until = Date.now() + TG_PREVIEW_RATE_LIMIT_MAX_WAIT_SECONDS * 1000;
  if ((channelBackoffs[channelId] ?? 0) < until) channelBackoffs[channelId] = until;
  console.warn(
    `[tg-preview] ${channelId} still throttled after ${TG_PREVIEW_RATE_LIMIT_RETRIES} retries, backing off for ${TG_PREVIEW_RATE_LIMIT_MAX_WAIT_SECONDS}s`,
  );
}

export interface ChannelOutcome {
  channelId: string;
  skipped: boolean;
  ok: boolean;
  backfilled: boolean;
  pages: number;
  inserted: number;
}

async function processChannel(channelId: string): Promise<ChannelOutcome> {
  let lowestMessageId = Infinity;
  let totalPages = 0;
  let totalInserted = 0;

  const backoffUntil = channelBackoffs[channelId];
  if (backoffUntil && Date.now() < backoffUntil) {
    log(`${channelId} skipped, backoff until ${new Date(backoffUntil).toISOString()}`);
    return { channelId, skipped: true, ok: false, backfilled: false, pages: 0, inserted: 0 };
  }

  // Backfill once, then read only the top of the channel. The card's 25 rapid
  // requests per channel are the first round's cost, not every round's.
  const backfilling = !channelBackfilled[channelId];
  const pageBudget = backfilling ? TG_PREVIEW_MAX_PAGES : TG_PREVIEW_POLL_PAGES;

  try {
    log(`processing channel ${channelId}, up to ${pageBudget} pages (${backfilling ? "backfill" : "poll"})`);

    while (totalPages < pageBudget) {
      if (collectorsShouldStop()) break;

      let urlString = `${TG_PREVIEW_BASE_URL}/s/${channelId}`;
      if (lowestMessageId !== Infinity) {
        urlString += `?before=${lowestMessageId}`;
      }

      const html = await fetchPage(urlString, channelId);
      const messages = extractMessagesFromHtml(html, channelId);

      // A first page that parses to nothing is a block page or a changed layout,
      // not a quiet channel, and it used to be logged as "no more messages" and
      // recorded as a success. On a later page it is just the end of history.
      if (messages.length === 0) {
        if (totalPages === 0) {
          throw new Error(
            `${urlString} returned 200 with ${html.length} chars but no .tgme_widget_message elements, page starts: ${firstLine(html)}`,
          );
        }
        log(`${channelId} history exhausted after ${totalPages} pages`);
        break;
      }

      // Check if we have new messages compared to previous page
      const newMessages = messages.filter(msg => msg.messageId < lowestMessageId);
      if (newMessages.length === 0) {
        log(`${channelId} history exhausted after ${totalPages} pages`);
        break;
      }
      
      // Update lowest message ID for next pagination
      const currentLowest = Math.min(...messages.map(m => m.messageId));
      if (currentLowest < lowestMessageId) {
        lowestMessageId = currentLowest;
      }
      
      // Process each message
      let insertedCount = 0;
      for (const message of messages) {
        const eventTs = clampFutureTimestamp(message.eventTs);
        if (!eventTs) {
          console.warn(`[tg-preview] ${channelId} skipping message ${message.messageId}, unparseable timestamp`);
          continue;
        }
        
        const inserted = await insertItem({
          source: "telegram",
          externalId: `${channelId}:${message.messageId}`,
          url: message.url,
          content: message.content,
          eventTs,
          hasMedia: message.hasMedia,
          channelId,
          raw: {
            html: message.raw,
            source: "telegram_preview"
          }
        });
        
        if (inserted) {
          insertedCount++;
          totalInserted++;
        }
      }
      
      log(`${channelId} page ${totalPages + 1}: ${messages.length} read, ${insertedCount} inserted`);
      totalPages++;
      
      // If we're not at the last page, wait before next request
      if (totalPages < pageBudget) {
        await sleep(TG_PREVIEW_DELAY_SECONDS);
      }
    }

    channelFailures[channelId] = 0;
    channelLastOk[channelId] = Date.now();
    channelBackfilled[channelId] = true;
    delete channelBackoffs[channelId];

    const detail = `${backfilling ? "backfilled" : "polled"} ${totalPages} pages, inserted ${totalInserted} items`;
    log(`${channelId} ok: ${detail}`);

    // last_ok used to be written as undefined here, which the upsert stores as
    // NULL. A channel that had just ingested 500 messages therefore reported
    // last_ok: null and read as never having worked.
    await sourceStatusUpdate({
      id: channelId,
      source: "telegram",
      label: channelId,
      ok: true,
      detail,
      failures: 0,
      last_ok: new Date(channelLastOk[channelId]),
      updated_at: new Date()
    });

    return { channelId, skipped: false, ok: true, backfilled: backfilling, pages: totalPages, inserted: totalInserted };
  } catch (e) {
    channelFailures[channelId] = (channelFailures[channelId] || 0) + 1;
    const detail = describeError(e);
    console.error(
      `[tg-preview] ${channelId} failed (${channelFailures[channelId]} consecutive) after ${totalPages} pages, ${totalInserted} inserted: ${detail}`,
    );

    await sourceStatusUpdate({
      id: channelId,
      source: "telegram",
      label: channelId,
      ok: false,
      detail,
      failures: channelFailures[channelId],
      last_ok: channelLastOk[channelId] ? new Date(channelLastOk[channelId]) : undefined,
      updated_at: new Date()
    });

    if (e instanceof HttpStatusError && e.throttled) applyThrottleBackoff(channelId);
    applyBackoff(channelId);

    return { channelId, skipped: false, ok: false, backfilled: false, pages: totalPages, inserted: totalInserted };
  }
}

export interface RoundSummary {
  outcomes: ChannelOutcome[];
  backfilled: boolean;
}

// One pass over every channel, sequential so the channels do not compete for the
// same rate limit. Exported so a deploy can prove a single round instead of
// leaving the poll loop running.
export async function runTelegramPreviewRound(): Promise<RoundSummary> {
  const outcomes: ChannelOutcome[] = [];
  for (const channel of TG_PREVIEW_CHANNELS) {
    if (collectorsShouldStop()) break;
    // One throttled channel must not stop the rest: processChannel already
    // converts every failure into an outcome, and the loop keeps going.
    outcomes.push(await processChannel(channel));
    await sleepUnlessStopped(TG_PREVIEW_DELAY_SECONDS);
  }
  // A round where any channel walked its history made a burst of requests that
  // the next round has to cool down from.
  return { outcomes, backfilled: outcomes.some((o) => o.backfilled) };
}

export async function runTelegramPreviewWorker(): Promise<void> {
  if (TG_PREVIEW_CHANNELS.length === 0) {
    console.error("[tg-preview] no channels configured");
    return;
  }

  log(
    `starting with ${TG_PREVIEW_CHANNELS.length} channels, up to ${TG_PREVIEW_MAX_PAGES} pages each, ${TG_PREVIEW_DELAY_SECONDS}s between requests`,
  );

  while (!collectorsShouldStop()) {
    try {
      const { outcomes, backfilled } = await runTelegramPreviewRound();

      const ok = outcomes.filter((o) => o.ok).length;
      const failed = outcomes.filter((o) => !o.ok && !o.skipped).length;
      const skipped = outcomes.filter((o) => o.skipped).length;
      const inserted = outcomes.reduce((sum, o) => sum + o.inserted, 0);
      const pages = outcomes.reduce((sum, o) => sum + o.pages, 0);

      const pause = backfilled ? TG_PREVIEW_BACKFILL_PAUSE_SECONDS : TG_PREVIEW_POLL_SECONDS;
      log(
        `round complete: ${ok} ok, ${failed} failed, ${skipped} skipped in backoff, ${pages} pages, ${inserted} inserted. Sleeping ${pause}s${backfilled ? " (backfill cooldown)" : ""}`,
      );
      await sleepUnlessStopped(pause);
    } catch (e) {
      console.error(`[tg-preview] unexpected error in the poll loop: ${describeError(e)}`);
      await sleepUnlessStopped(TG_PREVIEW_ERROR_BACKOFF_SECONDS);
    }
  }
  log("poll loop stopped");
}
