# SPEC: Phase 1 & 2: Real Ingestion + DB as Source of Truth

**Status:** to build
**Benchmark:** mideastpulse.live (API reverse-engineered 2026-09-13, see `GAP-ANALYSIS.md`)
**Constraint:** single language runtime. The API is Hono + TypeScript + `pg`. Workers are TypeScript too, run as a separate long-lived container in `docker-compose.yml`.

---

## §0 CODE STYLE. NON NEGOTIABLE.

These are Hessa's standing rules for all code in her repos.

1. **Never commit or push.** Leave everything in the working tree. She commits.
2. **No em dashes anywhere.** Not in code, comments, docs, or your report. No AI-sounding
   filler either. Concise, clear, no fluff.
3. **Comments only where the code genuinely needs explaining.** Default is no comment. Never
   restate what a line does.
4. **Tag every tunable value** with this exact form, on the line directly above it:

```
//TUNE: Control the (what it controls)
```

The repo already follows this (`server/src/routes/telegram.ts:13`,
`server/src/routes/osint.ts:11`). Match it. Every env var you read and every constant that
governs timing, batch size, retry count, or a limit needs a tag. This is how she navigates
the code by keyword search, so an untagged knob is a knob she cannot find.

```ts
//TUNE: Control how long a collection pass stays fresh before re-collecting
const CACHE_TTL_MS = 60 * 60 * 1000;
```

For an env var, describe the knob and the default in the tag:

```ts
//TUNE: Control the (rss poll rate). RSS_POLL_SECONDS=seconds between polling rounds.
const RSS_POLL_SECONDS = Number(envKey("RSS_POLL_SECONDS") || 120);
```

5. **Never invent data.** If a real value is unavailable, store `NULL`.

---

## READ FIRST: a prior attempt at this task failed. Do not repeat it.

Artifacts preserved at `/home/hessa/.openclaw/workspace/projects/osint-dashboard/prior-attempt/`:

- **`events.ts`**: genuinely usable reference for the read routes. Reuse its shape, then fix:
  guard null `published_at` before `.toISOString()` in cursor generation; use the repo's
  `AppError` from `./errors` instead of `console.error` + raw 500; filter `noise = false`;
  stop aliasing `source_uid` as BOTH `channel_name` and `channel_id`.
- **`rss_worker.py`**: **DO NOT COPY ITS APPROACH.** It is a stub. Line 144 reads
  `# In a real implementation, this would insert into the database` and it only calls
  `logger.info`. It never writes to Postgres. Your version MUST perform real
  parameterized `INSERT`s into `items` with `ON CONFLICT (source, external_id) DO NOTHING`.
- **`ingest-truth.patch`**: the prior schema delta. Read it so column names line up.
  Prefer §1 below, but keep names prior work established so the two don't diverge.

**Hard requirement: no stubs.** No `"would insert"` logging, no `TODO: insert`, no in-memory
placeholder where the DB belongs. If `DATABASE_URL` is unavailable in your environment, the
insert code must still be complete and correct, then say honestly in your summary that you
could not execute it, instead of logging a fake success. A previous run claimed completion in
118 seconds and produced a worker that stores nothing.

---

## 0. The problem being fixed

`server/src/routes/telegram.ts` currently:
1. Firecrawl-scrapes `https://t.me/s/<channel>` (public web preview, ~last 20 posts, relative timestamps)
2. `markdown.slice(-1500)`: keeps only the tail, cut point moves every run
3. Asks an LLM to output `"timestamp": "ISO 8601 UTC timestamp"` and `"message_id": number`
4. Compares `MAX_NEWEST_POST_AGE_MS` against that **LLM-generated** timestamp

The stored timestamp is invented, so the staleness gate can never detect staleness. Every panel also serves from `api_cache` (a JSON blob, 60-min TTL), so nothing accumulates verifiable history.

**Fix: collect real messages/feeds with real source timestamps into `items`, and serve panels from `items`.**

---

## 1. New schema (add to `SCHEMA_SQL` in `server/src/db.ts`)

Keep existing `items` columns. Add:

```sql
ALTER TABLE items ADD COLUMN IF NOT EXISTS source_uid text;
ALTER TABLE items ADD COLUMN IF NOT EXISTS lang text;
ALTER TABLE items ADD COLUMN IF NOT EXISTS has_media boolean NOT NULL DEFAULT false;
ALTER TABLE items ADD COLUMN IF NOT EXISTS event_type text;
ALTER TABLE items ADD COLUMN IF NOT EXISTS is_breaking boolean NOT NULL DEFAULT false;
ALTER TABLE items ADD COLUMN IF NOT EXISTS primary_location jsonb;
ALTER TABLE items ADD COLUMN IF NOT EXISTS enrichment jsonb;
ALTER TABLE items ADD COLUMN IF NOT EXISTS event_ts timestamptz;

CREATE INDEX IF NOT EXISTS items_event_ts_idx ON items (event_ts DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS items_event_type_idx ON items (event_type);
CREATE INDEX IF NOT EXISTS items_source_idx ON items (source);

CREATE TABLE IF NOT EXISTS source_status (
  id text PRIMARY KEY,
  source text NOT NULL,
  label text,
  ok boolean NOT NULL DEFAULT true,
  detail text,
  failures integer NOT NULL DEFAULT 0,
  last_ok timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

**Contract rules (non-negotiable):**
- `event_ts` is the **real** source time. Telegram: `msg.date`. RSS: `published_parsed`. Never an LLM guess. Never null for a stored item.
- **Clamp future dates:** if `event_ts > now()`, store `now()`. (JPost's feed stamps ~2–3h into the future.) Keep the original in `raw.original_pubdate`.
- **Dedupe key:** `(source, external_id)`, already `UNIQUE`. Telegram: `external_id = "<chat_id>:<msg.id>"`. RSS: `external_id = "<feed_key>:<guid or link hash>"`.
- Always store the full original payload in `raw` JSONB.

---

## 2. `server/src/workers/rss.ts`

Use `rss-parser`. Env: `RSS_FEEDS` (comma-separated), `RSS_POLL_SECONDS` (default 120), `RSS_MAX_BACKOFF` (default 10).

Per feed per round:
- `source = 'rss'`, `external_id = "<feedKey>:<guid|link>"`, `url = item.link`, `title`, `content = item.contentSnippet || item.content`, `author = item.creator || item.author`
- `event_ts = item.isoDate || pubDate`, clamped as above
- `ON CONFLICT (source, external_id) DO NOTHING`
- Per-round health into `source_status` (id = `<feedKey>`, label = feed title)
- **Circuit breaker:** N consecutive failures → skip with growing backoff, capped at `RSS_MAX_BACKOFF` rounds; a success resets the counter.
- Reject items with no parseable date (log to `source_status.detail`), so undated junk can't enter.

`feedKey` = stable slug from the feed URL (e.g. `https://feeds.bbci.co.uk/news/world/rss.xml` → `bbc_world`). Keep a small explicit map so keys are readable; fall back to a slug of the host.

**Feed list to ship in `.env.example` (validated live 2026-09-13):**

```
RSS_FEEDS=https://feeds.bbci.co.uk/news/world/rss.xml,https://feeds.bbci.co.uk/news/business/rss.xml,https://www.aljazeera.com/xml/rss/all.xml,https://www.aljazeera.net/aljazeerarss,https://www.france24.com/en/rss,https://www.france24.com/ar/rss,https://news.un.org/feed/subscribe/en/news/all/rss.xml,https://news.google.com/rss/headlines/section/topic/WORLD?hl=en-US&gl=US&ceid=US:en,https://news.google.com/rss/headlines/section/topic/TECHNOLOGY?hl=en-AE&gl=AE&ceid=AE:en,https://techcrunch.com/category/artificial-intelligence/feed/,https://arstechnica.com/ai/feed/,https://www.theverge.com/rss/index.xml,https://www.wired.com/feed/rss,https://feeds.content.dowjones.io/public/rss/mw_topstories,https://www.jpost.com/rss/rssfeedsfrontpage.aspx,https://www.jpost.com/rss/rssfeedsmiddleeast.aspx,https://www.space.com/feeds/all
```

**NOT included, and why:**
- `mw_marketpulse` is **dead**, newest item ~1.2 years old. Do not add.
- `aawsat.com/feed` returns a Mailchimp newsletter template, not the paper. Needs the correct endpoint.
- Reuters / AP / ACLED: no usable public RSS (404 / 403).
- **WAM tokened feeds**: 5 URLs, token-gated. Only in the private `.env`, never committed. Add a comment in `.env.example` noting they belong there.

---

## 3. `server/src/workers/telegram.ts`

Use `telegram` (gramjs) MTProto. Env: `TG_API_ID`, `TG_API_HASH`, `TG_SESSION`, `TG_CHANNELS` (comma-separated usernames), `TG_MAX_CHANNELS` (default 40), `TG_RESOLVE_DELAY_SECONDS` (default 5), `TG_HEARTBEAT_SECONDS` (default 120).

- Resolve each channel, page back **history** (`getMessages`, limit ~100) on start, then subscribe to `NewMessage` for live streaming.
- Insert with `source='telegram'`, `external_id="<chat_id>:<msg.id>"`, `url=https://t.me/<username>/<msg.id>`, `event_ts=msg.date`, `has_media = !!msg.media`, full `raw` dict.
- **`msg.date` is the timestamp. Do not touch an LLM for it.**
- Flood control: set `floodSleepThreshold`; per-channel resolve pacing via `TG_RESOLVE_DELAY_SECONDS`.
- Heartbeat into `source_status` every `TG_HEARTBEAT_SECONDS`.
- Read existing messages on a channel too. On first run a channel should backfill, not start empty.

**Channels to seed `TG_CHANNELS` with: the benchmark's verified roster (7-day enumeration, 2,149 events):**

| events | channel | note |
|---:|---|---|
| 610 | `monitor_the_situation` | 28% of all his volume |
| 202 | `intelslava` | |
| 200 | `GeoPWatch` | |
| 184 | `rnintel` | |
| 157 | `CIG_telegram` | |
| 117 | `idkunim_il` | |
| 40 | `OSINTdefender` | |
| 34 | `BellumActaNews` | |
| 1 | `RocketAlert` | alert channel, low volume but high signal |

Signal density beats channel count. Start with these, not 40.

## 3b. Retire the old collection path
In `routes/telegram.ts`: remove Firecrawl collection + `extractStructured` metadata invention + `MAX_NEWEST_POST_AGE_MS` gate. Keep Firecrawl only for on-demand single-article deep-dives. Do not delete the file. Repoint it to read the DB (see §4).

---

## 4. New read routes (`server/src/routes/events.ts`), mounted in `index.ts`

```
GET /api/events?since=&until=&limit=&cursor=&channel=&source=&type=&severity=&breaking=
GET /api/events/pins
GET /api/stats
```

- `/api/events` reads `items` `ORDER BY event_ts DESC`, **keyset paginated** (cursor = `event_ts|id`, not OFFSET). Exclude `noise = true`.
- `/api/events/pins`: only rows where `primary_location->>'lat'` is non-null.
- `/api/stats` returns `total_events`, `events_last_hour`, `events_per_minute`, `by_type`, `by_severity`, `by_channel`, `top_regions`. **This endpoint is what makes the dashboard feel alive**: every number a real count over a real store with a real time.
- `source_status` returnable so a dead feed is visible instead of silently absent.

`api_cache` becomes a read-through cache at most, never the origin.

Enrichment fields (`event_type`, `severity`, `primary_location`, `translation`, `is_breaking`) go in `enrichment` JSONB for now. Phase 3 fills them; the read routes must tolerate nulls from day one.

---

## 5. Runtime

Add a `workers` service to `docker-compose.yml` (same image as `api`, different command, same `DATABASE_URL`, `depends_on: db healthy`). The workers are long-lived processes, not request-triggered. Add a `workers:dev` script to `server/package.json`.

---

## 6. Verification (must run, paste real output)

1. `npm run typecheck` in `server/`: clean.
2. RSS worker against the 16 feeds for one round → `psql` query proving `COUNT(*)`, `MIN(event_ts)`, `MAX(event_ts)`, and per-feed counts. Assert `MAX(event_ts) <= now()`.
3. Telegram worker → assert every inserted row has a non-null `event_ts` equal to a real `msg.date`, and `url` resolves to a real `t.me` permalink.
4. Re-run both → assert **zero** new rows (dedupe holds).
5. `curl /api/stats` and `curl /api/events?limit=5` → paste the real JSON.

## 7. Do NOT
- Do not commit or push. Leave changes in the working tree; Pearl commits.
- Do not invent a timestamp anywhere, ever.
- Do not add a paid API dependency.
- Do not touch frontend files (`src/`). That's Phase 4.
